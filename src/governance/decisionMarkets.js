import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { currentNetwork, networkEnvName } from "../networks.js";
import { ensureAllowance } from "./common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("DecisionMarketsGovernance");
const factoryAbi = loadAbi("DecisionMarketsDAOFactory");
const vaultAbi = loadAbi("ConditionalVault");

const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

// Minimal WMON interface - deposit()/withdraw() are the WETH9-style
// wrap/unwrap functions, confirmed directly from WMON.sol's own source.
const WMON_ABI = [
  { type: "function", name: "withdraw", inputs: [{ type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
];

const POOL_TOKEN_ABI = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/**
 * Adapter for DecisionMarketsGovernance - the one model with no vote of
 * any kind, confirmed directly from source: no castVote, no support(),
 * no confirmations, nothing. A proposal's two possible outcomes each
 * get their own live trading market (deployed and seeded inside
 * propose() itself); people trade whichever side they believe in; and
 * finalizeProposal() compares the two markets' time-weighted average
 * prices - pass must exceed fail's TWAP by the configured threshold.
 * No oracle, no resolver, no challenge - the price comparison itself is
 * the entire verdict.
 *
 * Three of five shared-interface functions throw explicitly:
 *
 * - propose() throws: the real propose() needs a third parameter
 *   (baseSeedAmount) and is itself payable (msg.value supplies the
 *   quote-side WMON seed) - genuinely doesn't fit the standard
 *   4-argument, non-payable shape. Use proposeWithSeed() instead.
 *
 * - vote() throws: there is nothing to vote on. Use trade() to actually
 *   participate in either market.
 *
 * - queue() throws: there is no separate queueProposal - finalizeProposal()
 *   itself sets the queued timestamp directly the moment it determines
 *   the proposal passed. Nothing else to call.
 *
 * execute() and cancel() both map directly - same names, same shapes,
 * standard timelock-gated execution once finalized and passed.
 *
 * trade()'s closed-window revert previously reused finalizeProposal()'s
 * TradingWindowStillOpen error, which was misleadingly named for that
 * usage (the actual condition being checked was correct throughout -
 * only the shared name was confusing). Fixed at the contract level:
 * trade() now reverts with its own TradingWindowClosed instead. Nothing
 * in this adapter needed to change as a result - it never referenced
 * the specific error name, only let reverts surface as-is - but the ABI
 * above was regenerated to include the new error.
 */

export async function propose() {
  throw new Error(
    "DecisionMarketsGovernance's propose() takes a required baseSeedAmount and is itself payable " +
      "(msg.value supplies the quote-side WMON seed) - use proposeWithSeed() instead, which exposes " +
      "the real signature."
  );
}

export async function vote() {
  throw new Error(
    "DecisionMarketsGovernance has no voting at all - a proposal's fate is decided by comparing two " +
      "live markets' prices. Use trade() to actually back the outcome you believe in."
  );
}

export async function queue() {
  throw new Error(
    "DecisionMarketsGovernance has no separate queue step - finalizeProposal() itself queues the " +
      "proposal the moment it determines the pass market's TWAP beat the fail market's by enough."
  );
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
 * Read-only. No forVotes/against/abstain, no phase enum at all - status
 * is derived here from the struct's own boolean flags, since the
 * contract itself exposes no single state()/phase value. "Open" covers
 * both "still trading" and "trading closed but not yet finalized" -
 * genuinely indistinguishable from these fields alone without comparing
 * tradingDeadline against the current time, which this function
 * deliberately does not do (avoiding an extra RPC call here) - both
 * tradingDeadline and the current proposal fields are returned raw so a
 * caller who needs that distinction can compute it themselves.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const proposal = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] });

  let statusLabel;
  if (proposal.cancelled) statusLabel = "Cancelled";
  else if (proposal.executed) statusLabel = "Executed";
  else if (!proposal.finalized) statusLabel = "Open"; // trading or awaiting finalization - see doc comment
  else if (!proposal.passed) statusLabel = "Failed";
  else statusLabel = "Queued"; // finalized, passed, not yet executed

  return {
    ...proposal,
    statusLabel,
  };
}

/*//////////////////////////////////////////////////////////////
    MODEL-SPECIFIC EXTRAS
//////////////////////////////////////////////////////////////*/

/**
 * The real propose() - deploys and seeds both markets in this one call.
 * `baseSeedAmountWhole` is the DAO governance token seed (pulled via
 * transferFrom, so the caller must have approved this contract first);
 * `quoteSeedAmountWhole` is the native MON seed, sent as msg.value and
 * wrapped into WMON internally.
 */
export async function proposeWithSeed(
  client,
  governanceAddress,
  actions,
  metadataURI,
  baseSeedAmountWhole,
  quoteSeedAmountWhole
) {
  const gov = contractFor(governanceAddress);
  // propose() pulls the base seed via transferFrom - approve it first.
  const baseToken = await publicClient.readContract({ ...gov, functionName: "governanceToken" });
  await ensureAllowance(client, baseToken, governanceAddress, parseEther(String(baseSeedAmountWhole)));

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "propose",
    args: [actions, metadataURI, parseEther(String(baseSeedAmountWhole))],
    value: parseEther(String(quoteSeedAmountWhole)),
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });
  return { hash, proposalId };
}

/**
 * Trades in one of the two markets. `market`: 0 = Pass, 1 = Fail.
 * `sideIn`: 0 = Base (the DAO token side), 1 = Quote (the WMON side) -
 * whichever conditional token the caller is selling. The caller must
 * already hold that conditional token (acquired by splitting real
 * tokens via the relevant ConditionalVault - not something this
 * function does for them). `minAmountOutWhole` is real slippage
 * protection, not optional in spirit even though the contract accepts
 * any value including 0 - always supply a real minimum in production
 * use.
 */
export async function trade(client, governanceAddress, proposalId, market, sideIn, amountInWhole, minAmountOutWhole) {
  const gov = contractFor(governanceAddress);
  // trade() pulls the conditional token being sold (the pool's token0 for
  // base, token1 for quote) via transferFrom - approve it first.
  const proposal = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] });
  const pool = getAddress(market === 0 ? proposal.passPool : proposal.failPool);
  const tokenIn = await publicClient.readContract({ address: pool, abi: POOL_TOKEN_ABI, functionName: sideIn === 0 ? "token0" : "token1" });
  await ensureAllowance(client, tokenIn, governanceAddress, parseEther(String(amountInWhole)));

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "trade",
    args: [BigInt(proposalId), market, sideIn, parseEther(String(amountInWhole)), parseEther(String(minAmountOutWhole))],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

/** Reads both markets' TWAP, compares them against the configured threshold, and resolves both vaults. Permissionless, callable by anyone once trading has closed. */
export async function finalizeProposal(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeProposal", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Recovers this contract's seed liquidity from a finalized proposal's
 * two pools and sends it to the proposer - permissionless, callable
 * once per proposal, any time after finalization regardless of whether
 * the proposal passed, failed, or was ever executed.
 */
export async function reclaimLiquidity(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "reclaimLiquidity", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Read-only: this DAO's shared WMON address. */
export async function getWmon(governanceAddress) {
  const gov = contractFor(governanceAddress);
  return publicClient.readContract({ ...gov, functionName: "wmon", args: [] });
}

// Same defaults as script/CreateDecisionMarketsDAO.s.sol, kept in sync
// deliberately. Note WMON and the shared clone implementations are NOT
// part of createDAO's own arguments - the factory already fixed those
// at ITS OWN deployment time (see DeployDecisionMarketsDAOFactory.s.sol),
// reused automatically for every DAO it creates from here on.
const DEFAULT_CONFIG = {
  tradingPeriod: 60n * 60n * 24n * 3n,
  thresholdBps: 300,
  timelockDelay: 60n * 60n * 24n,
  executionPeriod: 60n * 60n * 24n * 7n,
};

/** Creates a Decision-Markets-governed DAO via the factory, using the bot's operator wallet. */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.decisionMarkets;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "DECISION_MARKETS_FACTORY_ADDRESS")} is not configured on this bot instance`);
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

/*//////////////////////////////////////////////////////////////
    CONDITIONAL VAULT WIRING - previously missing entirely.
    trade() alone was never sufficient: a trader needs splitTokens()
    first to actually get conditional tokens to trade with, and
    redeemTokens() afterward to turn winning tokens back into real
    value - neither was wired anywhere in this adapter before, despite
    both genuinely existing on ConditionalVault.sol. resolve() itself
    needed no separate wiring - it's onlyOracle, called internally by
    finalizeProposal() above, not something a user calls directly.
//////////////////////////////////////////////////////////////*/

function vaultContract(vaultAddress) {
  return { address: getAddress(vaultAddress), abi: vaultAbi };
}

/**
 * Resolves which vault address backs which side of a given proposal.
 * `side`: "base" (the DAO's governance token) or "quote" (WMON) -
 * matches trade()'s own sideIn convention (0 = Base, 1 = Quote).
 */
export async function getProposalVaults(governanceAddress, proposalId) {
  const p = await getProposal(governanceAddress, proposalId);
  return { baseVault: p.baseVault, quoteVault: p.quoteVault };
}

/**
 * Splits `amountWhole` of the vault's real underlying token into an
 * equal amount of both pass and fail conditional tokens - the step a
 * trader needs before trade() has anything to actually sell. Two
 * transactions: approve, then split, same pattern as common.js's
 * stakeTokens. `vaultAddress` should be whichever of a proposal's
 * baseVault/quoteVault matches the side being traded - get it from
 * getProposalVaults() first.
 */
export async function splitTokens(client, vaultAddress, amountWhole) {
  const vault = vaultContract(vaultAddress);
  const underlyingAddress = await publicClient.readContract({ ...vault, functionName: "underlying" });
  const amount = parseEther(String(amountWhole));

  const approveHash = await writeWithGasBuffer(client, {
    address: underlyingAddress,
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [vault.address, amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const hash = await writeWithGasBuffer(client, { ...vault, functionName: "splitTokens", args: [amount] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { approveHash, hash };
}

/**
 * Reverses a split before resolution - burns equal pass/fail tokens,
 * returns the real underlying. Only works pre-resolution; the contract
 * itself rejects this afterward (only one side has any value once
 * resolved, so merging back to a matched pair no longer makes sense).
 */
export async function mergeTokens(client, vaultAddress, amountWhole) {
  const vault = vaultContract(vaultAddress);
  const hash = await writeWithGasBuffer(client, {
    ...vault,
    functionName: "mergeTokens",
    args: [parseEther(String(amountWhole))],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Redeems the caller's ENTIRE conditional token balance in this vault
 * for real underlying, weighted by the resolved payout - the function
 * this whole gap was actually about. No amount parameter; the contract
 * redeems everything the caller holds in one call, matching its real
 * signature exactly (confirmed from source, takes no arguments at all).
 * Only works after resolution - finalizeProposal() must have run first.
 */
export async function redeemTokens(client, vaultAddress) {
  const vault = vaultContract(vaultAddress);
  const hash = await writeWithGasBuffer(client, { ...vault, functionName: "redeemTokens", args: [] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Converts WMON the caller is holding back into native MON - the
 * missing counterpart to proposeWithSeed's automatic wrap. Nothing in
 * this system unwraps automatically: redeeming or reclaiming on the
 * quote side of a Decision Markets proposal returns WMON, not MON, so
 * this is the step a user runs afterward if they want native currency
 * back rather than staying in WMON. `governanceAddress` is used to
 * resolve the correct WMON address for this specific DAO via getWmon(),
 * rather than assuming any fixed address - the WMON a DAO uses is
 * whatever was passed to its factory at creation time, and could
 * genuinely differ between DAOs on the same chain.
 */
export async function unwrapWmon(client, governanceAddress, amountWhole) {
  const wmonAddress = await getWmon(governanceAddress);
  const wmon = { address: getAddress(wmonAddress), abi: WMON_ABI };
  const amount = parseEther(String(amountWhole));

  const hash = await writeWithGasBuffer(client, { ...wmon, functionName: "withdraw", args: [amount] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}