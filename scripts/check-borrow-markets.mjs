#!/usr/bin/env node
/**
 * Where the hub test's borrowing steps can run on mainnet now, on both
 * lending platforms. Read-only: it sends nothing.
 *
 * Kamino: each market Kamino's API lists (api.kamino.finance/v2/
 * kamino-market), with whether borrowing is on (the market's
 * borrow_disabled), whether its USDC reserve lends 20 USDC (active, with a
 * borrow limit outside elevation groups and that much left), and if so
 * the tokens that back a loan there as collateral (active, loan-to-value
 * above 0, usable outside an elevation group, room under the deposit
 * limit), with an amount worth enough to borrow 20 USDC.
 *
 * Jupiter Lend: each of its SDK's borrowing markets (main, ethena,
 * galaxy), with the vaults taking SOL as collateral and how full the
 * borrowed token's pool is (a pool at its utilization cap lends nothing).
 *
 *   SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com node scripts/check-borrow-markets.mjs
 *
 * CHECK_ONLY=kamino (or juplend) checks just that one.
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { Connection, PublicKey } from "@solana/web3.js";
import { getVaultsProgram, getLiquidityProgram, isDexVault } from "@jup-ag/lend/borrow";
import { borrowPda } from "@jup-ag/lend";

const require = createRequire(import.meta.url);
const klend = require("@kamino-finance/klend-sdk");

const RPC = process.env.SOLANA_MAINNET_RPC_URL;
if (!RPC) {
  console.error("Set SOLANA_MAINNET_RPC_URL to a mainnet RPC.");
  process.exit(2);
}
const PROGRAM = new PublicKey(klend.PROGRAM_ID);
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STATUS = ["active", "obsolete", "hidden"];
const conn = new Connection(RPC, "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const name = (mint) => (mint === SOL ? "SOL" : mint === USDC ? "USDC" : mint);

// ---- Kamino ----
const ONLY = process.env.CHECK_ONLY; // kamino or juplend: just that platform
const SF = 2n ** 60n; // Kamino's scaled fractions
const symbol = (r) => Buffer.from(r.state.config.tokenInfo.name).toString("utf8").replace(/\0.*$/s, "") || r.state.liquidity.mintPubkey.toString();
const good = [];
if (ONLY !== "juplend") {
  const list = await (await fetch("https://api.kamino.finance/v2/kamino-market")).json();
  console.log(`Kamino: ${list.length} markets from its API; reading each from mainnet...\n`);
  for (const entry of list) {
    const address = new PublicKey(entry.lendingMarket);
    const marketInfo = await conn.getAccountInfo(address);
    if (!marketInfo || !marketInfo.owner.equals(PROGRAM)) {
      console.log(`${entry.name}: not a Kamino account on mainnet, skipped`);
      continue;
    }
    const market = klend.LendingMarket.decode(marketInfo.data);
    const accounts = await conn.getProgramAccounts(PROGRAM, {
      filters: [{ dataSize: klend.Reserve.layout.span + 8 }, { memcmp: { offset: 32, bytes: address.toBase58() } }],
    });
    // Variable-rate reserves that aren't obsolete, best status first (the bot takes the first for a token).
    const reserves = accounts
      .map((a) => ({ address: a.pubkey.toBase58(), state: klend.Reserve.decode(a.account.data) }))
      .filter((r) => r.state.config.debtTermSeconds.isZero() && r.state.config.debtMaturityTimestamp.isZero() && r.state.config.status !== 1)
      .sort((x, y) => x.state.config.status - y.state.config.status);
    const usdc = reserves.find((r) => r.state.liquidity.mintPubkey.toString() === USDC);
    const borrowOn = market.borrowDisabled === 0;
    const left = usdc ? BigInt(usdc.state.liquidity.totalAvailableAmount.toString()) : 0n;
    const usdcOpen = borrowOn && usdc && usdc.state.config.status === 0 && !usdc.state.config.borrowLimit.isZero() && BigInt(usdc.state.config.borrowLimitOutsideElevationGroup.toString()) >= 20_000_000n && left >= 20_000_000n;
    console.log(`${entry.name} (${entry.lendingMarket})\n  borrowing ${borrowOn ? "on" : "OFF"}; ${usdc ? `USDC ${STATUS[usdc.state.config.status]}, ${(Number(left) / 1e6).toLocaleString("en-US")} left to borrow${usdc.state.config.borrowLimitOutsideElevationGroup.isZero() ? ", only inside an elevation group" : ""}` : "no USDC"}${usdcOpen ? "" : " - can't borrow 20 USDC"}`);
    if (usdcOpen) {
      // Collateral that backs a USDC loan outside an elevation group: active, loan-to-value above 0, room under its deposit limit.
      for (const r of reserves) {
        const c = r.state.config;
        const mint = r.state.liquidity.mintPubkey.toString();
        if (mint === USDC || c.status !== 0 || c.loanToValuePct === 0 || c.disableUsageAsCollOutsideEmode !== 0) continue;
        const decimals = Number(r.state.liquidity.mintDecimals.toString());
        const price = Number((BigInt(r.state.liquidity.marketPriceSf.toString()) * 1_000_000n) / SF) / 1e6;
        if (!(price > 0)) continue;
        // Enough to borrow 20 USDC with room: $60 of borrowing power.
        const usd = Math.ceil(60 / (c.loanToValuePct / 100));
        const amount = Number((usd / price).toPrecision(3));
        const supplied = BigInt(r.state.liquidity.totalAvailableAmount.toString()) + BigInt(r.state.liquidity.borrowedAmountSf.toString()) / SF;
        const room = BigInt(c.depositLimit.toString()) - supplied;
        if (room < BigInt(Math.ceil(amount * 10 ** decimals))) continue;
        console.log(`    collateral ${symbol(r)} (${mint}): loan-to-value ${c.loanToValuePct}%, $${price.toPrecision(4)} each`);
        good.push({ entry, mint, sym: symbol(r), amount });
      }
    }
    await sleep(400);
  }
  console.log(good.length ? `\nKamino settings that fit the hub test (borrowing 20 USDC):\n${good.map((g) => `  ${g.entry.name}, ${g.sym}: HUB_TEST_KAMINO_MARKET=${g.entry.lendingMarket} HUB_TEST_KAMINO_COLLATERAL=${g.mint === SOL ? "sol" : g.mint} HUB_TEST_KAMINO_COLLATERAL_AMOUNT=${g.amount}`).join("\n")}` : "\nNo Kamino market fits the hub test right now.");
}

// ---- Jupiter Lend ----
const open = [];
if (ONLY !== "kamino") console.log("\nJupiter Lend: vaults taking SOL as collateral, by market...\n");
for (const mk of ONLY === "kamino" ? [] : ["main", "ethena", "galaxy"]) {
  let configs;
  try {
    configs = await getVaultsProgram({ connection: conn, signer: PublicKey.default, market: mk }).account.vaultConfig.all();
  } catch (err) {
    console.log(`${mk}: couldn't read its vaults (${err.message})`);
    continue;
  }
  const liquidity = getLiquidityProgram({ connection: conn, signer: PublicKey.default, market: mk });
  const sol = configs.filter(({ account: c }) => !isDexVault(Number(c.vaultType)) && c.supplyToken.toBase58() === SOL);
  console.log(`${mk} market: ${configs.length} vaults, ${sol.length} with SOL as collateral`);
  for (const { account: c } of sol) {
    const debt = c.borrowToken.toBase58();
    const reserve = await liquidity.account.tokenReserve.fetchNullable(borrowPda.getLiquidityReserve(c.borrowToken, mk)).catch(() => null);
    const full = !reserve || reserve.lastUtilization >= reserve.maxUtilization;
    console.log(`  vault ${c.vaultId}: borrow ${name(debt)}; its pool ${reserve ? `${reserve.lastUtilization / 100}% used of ${reserve.maxUtilization / 100}%` : "not found"}${full ? " - FULL" : ""}`);
    if (!full) open.push({ mk, debt });
    await sleep(250);
  }
}
if (ONLY !== "kamino") console.log(open.length ? `\nJupiter Lend borrows against SOL that are open:\n${open.map(({ mk, debt }) => `  HUB_TEST_JUPLEND_MARKET=${mk} HUB_TEST_JUPLEND_BORROW=${debt === USDC ? "usdc" : debt}${debt === SOL ? "  (SOL against SOL: not for the hub test)" : ""}`).join("\n")}` : "\nNo Jupiter Lend borrow against SOL is open right now.");
