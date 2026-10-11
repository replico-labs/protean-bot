import { formatEther } from "viem";
import { publicClient, walletClient, operatorAccount } from "./config.js";
import { currentNetwork } from "./networks.js";
import { recordGasTopup, isWalletStoreConfigured } from "./walletStore.js";
import { fitGasLimit } from "./gasLimit.js";

/**
 * Gas sponsorship: the operator wallet pays for users' gas, never for the
 * value a user is sending.
 *
 * Monad charges gas_limit x maxFeePerGas up front, so a wallet needs that
 * much before the node will even accept a transaction - an approve with a
 * 98k gas limit at 182 gwei needs ~0.018 MON, whatever it ends up using.
 * A fixed "top up below 0.005 MON" rule left wallets holding between the
 * two stuck: judged funded, rejected every time with "Signer had
 * insufficient balance". So each transaction is funded for its own real
 * worst-case cost, read fresh from the chain right before it is signed,
 * and the fees used for that check are the ones the transaction is sent
 * with.
 *
 * Monad also executes 3 blocks behind consensus. Before including a
 * transaction it checks the wallet can cover the most every one of its
 * transactions from the last 3 blocks could cost (value + gas limit x max
 * fee), not just the new one - so an approve followed at once by the call
 * it approves is refused ("Signer had insufficient balance") unless the
 * balance covers both. And a top-up isn't counted until it's 3 blocks old.
 * So on Monad the bot remembers what each wallet just sent (recordSent)
 * and counts it in, and lets a top-up settle before going on.
 */

const VISIBLE_POLL_MS = 500;
const VISIBLE_TIMEOUT_MS = 20_000;

const isOperator = (address) => operatorAccount && address.toLowerCase() === operatorAccount.address.toLowerCase();

/** The wallet's balance, never cached: always read at the latest block. */
export function freshBalance(address) {
  return publicClient.getBalance({ address, blockTag: "latest" });
}

/*
 * In-flight costs per wallet, on chains that check them (Monad): what each
 * transaction sent in the last few blocks could cost at most.
 */
const inflight = new Map();
const inflightKey = (address) => `${currentNetwork().id}:${address.toLowerCase()}`;

/** The window a sent transaction stays counted: mined in a block or two, then inflightBlocks deep, plus slack. */
const inflightMs = () => {
  const { inflightBlocks, blockTimeMs } = currentNetwork();
  return (inflightBlocks + 3) * blockTimeMs + 2_000;
};

/** Records that `address` just sent a transaction that can cost up to `maxCost` (gas limit x max fee + value). */
export function recordSent(address, maxCost) {
  if (!currentNetwork().inflightBlocks || isOperator(address)) return;
  const key = inflightKey(address);
  const now = Date.now();
  const live = (inflight.get(key) ?? []).filter((t) => t.until > now);
  live.push({ cost: maxCost, until: now + inflightMs() });
  inflight.set(key, live);
}

/** What `address`'s recent transactions can still cost, as far as the chain's balance check is concerned. */
function inflightCost(address) {
  const now = Date.now();
  const live = (inflight.get(inflightKey(address)) ?? []).filter((t) => t.until > now);
  inflight.set(inflightKey(address), live);
  return live.reduce((sum, t) => sum + t.cost, 0n);
}

/** Waits until block `block` is `depth` blocks deep. */
async function waitDepth(block, depth) {
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
  while (Date.now() < deadline && (await publicClient.getBlockNumber({ cacheTime: 0 })) < block + BigInt(depth)) {
    await new Promise((r) => setTimeout(r, VISIBLE_POLL_MS));
  }
}

/** Sends `amount` of the native token from the operator and waits until the new balance is visible to reads. */
async function sendFromOperator(address, amount) {
  const before = await freshBalance(address);
  const hash = await walletClient.sendTransaction({ to: address, value: amount });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The gas top-up transaction failed.");
  // Monad counts a deposit towards the wallet's balance check only once it's inflightBlocks deep.
  const { inflightBlocks } = currentNetwork();
  if (inflightBlocks) await waitDepth(receipt.blockNumber, inflightBlocks);
  // A mined receipt isn't always visible to the next read on a fast chain; wait until it is.
  const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await freshBalance(address)) >= before + amount) return hash;
    await new Promise((r) => setTimeout(r, VISIBLE_POLL_MS));
  }
  return hash;
}

/** Counts a top-up in the wallet's history (for first vs repeat amounts); never blocks a transaction. */
async function countTopup(address) {
  if (!isWalletStoreConfigured()) return null;
  try {
    return await recordGasTopup(address);
  } catch (err) {
    console.error("[gasSponsor] Couldn't record top-up history:", err.message);
    return null;
  }
}

/**
 * Sends a new wallet its first gas allowance (0.1 MON on Monad, the
 * network's `gas.first` elsewhere) as soon as it's created, so its first
 * transaction never waits on a top-up. Never throws: a failed top-up here
 * is retried by ensureCanAfford when the wallet first transacts.
 */
export async function fundNewWallet(address) {
  if (!walletClient || !operatorAccount || isOperator(address)) return;
  try {
    const { gas } = currentNetwork();
    if ((await freshBalance(address)) >= gas.first) return;
    await sendFromOperator(address, gas.first);
    await countTopup(address);
  } catch (err) {
    console.error(`[gasSponsor] Couldn't fund new wallet ${address}:`, err.shortMessage || err.message);
  }
}

/**
 * Makes sure `address` can pay `gasCost` (gas limit x max fee) on top of
 * `value`. Tops up the gas shortfall from the operator, with headroom so
 * the next few transactions don't each need a top-up, but never the value
 * itself: a user sending more than they hold gets a clear error instead.
 */
export async function ensureCanAfford(address, gasCost, value = 0n) {
  if (isOperator(address)) return;
  const symbol = currentNetwork().nativeSymbol;
  const balance = await freshBalance(address);
  if (value > balance) {
    throw new Error(`Your wallet has ${formatEther(balance)} ${symbol}, but this sends ${formatEther(value)} ${symbol}.`);
  }
  // On Monad, what this wallet sent in the last few blocks counts too.
  const pending = inflightCost(address);
  if (balance >= gasCost + value + pending) return;
  if (!walletClient || !operatorAccount) {
    throw new Error(`Your wallet needs up to ${formatEther(gasCost)} ${symbol} for gas and has ${formatEther(balance - value)} ${symbol} to spare - add some and try again.`);
  }

  const { gas } = currentNetwork();
  const shortfall = gasCost + value + pending - balance;
  const history = await countTopup(address);
  const allowance = history === null || history <= 1 ? gas.first : gas.repeat;
  const amount = shortfall * 2n > allowance ? shortfall * 2n : allowance;
  await sendFromOperator(address, amount);

  const after = await freshBalance(address);
  if (after < gasCost + value + pending) {
    throw new Error(`The gas top-up hasn't reached your wallet yet (${formatEther(after)} ${symbol}). Try again in a few seconds.`);
  }
}

// Some nodes cap eth_estimateGas at what the sender's balance can pay for, so
// an underfunded wallet fails to even estimate. This much gas covers the
// bot's ordinary calls for a retry after funding.
const ESTIMATE_FUNDING_GAS = 1_000_000n;
const unaffordable = (err) => /exceeds allowance|insufficient funds|exceeds the balance|insufficient balance/i.test(`${err.shortMessage || ""} ${err.details || ""} ${err.message}`);

/** estimateContractGas, funding the wallet and retrying once if the node refused because the wallet couldn't pay. */
export async function estimateWithFunding(client, contractParams) {
  const params = { ...contractParams, account: client.account };
  try {
    return await publicClient.estimateContractGas(params);
  } catch (err) {
    if (bareRevert(err)) return publicClient.estimateContractGas({ ...params, account: client.account.address }).catch(() => Promise.reject(err));
    if (!unaffordable(err) || isOperator(client.account.address)) throw err;
    const { gasCost } = await feesFor(ESTIMATE_FUNDING_GAS);
    await ensureCanAfford(client.account.address, gasCost, contractParams.value ?? 0n);
    return publicClient.estimateContractGas(params);
  }
}

/** estimateGas for a raw transaction (e.g. a contract deployment), funding and retrying the same way. */
export async function estimateTxWithFunding(client, tx, fundingGas = ESTIMATE_FUNDING_GAS) {
  const params = { ...tx, account: client.account };
  try {
    return await publicClient.estimateGas(params);
  } catch (err) {
    if (bareRevert(err)) return publicClient.estimateGas({ ...params, account: client.account.address }).catch(() => Promise.reject(err));
    if (!unaffordable(err) || isOperator(client.account.address)) throw err;
    const { gasCost } = await feesFor(fundingGas);
    await ensureCanAfford(client.account.address, gasCost, tx.value ?? 0n);
    return publicClient.estimateGas(params);
  }
}

// viem sends a local account's estimate with fees, and some nodes (anvil
// among them) then cap its gas at what the balance pays for and report
// running out as a revert with no reason - not as "insufficient funds".
// Asked again without fees (the account as a bare address), the node
// estimates the call itself; funding for that limit happens afterwards.
const bareRevert = (err) => {
  const text = `${err.shortMessage || ""} ${err.details || ""} ${err.message}`;
  return /execution reverted/i.test(text) && !/following (signature|reason)|custom error|reason:/i.test(text);
};

/** Current fees, and the up-front cost of a transaction with this gas limit at them. */
export async function feesFor(gasLimit) {
  const fees = await publicClient.estimateFeesPerGas();
  return { fees, gasCost: gasLimit * fees.maxFeePerGas };
}

/**
 * Sends native currency from a user's wallet, funding its gas (not the
 * amount) first. Used by tips and transfers.
 */
export async function sendNativeSponsored(client, to, value) {
  const tx = { account: client.account, to, value };
  const estimate = await estimateTxWithFunding(client, { to, value });
  // A plain transfer to a wallet is exactly 21000; a contract recipient
  // runs code, so the limit is proven by simulation like any other call.
  const gasLimit = await fitGasLimit(publicClient, tx, estimate);
  const { fees, gasCost } = await feesFor(gasLimit);
  await ensureCanAfford(client.account.address, gasCost, value);
  const hash = await client.sendTransaction({ to, value, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  recordSent(client.account.address, gasCost + value);
  return hash;
}
