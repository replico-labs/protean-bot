import { encodeFunctionData, getAddress, isAddress, parseUnits, formatUnits, erc20Abi, zeroAddress } from "viem";
import { isNativeTokenWord } from "../networks.js";

/**
 * Shared plumbing for external-protocol actions (src/integrations/*).
 *
 * An integration action never calls a protocol from the governance
 * contract directly: the DAO's money sits in its Treasury, so each step
 * is a Treasury.execute(target, value, data) call - the protocol sees
 * the Treasury as msg.sender and pays/receives from it. A few steps go
 * through the DAO's NFT wrapper instead (NFT custody - see opensea.js).
 * proposalBuilder.js turns these calls into proposal actions and routes
 * them through a GuardWrapper when the Treasury has been handed over.
 */

export const NATIVE = zeroAddress;

export class IntegrationError extends Error {}

/**
 * Deployment addresses are stored lowercase, exactly as copied from their
 * sources (never re-typed with a checksum by hand); this checksums every
 * 0x string field for use.
 */
export function checksummed(deployment) {
  return Object.fromEntries(
    Object.entries(deployment).map(([k, v]) => [k, typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : v])
  );
}

/** One step of an integration action. `via` is who makes the call: the Treasury (default) or the NFT wrapper. */
export function call(target, data, { value = 0n, via = "treasury", note } = {}) {
  return { target: getAddress(target), data, value: BigInt(value), via, note };
}

export function approveCall(token, spender, amount, note) {
  return call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(spender), amount] }), {
    note: note ?? "approve",
  });
}

/**
 * Resolves a token word from a command: "native" or the chain's native
 * symbol (MON/ETH/HYPE) -> NATIVE, a 0x address, a symbol from the
 * protocol's own verified token list, or a ticker the chat registered
 * with /registertoken (ctx.lookupTicker).
 */
export function resolveToken(word, ctx, knownTokens = {}) {
  if (!word) throw new IntegrationError("Missing token.");
  if (isNativeTokenWord(word)) return NATIVE;
  if (isAddress(word)) return getAddress(word.toLowerCase());
  const key = Object.keys(knownTokens).find((k) => k.toUpperCase() === word.toUpperCase());
  if (key) return getAddress(knownTokens[key]);
  const registered = ctx.lookupTicker?.(word);
  if (registered) return getAddress(registered);
  throw new IntegrationError(`Unknown token "${word}" - use its 0x address, "native", or register it with /registertoken.`);
}

export async function tokenDecimals(ctx, token) {
  if (token === NATIVE) return 18;
  return Number(await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
}

export async function tokenSymbol(ctx, token) {
  if (token === NATIVE) return ctx.network.nativeSymbol;
  try {
    return await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" });
  } catch {
    return `${token.slice(0, 6)}…`;
  }
}

/** "1.5" -> base units for `token`. Rejects zero and negatives. */
export async function parseAmount(ctx, token, text, { allowZero = false } = {}) {
  if (!/^\d+(\.\d+)?$/.test(String(text ?? ""))) throw new IntegrationError(`"${text}" isn't an amount - use a plain number like 1.5`);
  const decimals = await tokenDecimals(ctx, token);
  const amount = parseUnits(String(text), decimals);
  if (amount === 0n && !allowZero) throw new IntegrationError("Amount must be more than 0.");
  return amount;
}

/** An estimate for display: 6 significant digits, no trailing zeros (9.00000 -> 9). */
export function approxUnits(value, decimals = 18) {
  return String(Number(Number(formatUnits(value, decimals)).toPrecision(6)));
}

/** "1.5 USDC". With approx, rounds to 6 significant digits for estimates (e.g. 99.9999999999996 -> 100). */
export async function formatAmount(ctx, token, amount, { approx = false } = {}) {
  const text = formatUnits(amount, await tokenDecimals(ctx, token));
  const shown = approx ? String(Number(Number(text).toPrecision(6))) : text;
  return `${shown} ${await tokenSymbol(ctx, token)}`;
}

/** "30d", "12h", "90m" or plain seconds -> seconds. */
export function parseDuration(text, fallbackSeconds) {
  if (text === undefined) return fallbackSeconds;
  const m = /^(\d+)([smhd]?)$/.exec(String(text));
  if (!m) throw new IntegrationError(`"${text}" isn't a duration - use e.g. 30d, 12h or 3600.`);
  return Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

/** "1%" / "0.5%" -> basis points. */
export function parsePercentBps(text, fallbackBps) {
  if (text === undefined) return fallbackBps;
  const m = /^(\d+(\.\d+)?)%?$/.exec(String(text));
  if (!m) throw new IntegrationError(`"${text}" isn't a percentage - use e.g. 1%.`);
  const bps = Math.round(Number(m[1]) * 100);
  if (bps < 0 || bps > 10_000) throw new IntegrationError("Percentage must be between 0% and 100%.");
  return bps;
}

/** `amount` reduced by `bps` basis points (for a minimum-out from a quote). */
export function minusBps(amount, bps) {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Deadline for calls that take one. A proposal executes only after its
 * vote and timelock, so this is measured from when it's proposed and
 * defaults to 30 days - long enough to cover any model's voting and
 * timelock, short enough that a stale proposal can't execute at a price
 * nobody agreed to (the minimum-out still guards the price itself).
 */
export async function deadlineFrom(ctx, options) {
  const seconds = parseDuration(options.deadline, 30 * 86400);
  const block = await ctx.publicClient.getBlock();
  return block.timestamp + BigInt(seconds);
}

/** Throws unless every address has contract code on the chat's network - catches a wrong-network or mistyped address before a vote is wasted on it. */
export async function requireCode(ctx, addresses) {
  for (const [label, address] of Object.entries(addresses)) {
    const code = await ctx.publicClient.getCode({ address });
    if (!code || code === "0x") {
      throw new IntegrationError(`${label} (${address}) has no contract code on ${ctx.network.chain.name} - refusing to propose a call to it.`);
    }
  }
}
