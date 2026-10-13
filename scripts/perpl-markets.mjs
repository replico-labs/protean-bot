#!/usr/bin/env node
/**
 * Lists every market on Perpl's exchange, straight from the contract, and
 * the token it takes as collateral - to fill in or re-check the market ids
 * in src/integrations/perpl.js.
 *
 *   node scripts/perpl-markets.mjs                 # Monad testnet
 *   node scripts/perpl-markets.mjs --network monad-mainnet
 *   node scripts/perpl-markets.mjs --max 4096      # scan further (default 2048)
 *   node scripts/perpl-markets.mjs --rps 4         # slower, for a stricter RPC (default 8/s)
 *   node scripts/perpl-markets.mjs --address 0xTREASURY   # can this address trade? (no market scan)
 *
 * Uses the network's RPC from .env (RPC_URL for Monad testnet,
 * MONAD_MAINNET_RPC_URL for mainnet) or the public one.
 */
import "dotenv/config";
import { createPublicClient, http, erc20Abi } from "viem";
import { monadTestnet, monad } from "viem/chains";
import { loadIntegrationAbi } from "../src/integrations/abis/index.js";
import { protocol } from "../src/integrations/perpl.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const networkId = arg("network", "monad-testnet");
const max = Number(arg("max", 2048));
const chain = { "monad-testnet": monadTestnet, "monad-mainnet": monad }[networkId];
const d = protocol.deployments[networkId];
if (!chain || !d) throw new Error(`Perpl isn't set up for ${networkId}; use monad-testnet or monad-mainnet.`);
const rpc = (networkId === "monad-testnet" ? process.env.RPC_URL : process.env.MONAD_MAINNET_RPC_URL) || chain.rpcUrls.default.http[0];
const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 6, retryDelay: 1500 }) });
const abi = loadIntegrationAbi("perpl").exchange;
const exchange = d.exchange;
// Public RPCs cap requests (Monad testnet: 15/s) - stay well under: one
// request at a time, at most --rps a second (default 8).
const rps = Number(arg("rps", 8));
let last = 0;
async function read(functionName, args) {
  const wait = last + 1000 / rps - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  return client.readContract({ address: exchange, abi, functionName, args });
}

const info = await read("getExchangeInfo");
const collateral = info.collateralToken ?? info[4];
const [symbol, name, decimals] = await Promise.all(["symbol", "name", "decimals"].map((f) => client.readContract({ address: collateral, abi: erc20Abi, functionName: f }).catch(() => "?")));
console.log(`Perpl exchange on ${chain.name}: ${exchange}${(await read("isHalted")) ? "  (HALTED)" : ""}`);
console.log(`Collateral: ${collateral}  ${symbol} (${name}), ${decimals} decimals`);
console.log(`Pinned in the bot: ${d.collateral}${collateral.toLowerCase() === d.collateral.toLowerCase() ? "  ✓ same" : "  ✗ DIFFERENT - update perpl.js"}`);
// --address: whitelist and account status of one address (e.g. a DAO's treasury), then stop.
const who = arg("address");
if (who) {
  const enabled = await read("whitelistingEnabled");
  const listed = enabled ? await read("whitelisted", [who]) : true;
  const account = await read("getAccountByAddr", [who]).catch(() => null);
  console.log(`\nAddress ${who}`);
  console.log(`  Whitelisting on the exchange: ${enabled ? "ON - only listed addresses can open an account" : "OFF - anyone can trade, nothing to do"}`);
  if (enabled) console.log(`  This address: ${listed ? "✓ whitelisted" : "✗ NOT whitelisted - ask Perpl to whitelist it"}`);
  console.log(`  Perpl account: ${account && account.accountId > 0n ? `#${account.accountId}, ${Number(account.balanceCNS) / 10 ** Number(decimals)} ${symbol} free` : "none yet (the first perpl-deposit opens it)"}`);
  console.log(`  Minimum first deposit: ${Number(await read("getMinAccountOpenCNS")) / 10 ** Number(decimals)} ${symbol}`);
  process.exit(0);
}

console.log(`\nScanning market ids 0-${max} at ${rps} requests a second (~${Math.ceil(max / rps / 60)} min)…`);

const found = [];
for (let id = 0; id <= max; id++) {
  if (id % 256 === 0) console.log(`  …checking ${id}-${Math.min(id + 255, max)}`);
  // Past the exchange's highest possible id, perpetualExists reverts
  // instead of returning false (testnet: from 1021) - that's the end.
  let exists;
  try {
    exists = await read("perpetualExists", [BigInt(id)]);
  } catch (err) {
    if (!/reverted/i.test(err.shortMessage ?? err.message)) throw err;
    console.log(`  (the exchange takes no ids from ${id} up - done)`);
    break;
  }
  if (!exists) continue;
  const p = await read("getPerpetualInfo", [BigInt(id)]);
  found.push({ id, symbol: p.symbol, name: p.name });
  console.log(`  id ${String(id).padStart(4)}  ${p.symbol.padEnd(6)} ${p.name}  (price decimals ${p.priceDecimals}, lot decimals ${p.lotDecimals})`);
}
const pinned = Object.entries(d.markets).map(([s, id]) => `${s}: ${id}`).join(", ");
console.log(`\n${found.length} markets. For perpl.js markets: { ${found.map((m) => `${m.symbol}: ${m.id}`).join(", ")} }`);
console.log(`Pinned in the bot now: { ${pinned} }`);
