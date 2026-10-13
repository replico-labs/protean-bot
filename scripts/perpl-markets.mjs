#!/usr/bin/env node
/**
 * Lists every market on Perpl's exchange, straight from the contract, and
 * the token it takes as collateral - to fill in or re-check the market ids
 * in src/integrations/perpl.js.
 *
 *   node scripts/perpl-markets.mjs                 # Monad testnet
 *   node scripts/perpl-markets.mjs --network monad-mainnet
 *   node scripts/perpl-markets.mjs --max 4096      # scan further (default 2048)
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
const client = createPublicClient({ chain, transport: http(rpc, { retryCount: 4, retryDelay: 500 }) });
const abi = loadIntegrationAbi("perpl").exchange;
const exchange = d.exchange;
const read = (functionName, args) => client.readContract({ address: exchange, abi, functionName, args });

const info = await read("getExchangeInfo");
const collateral = info.collateralToken ?? info[4];
const [symbol, name, decimals] = await Promise.all(["symbol", "name", "decimals"].map((f) => client.readContract({ address: collateral, abi: erc20Abi, functionName: f }).catch(() => "?")));
console.log(`Perpl exchange on ${chain.name}: ${exchange}${(await read("isHalted")) ? "  (HALTED)" : ""}`);
console.log(`Collateral: ${collateral}  ${symbol} (${name}), ${decimals} decimals`);
console.log(`Pinned in the bot: ${d.collateral}${collateral.toLowerCase() === d.collateral.toLowerCase() ? "  ✓ same" : "  ✗ DIFFERENT - update perpl.js"}`);
console.log(`\nScanning market ids 0-${max}…`);

const found = [];
for (let start = 0; start <= max; start += 32) {
  const ids = Array.from({ length: Math.min(32, max - start + 1) }, (_, i) => start + i);
  const exists = await Promise.all(ids.map((id) => read("perpetualExists", [BigInt(id)]).catch(() => false)));
  for (const [i, ok] of exists.entries()) {
    if (!ok) continue;
    const p = await read("getPerpetualInfo", [BigInt(ids[i])]);
    found.push({ id: ids[i], symbol: p.symbol, name: p.name });
    console.log(`  id ${String(ids[i]).padStart(4)}  ${p.symbol.padEnd(6)} ${p.name}  (price decimals ${p.priceDecimals}, lot decimals ${p.lotDecimals})`);
  }
}
const pinned = Object.entries(d.markets).map(([s, id]) => `${s}: ${id}`).join(", ");
console.log(`\n${found.length} markets. For perpl.js markets: { ${found.map((m) => `${m.symbol}: ${m.id}`).join(", ")} }`);
console.log(`Pinned in the bot now: { ${pinned} }`);
