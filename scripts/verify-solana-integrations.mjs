#!/usr/bin/env node
/**
 * Checks every address the Solana integrations pin (src/solana/integrations/*)
 * against the chain: programs must be deployed and executable, other
 * accounts must exist. The Solana counterpart of verify-integrations.js.
 *
 *   node scripts/verify-solana-integrations.mjs            # every cluster pinned
 *   node scripts/verify-solana-integrations.mjs mainnet    # one cluster
 *
 * RPC: SOLANA_MAINNET_RPC_URL / SOLANA_DEVNET_RPC_URL, else the public endpoints.
 */
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { PROTOCOLS } from "../src/solana/integrations/index.js";

const RPC = {
  "solana-mainnet": process.env.SOLANA_MAINNET_RPC_URL || clusterApiUrl("mainnet-beta"),
  "solana-devnet": process.env.SOLANA_DEVNET_RPC_URL || clusterApiUrl("devnet"),
};
const only = process.argv[2] ? `solana-${process.argv[2]}` : null;
// Fields holding a program (must be executable); the rest are accounts (must exist).
const PROGRAM_FIELDS = new Set(["program", "lending"]);

let failures = 0;
for (const { protocol } of PROTOCOLS) {
  for (const [cluster, dep] of Object.entries(protocol.deployments)) {
    if (only && cluster !== only) continue;
    const connection = new Connection(RPC[cluster], "confirmed");
    for (const [field, address] of Object.entries(dep)) {
      let line;
      try {
        const info = await connection.getAccountInfo(new PublicKey(address));
        const want = PROGRAM_FIELDS.has(field) ? "executable program" : "account";
        const ok = info && (!PROGRAM_FIELDS.has(field) || info.executable);
        line = `${ok ? "✓" : "✗"} ${protocol.name} ${cluster} ${field} ${address}${ok ? "" : ` - not a deployed ${want}`}`;
        if (!ok) failures++;
      } catch (err) {
        line = `✗ ${protocol.name} ${cluster} ${field} ${address} - ${err.message}`;
        failures++;
      }
      console.log(line);
      await new Promise((r) => setTimeout(r, 250)); // the public RPCs rate-limit
    }
  }
}
console.log(failures ? `\n${failures} address(es) failed.` : "\nEvery pinned address checks out.");
process.exit(failures ? 1 : 0);
