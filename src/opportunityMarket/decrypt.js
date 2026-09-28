import { marketContract } from "./market.js";
import { getFhevmInstance } from "./encryptedBet.js";
import { opportunityPublicClient } from "./config.js";

/**
 * Real implementation of userDecrypt for balanceOf/getBet - reading a
 * user's own encrypted values back as cleartext. Genuinely different
 * shape of operation from everything else in this system: not a
 * transaction, an off-chain EIP-712 SIGNATURE, authorizing a fresh,
 * ephemeral keypair (NOT the user's actual wallet key) to decrypt on
 * their behalf for a bounded time window, relayed through Zama's
 * service.
 *
 * SESSION CACHING, deliberate design choice: that time window
 * (durationDays below) means this authorization is a session, not a
 * one-shot - regenerating a fresh ephemeral keypair and demanding a new
 * wallet signature every single time someone checks their balance would
 * be a needlessly repetitive experience. Sessions are cached per
 * (userAddress, marketAddress) pair, in memory only, for the life of
 * this process - never persisted to disk or the database, same caution
 * as any other sensitive session material in this bot.
 */

const DECRYPT_SESSION_DURATION_DAYS = 7;

/**
 * Without an explicit timeout, userDecrypt defaults to the SDK's own
 * DEFAULT_GLOBAL_REQUEST_TIMEOUT_MS - confirmed directly in the
 * installed package's source: a full hour. Observed directly in
 * production logs: three separate real requests each ran their
 * internal retry loop for ~30 minutes before finally giving up during
 * a period of genuine Zama testnet relayer degradation. A user waiting
 * up to an hour for a single command to fail is a bad experience
 * regardless of whose infrastructure is at fault - this makes a
 * failure during an outage surface in a reasonable, bounded time
 * instead, without changing behavior at all when the relayer is
 * healthy and responds normally.
 */
const USER_DECRYPT_TIMEOUT_MS = 60_000;

// Map<`${userAddress}:${marketAddress}`, session>
const decryptSessions = new Map();

async function getOrCreateDecryptSession(client, marketAddress) {
  const userAddress = client.account.address;
  const cacheKey = `${userAddress}:${marketAddress}`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const existing = decryptSessions.get(cacheKey);
  if (existing && existing.expiresAt > nowSeconds) {
    return existing;
  }

  const instance = await getFhevmInstance();
  const keypair = instance.generateKeypair();
  const startTimestamp = nowSeconds;

  // KmsUserDecryptEIP712Type - {domain, types, primaryType, message} -
  // this shape lines up directly with viem's signTypedData parameters,
  // confirmed from the real SDK's own type definitions.
  const eip712 = instance.createEIP712(
    keypair.publicKey,
    [marketAddress],
    startTimestamp,
    DECRYPT_SESSION_DURATION_DAYS
  );

  const signature = await client.signTypedData({
    domain: eip712.domain,
    types: eip712.types,
    primaryType: eip712.primaryType,
    message: eip712.message,
  });

  const session = {
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    signature,
    startTimestamp,
    durationDays: DECRYPT_SESSION_DURATION_DAYS,
    expiresAt: startTimestamp + DECRYPT_SESSION_DURATION_DAYS * 86400,
  };
  decryptSessions.set(cacheKey, session);
  return session;
}

/**
 * Decrypts the caller's own confidential balance. `client` must be a
 * wallet client for the account whose balance is being read - userDecrypt
 * is bound to that specific address, same as encryptBetInput().
 */
export async function getBalance(client, marketAddress) {
  const userAddress = client.account.address;
  const gov = marketContract(marketAddress);
  const handle = await opportunityPublicClient.readContract({
    ...gov,
    functionName: "balanceOf",
    args: [userAddress],
  });

  const instance = await getFhevmInstance();
  const session = await getOrCreateDecryptSession(client, marketAddress);

  const results = await instance.userDecrypt(
    [{ handle, contractAddress: marketAddress }],
    session.privateKey,
    session.publicKey,
    session.signature,
    [marketAddress],
    userAddress,
    session.startTimestamp,
    session.durationDays,
    { timeout: USER_DECRYPT_TIMEOUT_MS }
  );

  return results[handle];
}

/**
 * Decrypts one of the caller's own bets - both the target opportunity
 * id and the amount, in a single userDecrypt call covering both
 * handles together.
 */
export async function getBet(client, marketAddress, betIndex) {
  const userAddress = client.account.address;
  const gov = marketContract(marketAddress);

  // getBet returns two separate named outputs (target, amount), not one
  // struct - accessed positionally here rather than by name, since
  // viem's readContract returns multi-output results as an array-like
  // tuple, not guaranteed to expose named properties.
  const betResult = await opportunityPublicClient.readContract({
    ...gov,
    functionName: "getBet",
    args: [userAddress, BigInt(betIndex)],
  });
  const [targetHandle, amountHandle] = betResult;

  const instance = await getFhevmInstance();
  const session = await getOrCreateDecryptSession(client, marketAddress);

  const results = await instance.userDecrypt(
    [
      { handle: targetHandle, contractAddress: marketAddress },
      { handle: amountHandle, contractAddress: marketAddress },
    ],
    session.privateKey,
    session.publicKey,
    session.signature,
    [marketAddress],
    userAddress,
    session.startTimestamp,
    session.durationDays,
    { timeout: USER_DECRYPT_TIMEOUT_MS }
  );

  return {
    target: results[targetHandle],
    amount: results[amountHandle],
  };
}

/**
 * Decrypts every bet in the market at once - deployer-only in practice,
 * though not enforced by this function itself. Confirmed directly from
 * source: back() explicitly grants the deployer ACL permission on every
 * bet's target and amount (FHE.allow(target, deployer) /
 * FHE.allow(actualAmount, deployer)) - meaning this is genuinely the
 * SAME userDecrypt flow as getBalance()/getBet() above, just batching
 * many handles into one call, not a fundamentally different problem the
 * per-user authorization model can't handle. If called by anyone other
 * than the actual deployer, the underlying userDecrypt call will fail
 * or return unusable results for these handles, since the ACL never
 * granted that caller permission on them - the contract's own access
 * control is what enforces this, not a check here.
 */
export async function getAllBets(client, marketAddress) {
  const userAddress = client.account.address;
  const gov = marketContract(marketAddress);

  const betsResult = await opportunityPublicClient.readContract({
    ...gov,
    functionName: "getAllBets",
    args: [],
  });
  const [bettors, targetHandles, amountHandles] = betsResult;

  if (bettors.length === 0) return [];

  const instance = await getFhevmInstance();
  const session = await getOrCreateDecryptSession(client, marketAddress);

  const handleContractPairs = [
    ...targetHandles.map((handle) => ({ handle, contractAddress: marketAddress })),
    ...amountHandles.map((handle) => ({ handle, contractAddress: marketAddress })),
  ];

  const results = await instance.userDecrypt(
    handleContractPairs,
    session.privateKey,
    session.publicKey,
    session.signature,
    [marketAddress],
    userAddress,
    session.startTimestamp,
    session.durationDays,
    { timeout: USER_DECRYPT_TIMEOUT_MS }
  );

  return bettors.map((bettor, i) => ({
    bettor,
    target: results[targetHandles[i]],
    amount: results[amountHandles[i]],
  }));
}

/**
 * Deployer-only aggregate stats per opportunity - total staked and
 * unique backer count, built directly on top of getAllBets (same
 * decrypt permissions, same deployer-only restriction enforced by the
 * contract's own ACL, not re-checked here). Opportunity metadata
 * (lister, metadataURI) is public on-chain and read separately, not
 * part of the confidential bet data at all.
 */
export async function getMarketAnalytics(client, marketAddress) {
  const gov = marketContract(marketAddress);
  const bets = await getAllBets(client, marketAddress);

  const opportunityCount = await opportunityPublicClient.readContract({ ...gov, functionName: "opportunityCount" });

  const perOpportunity = new Map();
  // Opportunity IDs start at 1, not 0 - confirmed directly from the
  // real contract: listOpportunity() does `id = ++opportunityCount`
  // (pre-increment), so opportunityCount is genuinely the count of
  // real opportunities, and valid ids run 1..opportunityCount
  // inclusive. Looping from 0 would both fabricate a never-real #0
  // slot and silently skip the actual last opportunity.
  for (let id = 1; id <= Number(opportunityCount); id++) {
    const [lister, metadataURI] = await opportunityPublicClient.readContract({
      ...gov,
      functionName: "opportunities",
      args: [BigInt(id)],
    });
    perOpportunity.set(id, { id, lister, metadataURI });
  }

  return summarizeBets(bets, [...perOpportunity.values()]);
}

/** Rounded bigint division; 0 when there's nothing to divide by. */
function roundedDiv(a, b) {
  return b === 0n ? 0n : (a * 2n + b) / (2n * b);
}

function averageOf(total, count) {
  return roundedDiv(total, BigInt(count));
}

/**
 * Pure summary of decrypted bets, split out so it can be tested without
 * a chain or the relayer. `opportunities` are { id, lister, metadataURI }.
 *
 * A bet whose amount decrypts to 0 is one back() zeroed because the
 * backer's balance was too low - it's counted separately and left out of
 * every average, so failed bets don't drag the averages down.
 */
export function summarizeBets(bets, opportunities) {
  const perOpportunity = new Map(
    opportunities.map((o) => [o.id, { ...o, totalStaked: 0n, betCount: 0, largestBet: 0n, backers: new Set() }])
  );

  let totalStakedOverall = 0n;
  let fundedBets = 0;
  let zeroBets = 0;
  let unmatchedBets = 0;
  let largestBet = 0n;
  const allBettors = new Set();
  for (const bet of bets) {
    const amount = BigInt(bet.amount);
    allBettors.add(bet.bettor);
    if (amount === 0n) {
      zeroBets++;
      continue;
    }
    fundedBets++;
    totalStakedOverall += amount;
    if (amount > largestBet) largestBet = amount;
    // A bet's target can decrypt to an id outside the current
    // opportunity list (e.g. one that didn't exist yet) - it still
    // counts toward the overall figures, just not any opportunity's.
    const entry = perOpportunity.get(Number(bet.target));
    if (!entry) {
      unmatchedBets++;
      continue;
    }
    entry.totalStaked += amount;
    entry.betCount++;
    entry.backers.add(bet.bettor);
    if (amount > entry.largestBet) entry.largestBet = amount;
  }

  return {
    totalBets: bets.length,
    fundedBets,
    zeroBets,
    unmatchedBets,
    totalStakedOverall,
    totalUniqueBettors: allBettors.size,
    averageBet: averageOf(totalStakedOverall, fundedBets),
    averagePerBettor: averageOf(totalStakedOverall, allBettors.size),
    largestBet,
    opportunities: [...perOpportunity.values()].map((o) => ({
      id: o.id,
      lister: o.lister,
      metadataURI: o.metadataURI,
      totalStaked: o.totalStaked,
      betCount: o.betCount,
      backerCount: o.backers.size,
      averageBet: averageOf(o.totalStaked, o.betCount),
      largestBet: o.largestBet,
      // basis points of everything staked, so 1234 = 12.34%
      shareBps: Number(roundedDiv(o.totalStaked * 10000n, totalStakedOverall)),
    })),
  };
}
