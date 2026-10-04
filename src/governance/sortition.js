import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { scaleBlockFields, currentNetwork, networkEnvName } from "../networks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The randomness source a Sortition DAO draws from: Spaces'
// PythEntropyRandomnessAdapter (src/randomness), checked against its
// source. requestFee/credit/fund are the adapter's own; isFulfilled is
// IRandomnessSource.
const RANDOMNESS_ABI = [
  { type: "function", name: "requestFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "credit", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "fund", inputs: [{ type: "address" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "isFulfilled", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
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

/** A refusal the bot can explain before spending gas, shown to the user as is. */
export class SortitionError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

/**
 * What a draw costs right now and how much of it this DAO's credit at
 * the adapter already covers. Sources other than the Pyth Entropy adapter
 * (no requestFee) are treated as free.
 */
export async function sortitionFee(governanceAddress) {
  const gov = contractFor(governanceAddress);
  const source = await publicClient.readContract({ ...gov, functionName: "randomnessSource" });
  const adapter = { address: getAddress(source), abi: RANDOMNESS_ABI };
  const fee = await publicClient.readContract({ ...adapter, functionName: "requestFee" }).catch(() => null);
  if (fee === null) return { source, fee: 0n, credit: 0n, shortfall: 0n };
  const credit = await publicClient.readContract({ ...adapter, functionName: "credit", args: [gov.address] });
  return { source, fee, credit, shortfall: fee > credit ? fee - credit : 0n };
}

/**
 * Starts a new sortition round - requests randomness from this DAO's
 * IRandomnessSource. Only callable once the current term has ended and
 * the eligible pool is non-empty; both checked on-chain.
 *
 * Pyth Entropy charges a fee per request. If the DAO's credit at the
 * adapter doesn't cover it, the caller tops the credit up first
 * (adapter.fund(governance)) and the round then starts with no value
 * sent. That works for every Sortition DAO, including ones cloned
 * before startSortition was payable. `paid` is what the caller spent.
 */
export async function startSortition(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const { source, shortfall } = await sortitionFee(governanceAddress);
  // A DAO created before the switch to Pyth still points at the Switchboard
  // adapter, which will never answer. Starting a round there would leave it
  // waiting forever (those DAOs' contracts can't abandon a round), so refuse.
  const isEntropyAdapter = await publicClient
    .readContract({ address: getAddress(source), abi: RANDOMNESS_ABI, functionName: "requestFee" })
    .then(() => true, () => false);
  if (!isEntropyAdapter) {
    throw new SortitionError(
      `This DAO's randomness source (${source}) isn't a Pyth Entropy adapter - most likely the old Switchboard one, which will never answer. ` +
        "Pass a proposal first: /proposeaction sortition-set-randomness-source <this network's Entropy adapter> Switch to Pyth Entropy - then /startsortition."
    );
  }
  if (shortfall > 0n) {
    const hash = await writeWithGasBuffer(client, {
      address: getAddress(source),
      abi: RANDOMNESS_ABI,
      functionName: "fund",
      args: [gov.address],
      value: shortfall,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "startSortition", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });

  const round = await publicClient.readContract({ ...gov, functionName: "sortitionRound" });
  return { hash, round, paid: shortfall };
}

/**
 * Where the current round stands: { round, active, fulfilled }. Entropy
 * calls the adapter back by itself, usually within seconds of the start.
 */
export async function sortitionStatus(governanceAddress) {
  const gov = contractFor(governanceAddress);
  const round = await publicClient.readContract({ ...gov, functionName: "sortitionRound" });
  if (round === 0n) return { round, active: false, fulfilled: false };
  const [finalized, requestId, source] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "roundFinalized", args: [round] }),
    publicClient.readContract({ ...gov, functionName: "requestIdOfRound", args: [round] }),
    publicClient.readContract({ ...gov, functionName: "randomnessSource" }),
  ]);
  if (finalized) return { round, active: false, fulfilled: true };
  const fulfilled = await publicClient.readContract({ address: getAddress(source), abi: RANDOMNESS_ABI, functionName: "isFulfilled", args: [requestId] });
  return { round, active: true, fulfilled };
}

/**
 * Finalizes the active sortition round once its randomness has arrived -
 * draws the new council via an unbiased shuffle seeded by it. Says so
 * plainly when there's no round or the randomness hasn't arrived yet.
 */
export async function finalizeSortition(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const status = await sortitionStatus(governanceAddress);
  if (!status.active) throw new SortitionError("There's no sortition round waiting to be finalized - start one with /startsortition once the term has ended.");
  if (!status.fulfilled) throw new SortitionError(`Round #${status.round}'s randomness hasn't arrived yet. Pyth Entropy usually delivers within a few seconds - try again shortly.`);
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
  // termLength: 60n * 60n * 24n * 30n,
  termLength: 60n * 60n * 24n * 2n,
  eligibilityThreshold: 0n,
  councilApprovalThresholdBps: 6_000,
  votingDelay: 1,
  votingPeriod: 50_400,
  // timelockDelay: 60n * 60n * 24n,
  timelockDelay: 60n * 60n,
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
