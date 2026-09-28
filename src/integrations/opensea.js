import path from "path";
import { fileURLToPath } from "url";
import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, parseUnits, toHex, zeroAddress, zeroHash } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import { IntegrationError, checksummed, call, parseDuration, requireCode } from "./common.js";
import { readJson, updateJson } from "../jsonFile.js";

/**
 * OpenSea (Seaport 1.6) through the DAO's NFT wrapper - the wrapper, not
 * the Treasury, holds NFTs (see NFTMarketplaceWrapper.sol).
 *
 * list    Built like @opensea/sdk's createListingAndValidateOnchain, the
 *         SDK's path for contract accounts that can't sign: the wrapper
 *         approves OpenSea's conduit for the collection and calls
 *         Seaport.validate(order) itself (offerer == caller, so no
 *         signature is needed). OpenSea picks the listing up from the
 *         OrderValidated event. Price split exactly like the SDK's getFees:
 *         the collection's required fees (from OpenSea's API) to their
 *         recipients, the rest to the seller - the wrapper, whose proceeds
 *         then go to the Treasury with nftwrapper-sweep-native/-erc20.
 * update  Seaport.cancel(old) + validate(new price), in one proposal.
 * cancel  Seaport.cancel(old).
 * buy     Like the SDK's fulfillOrder: the best listing and its fill
 *         transaction come from OpenSea's API with the wrapper as the
 *         fulfiller. The bot re-encodes it with Seaport's own ABI and
 *         checks it before proposing: right Seaport, allowed function,
 *         the requested NFT, native payment within the maximum, delivered
 *         to the wrapper. The Treasury then sends the price to the wrapper
 *         and the wrapper fills the order.
 *
 * Needs OPENSEA_API_KEY for fees and buying. Listings the bot builds are
 * kept (data/openseaListings.json) so they can be updated or cancelled.
 */

const ABI = loadIntegrationAbi("opensea");
const API = process.env.OPENSEA_API_BASE || "https://api.opensea.io";
const LISTINGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "openseaListings.json");

// Seaport ItemType / OrderType (seaport-types ConsiderationEnums.sol).
const ITEM = { NATIVE: 0, ERC20: 1, ERC721: 2, ERC1155: 3 };
const ORDER_PARTIAL_OPEN = 1;
const ORDER_PARTIAL_RESTRICTED = 3;

// Constants from @opensea/sdk src/constants.ts and utils/chain.ts
// (getSeaportAddress, getDefaultConduit, getFeeRecipient).
const SEAPORT_1_6 = "0x0000000000000068f116a894984e2db1123eb395";
const CONDUIT_1 = { conduitKey: "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000", conduit: "0x1e0049783f008a0085193e00003d00cd54003c71" };
const CONDUIT_2 = { conduitKey: "0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e", conduit: "0x963f00d3ff000064ffcba824b800c0000000c300" };
const SDK_SOURCES = ["@opensea/sdk (src/constants.ts, utils/chain.ts: getSeaportAddress, getDefaultConduit)", "@opensea/seaport-js@4.3.0 CROSS_CHAIN_SEAPORT_V1_6_ADDRESS"];

export const protocol = {
  id: "opensea",
  name: "OpenSea",
  category: "NFT marketplace",
  deployments: {
    "monad-mainnet": { seaport: SEAPORT_1_6, ...CONDUIT_2, openseaChain: "monad", sources: [...SDK_SOURCES, "monad-crypto/protocols mainnet registry (OpenSea Marketplace = Seaport 1.6)"] },
    base: { seaport: SEAPORT_1_6, ...CONDUIT_1, openseaChain: "base", sources: SDK_SOURCES },
    hyperevm: { seaport: SEAPORT_1_6, ...CONDUIT_2, openseaChain: "hyperevm", sources: SDK_SOURCES },
  },
};

/** verify-integrations: Seaport reports itself and its conduit controller. */
export async function verify(publicClient, d) {
  const [version] = await publicClient.readContract({ address: getAddress(d.seaport), abi: ABI.seaport, functionName: "information" });
  return version === "1.6" ? [] : [`Seaport information().version is "${version}", expected "1.6"`];
}

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`OpenSea isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

function requireWrapper(ctx) {
  if (!ctx.nftWrapper) throw new IntegrationError("OpenSea actions go through the DAO's NFT wrapper - deploy it with /deploynftwrapper first.");
  return ctx.nftWrapper;
}

/* ------------------------------ OpenSea API ------------------------------ */

/** JSON.parse that keeps integers too big for a JS number as strings (amounts, salts). */
function parseJsonSafe(text) {
  return JSON.parse(text.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,\]}])/g, '$1"$2"'));
}

async function openseaApi(ctx, method, route, body) {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) throw new IntegrationError("OpenSea needs an API key for this - set OPENSEA_API_KEY (free at opensea.io/settings/developer).");
  const res = await (ctx.fetch ?? fetch)(`${API}${route}`, {
    method,
    headers: { "X-API-KEY": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new IntegrationError(`OpenSea API ${route} failed (${res.status}): ${text.slice(0, 200)}`);
  return parseJsonSafe(text);
}

/* ------------------------------- NFT helpers ------------------------------ */

async function nftKind(ctx, token, tokenId, holder) {
  try {
    const owner = await ctx.publicClient.readContract({ address: token, abi: ABI.erc721, functionName: "ownerOf", args: [tokenId] });
    return { itemType: ITEM.ERC721, held: getAddress(owner) === holder ? 1n : 0n, abi: ABI.erc721 };
  } catch {
    const held = await ctx.publicClient.readContract({ address: token, abi: ABI.erc1155, functionName: "balanceOf", args: [holder, tokenId] });
    return { itemType: ITEM.ERC1155, held, abi: ABI.erc1155 };
  }
}

function listingsStore() {
  return readJson(LISTINGS_FILE, {});
}

function rememberListing(orderHash, record) {
  updateJson(LISTINGS_FILE, {}, (db) => {
    db[orderHash.toLowerCase()] = record;
  });
}

const serialize = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

function componentsFrom(record) {
  const c = record.components;
  const big = (v) => BigInt(v);
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: c.offer.map((i) => ({ ...i, identifierOrCriteria: big(i.identifierOrCriteria), startAmount: big(i.startAmount), endAmount: big(i.endAmount) })),
    consideration: c.consideration.map((i) => ({ ...i, identifierOrCriteria: big(i.identifierOrCriteria), startAmount: big(i.startAmount), endAmount: big(i.endAmount) })),
    orderType: c.orderType,
    startTime: big(c.startTime),
    endTime: big(c.endTime),
    zoneHash: c.zoneHash,
    salt: big(c.salt),
    conduitKey: c.conduitKey,
    counter: big(c.counter),
  };
}

/* ----------------------------- listing builder ---------------------------- */

async function buildListing(ctx, d, { token, tokenId, priceText, quantity }) {
  const wrapper = requireWrapper(ctx);
  await requireCode(ctx, { Seaport: d.seaport, "NFT contract": token });
  const kind = await nftKind(ctx, token, tokenId, wrapper);
  if (kind.held < quantity) {
    throw new IntegrationError(`The NFT wrapper doesn't hold ${kind.itemType === ITEM.ERC721 ? "this NFT" : `${quantity} of this token`} - send it to the wrapper first (NFTs never go to the Treasury).`);
  }

  // Collection fees and listing currency, as @opensea/sdk _buildListingOrder does.
  let fees = [];
  let zone = zeroAddress;
  let currency = zeroAddress;
  if (ctx.options.fees !== "none") {
    const { nft } = await openseaApi(ctx, "GET", `/api/v2/chain/${d.openseaChain}/contract/${token}/nfts/${tokenId}`);
    const collection = await openseaApi(ctx, "GET", `/api/v2/collections/${encodeURIComponent(nft.collection)}`);
    fees = (collection.fees ?? []).filter((f) => f.required);
    if (collection.required_zone) zone = getAddress(collection.required_zone);
    const listingCurrency = collection.pricing_currencies?.listing_currency?.address;
    if (listingCurrency && getAddress(listingCurrency) !== zeroAddress) {
      throw new IntegrationError("This collection lists in an ERC20, not the native currency - not supported yet.");
    }
    currency = zeroAddress;
  }

  const price = parseUnits(String(priceText), 18);
  if (price === 0n) throw new IntegrationError("Price must be more than 0.");
  // getFees(): each fee gets amount * bps / 10000; the seller gets the rest of the bps.
  const feeBps = fees.map((f) => BigInt(Math.round(Number(f.fee) * 100)));
  const totalFeeBps = feeBps.reduce((a, b) => a + b, 0n);
  if (totalFeeBps >= 10_000n) throw new IntegrationError("Collection fees add up to 100% or more.");
  const item = (amount, recipient) => ({ itemType: currency === zeroAddress ? ITEM.NATIVE : ITEM.ERC20, token: currency, identifierOrCriteria: 0n, startAmount: amount, endAmount: amount, recipient });
  const consideration = [item((price * (10_000n - totalFeeBps)) / 10_000n, wrapper), ...fees.map((f, i) => item((price * feeBps[i]) / 10_000n, getAddress(f.recipient)))];

  const now = (await ctx.publicClient.getBlock()).timestamp;
  const counter = await ctx.publicClient.readContract({ address: d.seaport, abi: ABI.seaport, functionName: "getCounter", args: [wrapper] });
  const components = {
    offerer: wrapper,
    zone,
    offer: [{ itemType: kind.itemType, token, identifierOrCriteria: tokenId, startAmount: quantity, endAmount: quantity }],
    consideration,
    orderType: zone === zeroAddress ? ORDER_PARTIAL_OPEN : ORDER_PARTIAL_RESTRICTED,
    startTime: now,
    endTime: now + BigInt(parseDuration(ctx.options.duration, 90 * 86400)),
    zoneHash: zeroHash,
    salt: BigInt(toHex(crypto.getRandomValues(new Uint8Array(32)))),
    conduitKey: d.conduitKey,
    counter,
  };
  const orderHash = await ctx.publicClient.readContract({ address: d.seaport, abi: ABI.seaport, functionName: "getOrderHash", args: [components] });

  const { counter: _c, ...rest } = components;
  const parameters = { ...rest, totalOriginalConsiderationItems: BigInt(consideration.length) };
  const approved = await ctx.publicClient.readContract({ address: token, abi: kind.abi, functionName: "isApprovedForAll", args: [wrapper, d.conduit] });
  const calls = [
    ...(approved ? [] : [call(token, encodeFunctionData({ abi: kind.abi, functionName: "setApprovalForAll", args: [d.conduit, true] }), { via: "nftWrapper", note: "approve OpenSea conduit" })]),
    call(d.seaport, encodeFunctionData({ abi: ABI.seaport, functionName: "validate", args: [[{ parameters, signature: "0x" }]] }), { via: "nftWrapper", note: "list" }),
  ];
  rememberListing(orderHash, { network: ctx.network.id, components: serialize(components), price: price.toString() });
  const feeText = fees.length ? ` Required collection fees: ${fees.map((f) => `${f.fee}%`).join(" + ")}.` : ctx.options.fees === "none" ? " No marketplace fees included (fees=none) - OpenSea may not show it." : "";
  return { calls, orderHash, price, feeText };
}

/* --------------------------------- actions -------------------------------- */

export const actions = [
  {
    id: "opensea-list",
    label: "List an NFT the DAO's NFT wrapper holds for sale on OpenSea",
    usage: ["nftContract", "tokenId", "price"],
    options: [
      { name: "duration", description: "how long the listing stays open", default: "90d" },
      { name: "quantity", description: "for ERC1155: how many", default: "1" },
      { name: "fees", description: "none = skip OpenSea's fee lookup (not recommended)" },
    ],
    help: "The price is in the chain's native currency. Proceeds arrive in the NFT wrapper; sweep them to the Treasury with nftwrapper-sweep-native.",
    async build(ctx) {
      const d = deployment(ctx);
      const [tokenText, idText, priceText] = ctx.args;
      if (!/^\d+$/.test(String(idText))) throw new IntegrationError(`"${idText}" isn't a token id.`);
      const listing = await buildListing(ctx, d, { token: getAddress(tokenText), tokenId: BigInt(idText), priceText, quantity: BigInt(ctx.options.quantity ?? 1) });
      return {
        calls: listing.calls,
        summary:
          `List ${tokenText} #${idText} on OpenSea for ${formatUnits(listing.price, 18)} ${ctx.network.nativeSymbol}.${listing.feeText} ` +
          `Order hash ${listing.orderHash} - use it with opensea-update-listing or opensea-cancel-listing.`,
      };
    },
  },
  {
    id: "opensea-update-listing",
    label: "Change the price of an OpenSea listing (cancels it and lists again)",
    usage: ["orderHash", "newPrice"],
    options: [{ name: "duration", description: "how long the new listing stays open", default: "90d" }],
    async build(ctx) {
      const d = deployment(ctx);
      const record = listingsStore()[String(ctx.args[0]).toLowerCase()];
      if (!record) throw new IntegrationError("No listing with that order hash was made through this bot.");
      const old = componentsFrom(record);
      const listing = await buildListing(ctx, d, {
        token: getAddress(old.offer[0].token),
        tokenId: old.offer[0].identifierOrCriteria,
        priceText: ctx.args[1],
        quantity: old.offer[0].startAmount,
      });
      return {
        calls: [call(d.seaport, encodeFunctionData({ abi: ABI.seaport, functionName: "cancel", args: [[old]] }), { via: "nftWrapper", note: "cancel old listing" }), ...listing.calls],
        summary: `Re-list ${old.offer[0].token} #${old.offer[0].identifierOrCriteria} at ${formatUnits(listing.price, 18)} ${ctx.network.nativeSymbol} (was ${formatUnits(BigInt(record.price), 18)}).${listing.feeText} New order hash ${listing.orderHash}.`,
      };
    },
  },
  {
    id: "opensea-cancel-listing",
    label: "Cancel an OpenSea listing made through this bot",
    usage: ["orderHash"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      requireWrapper(ctx);
      const record = listingsStore()[String(ctx.args[0]).toLowerCase()];
      if (!record) throw new IntegrationError("No listing with that order hash was made through this bot.");
      const old = componentsFrom(record);
      return {
        calls: [call(d.seaport, encodeFunctionData({ abi: ABI.seaport, functionName: "cancel", args: [[old]] }), { via: "nftWrapper", note: "cancel listing" })],
        summary: `Cancel the OpenSea listing of ${old.offer[0].token} #${old.offer[0].identifierOrCriteria} (${ctx.args[0]}).`,
      };
    },
  },
  {
    id: "opensea-buy",
    label: "Buy an NFT at its cheapest OpenSea listing (it goes to the NFT wrapper)",
    usage: ["nftContract", "tokenId", "maxPrice"],
    options: [],
    help: "Native-currency listings only. The Treasury pays; the NFT is delivered to the DAO's NFT wrapper.",
    async build(ctx) {
      const d = deployment(ctx);
      const wrapper = requireWrapper(ctx);
      const [tokenText, idText, maxText] = ctx.args;
      const token = getAddress(tokenText);
      if (!/^\d+$/.test(String(idText))) throw new IntegrationError(`"${idText}" isn't a token id.`);
      const tokenId = BigInt(idText);
      const maxPrice = parseUnits(String(maxText), 18);
      await requireCode(ctx, { Seaport: d.seaport, "NFT contract": token });

      const { nft } = await openseaApi(ctx, "GET", `/api/v2/chain/${d.openseaChain}/contract/${token}/nfts/${tokenId}`);
      const best = await openseaApi(ctx, "GET", `/api/v2/listings/collection/${encodeURIComponent(nft.collection)}/nfts/${tokenId}/best`);
      if (!best?.order_hash) throw new IntegrationError("That NFT has no active OpenSea listing.");
      if (getAddress(best.protocol_address) !== d.seaport) throw new IntegrationError(`The listing is on protocol ${best.protocol_address}, not Seaport 1.6 - refusing.`);

      const fill = await openseaApi(ctx, "POST", "/api/v2/listings/fulfillment_data", {
        listing: { hash: best.order_hash, chain: d.openseaChain, protocol_address: d.seaport },
        fulfiller: { address: wrapper },
        units_to_fill: "1",
        include_optional_creator_fees: false,
      });
      const tx = fill.fulfillment_data.transaction;
      const { data, value } = encodeFulfillment(tx);
      checkFulfillment({ d, tx, data, value, token, tokenId, wrapper, maxPrice });

      return {
        calls: [
          call(wrapper, "0x", { value, note: "fund wrapper" }),
          call(d.seaport, data, { value, via: "nftWrapper", note: "buy" }),
        ],
        summary: `Buy ${tokenText} #${idText} on OpenSea for ${formatUnits(value, 18)} ${ctx.network.nativeSymbol} (max ${maxText}); it's delivered to the DAO's NFT wrapper.`,
      };
    },
  },
];

/* ------------------------------ fulfillment ------------------------------ */

const ALLOWED_FILLS = new Set(["fulfillBasicOrder", "fulfillBasicOrder_efficient_6GL6yc", "fulfillOrder", "fulfillAdvancedOrder"]);

/** Encodes the API's input_data with Seaport's ABI, as @opensea/sdk fulfillOrder does, keeping its attribution suffix. */
export function encodeFulfillment(tx) {
  const functionName = tx.function.split("(")[0];
  if (!ALLOWED_FILLS.has(functionName)) throw new IntegrationError(`OpenSea returned a ${functionName} fill, which the bot doesn't accept.`);
  const input = tx.input_data;
  const zeroKey = zeroHash;
  let args;
  if (functionName === "fulfillAdvancedOrder") args = [input.advancedOrder, input.criteriaResolvers ?? [], input.fulfillerConduitKey || zeroKey, input.recipient];
  else if (functionName === "fulfillOrder") args = [input.order, input.fulfillerConduitKey || zeroKey];
  else args = [input.parameters];
  let data = encodeFunctionData({ abi: ABI.seaport, functionName, args });
  if (tx.calldata_suffix && /^0x[0-9a-fA-F]{8}$/.test(tx.calldata_suffix)) data = `${data}${tx.calldata_suffix.slice(2)}`;
  return { data, value: BigInt(tx.value) };
}

/** Refuses a fill that isn't exactly: this NFT, from Seaport, paid in native, within the maximum, to the wrapper. */
export function checkFulfillment({ d, tx, data, value, token, tokenId, wrapper, maxPrice }) {
  if (getAddress(tx.to) !== d.seaport) throw new IntegrationError(`OpenSea's fill targets ${tx.to}, not Seaport - refusing.`);
  if (value > maxPrice) throw new IntegrationError(`The cheapest listing is ${formatUnits(value, 18)}, above your maximum of ${formatUnits(maxPrice, 18)}.`);
  const { functionName, args } = decodeFunctionData({ abi: ABI.seaport, data: data.slice(0, data.length - (tx.calldata_suffix ? 8 : 0)) });
  const sameNft = (t, id) => getAddress(t) === token && BigInt(id) === tokenId;
  if (functionName.startsWith("fulfillBasicOrder")) {
    const p = args[0];
    if (!sameNft(p.offerToken, p.offerIdentifier)) throw new IntegrationError("OpenSea's fill is for a different NFT - refusing.");
    if (getAddress(p.considerationToken) !== zeroAddress) throw new IntegrationError("That listing isn't priced in the native currency - not supported.");
    return; // basic orders deliver to msg.sender: the wrapper
  }
  const order = functionName === "fulfillAdvancedOrder" ? args[0] : args[0];
  const offer = order.parameters.offer;
  if (offer.length !== 1 || !sameNft(offer[0].token, offer[0].identifierOrCriteria)) throw new IntegrationError("OpenSea's fill is for a different NFT - refusing.");
  if (order.parameters.consideration.some((c) => c.itemType !== ITEM.NATIVE)) throw new IntegrationError("That listing isn't priced in the native currency - not supported.");
  if (functionName === "fulfillAdvancedOrder" && getAddress(args[3]) !== zeroAddress && getAddress(args[3]) !== wrapper) {
    throw new IntegrationError(`OpenSea's fill would deliver to ${args[3]}, not the NFT wrapper - refusing.`);
  }
}
