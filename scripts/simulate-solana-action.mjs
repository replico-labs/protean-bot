#!/usr/bin/env node
/**
 * Checks a Solana protocol action's instructions against the live
 * programs, without a DAO or any funds: builds the action (as
 * /proposeaction would) with a stand-in account as the treasury, then
 * simulates those instructions on the cluster with signature checks off.
 *
 *   node scripts/simulate-solana-action.mjs <mainnet|devnet> <stand-in address> <action> [args...]
 *   node scripts/simulate-solana-action.mjs mainnet 5eosrve6LktMZgVNszYzebgmmC7BjLK8NoWyRQtcmGTF jito-stake 1
 *
 * The stand-in must be a funded system account holding whatever the action
 * spends (it signs in the simulation where the treasury would). This proves
 * the instructions are right for the protocol; the hub's CPI is covered by
 * the local tests. RPC: SOLANA_MAINNET_RPC_URL / SOLANA_DEVNET_RPC_URL, else
 * the public endpoints.
 */
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, clusterApiUrl } from "@solana/web3.js";
import { PROTOCOLS } from "../src/solana/integrations/index.js";
import { legacySize, unsignedV1, LEGACY_TRANSACTION_SIZE_LIMIT } from "../src/solana/v1.js";

// Every protocol's actions, including ones held back from /proposeaction until v1 transactions.
const INTEGRATION_ACTIONS = Object.assign({}, ...PROTOCOLS.map((p) => p.actions));

const [cluster, standIn, actionId, ...args] = process.argv.slice(2);
const CLUSTERS = {
  mainnet: { id: "solana-mainnet", name: "Solana", rpc: process.env.SOLANA_MAINNET_RPC_URL || clusterApiUrl("mainnet-beta") },
  devnet: { id: "solana-devnet", name: "Solana devnet", rpc: process.env.SOLANA_DEVNET_RPC_URL || clusterApiUrl("devnet") },
};
const def = CLUSTERS[cluster];
const action = INTEGRATION_ACTIONS[actionId];
if (!def || !standIn || !action) {
  console.error(`Usage: simulate-solana-action.mjs <mainnet|devnet> <stand-in address> <action> [args...]\nActions: ${Object.keys(INTEGRATION_ACTIONS).join(", ")}`);
  process.exit(2);
}
const network = { id: def.id, name: def.name, rpcUrl: def.rpc, envPrefix: def.id === "solana-mainnet" ? "SOLANA_MAINNET" : "SOLANA_DEVNET", v1Transactions: true, connection: new Connection(def.rpc, "confirmed") };
const treasury = new PublicKey(standIn);

let built;
try {
  built = await action.build({ network, d: { treasury }, model: "tokenWeighted", governance: {}, link: {}, args });
} catch (err) {
  console.error(err.userFacing ? `Refused: ${err.message}` : err);
  process.exit(1);
}
console.log(`Summary: ${built.summary}`);
const instructions = built.instructions.map((ix) => ({
  programId: ix.programId,
  keys: ix.accounts.map((a) => ({ pubkey: a.pubkey, isSigner: a.isSigner, isWritable: a.isWritable })),
  data: ix.data,
}));
const accounts = new Set(instructions.flatMap((ix) => [ix.programId.toBase58(), ...ix.keys.map((k) => k.pubkey.toBase58())]));
console.log(`${instructions.length} instruction(s), ${accounts.size} distinct accounts`);
// How much of a propose transaction the stored instructions take: a token-weighted propose carries
// 7 accounts and ~361 bytes besides the instructions and the description, under the 1,232-byte limit.
const storedBytes = 4 + built.instructions.reduce((n, ix) => n + 36 + 34 * ix.accounts.length + 4 + ix.data.length, 0);
const room = 1232 - 361 - storedBytes;
console.log(`Stored in a proposal: ${storedBytes} bytes; ${room >= 0 ? `fits a legacy propose with a description up to ${room} characters` : `too big for a legacy propose by ${-room} bytes (needs v1 transactions)`}`);

let sim;
if (legacySize([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...instructions], treasury) <= LEGACY_TRANSACTION_SIZE_LIMIT) {
  const { blockhash } = await network.connection.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...instructions] }).compileToLegacyMessage();
  const tx = new VersionedTransaction(message);
  console.log(`Transaction size: ${tx.serialize().length} bytes (legacy)`);
  sim = await network.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
} else {
  // Too big for legacy: simulate it as a v1 transaction, as the bot would send it.
  const wire = unsignedV1(instructions, treasury, { computeUnits: 1_400_000 });
  console.log(`Transaction size: ${Buffer.from(wire, "base64").length} bytes (v1; legacy holds 1232)`);
  sim = await network.connection._rpcRequest("simulateTransaction", [wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }]);
  if (sim.error) throw new Error(`simulateTransaction: ${JSON.stringify(sim.error)}`);
  sim = sim.result;
}
for (const line of sim.value.logs ?? []) console.log(`  ${line}`);
if (sim.value.err) {
  console.log(`✗ Simulation failed: ${JSON.stringify(sim.value.err)}`);
  process.exit(1);
}
console.log(`✓ Simulation succeeded (${sim.value.unitsConsumed} compute units)`);
