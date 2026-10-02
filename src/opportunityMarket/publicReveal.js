import { decodeAbiParameters } from "viem";
import { marketContract, finalizeWinningTotal, requestWithdrawal, requestRewardWithdrawal } from "./market.js";
import { getFhevmInstance } from "./encryptedBet.js";
import { opportunityPublicClient, writeWithGasBuffer } from "./config.js";

/**
 * publicDecrypt requires the target handle to have been granted public
 * decryptability via FHE.makePubliclyDecryptable() on-chain - but that
 * grant is registered by Zama's relayer asynchronously, off-chain,
 * separately from the transaction that made it being mined.
 * waitForTransactionReceipt only confirms the on-chain half; it says
 * nothing about whether the relayer has caught up yet. Observed
 * directly in production: a handle correctly, freshly granted in the
 * very same transaction still failed with "Handle ... is not allowed
 * for public decryption" moments later - the exact same class of race
 * already found and fixed for gas top-ups elsewhere in this bot, here
 * showing up as a hard ACL rejection rather than a retryable gateway
 * timeout, so it needs its own short, bounded retry rather than
 * relying on the SDK's own internal retry behavior.
 */
async function publicDecryptWithRetry(instance, handle) {
  // Observed directly in production: the previous 6-attempt/3-second
  // window (max ~18s) was genuinely too short - two separate real
  // attempts both exhausted it without the grant propagating in time.
  // Re-running the command doesn't help either: finalizeWinningTotal()
  // creates a brand new encrypted handle on every call (FHE ciphertexts
  // are never reused, even for an identical underlying value), so a
  // retry-by-rerunning approach resets the propagation clock to zero on
  // a different handle each time rather than giving the same one more
  // time. A much longer single-invocation window is the actual fix -
  // 40 attempts at 5s apart, up to ~200s worst case, chosen to
  // comfortably outlast a normal propagation delay without waiting as
  // long as the multi-hour gateway outages seen elsewhere (a
  // genuinely different failure mode, already handled separately by
  // decrypt.js's own 60s timeout).
  const MAX_ATTEMPTS = 40;
  const DELAY_MS = 5000;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await instance.publicDecrypt([handle]);
    } catch (err) {
      lastErr = err;
      const isAclPropagationDelay = err?.name === "ACLPublicDecryptionError" || /not allowed for public decryption/i.test(err?.message ?? "");
      if (!isAclPropagationDelay || attempt === MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
  throw lastErr;
}

/**
 * Real implementation of the public-decrypt flow that
 * completeWinningTotalReveal()/completeWithdrawal() need. Genuinely
 * different from decrypt.js's userDecrypt flow, despite superficial
 * similarity (both eventually produce cleartext from a handle):
 *
 * - userDecrypt (decrypt.js) is for a user reading their OWN value
 *   off-chain, authorized by an EIP-712 signature tied to their
 *   identity. Never fed back into a contract call.
 *
 * - publicDecrypt (here) is for a value the contract itself needs to
 *   act on - confirmed directly from OpportunityMarket.sol's source,
 *   both completion functions verify the cleartext via
 *   FHE.checkSignatures() and then abi.decode() it to actually move
 *   tokens. That requires an on-chain-verifiable, KMS-signed proof, not
 *   a user's own authorization - publicDecrypt needs no keypair, no
 *   signature, nothing tied to a specific user at all, since the
 *   contract already decided (by emitting the reveal-request event in
 *   the first place) that this specific handle is meant to become
 *   public.
 *
 * Both functions here do the full round trip in one call - simulate to
 * get the handle, decrypt it publicly, submit the completion - rather
 * than making the caller orchestrate multiple steps by hand.
 */

/** Full flow: finalizes the winning total, publicly reveals it, and submits the completion in one call. */
export async function revealAndCompleteWinningTotal(client, marketAddress) {
  const { handle } = await finalizeWinningTotal(client, marketAddress);

  const instance = await getFhevmInstance();
  const { abiEncodedClearValues, decryptionProof } = await publicDecryptWithRetry(instance, handle);

  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "completeWinningTotalReveal",
    args: [abiEncodedClearValues, decryptionProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, handle };
}

/**
 * Full flow for either a stake or reward withdrawal - `kind` picks
 * which. Requests the withdrawal, publicly reveals the resulting
 * handle, and submits the completion.
 */
export async function revealAndCompleteWithdrawal(client, marketAddress, kind) {
  const requestFn = kind === "reward" ? requestRewardWithdrawal : requestWithdrawal;
  const { handle } = await requestFn(client, marketAddress);

  const instance = await getFhevmInstance();
  const { abiEncodedClearValues, decryptionProof } = await publicDecryptWithRetry(instance, handle);

  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "completeWithdrawal",
    args: [handle, abiEncodedClearValues, decryptionProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  // The KMS-signed cleartext is exactly what completeWithdrawal pays out (abi.decode as uint64).
  const [amount] = decodeAbiParameters([{ type: "uint64" }], abiEncodedClearValues);
  return { hash, handle, amount };
}