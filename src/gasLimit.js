import { encodeFunctionData } from "viem";

/**
 * Picks the gas limit a transaction is sent with: what it really uses
 * plus 15%, or 20% if 15% isn't enough - proven by simulating the call
 * at that limit before anything is signed.
 *
 * Why not just eth_estimateGas plus a big buffer: Monad charges the full
 * gas limit up front, and its estimate has come back wildly high (a Board
 * execute that used ~150k gas was estimated at ~9.94M), so a buffer on
 * top of the estimate multiplies an already-wrong number. Instead:
 *
 * 1. eth_createAccessList simulates the call once and reports the gas it
 *    actually used. Where a node doesn't support it, the smallest limit
 *    the call succeeds within is found by simulating (eth_call) at
 *    halving limits below the estimate, to within 2%.
 * 2. Each candidate limit (that base +15%, +20%, then the estimate +15%,
 *    +20%) is tried with eth_call capped at that limit; the first one the
 *    call succeeds within is used. That catches calls whose real need is
 *    above what they end up using (gas refunds, the 63/64 rule on nested
 *    calls).
 *
 * Used for every chain (Monad, Base, HyperEVM, and Sepolia for the
 * Opportunity Market) so a limit is never a blind guess.
 */

const BUFFERS = [115n, 120n];
const withBuffer = (gas, pct) => (gas * pct + 99n) / 100n;

async function gasUsedBySimulation(publicClient, tx) {
  try {
    const { gasUsed } = await publicClient.createAccessList(tx);
    return gasUsed > 0n ? gasUsed : null;
  } catch {
    return null;
  }
}

async function succeedsWithin(publicClient, tx, gas) {
  try {
    await publicClient.call({ ...tx, gas });
    return true;
  } catch {
    return false;
  }
}

/** The smallest limit (within 2%) the call succeeds within, searched below `estimate`. */
async function smallestPassingLimit(publicClient, tx, estimate) {
  if (!(await succeedsWithin(publicClient, tx, estimate))) return null;
  let lo = 21_000n;
  let hi = estimate;
  while (hi - lo > hi / 50n) {
    const mid = (lo + hi) / 2n;
    if (await succeedsWithin(publicClient, tx, mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The tightest proven limit for `tx` ({account, to?, data, value?}),
 * given the node's own estimate for it.
 */
export async function fitGasLimit(publicClient, tx, estimate) {
  const used = (await gasUsedBySimulation(publicClient, tx)) ?? (await smallestPassingLimit(publicClient, tx, estimate));
  const bases = used !== null && used < estimate ? [used, estimate] : [estimate];
  const candidates = [...new Set(bases.flatMap((b) => BUFFERS.map((pct) => withBuffer(b, pct))))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const gas of candidates) {
    if (await succeedsWithin(publicClient, tx, gas)) return gas;
  }
  // Nothing passed: the call itself is failing (it would fail at any
  // limit), so send at estimate +20% and let the real error surface.
  return withBuffer(estimate, BUFFERS[BUFFERS.length - 1]);
}

/** The raw transaction a contract write sends, for fitGasLimit. */
export function contractTx(account, { address, abi, functionName, args = [], value }) {
  return { account, to: address, data: encodeFunctionData({ abi, functionName, args }), ...(value ? { value } : {}) };
}
