import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { currentNetwork, networkEnvName } from "../networks.js";
import { ensureCanAfford, feesFor } from "../gasSponsor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("BoardGovernance");
const factoryAbi = loadAbi("BoardDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for BoardGovernance - the one model with no token, no For/
 * Against/Abstain voting, and no separate queue step at all. Genuinely
 * different from every other adapter, not just differently-named:
 *
 * - No governanceToken() on this contract at all. Board has no token
 *   concept whatsoever - do not call common.js's getGovernanceTokenAddress
 *   or getDaoInfo with model="board", both will fail since they assume
 *   every model has a token.
 *
 * - vote() and queue() are part of the shared interface for consistent
 *   registry dispatch, but BOTH throw a clear, explicit error here
 *   rather than silently mapping onto something incorrect. There is no
 *   For/Against/Abstain concept - signers either confirm() a proposal or
 *   they don't, a binary action with no equivalent to "vote against" or
 *   "abstain." And there is no separate queue step - confirming a
 *   proposal automatically queues it the moment the required threshold
 *   is reached (and revoking a confirmation automatically un-queues it
 *   if that drops it back below threshold - a real, genuine behavior no
 *   other model has: a Board proposal can move backward in its own
 *   lifecycle).
 *
 * - getProposal() has no forVotes/against/abstain fields at all -
 *   confirmations is a plain count against requiredApprovals, not a
 *   token-weighted or headcount vote total. voteWeightUnit is
 *   "signerConfirmationCount", a fourth distinct category alongside
 *   "token", "sqrtWeight", and Delegate's "councilVoteCount."
 */

export async function propose(client, governanceAddress, actions, metadataURI) {
  const gov = contractFor(governanceAddress);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "proposeTransaction",
    args: [actions, metadataURI],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId };
}

export async function vote() {
  throw new Error(
    "BoardGovernance has no voting - signers use confirm() or revokeConfirmation() instead. " +
      "See this adapter's confirm()/revokeConfirmation() exports."
  );
}

export async function queue() {
  throw new Error(
    "BoardGovernance proposals queue automatically the moment enough signers confirm - " +
      "there is no separate queue step to call."
  );
}

export async function execute(client, governanceAddress, proposalId, valueWhole = 0) {
  const gov = contractFor(governanceAddress);

  // Deliberately NOT using writeWithGasBuffer here, unlike every other
  // call in this file - that helper still calls estimateContractGas
  // internally, which hits the exact same eth_estimateGas RPC method
  // that returned ~9,943,397 gas for this specific call in production
  // (confirmed via the actual receipt), against a real, traced need of
  // only ~150,347 gas. Buffering on top of an estimate that may itself
  // already be wrong (Monad's dual-pool routing is a documented,
  // plausible cause) risks compounding the problem rather than fixing
  // it. A fixed, modest limit based on the real measured need sidesteps
  // estimateGas entirely for this proven case - matching Monad's own
  // guidance to set gas explicitly when it's fairly constant, since
  // executeTransaction's call depth (governance clone -> implementation
  // -> treasury clone -> implementation -> recipient) doesn't vary.
  const value = parseEther(String(valueWhole));
  const { fees, gasCost } = await feesFor(400_000n);
  await ensureCanAfford(client.account.address, gasCost, value);
  const hash = await client.writeContract({
    ...gov,
    functionName: "executeTransaction",
    args: [BigInt(proposalId)],
    value,
    gas: 400_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
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

// Only 5 states here, not 8 - and Active is index 0, not Pending/
// ChallengeWindow. Confirmed directly from source, own array kept
// rather than reusing the shared one, same reasoning as optimistic.js.
const BOARD_STATE_LABELS = ["Active", "Queued", "Executed", "Cancelled", "Expired"];

/**
 * Read-only. No forVotes/against/abstain - confirmations is a plain
 * count, requiredApprovals comes from config() separately (this
 * function does not fetch config itself - callers needing it should
 * read config() directly via getDaoInfo-equivalent logic, kept separate
 * so this stays a single, cheap call).
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
    stateLabel: BOARD_STATE_LABELS[Number(stateIndex)] ?? "Unknown",
    executableAfter,
    voteWeightUnit: "signerConfirmationCount",
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS - no equivalent in any other model
//////////////////////////////////////////////////////////////*/

/** Confirms a proposal - only callable by a current signer. */
export async function confirm(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "confirmTransaction", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Revokes the caller's own confirmation. If this drops the proposal
 * below requiredApprovals after it was already queued, the contract
 * itself un-queues it automatically - nothing extra to call here for
 * that part.
 */
export async function revokeConfirmation(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "revokeConfirmation",
    args: [BigInt(proposalId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: the current signer roster. */
export async function getSigners(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "getSigners", args: [] });
}

/** Read-only: full config (requiredApprovals, timelockDelay, executionPeriod). */
export async function getConfig(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "config", args: [] });
}

/**
 * Board-specific equivalent of common.js's shared getDaoInfo - Board is
 * deliberately excluded from that shared table (no governanceToken at
 * all), so this lives here instead. No tokenAddress field, since there
 * genuinely isn't one for this model.
 */
export async function getDaoInfo(governanceAddress) {
  const gov = contractFor(governanceAddress);
  const [daoName, treasuryAddress, config] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "daoName" }),
    publicClient.readContract({ ...gov, functionName: "treasury" }),
    publicClient.readContract({ ...gov, functionName: "config" }),
  ]);
  return { daoName, treasuryAddress, config };
}

// Same defaults as script/CreateBoardDAO.s.sol, kept in sync
// deliberately - only timelockDelay/executionPeriod are fixed defaults;
// requiredApprovals is derived from initialSigners' length below, same
// majority-rounded-up approach as delegate.js's councilQuorum.
const DEFAULT_CONFIG_WITHOUT_REQUIRED_APPROVALS = {
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
};

/**
 * Creates a Board-governed DAO via the factory, using the bot's
 * operator wallet. Genuinely different signature from every other
 * createDAO in this system - confirmed from the real factory ABI: no
 * symbol/initialSupply/maxSupply at all, since Board has no token
 * concept whatsoever. `initialSigners` is required - no sensible
 * default for who the signers actually are. Returns governanceToken/
 * underlyingToken as the zero address, matching what the factory
 * itself records for this tokenless model - callers should check
 * hasToken(model) before displaying these, same as everywhere else.
 */
export async function createDAO(name, initialSigners) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.board;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "BOARD_FACTORY_ADDRESS")} is not configured on this bot instance`);
  }
  if (!initialSigners || initialSigners.length === 0) {
    throw new Error("initialSigners is required - at least one address must be supplied");
  }

  const requiredApprovals = Math.ceil((initialSigners.length + 1) / 2);
  const config = { ...DEFAULT_CONFIG_WITHOUT_REQUIRED_APPROVALS, requiredApprovals };

  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };

  const hash = await writeWithGasBuffer(walletClient, {
    ...factory,
    functionName: "createDAO",
    args: [name, config, initialSigners.map((s) => getAddress(s.toLowerCase()))],
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