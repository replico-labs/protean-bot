import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatUnits, getAddress, parseEther, zeroHash } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { scaleBlockFields, currentNetwork, networkEnvName, networkEnv } from "../networks.js";
import { ensureAllowance } from "./common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abi = loadAbi("SowellianGovernance");
const factoryAbi = loadAbi("SowellianDAOFactory");

function contractFor(address) {
  return { address: getAddress(address), abi };
}

/** governanceToken() and one config() field - what a bond approval needs. */
async function bondToken(gov, configField) {
  const [token, config] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "governanceToken" }),
    configField ? publicClient.readContract({ ...gov, functionName: "config" }) : null,
  ]);
  return { token, amount: configField ? config[configField] : undefined };
}

/**
 * Adapter for SowellianGovernance - the biggest, most involved model in
 * this system. A real 11-stage lifecycle, confirmed directly from
 * source (the contract's own section comments are numbered 1 through
 * 11): approval vote -> pari-mutuel positions market -> execution ->
 * one of two resolution tracks (automatic oracle, or human-proposed
 * with a challenge window) -> adjudication only if actually challenged
 * -> claiming payouts. Four of the five shared-interface functions
 * throw explicitly here, each for a different, real reason:
 *
 * - propose() throws: the real propose() needs 7 parameters
 *   (resolutionMethod, oracle, targetValue, targetIsMinimum,
 *   measurementPeriod, beyond actions/metadataURI) - silently dropping
 *   5 required parameters would be broken, not just imprecise. Use
 *   proposeWithCriteria() instead, which exposes all of them.
 *
 * - vote() throws: there are genuinely TWO separate, incompatible votes
 *   here - castApprovalVote (VoteType: Against/For/Abstain) and
 *   castAdjudicationVote (Outcome: Success/Failure) - different enums,
 *   different phases, different purposes. A single vote() couldn't
 *   safely guess which one a caller means. Use castApprovalVote() or
 *   castAdjudicationVote() directly.
 *
 * - queue() throws: there is no queueProposal at all, confirmed absent
 *   from the contract. Once approved, positions open on a fixed window;
 *   execution happens directly once that window closes, no separate
 *   queue/timelock step exists here the way it does in every proposal-
 *   then-vote model.
 *
 * - cancel() throws: there is no cancelProposal at all, confirmed
 *   absent. The only way a proposal doesn't proceed is the approval
 *   vote itself failing (which forfeits the proposal bond to treasury
 *   automatically) - there's no separate, unilateral withdrawal option
 *   once submitted.
 *
 * execute() is the one shared-interface function that DOES map
 * directly - same function name, same shape - even though what it
 * actually does here (start the measurement period) is conceptually
 * different from every other model's post-timelock execution.
 */

export async function propose() {
  throw new Error(
    "SowellianGovernance's propose() needs resolution criteria (resolutionMethod, oracle, " +
      "targetValue, targetIsMinimum, measurementPeriod) beyond actions/metadataURI - use " +
      "proposeWithCriteria() instead, which exposes the real, full parameter list."
  );
}

export async function vote() {
  throw new Error(
    "SowellianGovernance has two separate votes, not one - castApprovalVote() (gatekeeps whether " +
      "a proposal opens for betting) and castAdjudicationVote() (resolves a challenged human-track " +
      "resolution). Call whichever one actually applies directly."
  );
}

export async function queue() {
  throw new Error(
    "SowellianGovernance has no queue step - once the approval vote passes, positions open on a " +
      "fixed window, and execute() runs directly once that window closes. Nothing to queue."
  );
}

export async function cancel() {
  throw new Error(
    "SowellianGovernance has no way to cancel a proposal once submitted - the only way it doesn't " +
      "proceed is the approval vote itself failing, which forfeits the proposal bond automatically."
  );
}

/**
 * Starts the measurement period and runs the proposal's actions - see
 * the module-level note on why this is conceptually different timing
 * from every other model's execute(), despite being the same call
 * shape. `valueWhole` must match the sum of the proposal's actions'
 * values exactly, same as everywhere else.
 */
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

// Matches Phase's real enum order, confirmed from source. Note
// "Cancelled" is unreachable in practice (no cancelProposal exists to
// ever set it) but kept here for completeness against the real enum.
const SOWELLIAN_PHASE_LABELS = [
  "ApprovalVoting",
  "Rejected",
  "PositionsOpen",
  "Executed",
  "ResolutionPending",
  "ResolutionProposed",
  "Adjudicating",
  "Finalized",
  "Cancelled",
];

/**
 * Read-only. No single state()/getProposal split like other models -
 * this contract has no separate state() function at all; `phase` on
 * the struct itself is already the complete picture, confirmed absent
 * from the ABI. Returns TWO separate vote tallies depending which
 * phase actually used them - approvalForVotes/against/abstain (from
 * castApprovalVote) and adjudicateSuccessVotes/FailureVotes (from
 * castAdjudicationVote, only meaningful if the proposal was actually
 * challenged) - both are real token-weighted amounts, safe to
 * formatEther, voteWeightUnit "token" applies to both.
 */
export async function getProposal(governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);

  const proposal = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] });

  return {
    ...proposal,
    phaseLabel: SOWELLIAN_PHASE_LABELS[Number(proposal.phase)] ?? "Unknown",
    voteWeightUnit: "token",
  };
}

/*//////////////////////////////////////////////////////////////
    1. PROPOSING - the real, full propose() signature
//////////////////////////////////////////////////////////////*/

/**
 * @param resolutionMethod 0 = Oracle, 1 = Human
 * @param oracle required if resolutionMethod is Oracle, ignored otherwise - a deployed IMetricOracle address
 * @param targetValue the metric value success is measured against
 * @param targetIsMinimum true: success if metric >= targetValue; false: success if metric <= targetValue
 * @param measurementPeriod seconds, counted from execution
 */
export async function proposeWithCriteria(
  client,
  governanceAddress,
  actions,
  metadataURI,
  resolutionMethod,
  oracle,
  oracleSelector,
  targetValue,
  targetIsMinimum,
  measurementPeriod
) {
  const gov = contractFor(governanceAddress);
  // propose() pulls the proposal bond via transferFrom - approve it first.
  const bond = await bondToken(gov, "proposalBondAmount");
  await ensureAllowance(client, bond.token, governanceAddress, bond.amount);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "propose",
    args: [
      actions,
      metadataURI,
      resolutionMethod,
      getAddress(oracle ?? "0x0000000000000000000000000000000000000000"),
      oracleSelector ?? zeroHash,
      BigInt(targetValue),
      Boolean(targetIsMinimum),
      BigInt(measurementPeriod),
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });
  return { hash, proposalId };
}

/*//////////////////////////////////////////////////////////////
    2. APPROVAL VOTE - gatekeeps whether betting opens at all
//////////////////////////////////////////////////////////////*/

/** `support`: VoteType - 0 = Against, 1 = For, 2 = Abstain. */
export async function castApprovalVote(client, governanceAddress, proposalId, support) {
  const gov = contractFor(governanceAddress);
  const args = [BigInt(proposalId), support];

  // castApprovalVote returns the actual weight cast - see
  // tokenWeighted.js for the full reasoning behind capturing this via
  // simulateContract rather than assuming a successful tx meant a real,
  // non-zero vote.
  const { result: weight } = await publicClient.simulateContract({
    ...gov,
    functionName: "castApprovalVote",
    args,
    account: client.account,
  });

  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "castApprovalVote", args });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, weight };
}

/** Finalizes the approval vote once its window has closed. */
export async function finalizeApproval(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeApproval", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/*//////////////////////////////////////////////////////////////
    3. POSITIONS - the pari-mutuel outcome market itself
//////////////////////////////////////////////////////////////*/

/**
 * Backs `side` (0 = Yes, 1 = No) with `amountWhole` tokens. Positions
 * may only be increased, never withdrawn or reduced, once taken -
 * confirmed directly from source.
 */
export async function takePosition(client, governanceAddress, proposalId, side, amountWhole) {
  const gov = contractFor(governanceAddress);
  const { token } = await bondToken(gov);
  await ensureAllowance(client, token, governanceAddress, parseEther(String(amountWhole)));
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "takePosition",
    args: [BigInt(proposalId), side, parseEther(String(amountWhole))],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/*//////////////////////////////////////////////////////////////
    5/6. ORACLE-TRACK RESOLUTION - automatic, no dispute possible
//////////////////////////////////////////////////////////////*/

/** Reads the configured oracle directly and finalizes in one call - oracle-track proposals only. */
export async function resolveViaOracle(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const proposal = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] });
  // Pyth is pull-based: post the latest signed price first, so the
  // contract's staleness check sees a fresh value.
  const priceUpdate = await postPythPrice(client, proposal.oracle, proposal.oracleSelector);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "resolveViaOracle", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, priceUpdate };
}

/*//////////////////////////////////////////////////////////////
    PYTH PRICE UPDATES - Spaces' PythPriceFeedAdapter reads whatever
    price is stored on the chain's Pyth contract; someone has to post a
    signed update from Pyth's Hermes service first.
//////////////////////////////////////////////////////////////*/

// PythPriceFeedAdapter.pyth(), and IPyth's getUpdateFee/updatePriceFeeds,
// checked against @pythnetwork/pyth-sdk-solidity 4.3.1's IPyth.sol.
const PYTH_ADAPTER_ABI = [{ type: "function", name: "pyth", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }];
const PYTH_ABI = [
  { type: "function", name: "getUpdateFee", inputs: [{ type: "bytes[]" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "updatePriceFeeds", inputs: [{ type: "bytes[]" }], outputs: [], stateMutability: "payable" },
];

/**
 * Pyth's Hermes price service. Since Pyth's Core upgrade (26 Aug 2026) it
 * answers price requests only with an API key from Pyth Terminal, sent as
 * a Bearer token. PYTH_HERMES_URL and PYTH_API_KEY (per network) set them.
 */
function hermesUrl() {
  return (networkEnv(currentNetwork().id, "PYTH_HERMES_URL") || process.env.PYTH_HERMES_URL || "https://pyth.dourolabs.app/hermes").replace(/\/$/, "");
}

function hermesHeaders() {
  // One key serves every network, so the plain name is the fallback.
  const key = networkEnv(currentNetwork().id, "PYTH_API_KEY") || process.env.PYTH_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** The latest signed update for one price feed from Hermes, and its readable price. */
export async function fetchPythUpdate(priceId) {
  const url = `${hermesUrl()}/v2/updates/price/latest?ids[]=${priceId}&encoding=hex`;
  const res = await fetch(url, { headers: hermesHeaders() });
  if (!res.ok) {
    const hint =
      res.status === 404 ? " - check the feed ID"
      : res.status === 401 ? " - set PYTH_API_KEY to a key from Pyth Terminal"
      : res.status === 403 ? " - this API key's Pyth plan doesn't include that feed"
      : res.status === 429 ? " - rate limited, try again in a minute"
      : "";
    throw new Error(`Pyth's Hermes service answered ${res.status} for feed ${priceId}${hint}.`);
  }
  const body = await res.json();
  const data = body?.binary?.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Pyth's Hermes service returned no update for feed ${priceId}.`);
  const parsed = body.parsed?.[0]?.price;
  // price x 10^expo, exactly (no float rounding): e.g. 312345000000 at -8 -> "3123.45".
  const expo = parsed ? Number(parsed.expo) : 0;
  const price = parsed ? (expo <= 0 ? formatUnits(BigInt(parsed.price), -expo) : (BigInt(parsed.price) * 10n ** BigInt(expo)).toString()) : null;
  return { updates: data.map((d) => (d.startsWith("0x") ? d : `0x${d}`)), price, publishTime: parsed ? Number(parsed.publish_time) : null };
}

/**
 * Posts the latest Pyth price for `priceId` to the Pyth contract behind
 * `oracleAddress`, paying Pyth's update fee from `client`'s wallet.
 * Returns null when the oracle isn't a PythPriceFeedAdapter (nothing to post).
 */
export async function postPythPrice(client, oracleAddress, priceId) {
  if (!oracleAddress || getAddress(oracleAddress) === "0x0000000000000000000000000000000000000000") return null;
  const pyth = await publicClient.readContract({ address: getAddress(oracleAddress), abi: PYTH_ADAPTER_ABI, functionName: "pyth" }).catch(() => null);
  if (!pyth) return null;
  const { updates, price, publishTime } = await fetchPythUpdate(priceId);
  const fee = await publicClient.readContract({ address: pyth, abi: PYTH_ABI, functionName: "getUpdateFee", args: [updates] });
  const hash = await writeWithGasBuffer(client, { address: pyth, abi: PYTH_ABI, functionName: "updatePriceFeeds", args: [updates], value: fee });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, fee, price, publishTime };
}

/*//////////////////////////////////////////////////////////////
    7-10. HUMAN-TRACK RESOLUTION - propose, maybe challenge,
    maybe adjudicate
//////////////////////////////////////////////////////////////*/

/** Proposes what actually happened - human-track only. `outcome`: 1 = Success, 2 = Failure (0 = Unresolved is invalid here). */
export async function proposeResolution(client, governanceAddress, proposalId, outcome) {
  const gov = contractFor(governanceAddress);
  const bond = await bondToken(gov, "resolutionBondAmount");
  await ensureAllowance(client, bond.token, governanceAddress, bond.amount);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "proposeResolution",
    args: [BigInt(proposalId), outcome],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Disputes a proposed resolution within its window, posting a challenge bond. Opens the adjudication vote. */
export async function challengeResolution(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const bond = await bondToken(gov, "challengeBondAmount");
  await ensureAllowance(client, bond.token, governanceAddress, bond.amount);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "challengeResolution", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Finalizes an UNCHALLENGED human-track resolution once its challenge window has passed. */
export async function finalizeUnchallenged(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeUnchallenged", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Votes on the true outcome of a CHALLENGED resolution. `vote`: Outcome
 * - 1 = Success, 2 = Failure. Not a vote on who "wins" directly - bond
 * outcomes are derived afterward by comparing this result to what the
 * resolver originally proposed.
 */
export async function castAdjudicationVote(client, governanceAddress, proposalId, outcome) {
  const gov = contractFor(governanceAddress);
  const args = [BigInt(proposalId), outcome];

  // castAdjudicationVote returns the actual weight cast - same
  // reasoning as castApprovalVote above.
  const { result: weight } = await publicClient.simulateContract({
    ...gov,
    functionName: "castAdjudicationVote",
    args,
    account: client.account,
  });

  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "castAdjudicationVote", args });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash, weight };
}

/** Finalizes adjudication once its voting window closes - determines the true outcome and settles bonds. */
export async function finalizeAdjudication(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeAdjudication", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/*//////////////////////////////////////////////////////////////
    11. FINAL SETTLEMENT
//////////////////////////////////////////////////////////////*/

/** Claims a position's payout once the proposal is Finalized - winning side splits the entire pool proportionally. */
export async function claimPosition(client, governanceAddress, proposalId) {
  const gov = contractFor(governanceAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "claimPosition", args: [BigInt(proposalId)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

// Same defaults as script/CreateSowellianDAO.s.sol, kept in sync deliberately.
const DEFAULT_CONFIG = {
  proposalBondAmount: 100n * 10n ** 18n,
  approvalVotingDelay: 1,
  approvalVotingPeriod: 50_400,
  approvalQuorumBps: 1_000,
  approvalThresholdBps: 6_000,
  positionsWindow: 60n * 60n * 24n * 7n,
  executionTimelockDelay: 60n * 60n * 24n,
  resolutionBondAmount: 100n * 10n ** 18n,
  challengePeriod: 60n * 60n * 24n * 3n,
  challengeBondAmount: 100n * 10n ** 18n,
  adjudicationVotingPeriod: 50_400,
  adjudicationQuorumBps: 1_000,
  adjudicationThresholdBps: 6_000,
  maxOracleStaleness: 60n * 60n,
};

/** Creates a Sowellian-governed DAO via the factory, using the bot's operator wallet. */
export async function createDAO(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const factoryAddress = FACTORY_ADDRESSES.sowellian;
  if (!factoryAddress) {
    throw new Error(`${networkEnvName(currentNetwork().id, "SOWELLIAN_FACTORY_ADDRESS")} is not configured on this bot instance`);
  }

  const factory = { address: getAddress(factoryAddress), abi: factoryAbi };

  const hash = await writeWithGasBuffer(walletClient, {
    ...factory,
    functionName: "createDAO",
    args: [name, symbol, parseEther(String(initialSupplyWhole)), parseEther(String(maxSupplyWhole)), scaleBlockFields("sowellian", DEFAULT_CONFIG)],
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
