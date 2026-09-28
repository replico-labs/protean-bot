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

const abi = loadAbi("DelegateGovernance");
const factoryAbi = loadAbi("DelegateDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for DelegateGovernance - the biggest one in this system so
 * far. Three genuinely separate mechanisms live on this one contract:
 *
 * 1. Council proposals - the shared propose/vote/queue/execute/cancel
 *    interface, mapped onto this contract's *CouncilAction/*CouncilVote
 *    function names. Restricted to council members only, confirmed
 *    directly from source (onlyCouncilMember on both proposeCouncilAction
 *    and castCouncilVote) - a non-council caller gets a real on-chain
 *    revert here, not a bot-side check.
 *
 * 2. Elections - open to every token holder, not just the council.
 *    declareCandidacy/voteInElection/finalizeElection have no equivalent
 *    in any other model, so they're exposed as extras outside the shared
 *    interface.
 *
 * 3. Recall - also open to every token holder, a separate token-weighted
 *    vote to remove a sitting council member early. Also extras.
 *
 * IMPORTANT vote-weight distinction: council proposal votes
 * (forVotes/against/abstain on getProposal) are a plain uint16 headcount
 * of council members - NOT a token amount and NOT sqrt-weighted, a third
 * category distinct from every other adapter's voteWeightUnit. Election
 * votes and recall votes ARE real token-weighted amounts (confirmed from
 * source: getPastVotes for elections, uint256 totals for recall) - do
 * not conflate these three different vote-weight scales living on the
 * same contract.
 */

export async function propose(client, governanceAddress, actions, metadataURI) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "proposeCouncilAction",
    args: [actions, metadataURI],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId };
}

/**
 * `reason` is accepted for shared-interface consistency but has no
 * equivalent here - silently ignored. Only council members can actually
 * call this - a non-council caller gets a real on-chain revert.
 */
export async function vote(client, governanceAddress, proposalId, support, _reason) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "castCouncilVote",
    args: [BigInt(proposalId), support],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function queue(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "queueCouncilProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

export async function execute(client, governanceAddress, proposalId, valueWhole = 0) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "executeCouncilProposal",
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
    functionName: "cancelCouncilProposal",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Read-only. voteWeightUnit is "councilVoteCount" here, not "token" or
 * "sqrtWeight" - forVotes/against/abstain are a plain headcount of
 * council members (max value bounded by councilSize), never safe to
 * formatEther. Display these as plain integers, e.g. "3 of 5 council
 * members voted For."
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
    voteWeightUnit: "councilVoteCount",
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - elections, open to every token holder
//////////////////////////////////////////////////////////////*/

/** Opens a new election - only callable once the current term has ended. */
export async function startElection(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "startElection", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });

  const electionCount = await publicClient.readContract({ ...gov, functionName: "electionCount" });
  return { hash, electionId: electionCount };
}

/** Declares the caller's candidacy in an open election's candidacy window. */
export async function declareCandidacy(client, governanceAddress, electionId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "declareCandidacy", args: [BigInt(electionId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Votes for up to councilSize distinct candidates in an election, using
 * real token-weighted voting power (getPastVotes at the election's own
 * snapshot block - different snapshot from any council proposal's).
 */
const VOTES_TOKEN_ABI = [
  { type: "function", name: "getPastVotes", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
];

/**
 * voteInElection uses the identical snapshot-based getPastVotes pattern
 * as tokenWeighted's castVote - if the caller's tokens were staked
 * after the election's own snapshotBlock, the transaction still
 * succeeds, marks _hasVotedInElection permanently true (blocking any
 * retry), and adds zero to every selected candidate's tally. Since the
 * election's snapshotBlock is already fixed and public the moment the
 * election opens, this is fully checkable in advance - read here first
 * so the bot can warn before spending gas on a vote that would count
 * for nothing.
 */
export async function voteInElection(client, governanceAddress, electionId, candidateAddresses) {
  const gov = contractFor(governanceAddress);

  const election = await getElection(governanceAddress, electionId);
  const governanceTokenAddress = await publicClient.readContract({ ...gov, functionName: "governanceToken" });
  const weight = await publicClient.readContract({
    address: governanceTokenAddress,
    abi: VOTES_TOKEN_ABI,
    functionName: "getPastVotes",
    args: [client.account.address, election.snapshotBlock],
  });

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "voteInElection",
    args: [BigInt(electionId), candidateAddresses.map((s) => getAddress(s.toLowerCase()))],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, weight };
}

/** Finalizes a closed election - top vote-getters become the new council. */
export async function finalizeElection(client, governanceAddress, electionId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeElection", args: [BigInt(electionId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: full details of one election. */
export async function getElection(governanceAddress, electionId) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getElection", args: [BigInt(electionId)] });
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - recall, open to every token holder
//////////////////////////////////////////////////////////////*/

/** Starts a recall vote against a sitting council member. */
export async function initiateRecall(client, governanceAddress, delegateAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "initiateRecall",
    args: [getAddress(delegateAddress)],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const recallCount = await publicClient.readContract({ ...gov, functionName: "recallCount" });
  return { hash, recallId: recallCount };
}

/**
 * Votes on a recall - real token-weighted voting, same VoteType
 * enum (For/Against/Abstain) as everything else.
 */
export async function voteRecall(client, governanceAddress, recallId, support) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "voteRecall",
    args: [BigInt(recallId), support],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Finalizes a closed recall vote - removes the delegate if it passed. */
export async function finalizeRecall(client, governanceAddress, recallId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeRecall", args: [BigInt(recallId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: full details of one recall vote. */
export async function getRecall(governanceAddress, recallId) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getRecall", args: [BigInt(recallId)] });
}

/** Read-only: the current council roster. */
export async function getCouncil(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getCouncil", args: [] });
}

// Same defaults as script/CreateDelegateDAO.s.sol, kept in sync
// deliberately. councilSize is NOT here - it's derived automatically
// from initialCouncil's length below, same reasoning as the Solidity
// script: a separately-entered number could drift out of sync with the
// actual list, so there's nothing to keep in sync by construction.
const DEFAULT_CONFIG_WITHOUT_COUNCIL_SIZE = {
  termLength: 60n * 60n,
  candidacyThreshold: 0n,
  candidacyPeriod: 50_400,
  electionVotingPeriod: 50_400,
  councilApprovalThresholdBps: 6_000,
  votingDelay: 1,
  votingPeriod: 50_400,
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
  recallQuorumBps: 1_000,
  recallApprovalThresholdBps: 6_000,
  recallVotingPeriod: 50_400,
};

/**
 * Creates a Delegate-governed DAO via the factory, using the bot's
 * operator wallet. `initialCouncil` is required - there's no sensible
 * default for who the starting council actually is. councilSize and
 * councilQuorum (majority, rounded up) are both derived from its length
 * automatically, matching CreateDelegateDAO.s.sol's own approach.
 */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole, initialCouncil) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.delegate;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "DELEGATE_FACTORY_ADDRESS")} is not configured on this bot instance`);
  }
  if (!initialCouncil || initialCouncil.length === 0) {
    throw new Error("initialCouncil is required - at least one address must be supplied");
  }

  const councilSize = initialCouncil.length;
  const config = {
    ...scaleBlockFields("delegate", DEFAULT_CONFIG_WITHOUT_COUNCIL_SIZE),
    councilSize,
    councilQuorum: Math.ceil((councilSize + 1) / 2),
  };

  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };

  const hash = await writeWithGasBuffer(walletClient, {
    ...factory,
    functionName: "createDAO",
    args: [
      name,
      symbol,
      parseEther(String(initialSupplyWhole)),
      parseEther(String(maxSupplyWhole)),
      config,
      initialCouncil.map((s) => getAddress(s.toLowerCase())),
    ],
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