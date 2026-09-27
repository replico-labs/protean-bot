import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWalletClient, http, getAddress, parseEther, parseAbi, encodeFunctionData } from "viem";
import { publicClient, monadTestnet, writeWithGasBuffer } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "..", "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

/**
 * Builds a wallet client for `account`, matching contracts.js's own
 * walletClientFor exactly - every adapter function and common.js's own
 * stake/unstake expect an already-built client, not a raw account, so
 * callers (index.js's command handlers) build this once per command and
 * pass it to whichever adapter function they need.
 */
export function walletClientFor(account) {
  return createWalletClient({ account, chain: monadTestnet, transport: http() });
}

const abis = {
  StakedGovernanceToken: loadAbi("StakedGovernanceToken"),
  GovernanceToken: loadAbi("GovernanceToken"),
};

// Models with no token concept at all - currently just Board. Kept as
// an explicit list rather than inferred from GOVERNANCE_ABI_BY_MODEL's
// absence, since that table's purpose (which models have a known
// governance ABI) is conceptually different from "which models have a
// token," even though today they happen to coincide.
const TOKENLESS_MODELS = ["board"];

/** Whether `model` has a token/staking concept at all. */
export function hasToken(model) {
  return !TOKENLESS_MODELS.includes(model);
}

// Maps a model name to its own governance contract's ABI - used only for
// the one universal read below, not a general-purpose registry (that's
// index.js's job).
const GOVERNANCE_ABI_BY_MODEL = {
  tokenWeighted: loadAbi("Governance"),
  quadratic: loadAbi("QuadraticGovernance"),
  liquid: loadAbi("LiquidGovernance"),
  optimistic: loadAbi("OptimisticGovernance"),
  delegate: loadAbi("DelegateGovernance"),
  sortition: loadAbi("SortitionGovernance"),
  conviction: loadAbi("ConvictionGovernance"),
  sowellian: loadAbi("SowellianGovernance"),
  decisionMarkets: loadAbi("DecisionMarketsGovernance"),
};

// The only genuine per-model difference in getDaoInfo below: which
// function name holds the full config struct. Confirmed directly from
// source that the struct's fields themselves are identical
// (quorumBps/approvalThresholdBps/votingDelay/votingPeriod/timelockDelay/
// executionPeriod/proposalThreshold, same types, same order) - only the
// function name differs, so this one small map is all that's needed
// rather than a fully separate getDaoInfo per model.
const CONFIG_FUNCTION_BY_MODEL = {
  tokenWeighted: "governanceConfig",
  quadratic: "config",
  liquid: "config",
  optimistic: "config",
  delegate: "config",
  sortition: "config",
  conviction: "config",
  sowellian: "config",
  decisionMarkets: "config",
};

/**
 * Reads governanceToken() - confirmed present, with this exact name,
 * on every model's governance contract, unlike the full config struct
 * (governanceConfig() vs config(), genuinely different field sets per
 * model) - this narrow helper exists specifically to avoid needing a
 * fully model-aware getDaoInfo just to answer "which staking wrapper
 * does this DAO use," which is all /stake and /unstake actually need.
 */
export async function getGovernanceTokenAddress(model, governanceAddress) {
  const abi = GOVERNANCE_ABI_BY_MODEL[model];
  if (!abi) throw new Error(`No ABI registered for model "${model}"`);
  return publicClient.readContract({ address: getAddress(governanceAddress), abi, functionName: "governanceToken" });
}

/**
 * Model-aware replacement for contracts.js's original getDaoInfo -
 * daoName, governanceToken, and treasury are confirmed universal across
 * every model, so those three reads are identical regardless of model.
 * Only the config struct's function name actually varies - see
 * CONFIG_FUNCTION_BY_MODEL above for why a full per-model reimplementation
 * isn't needed for this specific piece.
 */
export async function getDaoInfo(model, governanceAddress) {
  const abi = GOVERNANCE_ABI_BY_MODEL[model];
  if (!abi) throw new Error(`No ABI registered for model "${model}"`);
  const gov = { address: getAddress(governanceAddress), abi };
  const configFunctionName = CONFIG_FUNCTION_BY_MODEL[model];
  if (!configFunctionName) throw new Error(`No config function name registered for model "${model}"`);

  const [daoName, tokenAddress, treasuryAddress, config] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "daoName" }),
    publicClient.readContract({ ...gov, functionName: "governanceToken" }),
    publicClient.readContract({ ...gov, functionName: "treasury" }),
    publicClient.readContract({ ...gov, functionName: configFunctionName }),
  ]);

  return { daoName, tokenAddress, treasuryAddress, config };
}

// Mirrors ProposalState's enum ordering - confirmed identical across
// every model that declares it (Types.sol and each model's own copy),
// not assumed. If a future model's ordering ever diverges, this needs
// to become per-adapter instead of shared.
export const PROPOSAL_STATE_LABELS = [
  "Pending",
  "Active",
  "Succeeded",
  "Queued",
  "Defeated",
  "Executed",
  "Cancelled",
  "Expired",
];

/**
 * Approves and stakes `amountWhole` of the underlying token into the
 * staking wrapper, signed by whichever account `client` was built for.
 * Two on-chain transactions: approve, then stake. Identical for every
 * token-based governance model - which governance contract eventually
 * reads this staked balance is irrelevant here.
 */
export async function stakeTokens(client, stakingTokenAddress, amountWhole) {
  const amount = parseEther(String(amountWhole));

  const underlyingAddress = await publicClient.readContract({
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "underlying",
  });

  const approveHash = await writeWithGasBuffer(client, {
    address: underlyingAddress,
    abi: abis.GovernanceToken,
    functionName: "approve",
    args: [getAddress(stakingTokenAddress), amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  const stakeHash = await writeWithGasBuffer(client, {
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "stake",
    args: [amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: stakeHash });

  return { approveHash, stakeHash };
}

/**
 * Unstakes `amountWhole` back to the underlying, liquid token, signed by
 * `account`. New - the bot did not previously expose this at all.
 */
export async function unstakeTokens(client, stakingTokenAddress, amountWhole) {
  const amount = parseEther(String(amountWhole));

  const hash = await writeWithGasBuffer(client, {
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "unstake",
    args: [amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { hash };
}
const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
];

/**
 * Approves `spender` to pull `amount` of `tokenAddress` from the caller,
 * if the current allowance is lower. Every governance action that posts a
 * bond or seed (Optimistic challenge, Sowellian bonds and positions,
 * Decision Markets seeding and trading) pulls tokens with transferFrom,
 * so without this the contract call always reverts. Same two-step,
 * wait-for-receipt pattern as stakeTokens above.
 */
export async function ensureAllowance(client, tokenAddress, spender, amount) {
  if (amount === 0n) return null;
  const token = getAddress(tokenAddress);
  const current = await publicClient.readContract({
    address: token,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [client.account.address, getAddress(spender)],
  });
  if (current >= amount) return null;
  const hash = await writeWithGasBuffer(client, { address: token, abi: ERC20_ALLOWANCE_ABI, functionName: "approve", args: [getAddress(spender), amount] });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/**
 * One cheap read per model that only a real deployment of that model
 * answers - a view function no other model has (the call reverts on
 * any other model's contract). Optimistic has no unique view function,
 * so it's identified by its config() struct being exactly 8 words.
 */
const MODEL_FINGERPRINTS = {
  tokenWeighted: { sig: "function governanceConfig() view returns (uint256)", args: [] },
  quadratic: { sig: "function previewWeight(address) view returns (uint256)", args: ["0x0000000000000000000000000000000000000000"] },
  liquid: { sig: "function MAX_CHAIN_DEPTH() view returns (uint256)", args: [] },
  delegate: { sig: "function electionCount() view returns (uint256)", args: [] },
  board: { sig: "function getSigners() view returns (address[])", args: [] },
  sortition: { sig: "function sortitionRound() view returns (uint256)", args: [] },
  conviction: { sig: "function totalSupport(uint256) view returns (uint256)", args: [0n] },
  sowellian: { sig: "function yesPosition(uint256,address) view returns (uint256)", args: [0n, "0x0000000000000000000000000000000000000000"] },
  decisionMarkets: { sig: "function wmon() view returns (address)", args: [] },
  optimistic: { sig: "function config() view returns (uint256)", args: [], words: 8 },
};

/**
 * Whether `governanceAddress` is really a deployment of `model` - used
 * before linking a chat to an address someone typed, so a DAO can't be
 * registered under the wrong model (every model has governanceToken(),
 * so that alone proves nothing, and Board has no token at all).
 */
export async function isGovernanceModel(model, governanceAddress) {
  const fp = MODEL_FINGERPRINTS[model];
  if (!fp) return false;
  const [item] = parseAbi([fp.sig]);
  try {
    const { data } = await publicClient.call({
      to: getAddress(governanceAddress),
      data: encodeFunctionData({ abi: [item], functionName: item.name, args: fp.args }),
    });
    if (!data || data === "0x") return false;
    return fp.words === undefined ? true : (data.length - 2) / 64 === fp.words;
  } catch {
    return false;
  }
}
