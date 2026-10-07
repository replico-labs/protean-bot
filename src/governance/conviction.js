import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseEther, formatEther, formatUnits, decodeFunctionData, parseAbi, zeroAddress } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer } from "../config.js";
import { currentNetwork, networkEnvName } from "../networks.js";

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

  // Spending budgets (BUDGET_VERSION 2): declare what the actions may take
  // from the Treasury, or execution reverts the moment a listed asset leaves.
  const budget = (await hasBudgets(governanceAddress)) ? await deriveBudget(governanceAddress, actions) : null;
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    ...(budget ? { functionName: "proposeWithBudget", args: [actions, metadataURI, budget] } : { functionName: "propose", args: [actions, metadataURI] }),
  });
  await publicClient.waitForTransactionReceipt({ hash });

  const proposalId = await publicClient.readContract({ ...gov, functionName: "proposalCount" });

  return { hash, proposalId, budget };
}

/*//////////////////////////////////////////////////////////////
    SPENDING BUDGETS - ConvictionGovernance BUDGET_VERSION 2
//////////////////////////////////////////////////////////////*/

const budgetVersions = new Map();

/** Whether this DAO checks spending budgets (DAOs from the newer factory). */
export async function hasBudgets(governanceAddress) {
  const key = `${currentNetwork().id}:${getAddress(governanceAddress)}`;
  if (!budgetVersions.has(key)) {
    const version = await publicClient
      .readContract({ ...contractFor(governanceAddress), functionName: "BUDGET_VERSION" })
      .catch(() => 0n);
    budgetVersions.set(key, Number(version));
  }
  return budgetVersions.get(key) >= 2;
}

// How a proposal can take assets from the Treasury - checked against
// Treasury.sol and the ERC20 standard.
const TREASURY_SPEND_ABI = parseAbi([
  "function transferETH(address recipient, uint256 amount)",
  "function transferERC20(address token, address recipient, uint256 amount)",
  "function execute(address target, uint256 value, bytes data)",
]);
const TOKEN_SPEND_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount)",
]);

function decodeOrNull(abi, data) {
  try {
    return decodeFunctionData({ abi, data });
  } catch {
    return null;
  }
}

/**
 * The most each listed asset can leave the Treasury through these
 * actions: native sent by transferETH or with an execute call, and
 * tokens moved by transferERC20 or approved/transferred through
 * execute. An approval caps what a protocol can pull (the contract
 * revokes whatever is left afterwards), so it's the budget for that
 * leg even if less is used. Only listed assets go in - the contract
 * rejects anything else.
 */
export async function deriveBudget(governanceAddress, actions) {
  const gov = contractFor(governanceAddress);
  const [treasury, [assets]] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "treasury" }),
    publicClient.readContract({ ...gov, functionName: "listedAssets" }),
  ]);
  const listed = new Set(assets.map((a) => a.toLowerCase()));
  const totals = new Map();
  const add = (asset, amount) => {
    const key = asset.toLowerCase();
    if (amount > 0n && listed.has(key)) totals.set(key, (totals.get(key) ?? 0n) + amount);
  };

  for (const action of actions) {
    if (getAddress(action.target) !== getAddress(treasury)) continue;
    const call = decodeOrNull(TREASURY_SPEND_ABI, action.data);
    if (!call) continue;
    if (call.functionName === "transferETH") add(zeroAddress, call.args[1]);
    else if (call.functionName === "transferERC20") add(call.args[0], call.args[2]);
    else {
      const [target, value, inner] = call.args;
      add(zeroAddress, value);
      const tokenCall = decodeOrNull(TOKEN_SPEND_ABI, inner);
      if (tokenCall) add(target, tokenCall.args[1]);
    }
  }
  return [...totals].map(([asset, amount]) => ({ asset: getAddress(asset), amount }));
}

const ASSET_META_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);

async function assetMeta(asset) {
  if (asset === zeroAddress) return { symbol: currentNetwork().nativeSymbol, decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: asset, abi: ASSET_META_ABI, functionName: "symbol" }).catch(() => `${asset.slice(0, 8)}…`),
    publicClient.readContract({ address: asset, abi: ASSET_META_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  return { symbol, decimals: Number(decimals) };
}

async function holdingOf(asset, holder) {
  return asset === zeroAddress
    ? publicClient.getBalance({ address: holder })
    : publicClient.readContract({ address: asset, abi: ASSET_META_ABI, functionName: "balanceOf", args: [holder] });
}

/** "10 USDC, 0.5 MON" - a budget in readable units. */
export async function describeBudget(budget) {
  const parts = await Promise.all(
    budget.map(async ({ asset, amount }) => {
      const { symbol, decimals } = await assetMeta(getAddress(asset));
      return `${formatUnits(amount, decimals)} ${symbol}`;
    })
  );
  return parts.join(", ");
}

/**
 * The DAO's listed assets: weight (extra conviction to spend all of it),
 * what the Treasury holds, and any weight cut or removal waiting out its
 * delay.
 */
export async function getAssets(governanceAddress) {
  const gov = contractFor(governanceAddress);
  const [treasury, [assets, weights]] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "treasury" }),
    publicClient.readContract({ ...gov, functionName: "listedAssets" }),
  ]);
  return Promise.all(
    assets.map(async (asset, i) => {
      const [meta, holding, pending] = await Promise.all([
        assetMeta(asset),
        holdingOf(asset, treasury),
        publicClient.readContract({ ...gov, functionName: "pendingAssetChange", args: [asset] }),
      ]);
      const [pendingWeight, effectiveAt, remove] = pending;
      return {
        asset,
        ...meta,
        weight: formatEther(weights[i]),
        holding: formatUnits(holding, meta.decimals),
        pending: Number(effectiveAt) ? { weight: formatEther(pendingWeight), effectiveAt: Number(effectiveAt), remove } : null,
      };
    })
  );
}

/** Applies a weight cut or removal whose delay has passed. Anyone may. */
export async function applyAssetChange(client, governanceAddress, asset) {
  const hash = await writeWithGasBuffer(client, { ...contractFor(governanceAddress), functionName: "applyAssetChange", args: [getAddress(asset)] });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
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

  let budget;
  if (await hasBudgets(governanceAddress)) {
    const [entries, weakens] = await Promise.all([
      publicClient.readContract({ ...gov, functionName: "proposalBudget", args: [BigInt(proposalId)] }),
      publicClient.readContract({ ...gov, functionName: "weakensRules", args: [BigInt(proposalId)] }),
    ]);
    budget = { text: entries.length ? await describeBudget(entries) : null, weakensRules: weakens };
  }

  return {
    ...proposal,
    budget,
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
    throw new Error(`${networkEnvName(currentNetwork().id, "CONVICTION_FACTORY_ADDRESS")} is not configured on this bot instance`);
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