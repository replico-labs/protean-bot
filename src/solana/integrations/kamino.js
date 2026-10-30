import { createRequire } from "module";
import { SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import * as v from "../vortex.js";
import { fail, key, deployment, requireProgram, requireOwned, fromKit } from "./common.js";

const require = createRequire(import.meta.url);
const klend = require("@kamino-finance/klend-sdk");
// The SDK is built on @solana/kit 2.x (its own copy); its RPC and signers come from that copy.
const kit = createRequire(require.resolve("@kamino-finance/klend-sdk"))("@solana/kit");

/**
 * Kamino Lend: the treasury lends a token in Kamino's main market for
 * interest, as collateral in its own obligation (a vanilla obligation owned
 * by the treasury), and withdraws it later.
 *
 * Kamino forbids being called through another program (CPI) for its
 * original deposit / withdraw instructions, which check that refresh
 * instructions sit right before them in the transaction. Its `_v2`
 * instructions don't make that check (programs/klend/src/utils/
 * refresh_ix_utils.rs; Kamino's klend-interface has a CPI example), so the
 * instructions come from Kamino's SDK (@kamino-finance/klend-sdk) with
 * useV2Ixs, and the proposal carries the refreshes before them, run by the
 * hub in the same order.
 *
 * The first deposit also sets up the treasury's user metadata, obligation
 * and the reserve's obligation farm (no lookup table: the treasury can't
 * sign a new one): about 10 instructions with SOL's wrapping, within a
 * proposal's 16 (vortex-core MAX_INSTRUCTIONS).
 *
 * The refreshes name the obligation's reserves when the proposal is
 * written; if another proposal adds a reserve to the obligation before this
 * one executes, this one fails and should be proposed again.
 *
 * Addresses: the program from Kamino's klend repo (lib.rs declare_id), the
 * main market from its klend-interface examples and the SDK's README.
 * Mainnet only (Kamino's repo builds a separate staging program).
 */

export const protocol = {
  id: "kamino",
  name: "Kamino Lend",
  // Refreshes, farms and (the first time) the obligation's setup: more than a legacy propose holds.
  needsV1Transactions: true,
  deployments: {
    "solana-mainnet": {
      program: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
      market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
      // USDC's mint, as Phoenix's SDK pins it (rise-public rust/ix/src/constants.rs), for the `usdc` shortcut.
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  },
};

const markets = new Map();

/** Kamino's main market with its reserves, loaded through the SDK. */
async function mainMarket(c) {
  const dep = deployment(protocol, c.network);
  if (klend.PROGRAM_ID !== dep.program.toBase58()) fail(`Kamino's SDK names program ${klend.PROGRAM_ID}, not the pinned ${dep.program.toBase58()} - refusing until that's re-checked.`);
  await requireProgram(c.network, dep.program, "Kamino Lend's program");
  await requireOwned(c.network, dep.market, dep.program, "Kamino's main market");
  const rpc = kit.createSolanaRpc(c.network.rpcUrl);
  if (!markets.has(c.network.id)) {
    const market = await klend.KaminoMarket.load(rpc, kit.address(dep.market.toBase58()), klend.DEFAULT_RECENT_SLOT_DURATION_MS);
    if (!market) fail("Kamino's main market couldn't be loaded.");
    markets.set(c.network.id, market);
  }
  const market = markets.get(c.network.id);
  await market.refreshAll();
  return { dep, rpc, market };
}

/** `sol`, `usdc` or a mint -> its token, and the market's variable-rate reserve for it. */
async function asset(c, m, word) {
  const w = String(word ?? "").toLowerCase();
  const mint = w === "sol" ? NATIVE_MINT : w === "usdc" ? m.dep.usdc : key(word, "the token's mint");
  const reserve = [...m.market.reserves.values()].find((r) => r.getLiquidityMint() === mint.toBase58() && r.getKind() instanceof klend.FloatRateReserveKind);
  if (!reserve) fail(`Kamino's main market has no reserve for ${w === "sol" || w === "usdc" ? w.toUpperCase() : `\`${mint.toBase58()}\``}.`);
  const { decimals, programId } = await v.mintInfo(c.network, mint);
  return { mint, decimals, programId, reserve, isSol: mint.equals(NATIVE_MINT), label: reserve.symbol || mint.toBase58() };
}

/** The treasury's obligation in the market, or the vanilla type that makes the SDK create it. */
async function obligationOf(c, m) {
  const type = new klend.VanillaObligation(kit.address(klend.PROGRAM_ID));
  const pda = await type.toPda(m.market.getAddress(), kit.address(c.d.treasury.toBase58()));
  return (await m.market.getObligationByAddress(pda)) ?? type;
}

/** A KaminoAction's instructions in order, minus compute budget (the transaction sets it) and the SDK's ATA creation (done here). */
function actionIxs(action) {
  return [...action.setupIxs, ...action.inBetweenIxs, ...action.lendingIxs, ...action.postLendingIxs, ...action.cleanupIxs].map(fromKit);
}

/** Instructions a proposal of this model holds (vortex-core MAX_INSTRUCTIONS, less conviction's 2 budget steps). */
const proposalLimit = (model) => (model === "conviction" ? 14 : 16);

/** The SDK's action for `kind` (deposit or withdraw) of `raw` (or all) of asset `a`. */
async function kaminoAction(c, m, kind, a, obligation, amount) {
  const props = {
    kaminoMarket: m.market,
    amount,
    reserveAddress: a.reserve.address,
    owner: kit.createNoopSigner(kit.address(c.d.treasury.toBase58())),
    obligation,
    useV2Ixs: true,
    scopeRefreshConfig: undefined,
    includeAtaIxs: false,
    requestElevationGroup: false,
    initUserMetadata: { skipInitialization: false, skipLutCreation: true },
    currentLedgerInstant: await klend.getCurrentLedgerInstant(m.rpc),
  };
  return kind === "deposit" ? klend.KaminoAction.buildDepositTxns(props) : klend.KaminoAction.buildWithdrawTxns(props);
}

async function build(c, kind, words) {
  const m = await mainMarket(c);
  const a = await asset(c, m, words[0]);
  const obligation = await obligationOf(c, m);
  const all = kind === "withdraw" && String(words[1]).toLowerCase() === "all";
  const raw = all ? null : v.parseUnits(words[1], a.decimals);
  if (raw !== null && raw <= 0n) fail(`${kind === "deposit" ? "Lend" : "Withdraw"} more than 0.`);
  if (kind === "withdraw" && obligation instanceof klend.VanillaObligation) fail("The treasury has nothing lent on Kamino.");
  const action = await kaminoAction(c, m, kind, a, obligation, all ? klend.U64_MAX : raw.toString());
  const own = v.tokenAccount(a.mint, c.d.treasury, a.programId);
  const ixs = [createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, own, c.d.treasury, a.mint, a.programId)];
  if (kind === "deposit" && a.isSol) ixs.push(SystemProgram.transfer({ fromPubkey: c.d.treasury, toPubkey: own, lamports: raw }), createSyncNativeInstruction(own));
  ixs.push(...actionIxs(action));
  if (a.isSol) ixs.push(createCloseAccountInstruction(own, c.d.treasury, c.d.treasury));
  if (ixs.length > proposalLimit(c.model)) fail(`This ${kind} needs ${ixs.length} instructions (refreshing every reserve the treasury's Kamino account uses), more than one proposal holds (${proposalLimit(c.model)}).`);
  return { a, raw, all, ixs };
}

export const actions = {
  "kamino-deposit": {
    models: "all",
    args: [
      { name: "<asset>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<amount>", about: "how much to lend, e.g. 500" },
    ],
    about: "Lend a token from the treasury in Kamino's main market for interest (held as collateral in the treasury's own obligation; nothing is borrowed).",
    async build(c) {
      const { a, raw, ixs } = await build(c, "deposit", c.args);
      // Rent for the user metadata and obligation the first time, and the wrapped-SOL account in between.
      const rent = BigInt(await c.network.connection.getMinimumBalanceForRentExemption(4_000));
      return {
        instructions: ixs.map(v.stored),
        budget: a.isSol ? [{ mint: v.SOL_ASSET, amount: raw + rent }] : [{ mint: a.mint, amount: raw }, { mint: v.SOL_ASSET, amount: rent }],
        summary: `lend ${v.formatUnits(raw, a.decimals)} ${a.label} in Kamino's main market`,
      };
    },
  },

  "kamino-withdraw": {
    models: "all",
    args: [
      { name: "<asset>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<amount|all>", about: "how much to take back, or `all`" },
    ],
    about: "Withdraw a token the treasury lent in Kamino's main market, with its interest.",
    async build(c) {
      const { a, raw, all, ixs } = await build(c, "withdraw", c.args);
      return {
        instructions: ixs.map(v.stored),
        budget: [],
        summary: all ? `withdraw everything the treasury lent on Kamino in ${a.label}, with interest` : `withdraw ${v.formatUnits(raw, a.decimals)} ${a.label} from Kamino`,
      };
    },
  },
};
