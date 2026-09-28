#!/usr/bin/env node
/**
 * Checks every external-protocol address the bot uses, on the real
 * networks: `npm run verify:integrations [network ...]`.
 *
 * For each protocol deployment (src/integrations/*.js):
 *   1. every address has contract code on that network;
 *   2. the protocol's own cross-references hold (e.g. PositionManager's
 *      poolManager() is the PoolManager we list) - `verifyLinks`.
 * Uses the same RPCs as the bot (RPC_URL, BASE_RPC_URL, ... or each
 * chain's public RPC). Nothing is sent; reads only.
 *
 * Run it before enabling a network, and again whenever an address in
 * src/integrations changes. Exit code 1 if anything fails.
 */
import "dotenv/config";
import { getAddress, isAddress } from "viem";
import { getNetwork, NETWORK_IDS, resolveNetworkId } from "../src/networks.js";
import { allIntegrationModules } from "../src/integrations/index.js";

const only = process.argv.slice(2).map((n) => resolveNetworkId(n) ?? n);
for (const n of only) if (!NETWORK_IDS.includes(n)) throw new Error(`Unknown network "${n}". Known: ${NETWORK_IDS.join(", ")}`);

const getter = (name, type = "address") => [{ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ type }] }];

let failures = 0;
let checked = 0;
const fail = (msg) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};

for (const mod of allIntegrationModules()) {
  for (const [networkId, deployment] of Object.entries(mod.protocol.deployments)) {
    if (only.length && !only.includes(networkId)) continue;
    const network = getNetwork(networkId);
    console.log(`\n${mod.protocol.name} on ${network.chain.name}${deployment.warning ? "  (⚠ " + deployment.warning + ")" : ""}`);
    const addresses = Object.fromEntries(Object.entries(deployment).filter(([, v]) => typeof v === "string" && isAddress(v, { strict: false })));

    for (const [label, raw] of Object.entries(addresses)) {
      const address = getAddress(raw);
      if ((deployment.noCode ?? []).includes(label)) {
        console.log(`  - ${label} ${address} is a system address (no code expected)`);
        continue;
      }
      try {
        const code = await network.publicClient.getCode({ address });
        checked++;
        if (!code || code === "0x") fail(`${label} ${address}: no contract code`);
        else console.log(`  ✓ ${label} ${address} has code`);
      } catch (err) {
        fail(`${label} ${address}: RPC error ${err.shortMessage || err.message}`);
      }
    }

    for (const [from, fn, expectLabel] of mod.verifyLinks ?? []) {
      if (!addresses[from] || !addresses[expectLabel]) continue;
      try {
        const got = await network.publicClient.readContract({ address: getAddress(addresses[from]), abi: getter(fn), functionName: fn });
        checked++;
        if (getAddress(got) !== getAddress(addresses[expectLabel])) fail(`${from}.${fn}() = ${got}, expected ${expectLabel} ${getAddress(addresses[expectLabel])}`);
        else console.log(`  ✓ ${from}.${fn}() is ${expectLabel}`);
      } catch (err) {
        fail(`${from}.${fn}(): ${err.shortMessage || err.message}`);
      }
    }

    for (const [from, fn, expected] of mod.verifyValues ?? []) {
      if (!addresses[from]) continue;
      try {
        const got = await network.publicClient.readContract({ address: getAddress(addresses[from]), abi: getter(fn, "string"), functionName: fn });
        checked++;
        if (got !== expected) fail(`${from}.${fn}() = "${got}", expected "${expected}"`);
        else console.log(`  ✓ ${from}.${fn}() is "${expected}"`);
      } catch (err) {
        fail(`${from}.${fn}(): ${err.shortMessage || err.message}`);
      }
    }

    if (mod.verify) {
      try {
        const problems = await mod.verify(network.publicClient, deployment);
        checked++;
        if (problems.length) problems.forEach((p) => fail(p));
        else console.log("  ✓ protocol-specific checks");
      } catch (err) {
        fail(`protocol-specific checks: ${err.shortMessage || err.message}`);
      }
    }
  }
}

console.log(`\n${checked} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
