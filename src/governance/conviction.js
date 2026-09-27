import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("ConvictionGovernance");
const factoryAbi = loadAbi("ConvictionDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for ConvictionGovernance - the model with no discrete voting
 * at all, confirmed directly from source: there is no castVote, no
 * For/Against/Abstain, not even a queue-blocking quorum check. Instead:
 *
 * - support(proposalId) backs a proposal with the caller's ENTIRE
 *   current staked balance - not a partial amount. Only one active
 *   support per holder DAO-wide; supporting a new proposal automatically
 *   withdraws support from whatever they were previously backing.
 *   Supported tokens get LOCKED (via the staking wrapper's
 *   authorizedLocker mechanism - see ConvictionDAOFactory, which wires
 *   this governance contract as that locker at deploy time) - a
 *   supporter cannot unstake while actively backing a proposal, only
 *   after withdrawSupport().
 *
 * - "Conviction" accumulates toward a proposal over time based on how
 *   much support it has, capped by convictionGrowthRate per block - not
 *   a snapshot vote, a continuously-settling value. queueProposal()
 *   settles it and checks it against requiredConviction(proposalId)
 *   (a floor plus a per-wei-requested multiplier, both from config) -
 *   this genuinely does map onto the shared interface unchanged, unlike
 *   vote(), confirmed by reading its actual logic.
 *
 * Given all this, vote() throws explicitly here, the same choice made
 * in board.js - mapping a For/Against/Abstain call onto support() would
 * be actively wrong, not just imprecise: someone calling vote() with
 * "Against" would end up SUPPORTING the proposal (support() has no
 * concept of opposition at all), the opposite of what they asked for.
 * Silence here would be far worse than an honest error.
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

export async function vote() {
  throw new Error(
    "ConvictionGovernance has no discrete voting - use support(proposalId) to back a proposal, " +
      "or withdrawSupport() to stop. See this adapter's support()/withdrawSupport() exports."
  );
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

// Same 5-state shape as board.js/optimistic.js - Active at index 0, not
// Pending. Confirmed directly from source.
const CONVICTION_STATE_LABELS = ["Active", "Queued", "Executed", "Cancelled", "Expired"];

/**
 * Read-only. Genuinely different SHAPE from every other model's
 * getProposal, not just a different vote-weight scale - there is no
 * forVotes/against/abstain at all. conviction and requiredConviction
 * (fetched here as a bonus, not part of the raw struct) are both real
 * token-weighted amounts (weight = balanceOf, confirmed from source,
 * not sqrt-transformed), safe to formatEther. voteWeightUnit is "token"
 * accordingly, but callers should check for the presence of `conviction`
 * rather than `forVotes` to know they're looking at this model's shape.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const [proposal, stateIndex, executableAfter, requiredConvictionValue, currentConviction] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "executableAfter", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "requiredConviction", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "previewConviction", args: [BigInt(proposalId)] }),
  ]);

  return {
    ...proposal,
    stateIndex: Number(stateIndex),
    stateLabel: CONVICTION_STATE_LABELS[Number(stateIndex)] ?? "Unknown",
    executableAfter,
    requiredConviction: requiredConvictionValue,
    // previewConviction is what conviction would settle to RIGHT NOW if
    // queued this instant - more current than proposal.conviction, which
    // is only as fresh as the last time anything touched this proposal's
    // support and triggered a settle.
    currentConviction,
    voteWeightUnit: "token",
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - continuous support, not voting
//////////////////////////////////////////////////////////////*/

/**
 * Backs a proposal with the caller's entire current staked balance.
 * Automatically withdraws support from whatever they were previously
 * backing, if anything - see the module-level note on why this is not
 * exposed through the shared vote() interface.
 */
const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

/**
 * Conviction's support() commits the caller's CURRENT staked balance as
 * their weight (a plain, live balanceOf read inside the contract, not a
 * snapshot) - if that balance is genuinely zero at call time, the
 * transaction still succeeds, silently recording zero weight and
 * marking the caller as "supporting" this proposal with no real effect.
 * Unlike a snapshot-based vote, this value is fully knowable before
 * submitting, so it's checked here first rather than simulated after -
 * letting the bot warn (and the caller decide) before spending any gas
 * on a transaction that's a guaranteed no-op.
 */
export async function support(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const governanceTokenAddress = await publicClient.readContract({ ...gov, functionName: "governanceToken" });
  const weight = await publicClient.readContract({
    address: governanceTokenAddress,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [client.account.address],
  });

  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "support", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, weight };
}

/**
 * Withdraws the caller's support from whatever they're currently
 * backing. Takes no proposalId - the contract itself only allows one
 * active support per holder, so there's nothing to disambiguate.
 */
export async function withdrawSupport(client, governanceAddress) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "withdrawSupport", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: which proposal (if any) `account` is currently supporting. 0 means none. */
export async function getCurrentSupport(governanceAddress, account) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "currentSupportProposal", args: [getAddress(account)] });
}

// Same defaults as script/CreateConvictionDAO.s.sol, kept in sync deliberately.
const DEFAULT_CONFIG = {
  convictionGrowthRate: 10n ** 15n,
  minThresholdConviction: 100n * 10n ** 18n,
  thresholdMultiplier: 10n,
  proposalThreshold: 0n,
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
};

/** Creates a Conviction-governed DAO via the factory, using the bot's operator wallet. */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.conviction;
  if (!factoryAddress) {
    throw new Error("CONVICTION_FACTORY_ADDRESS is not configured on this bot instance");
  }

  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };

  const hash = await writeWithGasBuffer(walletClient, {
    ...factory,
    functionName: "createDAO",
    args: [name, symbol, parseEther(String(initialSupplyWhole)), parseEther(String(maxSupplyWhole)), DEFAULT_CONFIG],
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