import { createRequire } from "module";
import anchor from "@coral-xyz/anchor";
import * as v from "../vortex.js";
import { fail, key, deployment, requireProgram } from "./common.js";

// The SDK's ES module build doesn't load under Node (a dependency imports a named export from Anchor's CommonJS
// build), so it's loaded as CommonJS.
const pump = createRequire(import.meta.url)("@pump-fun/pump-sdk");
const { BN } = anchor;

/**
 * Pump.fun: the treasury buys and sells a coin on its bonding curve.
 *
 * Built with Pump's own SDK (@pump-fun/pump-sdk: buyInstructions,
 * sellInstructions), SOL-quoted, with the treasury as the trader. A buy
 * names the SOL to spend; the SDK sizes the tokens at today's curve and
 * caps the SOL cost at the slippage given, and a sell names the tokens and
 * a minimum SOL out the same way. A proposal executes days later, so the
 * slippage is the protection: if the curve has moved further than that, the
 * trade fails at execution rather than filling at a worse price.
 *
 * Not here: creating a coin (it needs a new mint keypair to sign, which a
 * proposal can't), coins priced in another token, and coins that have
 * finished their curve and trade on Pump's AMM.
 */

export const protocol = {
  id: "pumpfun",
  name: "Pump.fun",
  deployments: {
    "solana-mainnet": {
      // Pump's bonding-curve program, as its SDK pins it (PUMP_PROGRAM_ID) and its docs list it.
      program: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    },
  },
};

const SOL_DECIMALS = 9;
const SOL_QUOTE = "11111111111111111111111111111111"; // a SOL-quoted curve stores the zero key

function slippage(word) {
  const s = Number(String(word ?? "").replace(/%$/, ""));
  if (!Number.isFinite(s) || s <= 0 || s > 50) fail("Give the slippage as a percentage from 0 to 50, e.g. 5 (the most the price may move against the trade by execution).");
  return s;
}

/** The coin's curve and what a trade needs, refusing anything this integration doesn't trade. */
async function curve(c, mintWord, side) {
  const dep = deployment(protocol, c.network);
  if (!pump.PUMP_PROGRAM_ID.equals(dep.program)) fail("Pump's SDK names a different program than the one pinned - refusing until that's re-verified.");
  await requireProgram(c.network, dep.program, "Pump.fun's program");
  const mint = key(mintWord, "the coin's mint");
  const info = await c.network.connection.getAccountInfo(mint);
  if (!info) fail(`\`${mint.toBase58()}\` isn't a token on ${c.network.name}.`);
  const tokenProgram = info.owner;
  const sdk = new pump.OnlinePumpSdk(c.network.connection);
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig().catch(() => null)]);
  const state = await (side === "buy" ? sdk.fetchBuyState(mint, c.d.treasury, tokenProgram) : sdk.fetchSellState(mint, c.d.treasury, tokenProgram)).catch(() => null);
  if (!state) fail(`\`${mint.toBase58()}\` isn't a Pump.fun coin.`);
  if (state.bondingCurve.complete) fail("That coin has finished its bonding curve and trades on Pump's AMM, which isn't supported here yet.");
  if (state.bondingCurve.quoteMint && state.bondingCurve.quoteMint.toBase58() !== SOL_QUOTE) fail("That coin is priced in another token, not SOL; only SOL-priced coins are supported.");
  const { decimals } = await v.mintInfo(c.network, mint);
  const supply = (await c.network.connection.getTokenSupply(mint)).value.amount;
  return { mint, tokenProgram, sdk, global, feeConfig, state, decimals, mintSupply: new BN(supply) };
}

export const actions = {
  "pumpfun-buy": {
    models: "all",
    args: [
      { name: "<mint>", about: "the coin's mint address" },
      { name: "<SOL>", about: "SOL to spend, e.g. 0.5" },
      { name: "<slippage%>", about: "the most the price may rise by execution, e.g. 5" },
    ],
    about: "Buy a Pump.fun coin on its bonding curve with SOL from the treasury.",
    async build(c) {
      let k = await curve(c, c.args[0], "buy");
      // With the treasury's coin account already open the buy carries one instruction, small enough for a legacy
      // propose; /proposeaction opens it first (c.openTokenAccount, paid by the operator).
      if (!k.state.associatedUserAccountInfo && c.openTokenAccount) {
        await c.openTokenAccount(k.mint, k.tokenProgram);
        k = await curve(c, c.args[0], "buy");
      }
      const lamports = v.parseUnits(c.args[1], SOL_DECIMALS);
      if (lamports <= 0n) fail("Spend more than 0 SOL.");
      const pct = slippage(c.args[2]);
      const solAmount = new BN(lamports.toString());
      const amount = pump.getBuyTokenAmountFromSolAmount({ global: k.global, feeConfig: k.feeConfig, mintSupply: k.mintSupply, bondingCurve: k.state.bondingCurve, amount: solAmount, quoteMint: k.state.quoteMint });
      if (amount.isZero()) fail("That buys no tokens at today's price.");
      const ixs = await pump.PUMP_SDK.buyInstructions({ global: k.global, bondingCurveAccountInfo: k.state.bondingCurveAccountInfo, bondingCurve: k.state.bondingCurve, associatedUserAccountInfo: k.state.associatedUserAccountInfo, mint: k.mint, user: c.d.treasury, amount, solAmount, slippage: pct, tokenProgram: k.tokenProgram });
      const tokens = BigInt(amount.toString());
      return {
        instructions: ixs.map(v.stored),
        budget: [{ mint: v.SOL_ASSET, amount: (lamports * BigInt(Math.round((100 + pct) * 100))) / 10_000n + BigInt(await v.tokenAccountRent(c.network)) }],
        summary: `buy about ${v.formatUnits(tokens, k.decimals)} of Pump.fun coin \`${k.mint.toBase58()}\` for ${v.formatUnits(lamports, SOL_DECIMALS)} SOL (up to ${pct}% more if the price rises by execution, else it fails)`,
      };
    },
  },

  "pumpfun-sell": {
    models: "all",
    args: [
      { name: "<mint>", about: "the coin's mint address" },
      { name: "<amount|all>", about: "tokens to sell, or `all` (the treasury's holding now)" },
      { name: "<slippage%>", about: "the most the price may fall by execution, e.g. 5" },
    ],
    about: "Sell a Pump.fun coin the treasury holds back to its bonding curve for SOL.",
    async build(c) {
      const k = await curve(c, c.args[0], "sell");
      const ata = v.tokenAccount(k.mint, c.d.treasury, k.tokenProgram);
      const held = await c.network.connection.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
      const tokens = String(c.args[1]).toLowerCase() === "all" ? held : v.parseUnits(c.args[1], k.decimals);
      if (tokens <= 0n) fail(held ? "Sell more than 0." : "The treasury holds none of that coin.");
      if (tokens > held) fail(`The treasury holds ${v.formatUnits(held, k.decimals)} of that coin.`);
      const pct = slippage(c.args[2]);
      const amount = new BN(tokens.toString());
      const solAmount = pump.getSellSolAmountFromTokenAmount({ global: k.global, feeConfig: k.feeConfig, mintSupply: k.mintSupply, bondingCurve: k.state.bondingCurve, amount });
      const ixs = await pump.PUMP_SDK.sellInstructions({ global: k.global, bondingCurveAccountInfo: k.state.bondingCurveAccountInfo, bondingCurve: k.state.bondingCurve, mint: k.mint, user: c.d.treasury, amount, solAmount, slippage: pct, tokenProgram: k.tokenProgram, mayhemMode: k.state.bondingCurve.isMayhemMode, cashback: k.state.bondingCurve.isCashbackCoin });
      return {
        instructions: ixs.map(v.stored),
        budget: [{ mint: k.mint, amount: tokens }],
        summary: `sell ${v.formatUnits(tokens, k.decimals)} of Pump.fun coin \`${k.mint.toBase58()}\` for about ${v.formatUnits(BigInt(solAmount.toString()), SOL_DECIMALS)} SOL (at least ${100 - pct}% of that, else it fails)`,
      };
    },
  },
};
