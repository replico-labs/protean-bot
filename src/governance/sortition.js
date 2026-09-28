import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { scaleBlockFields, currentNetwork, networkEnvName } from "../networks.js";
import { CrossbarClient } from "@switchboard-xyz/common";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal ABI for the pieces of the real Switchboard contract this needs -
// getRandomness/isRandomnessReady/settleRandomness, confirmed directly
// against the installed @switchboard-xyz/on-demand-solidity package's own
// ISwitchboard interface, not assumed from documentation.
const SWITCHBOARD_ABI = [
  {
    type: "function",
    name: "getRandomness",
    inputs: [{ type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "randId", type: "bytes32" },
          { name: "createdAt", type: "uint256" },
          { name: "authority", type: "address" },
          { name: "rollTimestamp", type: "uint256" },
          { name: "minSettlementDelay", type: "uint64" },
          { name: "oracle", type: "address" },
          { name: "value", type: "uint256" },
          { name: "settledAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isRandomnessReady",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "settleRandomness",
    inputs: [{ type: "bytes" }],
    outputs: [],
    stateMutability: "payable",
  },
];

// Adapter ABI fragment needed to find the real Switchboard address behind
// SortitionGovernance's own randomnessSource() - see the module comment on
// settleSortitionRandomness below for why this matters.
const ADAPTER_SWITCHBOARD_ABI = [
  { type: "function", name: "switchboard", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
];

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("SortitionGovernance");
const factoryAbi = loadAbi("SortitionDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for SortitionGovernance. Superficially similar to
 * delegate.js - both have a "council" that proposes and votes - but two
 * real differences, confirmed directly from source rather than assumed
 * from the similar naming:
 *
 * 1. queue/execute/cancel use the STANDARD names here (queueProposal,
 *    executeProposal, cancelProposal), NOT Delegate's *CouncilProposal
 *    versions. Only propose/vote keep the "Council" name
 *    (proposeCouncilAction/castCouncilVote).
 *
 * 2. proposeCouncilAction has NO onlyCouncilMember restriction here -
 *    anyone meeting the configured eligibilityThreshold can propose,
 *    not just sitting council members. Only castCouncilVote is actually
 *    restricted to the current council. Delegate restricts both.
 *
 * Council selection itself is a genuinely different mechanism from
 * every other model: no election, no voting for candidates - eligible
 * token holders opt into a pool (registerEligible), and the council is
 * drawn from that pool via a verifiable random shuffle
 * (startSortition/finalizeSortition), using whatever IRandomnessSource
 * this DAO was deployed with. There is no recall mechanism here, unlike
 * DelegateGovernance.
 *
 * Vote weight on getProposal is "councilVoteCount", same category as
 * delegate.js - forVotes/against/abstain are a plain uint16 headcount
 * of council members, confirmed from source, not token-weighted.
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
 * equivalent here - silently ignored. Only current council members can
 * actually call this - a non-council caller gets a real on-chain revert,
 * even though propose() itself has no such restriction.
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
 * Read-only. No quorumVotes field - same situation as quadratic.js/
 * liquid.js, no per-proposal quorum view exposed by the contract.
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
    MODEL-SPECIFIC EXTRAS - eligibility pool, open to any
    qualifying token holder
//////////////////////////////////////////////////////////////*/

/** Opts the caller into the eligible pool for future sortition draws. */
export async function registerEligible(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "registerEligible", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Removes the caller from the eligible pool. Does not remove them from
 * a council they're already serving on - confirmed directly from the
 * contract's own doc comment.
 */
export async function withdrawEligibility(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "withdrawEligibility", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - the sortition draw itself
//////////////////////////////////////////////////////////////*/

/**
 * Starts a new sortition round - requests randomness from this DAO's
 * configured IRandomnessSource. Only callable once the current term has
 * ended and the eligible pool is non-empty; both checked on-chain.
 */
export async function startSortition(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "startSortition", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });

  const round = await publicClient.readContract({ ...gov, functionName: "sortitionRound" });
  return { hash, round };
}

/**
 * Finalizes the active sortition round once its randomness request has
 * been fulfilled - draws the new council via an unbiased shuffle seeded
 * by the verified random value. Reverts if the randomness source hasn't
 * fulfilled the request yet; the caller (or the bot's command handler)
 * is expected to retry later rather than this function polling.
 */
export async function finalizeSortition(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeSortition", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: the current council roster. */
export async function getCouncil(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getCouncil", args: [] });
}

/** Read-only: everyone currently opted into the eligible pool. */
export async function getEligiblePool(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getEligiblePool", args: [] });
}

// Same defaults as script/CreateSortitionDAO.s.sol, kept in sync
// deliberately. councilSize derived from initialCouncil's length, same
// reasoning as delegate.js's createDAO.
const DEFAULT_CONFIG_WITHOUT_COUNCIL_SIZE = {
  termLength: 60n * 60n * 24n * 30n,
  eligibilityThreshold: 0n,
  councilApprovalThresholdBps: 6_000,
  votingDelay: 1,
  votingPeriod: 50_400,
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
};

/**
 * Creates a Sortition-governed DAO via the factory, using the bot's
 * operator wallet. Both `randomnessSource` and `initialCouncil` are
 * required, with no sensible default for either - randomnessSource must
 * be a real, already-deployed IRandomnessSource genuinely configured
 * for this chain (deliberately never guessed at, same reasoning as
 * SortitionDAOFactory.sol itself), and initialCouncil is the starting/
 * bootstrap council (councilSize/councilQuorum derived from its length),
 * not something with a meaningful default membership.
 */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole, randomnessSource, initialCouncil) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.sortition;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "SORTITION_FACTORY_ADDRESS")} is not configured on this bot instance`);
  }
  if (!randomnessSource) {
    throw new Error("randomnessSource is required - a real, already-deployed IRandomnessSource address");
  }
  if (!initialCouncil || initialCouncil.length === 0) {
    throw new Error("initialCouncil is required - at least one address must be supplied");
  }

  const councilSize = initialCouncil.length;
  const config = {
    ...scaleBlockFields("sortition", DEFAULT_CONFIG_WITHOUT_COUNCIL_SIZE),
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
      getAddress(randomnessSource),
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

/*//////////////////////////////////////////////////////////////
    SWITCHBOARD SETTLEMENT - the keeper step nothing else in this
    system does automatically. startSortition() requests randomness;
    someone still has to fetch Switchboard's signed response off-
    chain and submit it on-chain before finalizeSortition() can run.
    Confirmed against the real, installed @switchboard-xyz/common
    package (resolveEVMRandomness's actual signature and return
    shape) and the real, installed @switchboard-xyz/on-demand-solidity
    package's ISwitchboard interface - not assumed from docs alone.
//////////////////////////////////////////////////////////////*/

const crossbar = new CrossbarClient("https://crossbar.switchboard.xyz");

/**
 * Settles the current sortition round's randomness, if it's ready -
 * the full off-chain resolve + on-chain settle round trip in one call.
 * Anyone can call this (Switchboard's settleRandomness has no access
 * control - it's a pull-based oracle, not a push/callback one), so
 * `client` just needs to be able to pay gas; it doesn't need to be the
 * DAO's own operator specifically.
 *
 * Returns one of:
 * - { status: "no-pending-round" } - no sortition round has ever been started
 * - { status: "already-settled" } - this round's randomness was already settled by someone else
 * - { status: "not-ready", readyIn: bigint } - still inside minSettlementDelay
 * - { status: "settled", hash } - settlement transaction succeeded
 *
 * Deliberately does NOT also call finalizeSortition() - settling
 * randomness and drawing the actual council are separate concerns, and
 * a caller may want to inspect the settled value or handle errors
 * independently before finalizing.
 */
export async function settleSortitionRandomness(client, governanceAddress) {
  const gov = contractFor(governanceAddress);

  const round = await publicClient.readContract({ ...gov, functionName: "sortitionRound" });
  if (round === 0n) return { status: "no-pending-round" };

  const requestId = await publicClient.readContract({ ...gov, functionName: "requestIdOfRound", args: [round] });

  const adapterAddress = await publicClient.readContract({ ...gov, functionName: "randomnessSource" });
  const switchboardAddress = await publicClient.readContract({
    address: adapterAddress,
    abi: ADAPTER_SWITCHBOARD_ABI,
    functionName: "switchboard",
  });
  const switchboardContract = { address: switchboardAddress, abi: SWITCHBOARD_ABI };

  const randomness = await publicClient.readContract({
    ...switchboardContract,
    functionName: "getRandomness",
    args: [requestId],
  });
  if (randomness.settledAt > 0n) return { status: "already-settled" };

  const ready = await publicClient.readContract({
    ...switchboardContract,
    functionName: "isRandomnessReady",
    args: [requestId],
  });
  if (!ready) {
    const readyAt = randomness.rollTimestamp + randomness.minSettlementDelay;
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    return { status: "not-ready", readyIn: readyAt > nowSeconds ? readyAt - nowSeconds : 0n };
  }

  const chainId = await publicClient.getChainId();
  const { encoded } = await crossbar.resolveEVMRandomness({
    chainId,
    randomnessId: requestId,
    timestamp: Number(randomness.rollTimestamp),
    minStalenessSeconds: Number(randomness.minSettlementDelay),
    oracle: randomness.oracle,
  });

  const hash = await writeWithGasBuffer(client, {
    ...switchboardContract,
    functionName: "settleRandomness",
    args: [encoded],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { status: "settled", hash };
}