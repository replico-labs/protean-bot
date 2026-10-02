import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress, parseUnits, formatUnits } from "viem";
import { opportunityPublicClient, writeWithGasBuffer } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const marketAbi = loadAbi("OpportunityMarket");
const factoryAbi = loadAbi("OpportunityMarketFactory");

export function marketContract(address) {
  return { address: getAddress(address), abi: marketAbi };
}

/** The market's real deployer address - used to gate deployer-only bot actions that never make an on-chain call themselves (so the contract's own onlyDeployer can't protect them). */
export async function getDeployer(marketAddress) {
  const gov = marketContract(marketAddress);
  return opportunityPublicClient.readContract({ ...gov, functionName: "deployer" });
}

function factoryContract(address) {
  return { address: getAddress(address), abi: factoryAbi };
}

/** Whether `marketAddress` was created by this factory - a matching ABI alone proves nothing, since anyone can deploy their own OpportunityMarket (or a lookalike) outside it. */
export async function isFactoryMarket(factoryAddress, marketAddress) {
  const factory = factoryContract(factoryAddress);
  return opportunityPublicClient.readContract({ ...factory, functionName: "isMarket", args: [getAddress(marketAddress)] });
}

/**
 * Non-encrypted actions for OpportunityMarket. Two things genuinely
 * live elsewhere, not here: back() (placing a confidential bet) is in
 * encryptedBet.js, and getBalance()/getBet() (reading a user's own
 * encrypted values back as cleartext) are in decrypt.js - both need
 * real @zama-fhe/relayer-sdk machinery (client-side encryption and
 * userDecrypt respectively), a different kind of dependency from
 * everything else here, worth keeping visibly separate rather than
 * folded into this file. getAllBets() still has no equivalent anywhere
 * - it returns every bettor's encrypted handles at once (for the
 * deployer's own statistics), not a single user's own values, so it
 * doesn't fit userDecrypt's per-user authorization model the same way.
 *
 * Everything below is either a plain-value action (no encryption
 * involved) or a proof-completion call using bytes already produced by
 * Zama's own relayer service - neither needs client-side encryption to
 * construct.
 */

/** Deploys a new, independent market via the factory - anyone can call this, becoming that market's deployer. */
export async function createMarket(client, factoryAddress, underlyingTokenAddress) {
  const factory = factoryContract(factoryAddress);

  const hash = await writeWithGasBuffer(client, {
    ...factory,
    functionName: "createMarket",
    args: [getAddress(underlyingTokenAddress)],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });

  const marketCount = await opportunityPublicClient.readContract({ ...factory, functionName: "marketCount" });
  const [markets] = await opportunityPublicClient.readContract({
    ...factory,
    functionName: "getMarkets",
    args: [marketCount - 1n, 1n],
  });

  return { hash, marketAddress: markets };
}

/** Lists a new opportunity for people to back. Metadata only, no funds involved. */
export async function listOpportunity(client, marketAddress, metadataURI) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "listOpportunity", args: [metadataURI] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });

  const id = await opportunityPublicClient.readContract({ ...gov, functionName: "opportunityCount" }).catch(() => null);
  return { hash, id };
}

const ERC20_DECIMALS_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
];

const ERC20_ALLOWANCE_ABI = [
  { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

/**
 * Approves `spenderAddress` to pull `amountRaw` of `tokenAddress` from
 * `client`'s own wallet, but only if its current allowance is actually
 * insufficient - avoids a redundant, gas-wasting approval transaction
 * on every call when a prior approval already covers this amount.
 * Missing this step entirely is exactly what caused deposit() and
 * fundRewardPool() to revert with "ERC20: transfer amount exceeds
 * allowance" - both do a plain transferFrom() internally, which
 * requires this approval to exist first; nothing does this implicitly.
 */
async function ensureAllowance(client, tokenAddress, spenderAddress, amountRaw) {
  const token = { address: getAddress(tokenAddress), abi: ERC20_ALLOWANCE_ABI };
  const currentAllowance = await opportunityPublicClient.readContract({
    ...token,
    functionName: "allowance",
    args: [client.account.address, getAddress(spenderAddress)],
  });
  if (currentAllowance >= amountRaw) return;

  const hash = await writeWithGasBuffer(client, {
    ...token,
    functionName: "approve",
    args: [getAddress(spenderAddress), amountRaw],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
}

/**
 * Exported so encryptedBet.js can reuse this for back()'s amount too,
 * keeping decimal handling consistent across every action that moves
 * the underlying token, rather than duplicating this lookup.
 */
export async function getUnderlyingDecimals(marketAddress) {
  const gov = marketContract(marketAddress);
  const tokenAddress = await opportunityPublicClient.readContract({ ...gov, functionName: "underlyingToken" });
  return opportunityPublicClient.readContract({
    address: tokenAddress,
    abi: ERC20_DECIMALS_ABI,
    functionName: "decimals",
  });
}

/** The market's real underlying token address - kept separate from getUnderlyingDecimals so that widely-used function's return shape never changes. */
export async function getUnderlyingTokenAddress(marketAddress) {
  const gov = marketContract(marketAddress);
  return opportunityPublicClient.readContract({ ...gov, functionName: "underlyingToken" });
}

const MAX_ENCRYPTED = (1n << 64n) - 1n;

/** A refusal shown to the user as is. */
export class MarketAmountError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

/**
 * Amounts are encrypted as 64-bit integers, so one amount can't exceed
 * 2^64 - 1 raw units (~18.4 tokens at 18 decimals, ~18 trillion at 6).
 * The updated contract reverts AmountTooLarge; markets from the earlier
 * implementation silently truncated - either way, refuse here first.
 */
function requireFitsEncrypted(amount, decimals) {
  if (amount > MAX_ENCRYPTED) {
    throw new MarketAmountError(
      `That's more than one encrypted amount can hold (${formatUnits(MAX_ENCRYPTED, decimals)} of this token). Markets work best with a 6-decimal stablecoin such as USDC.`
    );
  }
}

/**
 * Deposits `amountWhole` of the underlying token into the market -
 * separate from backing an opportunity. This initial deposit is
 * publicly visible on-chain (a plain ERC20 transferFrom), confirmed
 * from source - only which opportunity is later backed, and how much
 * of this deposit, stays encrypted. Decimals are read automatically
 * from the real underlying token, not assumed or caller-supplied - a
 * wrong manual value here would silently deposit the wrong amount.
 */
export async function deposit(client, marketAddress, amountWhole) {
  const gov = marketContract(marketAddress);
  const decimals = await getUnderlyingDecimals(marketAddress);
  const amount = parseUnits(String(amountWhole), decimals);
  requireFitsEncrypted(amount, decimals);

  const tokenAddress = await getUnderlyingTokenAddress(marketAddress);
  await ensureAllowance(client, tokenAddress, marketAddress, amount);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "deposit",
    args: [amount],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Deployer-only: funds the reward pool paid out to backers of the eventual winning opportunity. Decimals auto-detected, same reasoning as deposit(). */
export async function fundRewardPool(client, marketAddress, amountWhole) {
  const gov = marketContract(marketAddress);
  const decimals = await getUnderlyingDecimals(marketAddress);
  const amount = parseUnits(String(amountWhole), decimals);
  requireFitsEncrypted(amount, decimals);

  const tokenAddress = await getUnderlyingTokenAddress(marketAddress);
  await ensureAllowance(client, tokenAddress, marketAddress, amount);

  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "fundRewardPool",
    args: [amount],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Deployer-only: cancels the market before resolution, refunding the reward pool. */
export async function cancelMarket(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "cancelMarket", args: [] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Deployer-only: declares which opportunity turned out to be real. */
export async function resolve(client, marketAddress, winningOpportunityId) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "resolve",
    args: [BigInt(winningOpportunityId)],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Reclaims a backer's original stake after resolution or cancellation - the stake itself, not any reward. */
export async function reclaimStake(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "reclaimStake", args: [] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/**
 * Kicks off the public reveal of the aggregate winning-side total -
 * the one number the whole system deliberately makes public, so each
 * backer's own private stake can later be divided against it (see
 * OpportunityMarket.sol's own doc comment on why: encrypted-by-
 * encrypted division isn't supported by the FHE library at all).
 * Returns the real handle finalizeWinningTotal() returns on-chain -
 * captured via simulateContract before sending, since a write
 * transaction's return value isn't otherwise directly observable from
 * its hash or receipt. publicReveal.js's revealAndCompleteWinningTotal
 * uses this handle to finish the reveal.
 */
export async function finalizeWinningTotal(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const { result: handle } = await opportunityPublicClient.simulateContract({
    ...gov,
    functionName: "finalizeWinningTotal",
    account: client.account,
  });
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "finalizeWinningTotal", args: [] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, handle };
}

/**
 * Completes a pending reveal or withdrawal using the cleartext and
 * proof Zama's relayer produced for a given handle. Plain bytes
 * parameters - no new client-side encryption needed here, this is
 * finishing a decrypt, not starting one.
 */
export async function completeWinningTotalReveal(client, marketAddress, abiEncodedCleartext, decryptionProof) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "completeWinningTotalReveal",
    args: [abiEncodedCleartext, decryptionProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Computes the caller's own reward, once the winning total has been finalized. */
export async function computeReward(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "computeReward", args: [] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Requests withdrawal of the caller's (already-computed, still-encrypted) stake balance. Returns the real on-chain handle, same simulate-then-write pattern as finalizeWinningTotal. */
export async function requestWithdrawal(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const { result: handle } = await opportunityPublicClient.simulateContract({
    ...gov,
    functionName: "requestWithdrawal",
    account: client.account,
  });
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "requestWithdrawal", args: [] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, handle };
}

/** Requests withdrawal of the caller's (already-computed, still-encrypted) reward balance. Returns the real on-chain handle, same pattern. */
export async function requestRewardWithdrawal(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const { result: handle } = await opportunityPublicClient.simulateContract({
    ...gov,
    functionName: "requestRewardWithdrawal",
    account: client.account,
  });
  const hash = await writeWithGasBuffer(client, { ...gov, functionName: "requestRewardWithdrawal", args: [] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, handle };
}

/** Completes a pending withdrawal using the cleartext and proof for `handle`. Plain bytes, same reasoning as completeWinningTotalReveal. */
export async function completeWithdrawal(client, marketAddress, handle, abiEncodedCleartext, decryptionProof) {
  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "completeWithdrawal",
    args: [handle, abiEncodedCleartext, decryptionProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/*//////////////////////////////////////////////////////////////
    back(), getBalance(), getBet() all now have real
    implementations - see encryptedBet.js and decrypt.js
//////////////////////////////////////////////////////////////*/