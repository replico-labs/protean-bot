import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { scaleBlockFields, currentNetwork, networkEnvName } from "../networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("LiquidGovernance");
const factoryAbi = loadAbi("LiquidDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for LiquidGovernance. Implements the same shared interface as
 * tokenWeighted.js/quadratic.js - see src/governance/index.js for the
 * registry these plug into. Voting weight here is raw getPastVotes,
 * same scale as the original model (confirmed directly from source,
 * not sqrt-transformed the way Quadratic's is) - so getProposal's
 * voteWeightUnit is "token" here, safe to format with formatEther.
 * Like Quadratic, this model has no castVoteWithReason equivalent, so
 * `reason` is silently ignored if supplied.
 */

export async function propose(client, governanceAddress, actions, metadataURI) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "propose",
    args: [actions, metadataURI],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId };
}

export async function vote(client, governanceAddress, proposalId, support, _reason) {
  // _reason intentionally unused - no equivalent entry point, matching
  // quadratic.js's handling of the same situation.
  const gov = contractFor(governanceAddress);
  const args = [BigInt(proposalId), support];

  // castVote returns the actual weight cast - see quadratic.js for the
  // full reasoning behind capturing this via simulateContract.
  const { result: weight } = await publicClient.simulateContract({
    ...gov,
    functionName: "castVote",
    args,
    account: client.account,
  });

  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "castVote", args });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, weight };
}

export async function queue(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "queueProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function execute(client, governanceAddress, proposalId, valueWhole = 0) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "executeProposal",
    args: [BigInt(proposalId)],
    value: parseEther(String(valueWhole)),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function cancel(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "cancelProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Read-only. No quorumVotes field, same situation as quadratic.js - the
 * contract doesn't expose a per-proposal quorum figure, so none is
 * fabricated here; state() (Succeeded vs Defeated) is still the
 * authoritative signal for whether quorum was met.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const [proposal, stateIndex, executableAfter] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "executableAfter", args: [BigInt(proposalId)] }),
  ]);

  return {
    ...proposal,
    stateIndex: Number(stateIndex),
    executableAfter,
    voteWeightUnit: "token", // raw getPastVotes, safe to formatEther
  };
}

/*//////////////////////////////////////////////////////////////
        MODEL-SPECIFIC EXTRAS - delegation, not part of the
        shared interface, since no other model has an equivalent
//////////////////////////////////////////////////////////////*/

/** Delegates the caller's voting power to `to`. */
export async function delegate(client, governanceAddress, to) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "delegate", args: [getAddress(to)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Removes the caller's current delegation, reverting to voting directly. */
export async function undelegate(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "undelegate", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Once a delegate has voted on a proposal, this resolves that vote for
 * one of their delegators too - callable by anyone, not just the
 * delegator themselves, matching the contract's own permissionless
 * design for this action.
 */
export async function resolveDelegatedVote(client, governanceAddress, proposalId, delegator) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "resolveDelegatedVote",
    args: [BigInt(proposalId), getAddress(delegator)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: everyone currently delegating directly to `account`. */
export async function getDirectDelegators(governanceAddress, account) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getDirectDelegators", args: [getAddress(account)] });
}

/*//////////////////////////////////////////////////////////////
                    DELEGATED VOTE RESOLUTION
//////////////////////////////////////////////////////////////*/

// LiquidGovernance.MAX_CHAIN_DEPTH: resolveDelegatedVote follows a
// delegator's chain at most this many hops to find a voter.
const MAX_CHAIN_DEPTH = 5;
const ACTIVE = 1; // ProposalState.Active
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * A delegate's vote only carries their own weight. Each delegator's weight
 * is added separately, by resolveDelegatedVote(proposalId, delegator) -
 * permissionless, and only while voting is open. These helpers find
 * everyone behind a voter and resolve them.
 */
export async function isProposalActive(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  try {
    return Number(await publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] })) === ACTIVE;
  } catch {
    return false;
  }
}

/** Open proposals among the most recent `lookback`. */
export async function activeProposalIds(governanceAddress, lookback = 25) {
  const gov = contractFor(governanceAddress);
  const count = Number(await publicClient.readContract({ ...gov, functionName: "proposalCount" }));
  const ids = [];
  for (let id = count; id >= 1 && id > count - lookback; id--) if (await isProposalActive(governanceAddress, id)) ids.push(id);
  return ids;
}

/** Everyone delegating to `root`, directly or through others, up to MAX_CHAIN_DEPTH hops - nearest first. */
export async function delegatorsBehind(governanceAddress, root) {
  const seen = new Set([getAddress(root)]);
  const found = [];
  let frontier = [getAddress(root)];
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const addr of frontier) {
      for (const d of await getDirectDelegators(governanceAddress, addr)) {
        const delegator = getAddress(d);
        if (seen.has(delegator)) continue; // delegation cycles are possible on-chain
        seen.add(delegator);
        next.push(delegator);
        found.push(delegator);
      }
    }
    frontier = next;
  }
  return found;
}

async function receipt(governanceAddress, proposalId, account) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getVoteReceipt", args: [BigInt(proposalId), getAddress(account)] });
}

const EXPECTED_SKIP = /AlreadyVoted|DelegateHasNotVoted|NotDelegated|ProposalNotActive/;

/**
 * Resolves the delegated votes of everyone behind `root` on `proposalId`
 * (and `root` itself with includeRoot, for someone who just delegated).
 * Skips anyone who has already voted or whose chain has no voter yet.
 * Returns { resolved, weight, failed }. `client` signs and pays - the
 * operator wallet for automatic sweeps.
 */
export async function resolveDelegationsBehind({ client, governanceAddress, proposalId, root, includeRoot = false }) {
  const result = { resolved: 0, weight: 0n, failed: 0 };
  if (!(await isProposalActive(governanceAddress, proposalId))) return result;
  const candidates = [...(includeRoot ? [getAddress(root)] : []), ...(await delegatorsBehind(governanceAddress, root))];
  for (const delegator of candidates) {
    if ((await receipt(governanceAddress, proposalId, delegator)).hasVoted) continue;
    const gov = contractFor(governanceAddress);
    const tip = await publicClient.readContract({ ...gov, functionName: "delegatedTo", args: [delegator] });
    if (getAddress(tip) === ZERO) continue;
    try {
      await resolveDelegatedVote(client, governanceAddress, proposalId, delegator);
      result.resolved++;
      result.weight += (await receipt(governanceAddress, proposalId, delegator)).weight;
    } catch (err) {
      const why = `${err.shortMessage || ""} ${err.message}`;
      if (!EXPECTED_SKIP.test(why)) {
        result.failed++;
        console.error(`[liquid] couldn't resolve ${delegator} on proposal ${proposalId}:`, err.shortMessage || err.message);
      }
    }
  }
  return result;
}

// Automatic sweeps share one queue per process, so the operator wallet
// never sends two resolutions at once (nonce clashes) and overlapping
// triggers for the same voter find the work already done.
let sweepQueue = Promise.resolve();
export function queueSweep(job) {
  const run = sweepQueue.then(job, job);
  sweepQueue = run.catch(() => {});
  return run;
}

/** Read-only: walks the delegation chain from `account` to its final tip. */
export async function delegateChainTip(governanceAddress, account) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "delegateChainTip", args: [getAddress(account)] });
}

// Same defaults as script/CreateLiquidDAO.s.sol, kept in sync deliberately.
const DEFAULT_CONFIG = {
  quorumBps: 1_000,
  approvalThresholdBps: 6_000,
  votingDelay: 1,
  votingPeriod: 50_400,
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
  proposalThreshold: 0n,
};

/** Creates a Liquid-governed DAO via the factory, using the bot's operator wallet - same convention as every other createDAO in this folder. */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.liquid;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "LIQUID_FACTORY_ADDRESS")} is not configured on this bot instance`);
  }

  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };

  const hash = await writeWithGasBuffer(walletClient, {
    ...factory,
    functionName: "createDAO",
    args: [name, symbol, parseEther(String(initialSupplyWhole)), parseEther(String(maxSupplyWhole)), scaleBlockFields("liquid", DEFAULT_CONFIG)],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const daoCount = await publicClient.readContract({ ...factory, functionName: "daoCount" });
  const [, , governanceToken, underlyingToken, governance, treasury] = await publicClient.readContract({
    ...factory,
    functionName: "daos",
    args: [daoCount],
  });

  return { hash, governance, governanceToken, underlyingToken, treasury };
}