import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { decodeErrorResult, parseEventLogs, isAddressEqual } from "viem";

/**
 * A public client whose waitForTransactionReceipt throws when the
 * transaction was mined but reverted. A reverted transaction still has a
 * receipt, so without this every caller that only waits for one would
 * report success for a call that did nothing. The error says why it
 * reverted where it can: the transaction is replayed as a call at its own
 * block and the contract's error decoded (VotingClosed, AlreadyVoted...).
 */
export function failOnRevert(client) {
  const wait = client.waitForTransactionReceipt;
  return client.extend(() => ({
    async waitForTransactionReceipt(args) {
      const receipt = await wait(args);
      if (receipt.status === "reverted") {
        const reason = await revertReason(client, receipt).catch(() => null);
        const err = new Error(`The transaction was mined but reverted${reason ? `: ${reason}` : ""} (tx ${receipt.transactionHash}, gas used ${receipt.gasUsed}).`);
        err.shortMessage = err.message;
        err.receipt = receipt;
        throw err;
      }
      return receipt;
    },
  }));
}

// Every custom error in the contracts the bot talks to, for decoding replays.
let knownErrors;
function errorAbi() {
  if (knownErrors) return knownErrors;
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "abis");
  const seen = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      for (const item of Array.isArray(json) ? json : json.abi ?? []) {
        if (item.type === "error") seen.set(`${item.name}(${item.inputs.map((i) => i.type).join(",")})`, item);
      }
    } catch {}
  }
  return (knownErrors = [...seen.values()]);
}

/** Why a mined transaction reverted, from replaying it at its block - or null if that can't be told. */
async function revertReason(client, receipt) {
  const tx = await client.getTransaction({ hash: receipt.transactionHash });
  try {
    await client.call({ account: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas, blockNumber: receipt.blockNumber });
  } catch (err) {
    const data = err.walk?.((e) => typeof e.data === "string" && e.data.startsWith("0x"))?.data;
    if (!data || data === "0x") return /out of gas/i.test(err.message) ? "out of gas" : null;
    try {
      const { errorName, args } = decodeErrorResult({ abi: errorAbi(), data });
      const shown = (args ?? []).map((a) => (typeof a === "bigint" ? a.toString() : String(a)));
      return `${errorName}(${shown.join(", ")})`;
    } catch {
      return `error data ${data.slice(0, 10)}`;
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What a node says when asked for a block it doesn't have yet.
const NOT_YET = /header not found|unknown block|block not found|not (yet )?available|after last accepted|future block|block .* not found|invalid block|out ?of ?range|block height is \d+ but requested|requested block|beyond (the )?(current|latest)|greater than (the )?(current|latest)/i;

/**
 * Reads that never go back in time. Some public RPCs (Base Sepolia's) are a
 * pool of nodes, and the request after a mined transaction can land on a
 * node a block or two behind: the new DAO "doesn't exist", a payment
 * "didn't arrive". So plain "latest" reads - calls, balances, simulations,
 * gas estimates - are pinned to a block number: the newest block known
 * (refreshed every few seconds, so time keeps moving for things like
 * conviction), and never earlier than the block after this process's own
 * last mined transaction - the block a new transaction would land in, so a
 * simulation sees what the transaction will (a vote can't count stake "at"
 * a block that hasn't finished). A node that hasn't reached the block
 * answers "unknown block", and the read is retried until one has.
 */
export function monotonicReads(client) {
  let head = 0n; // newest block number known
  let afterWrite = 0n; // block after our last mined transaction
  const note = (n) => {
    if (typeof n === "bigint" && n > head) head = n;
    return n;
  };
  // viem's own actions stay bound to the client they were built on, so each
  // read that matters is wrapped here directly, not just the low-level call.
  const PINNED = ["call", "readContract", "simulateContract", "multicall", "getBalance", "estimateGas", "estimateContractGas", "createAccessList"];
  const original = Object.fromEntries([...PINNED, "getBlockNumber", "getBlock", "waitForTransactionReceipt"].map((k) => [k, client[k]]));

  async function pinned(fn, args = {}) {
    if (afterWrite === 0n || args.blockNumber !== undefined || (args.blockTag && args.blockTag !== "latest")) return fn(args);
    // viem caches the block number for a few seconds, so this is cheap.
    note(await original.getBlockNumber().catch(() => head));
    const at = head > afterWrite ? head : afterWrite;
    const { blockTag, ...rest } = args;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        return await fn({ ...rest, blockNumber: at });
      } catch (err) {
        if (!NOT_YET.test(`${err.shortMessage ?? ""} ${err.details ?? ""} ${err.message}`)) throw err;
        await sleep(300 + attempt * 100);
      }
    }
    return fn(args);
  }

  return client.extend(() => ({
    ...Object.fromEntries(PINNED.map((k) => [k, (args) => pinned(original[k], args)])),
    getBlockNumber: async (args) => note(await original.getBlockNumber(args)),
    getBlock: async (args) => {
      const block = await original.getBlock(args);
      note(block?.number);
      return block;
    },
    waitForTransactionReceipt: async (args) => {
      const receipt = await original.waitForTransactionReceipt(args);
      note(receipt.blockNumber);
      if (receipt.blockNumber + 1n > afterWrite) afterWrite = receipt.blockNumber + 1n;
      return receipt;
    },
  }));
}

/**
 * The id a factory gave the DAO created in this receipt, from its own
 * DAOCreated event - not the factory's newest DAO, which is someone else's
 * when two DAOs are created in the same block.
 */
export function createdDaoId(receipt, factory) {
  const [created] = parseEventLogs({ abi: factory.abi, eventName: "DAOCreated", logs: receipt.logs }).filter((log) => isAddressEqual(log.address, factory.address));
  if (!created) throw new Error(`No DAOCreated event from ${factory.address} in tx ${receipt.transactionHash}`);
  return created.args.daoId;
}
