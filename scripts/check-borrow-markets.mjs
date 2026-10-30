#!/usr/bin/env node
/**
 * Where the hub test's borrowing steps can run on mainnet now, on both
 * lending platforms. Read-only: it sends nothing.
 *
 * Kamino: each market Kamino's API lists (api.kamino.finance/v2/
 * kamino-market), with whether borrowing is on (the market's
 * borrow_disabled) and its SOL and USDC reserves (variable-rate ones):
 * status (active, obsolete, hidden), SOL's loan-to-value (0 means it can't
 * back a loan), and USDC's borrow limit and what's left to borrow.
 *
 * Jupiter Lend: each of its SDK's borrowing markets (main, ethena,
 * galaxy), with the vaults taking SOL as collateral and how full the
 * borrowed token's pool is (a pool at its utilization cap lends nothing).
 *
 *   SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com node scripts/check-borrow-markets.mjs
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
const list = await (await fetch("https://api.kamino.finance/v2/kamino-market")).json();
console.log(`Kamino: ${list.length} markets from its API; reading each from mainnet...\n`);

const good = [];
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
  const reserves = accounts.map((a) => ({ address: a.pubkey.toBase58(), state: klend.Reserve.decode(a.account.data) }));
  // Variable-rate reserves of a token, best status first (the bot takes the first that isn't obsolete).
  const of = (mint) =>
    reserves
      .filter((r) => r.state.liquidity.mintPubkey.toString() === mint && r.state.config.debtTermSeconds.isZero() && r.state.config.debtMaturityTimestamp.isZero())
      .sort((x, y) => x.state.config.status - y.state.config.status);
  const sol = of(SOL).find((r) => r.state.config.status !== 1);
  const usdc = of(USDC).find((r) => r.state.config.status !== 1);
  const borrowOn = market.borrowDisabled === 0;
  const solLine = sol ? `SOL ${STATUS[sol.state.config.status]}, loan-to-value ${sol.state.config.loanToValuePct}%` : `SOL ${of(SOL).length ? "obsolete only" : "none"}`;
  const left = usdc ? BigInt(usdc.state.liquidity.totalAvailableAmount.toString()) : 0n;
  const usdcLine = usdc ? `USDC ${STATUS[usdc.state.config.status]}, borrow limit ${usdc.state.config.borrowLimit.toString() === "0" ? "0 (no borrowing)" : "set"}, ${(Number(left) / 1e6).toLocaleString("en-US")} USDC left to borrow` : `USDC ${of(USDC).length ? "obsolete only" : "none"}`;
  console.log(`${entry.name} (${entry.lendingMarket})\n  borrowing ${borrowOn ? "on" : "OFF"}; ${solLine}; ${usdcLine}`);
  const ok = borrowOn && sol && sol.state.config.status === 0 && sol.state.config.loanToValuePct > 0 && usdc && usdc.state.config.status === 0 && usdc.state.config.borrowLimit.toString() !== "0" && left >= 20_000_000n;
  if (ok) good.push(entry);
  await sleep(250);
}

console.log(good.length ? `\nKamino markets that fit the hub test (SOL collateral, borrowing 20 USDC):\n${good.map((e) => `  ${e.name}: HUB_TEST_KAMINO_MARKET=${e.lendingMarket}`).join("\n")}` : "\nNo Kamino market fits the hub test right now.");

// ---- Jupiter Lend ----
console.log("\nJupiter Lend: vaults taking SOL as collateral, by market...\n");
const open = [];
for (const mk of ["main", "ethena", "galaxy"]) {
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
console.log(open.length ? `\nJupiter Lend borrows against SOL that are open:\n${open.map(({ mk, debt }) => `  HUB_TEST_JUPLEND_MARKET=${mk} HUB_TEST_JUPLEND_BORROW=${debt === USDC ? "usdc" : debt}${debt === SOL ? "  (SOL against SOL: not for the hub test)" : ""}`).join("\n")}` : "\nNo Jupiter Lend borrow against SOL is open right now.");
