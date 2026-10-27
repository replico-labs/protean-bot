import { SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import * as v from "../vortex.js";
import * as fill from "../fill.js";
import { quote } from "../jupiterApi.js";
import { fail, key, deployment } from "./common.js";

/**
 * Jupiter swaps, through Vortexes' fill program (src/solana/fill.js): the
 * proposal opens an order (the treasury's tokens for at least a minimum of
 * another token, by a deadline) and the bot's keeper
 * (src/solana/fillKeeper.js) fills it at the best route Jupiter finds once
 * that pays the minimum, sending all of the output to the treasury.
 * Nothing about the route is fixed in the proposal, so it can't go stale
 * while the vote runs; the minimum is the DAO's protection.
 *
 * The minimum is set from Jupiter's quote when the proposal is written,
 * less the slippage given. If the price falls below it the order waits;
 * past its deadline the keeper (or anyone) cancels it and the tokens go
 * back to the treasury. A proposal can cancel it sooner (jup-cancel).
 *
 * Offered where the network sets the fill program (network.fillProgram);
 * Jupiter routes on mainnet only.
 */

export const protocol = {
  id: "jupiter",
  name: "Jupiter",
  needsFillProgram: true,
  deployments: {
    "solana-mainnet": {
      // USDC's mint, as Phoenix's SDK pins it (rise-public rust/ix/src/constants.rs), for the `usdc` shortcut.
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  },
};

const DEFAULT_DAYS = 14;
// vortex-fill's Order account: discriminator + InitSpace (programs/fill/src/lib.rs).
const ORDER_SPACE = 8 + 32 + 8 + 32 + 32 + 8 + 8 + 8 + 32 + 32 + 9 + 3;

/** `sol`, `usdc` or a mint address -> { mint, decimals, programId, label }. SOL is swapped as wrapped SOL. */
async function token(c, word) {
  const dep = deployment(protocol, c.network);
  const w = String(word ?? "").toLowerCase();
  const mint = w === "sol" ? NATIVE_MINT : w === "usdc" ? dep.usdc : key(word, "the token's mint");
  const { decimals, programId } = await v.mintInfo(c.network, mint);
  return { mint, decimals, programId, isSol: mint.equals(NATIVE_MINT), label: w === "sol" ? "SOL" : w === "usdc" ? "USDC" : `of \`${mint.toBase58()}\`` };
}

function slippage(word) {
  const s = Number(String(word ?? "").replace(/%$/, ""));
  if (!Number.isFinite(s) || s < 0 || s > 50) fail("Give the slippage as a percentage from 0 to 50, e.g. 1 (how far below today's quote the DAO still accepts).");
  return s;
}

function days(word) {
  if (word === undefined) return DEFAULT_DAYS;
  const d = Number(word);
  if (!Number.isFinite(d) || d < 1 || d > 90) fail("Give the order's life in days, from 1 to 90 (counted from now, so it must outlast the vote).");
  return d;
}

const exists = async (c, account) => Boolean(await c.network.connection.getAccountInfo(account));

export const actions = {
  "jup-swap": {
    models: "all",
    args: [
      { name: "<from>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<to>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<amount>", about: "how much to sell, e.g. 100" },
      { name: "<slippage%>", about: "how far below today's quote the DAO accepts, e.g. 1" },
      { name: "[days]", about: `how long the order stays open, counted from now (default ${DEFAULT_DAYS})` },
    ],
    about: "Swap treasury tokens through Jupiter: the proposal opens an order for at least a minimum (today's quote less the slippage), which the bot fills at the best route once it pays that.",
    async build(c) {
      const from = await token(c, c.args[0]);
      const to = await token(c, c.args[1]);
      if (from.mint.equals(to.mint)) fail("Swap one token for another.");
      const amount = v.parseUnits(c.args[2], from.decimals);
      if (amount <= 0n) fail("Swap more than 0.");
      const pct = slippage(c.args[3]);
      const life = days(c.args[4]);
      const q = await quote(from.mint, to.mint, amount).catch((err) => fail(`Jupiter couldn't quote that swap (${err.message}).`));
      const quoted = BigInt(q.outAmount);
      const minOut = (quoted * BigInt(Math.round((100 - pct) * 100))) / 10_000n;
      if (minOut <= 0n) fail("At that size and slippage the minimum to receive rounds to 0. Swap more, or accept less slippage.");

      const treasury = c.d.treasury;
      const source = v.tokenAccount(from.mint, treasury, from.programId);
      const receive = v.tokenAccount(to.mint, treasury, to.programId);
      const ixs = [];
      if (from.isSol) {
        // The order takes wrapped SOL: wrap it first.
        if (!(await exists(c, source))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(treasury, source, treasury, NATIVE_MINT));
        ixs.push(SystemProgram.transfer({ fromPubkey: treasury, toPubkey: source, lamports: amount }), createSyncNativeInstruction(source));
      }
      if (!(await exists(c, receive))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(treasury, receive, treasury, to.mint, to.programId));
      const deadline = (await v.clusterNow(c.network)) + Math.round(life * 86_400);
      const id = fill.newOrderId();
      ixs.push(
        await fill.openOrderIx(c.network, { owner: treasury, id, mintIn: from.mint, mintOut: to.mint, tokenProgramIn: from.programId, tokenProgramOut: to.programId, source, receive, amount, minOut, deadline })
      );
      // The order and its two vaults' rent, back when it closes; plus any accounts opened here.
      const conn = c.network.connection;
      const tokenRent = BigInt(await v.tokenAccountRent(c.network));
      const rent = BigInt(await conn.getMinimumBalanceForRentExemption(ORDER_SPACE)) + 4n * tokenRent;
      const { order } = fill.orderAddresses(c.network, treasury, id);
      return {
        instructions: ixs.map(v.stored),
        budget: from.isSol ? [{ mint: v.SOL_ASSET, amount: amount + rent }] : [{ mint: from.mint, amount }, { mint: v.SOL_ASSET, amount: rent }],
        summary:
          `swap ${v.formatUnits(amount, from.decimals)} ${from.label} for at least ${v.formatUnits(minOut, to.decimals)} ${to.label} through Jupiter ` +
          `(today's quote ${v.formatUnits(quoted, to.decimals)}, less ${pct}%), open for ${life} days; order \`${order.toBase58()}\`` +
          (to.isSol ? " (received as wrapped SOL)" : ""),
      };
    },
  },

  "jup-cancel": {
    models: "all",
    args: [{ name: "<order>", about: "the order's address (from the jup-swap proposal)" }],
    about: "Cancel one of the treasury's open swap orders: its tokens go back to the treasury.",
    async build(c) {
      const orderKey = key(c.args[0], "the order");
      const o = await fill.readOrder(c.network, orderKey);
      if (!o) fail("That order isn't open (it filled, was cancelled, or never existed).");
      if (!o.owner.equals(c.d.treasury)) fail("That order isn't this DAO's.");
      const programs = { in: (await v.mintInfo(c.network, o.mintIn)).programId, out: (await v.mintInfo(c.network, o.mintOut)).programId };
      return {
        instructions: [v.stored(await fill.cancelIx(c.network, orderKey, o, c.d.treasury, programs))],
        budget: [],
        summary: `cancel swap order \`${orderKey.toBase58()}\` and take its tokens back`,
      };
    },
  },
};
