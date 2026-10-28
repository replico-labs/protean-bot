import { createRequire } from "module";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as v from "../vortex.js";
import { fail, key, deployment, requireProgram, fromKit } from "./common.js";

const require = createRequire(import.meta.url);
const tensor = require("@tensor-foundation/marketplace");
const tmeta = require("@tensor-foundation/mpl-token-metadata");
// Tensor's clients are built on @solana/web3.js 2.x (their own copy); RPC, addresses and signers come from it.
const kit = createRequire(require.resolve("@tensor-foundation/marketplace"))("@solana/web3.js");

/**
 * Tensor: the treasury buys a listed NFT, lists one of its NFTs for SOL,
 * or takes a listing down, on Tensor's marketplace program (open source,
 * tensor-foundation/marketplace, with a CPI test crate). Instructions come
 * from Tensor's own client (@tensor-foundation/marketplace), as its
 * examples build them: the listing and the NFT's metadata (token standard,
 * creators, rule set) are read when the proposal is written.
 *
 * Metaplex token-metadata NFTs only, programmable ones included; Core
 * assets and compressed NFTs aren't supported here yet. The treasury is
 * named as the trade's broker (Tensor shares its fee with brokers), and a
 * purchase pays the creators' royalties in full.
 *
 * A buy is protected by its maximum: the listing's price when proposed, or
 * the one given. If the listing is gone, repriced above it, or sold by
 * execution, the proposal fails.
 */

export const protocol = {
  id: "tensor",
  name: "Tensor",
  // A programmable NFT's buy touches 20-odd accounts: more than a legacy propose holds.
  needsV1Transactions: true,
  deployments: {
    "solana-mainnet": { program: "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp" },
    "solana-devnet": { program: "TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp" },
  },
};

/** A decoded Option's value, or undefined. */
const opt = (o) => (o && kit.isSome(o) ? kit.unwrapOption(o) : undefined);

const sol = (lamports) => `${v.formatUnits(BigInt(lamports), 9)} SOL`;

async function ctxOf(c, mintWord) {
  const dep = deployment(protocol, c.network);
  if (tensor.TENSOR_MARKETPLACE_PROGRAM_ADDRESS !== dep.program.toBase58()) fail("Tensor's client names another marketplace program than the pinned one - refusing until that's re-checked.");
  await requireProgram(c.network, dep.program, "Tensor's marketplace program");
  const mint = key(mintWord, "the NFT's mint");
  const mintInfo = await c.network.connection.getAccountInfo(mint);
  if (!mintInfo) fail(`\`${mint.toBase58()}\` doesn't exist on ${c.network.name}.`);
  if (!mintInfo.owner.equals(TOKEN_PROGRAM_ID) && !mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) fail("That isn't a token-metadata NFT (Core assets and compressed NFTs aren't supported yet).");
  const rpc = kit.createSolanaRpc(c.network.rpcUrl);
  const [metadataPda] = await tmeta.findMetadataPda({ mint: kit.address(mint.toBase58()) });
  const metadata = await tmeta.fetchMaybeMetadata(rpc, metadataPda);
  if (!metadata.exists) fail("That mint has no Metaplex metadata, so it isn't an NFT Tensor trades.");
  const m = metadata.data;
  return {
    rpc,
    mint: kit.address(mint.toBase58()),
    treasury: kit.createNoopSigner(kit.address(c.d.treasury.toBase58())),
    tokenStandard: opt(m.tokenStandard),
    creators: (opt(m.creators) ?? []).map((cr) => cr.address),
    // A programmable NFT's rule set: Option<{ __kind: "V1", ruleSet: Option<Address> }>.
    ruleSet: opt(opt(m.programmableConfig)?.ruleSet),
    name: m.name?.replace(/\0/g, "").trim() || mint.toBase58(),
  };
}

/** The NFT's listing, or a refusal saying why the treasury can't buy it. */
async function listing(t) {
  const [listState] = await tensor.findListStatePda({ mint: t.mint });
  const l = await tensor.fetchMaybeListState(t.rpc, listState);
  if (!l.exists) fail("That NFT isn't listed on Tensor.");
  const d = l.data;
  if (opt(d.currency)) fail("That listing is priced in a token, not SOL - only SOL listings are supported.");
  if (opt(d.privateTaker) && opt(d.privateTaker) !== t.treasury.address) fail("That listing is reserved for another buyer.");
  // Decoded as null when unset (a NullableAddress).
  if (d.cosigner) fail("That listing needs Tensor's cosigner, so it can only be bought on Tensor's site.");
  return d;
}

export const actions = {
  "tensor-buy": {
    models: "all",
    args: [
      { name: "<mint>", about: "the listed NFT's mint address" },
      { name: "[maxSOL]", about: "the most to pay (default: today's listing price)" },
    ],
    about: "Buy an NFT listed on Tensor for SOL, at its listing price or a given maximum.",
    async build(c) {
      const t = await ctxOf(c, c.args[0]);
      const l = await listing(t);
      const price = BigInt(l.amount);
      const max = c.args[1] ? v.parseUnits(c.args[1], 9) : price;
      if (max < price) fail(`It's listed at ${sol(price)}, above your maximum of ${sol(max)}.`);
      const ix = await tensor.getBuyLegacyInstructionAsync({
        payer: t.treasury,
        owner: l.owner,
        mint: t.mint,
        maxAmount: max,
        rentDestination: l.rentPayer ?? undefined,
        makerBroker: opt(l.makerBroker),
        takerBroker: t.treasury.address,
        optionalRoyaltyPct: 100,
        authorizationRules: t.ruleSet,
        tokenStandard: t.tokenStandard,
        creators: t.creators,
      });
      return {
        instructions: [v.stored(fromKit(ix))],
        // The price, plus Tensor's fee and royalties: budgeted at up to 15% over.
        budget: [{ mint: v.SOL_ASSET, amount: (max * 115n) / 100n }],
        summary: `buy the NFT ${t.name} (\`${t.mint}\`) on Tensor for at most ${sol(max)} plus fees and royalties`,
      };
    },
  },

  "tensor-list": {
    models: "all",
    args: [
      { name: "<mint>", about: "the treasury's NFT's mint address" },
      { name: "<priceSOL>", about: "the listing price in SOL" },
    ],
    about: "List one of the treasury's NFTs on Tensor for SOL (until it sells or a proposal delists it).",
    async build(c) {
      const t = await ctxOf(c, c.args[0]);
      const price = v.parseUnits(c.args[1], 9);
      if (price <= 0n) fail("List it for more than 0.");
      const owned = v.tokenAccount(new PublicKey(t.mint), c.d.treasury, (await c.network.connection.getAccountInfo(new PublicKey(t.mint))).owner);
      const balance = await c.network.connection.getTokenAccountBalance(owned).then((b) => BigInt(b.value.amount)).catch(() => 0n);
      if (balance !== 1n) fail("The treasury doesn't hold that NFT.");
      const ix = await tensor.getListLegacyInstructionAsync({
        owner: t.treasury,
        payer: t.treasury,
        mint: t.mint,
        amount: price,
        makerBroker: t.treasury.address,
        authorizationRules: t.ruleSet,
        tokenStandard: t.tokenStandard,
      });
      const rent = BigInt(await c.network.connection.getMinimumBalanceForRentExemption(400));
      return {
        instructions: [v.stored(fromKit(ix))],
        budget: [{ mint: v.SOL_ASSET, amount: rent }],
        summary: `list the NFT ${t.name} (\`${t.mint}\`) on Tensor for ${sol(price)}`,
      };
    },
  },

  "tensor-delist": {
    models: "all",
    args: [{ name: "<mint>", about: "the listed NFT's mint address" }],
    about: "Take one of the treasury's NFTs off Tensor (it returns to the treasury).",
    async build(c) {
      const t = await ctxOf(c, c.args[0]);
      const [listState] = await tensor.findListStatePda({ mint: t.mint });
      const l = await tensor.fetchMaybeListState(t.rpc, listState);
      if (!l.exists || l.data.owner !== t.treasury.address) fail("The treasury hasn't listed that NFT on Tensor.");
      const ix = await tensor.getDelistLegacyInstructionAsync({
        owner: t.treasury,
        payer: t.treasury,
        mint: t.mint,
        rentDestination: l.data.rentPayer ?? undefined,
        authorizationRules: t.ruleSet,
        tokenStandard: t.tokenStandard,
      });
      return {
        instructions: [v.stored(fromKit(ix))],
        budget: [],
        summary: `take the NFT ${t.name} (\`${t.mint}\`) off Tensor`,
      };
    },
  },
};

