import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { scaleBlockFields, currentNetwork, networkEnvName } from "../networks.js";
import { ensureAllowance } from "./common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("OptimisticGovernance");
const factoryAbi = loadAbi("OptimisticDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for OptimisticGovernance - the one model whose lifecycle is
 * genuinely different, not just differently-named. Every other adapter
 * in this system has a real queueProposal(); this contract has none at
 * all. Instead: a proposal passes by default once its challenge window
 * closes (finalizeUnchallenged), UNLESS someone posts a bond to
 * challenge it first, which opens a fallback vote whose result decides
 * everything (finalizeChallenge). castVote only works at all once a
 * proposal has been challenged - calling it before that correctly
 * reverts with the contract's own ProposalNotActive.
 *
 * Two deliberate design choices worth being explicit about:
 *
 * 1. queue() IS still exposed with the same shared signature as every
 *    other model, but it's "smart" underneath - it reads whether the
 *    proposal was challenged and calls the correct one of
 *    finalizeUnchallenged/finalizeChallenge automatically. This is safe
 *    to automate because neither path spends the caller's own funds or
 *    has any side effect beyond reading state that's already public.
 *
 * 2. vote() is NOT made smart the same way - it never auto-challenges a
 *    proposal on a caller's behalf before voting. Challenging spends the
 *    caller's own tokens as a bond; silently triggering that as a side
 *    effect of someone just trying to vote would be exactly the kind of
 *    hidden, consequential action this whole system has tried to avoid
 *    everywhere else. If a proposal hasn't been challenged yet, vote()
 *    surfaces the contract's real revert - the caller (or the bot's own
 *    command handler) decides explicitly whether to challenge() first.
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

/**
 * `reason` is accepted for shared-interface consistency but has no
 * equivalent here (no castVoteWithReason) - silently ignored, same as
 * quadratic.js/liquid.js. This will correctly revert if the proposal
 * hasn't been challenged yet - see the module-level note on why that's
 * surfaced honestly rather than auto-challenging behind the scenes.
 */
export async function vote(client, governanceAddress, proposalId, support, _reason) {
  const gov = contractFor(governanceAddress);
  const args = [BigInt(proposalId), support];

  // castVote returns the actual weight cast - see quadratic.js/liquid.js
  // for the full reasoning behind capturing this via simulateContract.
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

/**
 * Reads whether the proposal was challenged and calls the matching real
 * finalize function - see the module-level note for why this is safe to
 * automate (no caller funds spent, no side effect beyond what's already
 * publicly determined by on-chain state).
 */
export async function queue(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const proposal = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] });
  const functionName = proposal.challenged ? "finalizeChallenge" : "finalizeUnchallenged";

  const hash = await writeWithGasBuffer(client, { ...gov, functionName, args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, via: functionName };
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

// This model's ProposalState enum genuinely differs from every other
// model's at index 0 - ChallengeWindow, not Pending - confirmed directly
// from source, not assumed. Using the shared PROPOSAL_STATE_LABELS from
// common.js here would silently mislabel that one state, so this adapter
// keeps its own array instead.
const OPTIMISTIC_STATE_LABELS = [
  "ChallengeWindow",
  "Active", // challenged, fallback vote in progress
  "Succeeded",
  "Queued",
  "Defeated",
  "Executed",
  "Cancelled",
  "Expired",
];

/**
 * Read-only. Includes challenged/challenger/bondResolved directly from
 * the struct, since a caller (or the bot's display logic) genuinely
 * needs these to understand what's actually happening with a proposal
 * here - unlike other models, "state" alone doesn't tell the whole
 * story (e.g. Active here specifically means "challenged, vote open,"
 * not a generic active-proposal state).
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
    stateLabel: OPTIMISTIC_STATE_LABELS[Number(stateIndex)] ?? "Unknown",
    executableAfter,
    voteWeightUnit: "token", // raw getPastVotes, confirmed from source - safe to formatEther
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRA - no other model has an equivalent
//////////////////////////////////////////////////////////////*/

/**
 * Challenges a proposal within its challenge window, posting the
 * configured bond (pulled via transferFrom - the caller must have
 * approved the governance contract for at least config().challengeBond
 * beforehand). Opens the fallback vote. This is deliberately never
 * called automatically by vote() - see the module-level note.
 */
export async function challenge(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  // The contract pulls challengeBond via transferFrom - approve it first.
  const [token, config] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "governanceToken" }),
    publicClient.readContract({ ...gov, functionName: "config" }),
  ]);
  await ensureAllowance(client, token, governanceAddress, config.challengeBond);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "challenge", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

// Same defaults as script/CreateOptimisticDAO.s.sol, kept in sync
// deliberately. Note this config genuinely has no votingDelay at all -
// confirmed from the real struct - challengePeriod/challengeBond take
// its place conceptually.
const DEFAULT_CONFIG = {
  challengePeriod: 50_400,
  challengeBond: 100n * 10n ** 18n,
  quorumBps: 1_000,
  approvalThresholdBps: 6_000,
  votingPeriod: 50_400,
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
  proposalThreshold: 0n,
};

/** Creates an Optimistic-governed DAO via the factory, using the bot's operator wallet. */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.optimistic;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "OPTIMISTIC_FACTORY_ADDRESS")} is not configured on this bot instance`);
  }

  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };

  const hash = await writeWithGasBuffer(walletClient, {
    ...factory,
    functionName: "createDAO",
    args: [name, symbol, parseEther(String(initialSupplyWhole)), parseEther(String(maxSupplyWhole)), scaleBlockFields("optimistic", DEFAULT_CONFIG)],
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