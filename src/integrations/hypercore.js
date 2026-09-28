import { encodeAbiParameters, decodeAbiParameters, encodeFunctionData, encodePacked, getAddress, parseUnits, formatUnits, erc20Abi } from "viem";
import { IntegrationError, checksummed, call, approveCall, parseAmount, requireCode } from "./common.js";

/**
 * HyperCore (Hyperliquid's native order books) from a HyperEVM Treasury.
 *
 * The Treasury's EVM address is also its HyperCore account. Funds move to
 * Core by sending HYPE to the HYPE system address, or USDC through Circle's
 * CoreDepositWallet; orders and transfers are CoreWriter actions -
 * Treasury.execute(CoreWriter, sendRawAction(bytes)) - so no wrapper
 * contract is needed.
 *
 * A CoreWriter action is 1 version byte (1), a 3-byte action id, then the
 * abi-encoded fields. Prices and sizes are the human value x 1e8; asset is
 * the perp index, or 10000 + the spot index. The ids, field layouts,
 * system addresses and precompiles below are from hyper-evm-lib
 * (hyperliquid-dev/hyper-evm-lib, by Obsidian Audits - Hyperliquid's own
 * docs weren't reachable to cross-check, hence the warning).
 *
 * HyperCore processes an action after the EVM block: the proposal executes
 * even if Core then rejects the action (bad tick, no balance, no fill), so
 * the bot checks the tick/lot rules up front and says so in every summary.
 */

const CORE_WRITER_ABI = [{ type: "function", name: "sendRawAction", inputs: [{ name: "data", type: "bytes" }], outputs: [], stateMutability: "nonpayable" }];
const DEPOSIT_WALLET_ABI = [{ type: "function", name: "deposit", inputs: [{ name: "amount", type: "uint256" }, { name: "destinationDex", type: "uint32" }], outputs: [], stateMutability: "nonpayable" }];

const ACTION = { LIMIT_ORDER: 1, USD_CLASS_TRANSFER: 7, CANCEL_BY_CLOID: 11, SEND_ASSET: 13 };
const TIF = { alo: 1, gtc: 2, ioc: 3 };
const SPOT_DEX = 0xffffffff;
const PERP_DEX = 0;
const SPOT_ASSET_OFFSET = 10_000;
const HYPE_CORE_DECIMALS = 8; // HYPE is 18 decimals on the EVM, 8 on Core

const PRECOMPILE = {
  perpAssetInfo: "0x000000000000000000000000000000000000080a",
  spotInfo: "0x000000000000000000000000000000000000080b",
  tokenInfo: "0x000000000000000000000000000000000000080c",
};
const PERP_ASSET_INFO = [{ type: "tuple", components: [{ name: "coin", type: "string" }, { name: "marginTableId", type: "uint32" }, { name: "szDecimals", type: "uint8" }, { name: "maxLeverage", type: "uint8" }, { name: "onlyIsolated", type: "bool" }] }];
const SPOT_INFO = [{ type: "tuple", components: [{ name: "name", type: "string" }, { name: "tokens", type: "uint64[2]" }] }];
const TOKEN_INFO = [{ type: "tuple", components: [{ name: "name", type: "string" }, { name: "spots", type: "uint64[]" }, { name: "deployerTradingFeeShare", type: "uint64" }, { name: "deployer", type: "address" }, { name: "evmContract", type: "address" }, { name: "szDecimals", type: "uint8" }, { name: "weiDecimals", type: "uint8" }, { name: "evmExtraWeiDecimals", type: "int8" }] }];

const WARNING = "HyperCore action encodings are from hyper-evm-lib (Obsidian Audits), not a Hyperliquid source - test with small amounts first.";
const SOURCES = ["hyperliquid-dev/hyper-evm-lib (main, 2026-06-24): src/common/HLConstants.sol, src/CoreWriterLib.sol, src/PrecompileLib.sol"];

export const protocol = {
  id: "hypercore",
  name: "HyperCore",
  category: "DEX / perps",
  deployments: {
    hyperevm: {
      coreWriter: "0x3333333333333333333333333333333333333333",
      hypeSystem: "0x2222222222222222222222222222222222222222",
      usdc: "0xb88339cb7199b77e23db6e890353e22632ba630f",
      coreDepositWallet: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24",
      hypeTokenIndex: 150,
      noCode: ["hypeSystem"],
      sources: SOURCES,
      warning: WARNING,
    },
    "hyperevm-testnet": {
      coreWriter: "0x3333333333333333333333333333333333333333",
      hypeSystem: "0x2222222222222222222222222222222222222222",
      usdc: "0x2b3370ee501b4a559b57d449569354196457d8ab",
      coreDepositWallet: "0x0b80659a4076e9e93c7dbe0f10675a16a3e5c206",
      hypeTokenIndex: 1105,
      noCode: ["hypeSystem"],
      sources: SOURCES,
      warning: WARNING,
    },
  },
};

/** verify-integrations: HyperCore's own precompiles must agree - token 0 is linked to our USDC, the HYPE index is HYPE. */
export async function verify(publicClient, d) {
  const ctx = { publicClient };
  const problems = [];
  const usdc = await precompile(ctx, PRECOMPILE.tokenInfo, [{ type: "uint64" }], [0n], TOKEN_INFO);
  if (getAddress(usdc.evmContract) !== getAddress(d.usdc)) problems.push(`HyperCore token 0 (${usdc.name}) is linked to ${usdc.evmContract}, not USDC ${getAddress(d.usdc)}`);
  const hype = await precompile(ctx, PRECOMPILE.tokenInfo, [{ type: "uint64" }], [BigInt(d.hypeTokenIndex)], TOKEN_INFO);
  if (hype.name !== "HYPE") problems.push(`HyperCore token ${d.hypeTokenIndex} is "${hype.name}", not HYPE`);
  return problems;
}

const CORE_NOTE = " HyperCore applies it just after the EVM transaction - if Core rejects it, the proposal still shows as executed.";

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`HyperCore actions only exist on HyperEVM (not ${ctx.network.chain.name}).`);
  return checksummed(d);
}

/** 0x01 | uint24 action id | abi.encode(fields) - wrapped as CoreWriter.sendRawAction. */
export function coreAction(d, id, types, values, note) {
  const raw = encodePacked(["uint8", "uint24", "bytes"], [1, id, encodeAbiParameters(types, values)]);
  return call(d.coreWriter, encodeFunctionData({ abi: CORE_WRITER_ABI, functionName: "sendRawAction", args: [raw] }), { note });
}

async function precompile(ctx, address, argTypes, args, outTypes) {
  let data;
  try {
    ({ data } = await ctx.publicClient.call({ to: address, data: encodeAbiParameters(argTypes, args) }));
  } catch (err) {
    throw new IntegrationError(`HyperCore lookup failed (${err.shortMessage || err.message}).`);
  }
  if (!data || data === "0x") throw new IntegrationError("HyperCore returned nothing for that index - check it exists.");
  return decodeAbiParameters(outTypes, data)[0];
}

/** "perp:3", "spot:107" or a raw asset id -> { asset, market, szDecimals, maxDecimals }. */
async function market(ctx, text) {
  const m = /^(perp|spot):(\d+)$/i.exec(String(text ?? "")) ?? (/^\d+$/.test(String(text ?? "")) ? [null, Number(text) >= SPOT_ASSET_OFFSET ? "spot" : "perp", String(Number(text) >= SPOT_ASSET_OFFSET ? Number(text) - SPOT_ASSET_OFFSET : text)] : null);
  if (!m) throw new IntegrationError(`"${text}" isn't a market - use perp:<index> or spot:<index> (Hyperliquid's asset indexes).`);
  const kind = m[1].toLowerCase(), index = Number(m[2]);
  if (kind === "perp") {
    const info = await precompile(ctx, PRECOMPILE.perpAssetInfo, [{ type: "uint32" }], [index], PERP_ASSET_INFO);
    if (!info.coin) throw new IntegrationError(`There's no perp with index ${index}.`);
    return { asset: index, market: `${info.coin} perp`, szDecimals: Number(info.szDecimals), maxDecimals: 6 };
  }
  const info = await precompile(ctx, PRECOMPILE.spotInfo, [{ type: "uint64" }], [BigInt(index)], SPOT_INFO);
  if (!info.name) throw new IntegrationError(`There's no spot market with index ${index}.`);
  const base = await precompile(ctx, PRECOMPILE.tokenInfo, [{ type: "uint64" }], [info.tokens[0]], TOKEN_INFO);
  return { asset: SPOT_ASSET_OFFSET + index, market: `${info.name} spot`, szDecimals: Number(base.szDecimals), maxDecimals: 8 };
}

const decimalsOf = (text) => (String(text).split(".")[1] ?? "").length;

/** Hyperliquid's tick and lot rules: size to szDecimals; price to 5 significant figures and maxDecimals - szDecimals places (integers always allowed). */
function checkTick(m, sizeText, priceText) {
  if (!/^\d+(\.\d+)?$/.test(sizeText) || Number(sizeText) <= 0) throw new IntegrationError(`"${sizeText}" isn't a size.`);
  if (!/^\d+(\.\d+)?$/.test(priceText) || Number(priceText) <= 0) throw new IntegrationError(`"${priceText}" isn't a price.`);
  if (decimalsOf(sizeText) > m.szDecimals) throw new IntegrationError(`${m.market} sizes allow ${m.szDecimals} decimal places.`);
  const priceDecimals = decimalsOf(priceText);
  if (priceDecimals > 0) {
    const allowed = m.maxDecimals - m.szDecimals;
    if (priceDecimals > allowed) throw new IntegrationError(`${m.market} prices allow ${allowed} decimal places.`);
    const digits = priceText.replace(".", "").replace(/^0+/, "").length;
    if (digits > 5) throw new IntegrationError("Prices can have at most 5 significant figures (whole numbers are always fine).");
  }
}

function yesNo(text, fallback) {
  if (text === undefined) return fallback;
  const v = String(text).toLowerCase();
  if (["yes", "true", "on"].includes(v)) return true;
  if (["no", "false", "off"].includes(v)) return false;
  throw new IntegrationError(`"${text}" - use yes or no.`);
}

function randomCloid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`) || 1n;
}

export const actions = [
  {
    id: "hypercore-deposit-hype",
    label: "Move HYPE from the Treasury to its HyperCore spot balance",
    usage: ["amount"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const amount = parseUnits(String(ctx.args[0] ?? ""), 18);
      if (!/^\d+(\.\d+)?$/.test(String(ctx.args[0] ?? "")) || amount === 0n) throw new IntegrationError(`"${ctx.args[0]}" isn't an amount.`);
      if (decimalsOf(ctx.args[0]) > HYPE_CORE_DECIMALS) throw new IntegrationError(`HyperCore holds HYPE to ${HYPE_CORE_DECIMALS} decimals - anything finer would be lost.`);
      return {
        calls: [call(d.hypeSystem, "0x", { value: amount, note: "HYPE to Core" })],
        summary: `Move ${formatUnits(amount, 18)} HYPE from the Treasury to its HyperCore spot balance.`,
      };
    },
  },
  {
    id: "hypercore-deposit-usdc",
    label: "Move USDC from the Treasury to HyperCore (spot or perps)",
    usage: ["amount"],
    options: [{ name: "to", description: "spot or perp", default: "perp" }],
    async build(ctx) {
      const d = deployment(ctx);
      const to = String(ctx.options.to ?? "perp").toLowerCase();
      if (to !== "spot" && to !== "perp") throw new IntegrationError("to= must be spot or perp.");
      await requireCode(ctx, { USDC: d.usdc, CoreDepositWallet: d.coreDepositWallet });
      const amount = await parseAmount(ctx, d.usdc, ctx.args[0]);
      const held = await ctx.publicClient.readContract({ address: d.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
      if (held < amount) throw new IntegrationError(`The Treasury holds only ${formatUnits(held, 6)} USDC on HyperEVM.`);
      return {
        calls: [
          approveCall(d.usdc, d.coreDepositWallet, amount, "approve CoreDepositWallet"),
          call(d.coreDepositWallet, encodeFunctionData({ abi: DEPOSIT_WALLET_ABI, functionName: "deposit", args: [amount, to === "spot" ? SPOT_DEX : PERP_DEX] }), { note: "USDC to Core" }),
        ],
        summary: `Move ${formatUnits(amount, 6)} USDC from the Treasury to its HyperCore ${to} balance.`,
      };
    },
  },
  {
    id: "hypercore-order",
    label: "Place a HyperCore limit order (spot or perp) for the Treasury",
    usage: ["market", "buy|sell", "size", "price"],
    options: [
      { name: "tif", description: "ioc (fill now or cancel), gtc (rest on the book) or alo (post only)", default: "ioc" },
      { name: "reduceonly", description: "yes to only shrink an open perp position", default: "no" },
      { name: "cloid", description: "client order id to cancel it by later", default: "random" },
    ],
    help: "market is perp:<index> or spot:<index>. Price and size are in the market's own units; the price is fixed when proposing, so an IOC order simply doesn't fill if the market has moved by execution.",
    async build(ctx) {
      const d = deployment(ctx);
      const m = await market(ctx, ctx.args[0]);
      const side = String(ctx.args[1] ?? "").toLowerCase();
      if (side !== "buy" && side !== "sell") throw new IntegrationError('Side must be "buy" or "sell".');
      const sizeText = String(ctx.args[2] ?? ""), priceText = String(ctx.args[3] ?? "");
      checkTick(m, sizeText, priceText);
      const tifName = String(ctx.options.tif ?? "ioc").toLowerCase();
      if (!TIF[tifName]) throw new IntegrationError("tif= must be ioc, gtc or alo.");
      const reduceOnly = yesNo(ctx.options.reduceonly, false);
      const cloid = ctx.options.cloid === undefined ? randomCloid() : BigInt(ctx.options.cloid);
      if (cloid <= 0n || cloid >= 1n << 128n) throw new IntegrationError("cloid must fit in 128 bits.");
      const types = [{ type: "uint32" }, { type: "bool" }, { type: "uint64" }, { type: "uint64" }, { type: "bool" }, { type: "uint8" }, { type: "uint128" }];
      const values = [m.asset, side === "buy", parseUnits(priceText, 8), parseUnits(sizeText, 8), reduceOnly, TIF[tifName], cloid];
      return {
        calls: [coreAction(d, ACTION.LIMIT_ORDER, types, values, "limit order")],
        summary: `${side === "buy" ? "Buy" : "Sell"} ${sizeText} on HyperCore's ${m.market} at ${priceText} (${tifName.toUpperCase()}${reduceOnly ? ", reduce-only" : ""}; cloid ${cloid}).${CORE_NOTE}`,
      };
    },
  },
  {
    id: "hypercore-cancel",
    label: "Cancel a resting HyperCore order by its cloid",
    usage: ["market", "cloid"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const m = await market(ctx, ctx.args[0]);
      if (!/^\d+$/.test(String(ctx.args[1] ?? ""))) throw new IntegrationError("Give the order's cloid (a number, shown when it was proposed).");
      const cloid = BigInt(ctx.args[1]);
      return {
        calls: [coreAction(d, ACTION.CANCEL_BY_CLOID, [{ type: "uint32" }, { type: "uint128" }], [m.asset, cloid], "cancel")],
        summary: `Cancel the Treasury's ${m.market} order ${cloid} on HyperCore.${CORE_NOTE}`,
      };
    },
  },
  {
    id: "hypercore-usd-transfer",
    label: "Move USDC between the Treasury's HyperCore spot and perp balances",
    usage: ["amount", "to-perp|to-spot"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const dir = String(ctx.args[1] ?? "").toLowerCase();
      if (dir !== "to-perp" && dir !== "to-spot") throw new IntegrationError('Direction must be "to-perp" or "to-spot".');
      if (!/^\d+(\.\d{1,6})?$/.test(String(ctx.args[0] ?? "")) || Number(ctx.args[0]) <= 0) throw new IntegrationError(`"${ctx.args[0]}" isn't a USDC amount (up to 6 decimals).`);
      const ntl = parseUnits(String(ctx.args[0]), 6);
      return {
        calls: [coreAction(d, ACTION.USD_CLASS_TRANSFER, [{ type: "uint64" }, { type: "bool" }], [ntl, dir === "to-perp"], "usd class transfer")],
        summary: `Move ${ctx.args[0]} USDC from the Treasury's HyperCore ${dir === "to-perp" ? "spot to perp" : "perp to spot"} balance.${CORE_NOTE}`,
      };
    },
  },
  {
    id: "hypercore-withdraw",
    label: "Bring HYPE or a linked token from HyperCore spot back to the Treasury on HyperEVM",
    usage: ["HYPE|token:<index>", "amount"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const word = String(ctx.args[0] ?? "");
      let token, name, weiDecimals, system;
      if (word.toUpperCase() === "HYPE") {
        token = BigInt(d.hypeTokenIndex); name = "HYPE"; weiDecimals = HYPE_CORE_DECIMALS; system = d.hypeSystem;
      } else {
        const m = /^token:(\d+)$/i.exec(word);
        if (!m) throw new IntegrationError('Name the token as HYPE or token:<index> (its HyperCore token index).');
        token = BigInt(m[1]);
        const info = await precompile(ctx, PRECOMPILE.tokenInfo, [{ type: "uint64" }], [token], TOKEN_INFO);
        if (getAddress(info.evmContract) === "0x0000000000000000000000000000000000000000") throw new IntegrationError(`${info.name || `Token ${token}`} isn't linked to a HyperEVM contract - it can't be brought over.`);
        name = info.name; weiDecimals = Number(info.weiDecimals);
        system = getAddress(`0x20${token.toString(16).padStart(38, "0")}`);
      }
      const text = String(ctx.args[1] ?? "");
      if (!/^\d+(\.\d+)?$/.test(text) || Number(text) <= 0) throw new IntegrationError(`"${text}" isn't an amount.`);
      if (decimalsOf(text) > weiDecimals) throw new IntegrationError(`${name} on HyperCore has ${weiDecimals} decimals.`);
      const amountWei = parseUnits(text, weiDecimals);
      const types = [{ type: "address" }, { type: "address" }, { type: "uint32" }, { type: "uint32" }, { type: "uint64" }, { type: "uint64" }];
      return {
        calls: [coreAction(d, ACTION.SEND_ASSET, types, [system, "0x0000000000000000000000000000000000000000", SPOT_DEX, SPOT_DEX, token, amountWei], "Core to EVM")],
        summary: `Bring ${text} ${name} from the Treasury's HyperCore spot balance back to the Treasury on HyperEVM (non-HYPE tokens need a little HYPE on Core for the transfer fee).${CORE_NOTE}`,
      };
    },
  },
];
