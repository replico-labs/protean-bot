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
 *   3. the principal revokes it (approveAgent with the zero address and the
 *      same name) and the API wallet tries to trade again.
 *
 *   HL_TESTNET_KEY=0x... node scripts/hl-agent-check.mjs
 *
 * HL_TESTNET_KEY is a throwaway testnet wallet holding a few testnet USDC on
 * Hyperliquid (app.hyperliquid-testnet.xyz faucet). Never use a mainnet key.
 * It prints what each step returned; nothing here touches mainnet.
 */
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const key = process.env.HL_TESTNET_KEY;
if (!key) {
  console.error("Set HL_TESTNET_KEY to a throwaway Hyperliquid TESTNET wallet's private key (with a few testnet USDC).");
  process.exit(1);
}
const transport = new HttpTransport({ isTestnet: true });
const info = new InfoClient({ transport });
const principal = privateKeyToAccount(key);
const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey()).address;
const NAME = "protean-check";
// User-signed actions (approveAgent, usdSend, withdraw3) are EIP-712 with a chain id; testnet's is Arbitrum Sepolia's.
const signatureChainId = "0x66eee";
const asPrincipal = new ExchangeClient({ transport, wallet: principal, signatureChainId });
const asAgent = new ExchangeClient({ transport, wallet: agent, signatureChainId });

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

console.log("\n3. Principal revokes the API wallet (zero address, same name)");
await attempt("approveAgent(0x0)", () => asPrincipal.approveAgent({ agentAddress: "0x0000000000000000000000000000000000000000", agentName: NAME }));
console.log(`  userRole(API wallet): ${JSON.stringify(await info.userRole({ user: agent.address }))}`);
const stillTrades = await attempt("order after revoking", () =>
  asAgent.order({ orders: [{ a: btc, b: true, p: lowPx, s: "0.001", r: false, t: { limit: { tif: "Gtc" } } }], grouping: "na" })
);

console.log("\nVerdict:");
console.log(moved.some(Boolean) ? "  ✗ An API wallet CAN move the principal's funds - a HyperCore desk can't promise the trader never withdraws." : "  ✓ The API wallet couldn't move funds by any of the three routes.");
console.log(stillTrades ? "  ✗ Revoking with the zero address did NOT stop the API wallet." : "  ✓ Revoking with the zero address stops the API wallet.");
