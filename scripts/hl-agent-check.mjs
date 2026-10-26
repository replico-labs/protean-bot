#!/usr/bin/env node
/**
 * Can a Hyperliquid API ("agent") wallet move its principal's funds?
 *
 * The trading desk's promise is that an appointed trader can trade but never
 * withdraw. On Perpl that's enforced by Perpl's contract. On HyperCore the
 * desk would be an API wallet, and Hyperliquid's API has an
 * `agentSendAsset` action ("transfer tokens on behalf of the principal via
 * an agent wallet"), which may break that promise. Its limits aren't
 * documented anywhere this bot could check, so this script finds out on
 * TESTNET:
 *
 *   1. the principal approves a fresh API wallet,
 *   2. the API wallet tries agentSendAsset, usdSend and withdraw3 to a
 *      stranger's address (1 USDC each) - and places a tiny order to show
 *      trading works,
 *   3. sub-accounts: the principal makes one and moves 2 USDC in; the API
 *      wallet tries to trade it (vaultAddress) and to move its funds out,
 *   4. the principal approves a second fresh API wallet under the same name
 *      (how the bot replaces or removes a trader) and the first one tries to
 *      trade again, while the second one can,
 *   5. the principal revokes the name (approveAgent with the zero address)
 *      and the second API wallet tries to trade again.
 *
 *   HL_TESTNET_KEY=0x... node scripts/hl-agent-check.mjs
 *
 * HL_TESTNET_KEY is a throwaway testnet wallet holding a few testnet USDC on
 * Hyperliquid (app.hyperliquid-testnet.xyz faucet). Never use a mainnet key.
 * It prints what each step returned; nothing here touches mainnet.
 */
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Wallets often export the key without its 0x.
const key = process.env.HL_TESTNET_KEY && (process.env.HL_TESTNET_KEY.startsWith("0x") ? process.env.HL_TESTNET_KEY : `0x${process.env.HL_TESTNET_KEY}`);
if (!key) {
  console.error("Set HL_TESTNET_KEY to a throwaway Hyperliquid TESTNET wallet's private key (with a few testnet USDC).");
  process.exit(1);
}
const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });
const principal = privateKeyToAccount(key);
const agent = privateKeyToAccount(generatePrivateKey());
const replacement = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const NAME = "protean-check";
// User-signed actions (approveAgent, usdSend, withdraw3) are EIP-712 with a chain id; testnet's is Arbitrum Sepolia's.
const signatureChainId = "0x66eee";
const asPrincipal = new ExchangeClient({ transport, wallet: principal, signatureChainId });
const asAgent = new ExchangeClient({ transport, wallet: agent, signatureChainId });
const asReplacement = new ExchangeClient({ transport, wallet: replacement, signatureChainId });

async function attempt(label, fn) {
  try {
    const res = await fn();
    console.log(`  ${label}: SUCCEEDED ${JSON.stringify(res).slice(0, 300)}`);
    return true;
  } catch (err) {
    console.log(`  ${label}: refused - ${String(err.message ?? err).slice(0, 300)}`);
    return false;
  }
}

const usdc = (await info.spotMeta()).tokens.find((t) => t.name === "USDC");
const token = `USDC:${usdc.tokenId}`;
const balance = async (user) => {
  const s = await info.clearinghouseState({ user });
  return Number(s.marginSummary.accountValue);
};
console.log(`Principal ${principal.address}: ${await balance(principal.address)} USDC in perps`);
console.log(`API wallet ${agent.address}, stranger ${stranger}\n`);

console.log("1. Principal approves the API wallet");
await attempt("approveAgent", () => asPrincipal.approveAgent({ agentAddress: agent.address, agentName: NAME }));
const role = await info.userRole({ user: agent.address });
console.log(`  userRole(API wallet): ${JSON.stringify(role)}\n`);

console.log("2. The API wallet tries to move the principal's funds to a stranger");
const moved = [
  await attempt("agentSendAsset (perp -> stranger)", () => asAgent.agentSendAsset({ destination: stranger, sourceDex: "", destinationDex: "", token, amount: "1" })),
  await attempt("usdSend", () => asAgent.usdSend({ destination: stranger, amount: "1" })),
  await attempt("withdraw3", () => asAgent.withdraw3({ destination: stranger, amount: "2" })),
];
console.log(`  stranger now holds: ${await balance(stranger)} USDC in perps`);

console.log("\n   ...and trades (a far-off limit order, cancelled straight after)");
const meta = await info.meta();
const btc = meta.universe.findIndex((a) => a.name === "BTC");
const mids = await info.allMids();
const lowPx = String(Math.round(Number(mids.BTC) * 0.5));
let oid;
await attempt("order", async () => {
  const r = await asAgent.order({ orders: [{ a: btc, b: true, p: lowPx, s: "0.001", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" });
  oid = r.response.data.statuses[0].resting?.oid;
  return r;
});
if (oid) await attempt("cancel", () => asAgent.cancel({ cancels: [{ a: btc, o: oid }] }));

const farOrder = { orders: [{ a: btc, b: true, p: lowPx, s: "0.001", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" };
const restingOid = (r) => r.response.data.statuses[0].resting?.oid;

console.log("\n3. Sub-accounts: the principal makes one and moves 2 USDC in");
let sub;
await attempt("createSubAccount", async () => {
  const r = await asPrincipal.createSubAccount({ name: `pchk${Date.now() % 1e8}` });
  sub = r.response.data;
  return r;
});
let subTrades = false;
let subMoved = false;
if (!sub) {
  console.log("  (no sub-account - testnet may want some trading volume first; skipping this step)");
} else {
  await attempt("subAccountTransfer in (principal)", () => asPrincipal.subAccountTransfer({ subAccountUser: sub, isDeposit: true, usd: 2_000_000 }));
  console.log(`  sub-account ${sub}: ${await balance(sub)} USDC`);
  console.log("  The API wallet, approved by the principal only:");
  let subOid;
  subTrades = await attempt("order on the sub-account (vaultAddress)", async () => {
    const r = await asAgent.order(farOrder, { vaultAddress: sub });
    subOid = restingOid(r);
    return r;
  });
  if (subOid) await attempt("cancel", () => asAgent.cancel({ cancels: [{ a: btc, o: subOid }] }, { vaultAddress: sub }));
  // usdSend and withdraw3 are signed by the account itself and take no sub-account, so subAccountTransfer is the route to try.
  subMoved = await attempt("subAccountTransfer out (sub -> principal)", () => asAgent.subAccountTransfer({ subAccountUser: sub, isDeposit: false, usd: 1_000_000 }));
  console.log(`  sub-account now: ${await balance(sub)} USDC`);
  await attempt("subAccountTransfer back (principal)", async () => {
    const left = Math.floor((await balance(sub)) * 1e6);
    return left >= 1 ? asPrincipal.subAccountTransfer({ subAccountUser: sub, isDeposit: false, usd: left }) : "nothing left";
  });
}

console.log("\n4. Principal approves a new API wallet under the same name (how the bot replaces a trader)");
await attempt("approveAgent(replacement, same name)", () => asPrincipal.approveAgent({ agentAddress: replacement.address, agentName: NAME }));
console.log(`  extraAgents(principal): ${JSON.stringify(await info.extraAgents({ user: principal.address }))}`);
console.log(`  userRole(first API wallet): ${JSON.stringify(await info.userRole({ user: agent.address }))}`);
let oldOid;
const oldStillTrades = await attempt("order by the first API wallet", async () => {
  const r = await asAgent.order(farOrder);
  oldOid = restingOid(r);
  return r;
});
if (oldOid) await attempt("cancel (principal)", () => asPrincipal.cancel({ cancels: [{ a: btc, o: oldOid }] }));
let newOid;
const newTrades = await attempt("order by the replacement", async () => {
  const r = await asReplacement.order(farOrder);
  newOid = restingOid(r);
  return r;
});
if (newOid) await attempt("cancel", () => asReplacement.cancel({ cancels: [{ a: btc, o: newOid }] }));

console.log("\n5. Principal revokes the name (zero address, same name)");
await attempt("approveAgent(0x0)", () => asPrincipal.approveAgent({ agentAddress: "0x0000000000000000000000000000000000000000", agentName: NAME }));
console.log(`  userRole(replacement): ${JSON.stringify(await info.userRole({ user: replacement.address }))}`);
const stillTrades = await attempt("order by the replacement after revoking", () => asReplacement.order(farOrder));

console.log("\nVerdict:");
console.log(moved.some(Boolean) ? "  ✗ An API wallet CAN move the principal's funds - a HyperCore desk can't promise the trader never withdraws." : "  ✓ The API wallet couldn't move funds by any of the three routes.");
if (sub) {
  console.log(subTrades ? "  • The principal's API wallet CAN trade its sub-accounts (vaultAddress): one agent reaches every sub-account." : "  • The principal's API wallet can't trade its sub-accounts: each would need its own agent.");
  console.log(subMoved ? "  ✗ The API wallet CAN move a sub-account's funds." : "  ✓ The API wallet couldn't move a sub-account's funds.");
}
console.log(oldStillTrades ? "  ✗ Approving a new API wallet under the same name did NOT cut off the old one - the bot's replace/remove doesn't work." : "  ✓ Approving a new API wallet under the same name cuts off the old one.");
console.log(newTrades ? "  ✓ The replacement trades." : "  ✗ The replacement couldn't trade.");
console.log(stillTrades ? "  ✗ Revoking with the zero address did NOT stop the API wallet." : "  ✓ Revoking with the zero address stops the API wallet.");
