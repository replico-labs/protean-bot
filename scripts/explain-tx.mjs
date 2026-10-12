#!/usr/bin/env node
/**
 * Explains transactions that were mined but reverted: which function they
 * called, in which block, and why they revert - replayed as a call at the
 * block before and at their own block, with the contract error decoded
 * from every ABI the bot knows. For a governance proposal it also prints
 * the proposal's voting window, so a vote outside it is obvious.
 *
 *   node scripts/explain-tx.mjs --network hyperevm-testnet 0xTX1 0xTX2 ...
 *
 * Uses the network's RPC from .env (e.g. HYPEREVM_TESTNET_RPC_URL).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createPublicClient, decodeErrorResult, decodeFunctionData, http } from "viem";
import { getNetwork } from "../src/networks.js";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const network = getNetwork(arg("network") ?? "monad-testnet");
const hashes = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{64}$/.test(a));
if (!hashes.length) {
  console.error("Usage: node scripts/explain-tx.mjs --network <id> 0xTX ...");
  process.exit(1);
}
// A plain client: no pinning, no retries hiding anything.
const client = createPublicClient({ chain: network.chain, transport: http(network.rpcUrl) });

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "abis");
const abis = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => {
    const json = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return { name: f.replace(/\.json$/, ""), abi: Array.isArray(json) ? json : json.abi ?? [] };
  });
const allErrors = [...new Map(abis.flatMap((a) => a.abi.filter((i) => i.type === "error")).map((e) => [`${e.name}(${e.inputs.map((i) => i.type)})`, e])).values()];
const show = (v) => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? `[${v.map(show).join(", ")}]` : String(v));

function decodeCall(data) {
  for (const { name, abi } of abis) {
    try {
      const { functionName, args } = decodeFunctionData({ abi, data });
      return { contract: name, functionName, args: args ?? [], abi };
    } catch {}
  }
  return null;
}

async function replay(tx, blockNumber) {
  try {
    await client.call({ account: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, blockNumber });
    return "succeeds";
  } catch (err) {
    const data = err.walk?.((e) => typeof e.data === "string" && e.data.startsWith("0x"))?.data;
    if (!data || data === "0x") return `reverts without a reason (${err.shortMessage ?? err.message})`.slice(0, 200);
    try {
      const { errorName, args } = decodeErrorResult({ abi: allErrors, data });
      return `reverts: ${errorName}(${(args ?? []).map(show).join(", ")})`;
    } catch {
      return `reverts with unknown error ${data.slice(0, 10)}`;
    }
  }
}

/** The proposal's own fields, for any governance read that takes the proposal id. */
async function proposalWindow(to, abi, id, blockNumber) {
  for (const fn of ["getProposal", "proposals"]) {
    if (!abi.some((i) => i.type === "function" && i.name === fn && i.inputs.length === 1)) continue;
    try {
      const p = await client.readContract({ address: to, abi, functionName: fn, args: [id], blockNumber });
      const fields = Object.entries(p).filter(([k]) => /block|start|end|snapshot|deadline|created|window|period/i.test(k));
      return fields.map(([k, v]) => `${k}=${show(v)}`).join("  ");
    } catch {}
  }
  return null;
}

for (const hash of hashes) {
  console.log(`\n== ${hash}`);
  try {
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    console.log(`   status ${receipt.status}, gas used ${receipt.gasUsed} of ${tx.gas}, block ${receipt.blockNumber} (time ${block.timestamp}, gas limit ${block.gasLimit})`);
    console.log(`   from ${tx.from} to ${tx.to}`);
    const call = decodeCall(tx.input);
    if (call) console.log(`   calls ${call.contract}.${call.functionName}(${call.args.map(show).join(", ")})`);
    console.log(`   replayed at block ${receipt.blockNumber - 1n}: ${await replay(tx, receipt.blockNumber - 1n)}`);
    console.log(`   replayed at block ${receipt.blockNumber}: ${await replay(tx, receipt.blockNumber)}`);
    const id = call?.args.find((a) => typeof a === "bigint");
    if (call && id !== undefined) {
      const window = await proposalWindow(tx.to, call.abi, id, receipt.blockNumber);
      if (window) console.log(`   proposal ${id}: ${window}`);
    }
  } catch (err) {
    console.log(`   could not read it: ${err.shortMessage ?? err.message}`);
  }
}
