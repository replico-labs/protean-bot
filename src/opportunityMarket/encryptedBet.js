import { createInstance } from "@zama-fhe/relayer-sdk/node";
import { bytesToHex, parseUnits } from "viem";
import { ZAMA_FHE_CONFIG, opportunityPublicClient, writeWithGasBuffer } from "./config.js";
import { marketContract, getUnderlyingDecimals } from "./market.js";

/**
 * Real, working implementation of back() - placing a confidential bet.
 * Kept in its own file, not folded into market.js, because this is
 * genuinely different infrastructure: every other action in this
 * folder is a plain viem writeContract call, but back() needs a
 * client-side FHE encryption step first, via the real
 * @zama-fhe/relayer-sdk package.
 *
 * IMPORTANT, confirmed directly from OpportunityMarket.sol's real
 * back() signature: it takes TWO SEPARATE proofs (targetProof,
 * amountProof), not one shared proof covering both values. This means
 * building one combined multi-value encrypted input (the more common
 * pattern shown in most fhEVM examples, e.g. one input with both
 * .add32() and .add64() calls producing a single shared inputProof)
 * would NOT work here - each value needs its own independent
 * createEncryptedInput() call, each producing its own handle+proof
 * pair, matching what the contract's two separate FHE.fromExternal
 * calls each expect.
 *
 * The FHE instance itself (createInstance) is expensive to set up (it
 * fetches public keys from Zama's relayer) - cached as a singleton and
 * reused across calls, same pattern as this bot's other lazily-
 * initialized clients (see kmsWallet.js's getKmsClient).
 */

let fhevmInstancePromise = null;
/**
 * Exported so decrypt.js (userDecrypt for balances/bets) can reuse this
 * exact same cached instance rather than creating and initializing a
 * second, wasteful one - createInstance() is expensive (fetches public
 * keys from Zama's relayer), so this singleton is meant to be shared
 * across every FHE operation in this folder, not just back().
 *
 * If createInstance() ever fails - even a single transient hiccup on
 * Zama's relayer, at startup or any other time - the cached promise
 * must be cleared, not kept. Without this, a promise that rejects once
 * stays cached and rejected forever: every future call (checking
 * `!fhevmInstancePromise`) would see it as already set and reuse the
 * same broken promise for the rest of the process's life, even long
 * after Zama's relayer recovers, until the next full restart. This is
 * a real bug that was found and fixed directly - not a theoretical
 * concern - because it would turn one transient external failure into
 * a permanent one for every user, for every FHE operation, until
 * someone happened to redeploy.
 */
export function getFhevmInstance() {
  if (!fhevmInstancePromise) {
    fhevmInstancePromise = createInstance(ZAMA_FHE_CONFIG).catch((err) => {
      fhevmInstancePromise = null;
      throw err;
    });
  }
  return fhevmInstancePromise;
}

/**
 * Encrypts a bet's target opportunity id and amount as two independent
 * FHE inputs, ready to pass into back(). Exposed separately from
 * back() itself in case something else ever needs just the encryption
 * step without immediately submitting a transaction.
 *
 * @param marketAddress the OpportunityMarket this bet targets
 * @param userAddress the backer's own address - the encryption is bound to this specific (contract, user) pair
 * @param targetOpportunityId a plain integer - which opportunity is being backed (NOT decimal-scaled, this isn't a token amount)
 * @param amountWhole the amount being backed, in whole tokens - decimal-scaled automatically using the market's real underlying token, same as deposit()
 */
export async function encryptBetInput(marketAddress, userAddress, targetOpportunityId, amountWhole) {
  const instance = await getFhevmInstance();
  const decimals = await getUnderlyingDecimals(marketAddress);
  const amountScaled = parseUnits(String(amountWhole), decimals);

  const targetInput = instance.createEncryptedInput(marketAddress, userAddress);
  targetInput.add32(targetOpportunityId);
  const targetResult = await targetInput.encrypt();

  const amountInput = instance.createEncryptedInput(marketAddress, userAddress);
  amountInput.add64(amountScaled);
  const amountResult = await amountInput.encrypt();

  return {
    targetHandle: bytesToHex(targetResult.handles[0]),
    targetProof: bytesToHex(targetResult.inputProof),
    amountHandle: bytesToHex(amountResult.handles[0]),
    amountProof: bytesToHex(amountResult.inputProof),
  };
}

/**
 * Places a confidential bet - encrypts the target and amount client-side,
 * then submits back() with the resulting handles and proofs. `client`
 * must be a wallet client for the backer's own address (the encryption
 * is bound to userAddress = client.account.address; a mismatch here
 * would produce a proof the contract rejects).
 */
export async function back(client, marketAddress, targetOpportunityId, amountWhole) {
  const userAddress = client.account.address;
  const { targetHandle, targetProof, amountHandle, amountProof } = await encryptBetInput(
    marketAddress,
    userAddress,
    targetOpportunityId,
    amountWhole
  );

  const gov = marketContract(marketAddress);
  const hash = await writeWithGasBuffer(client, {
    ...gov,
    functionName: "back",
    args: [targetHandle, targetProof, amountHandle, amountProof],
  });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash };
}