import { PublicKey, Transaction } from "@solana/web3.js";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionEncoder,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
  signTransactionMessageWithSigners,
} from "@solana/kit";

/**
 * Solana's v1 transactions (SIMD-0296 / SIMD-0385): up to 4,096 bytes
 * instead of legacy's 1,232, with compute settings in the header instead of
 * ComputeBudget instructions, and no address lookup tables. The bot uses
 * them only for a transaction too big for legacy (a proposal carrying a
 * protocol's larger instructions, or its execution), and only on networks
 * where they're enabled (network.v1Transactions). @solana/web3.js can't
 * build them, so this goes through @solana/kit: the same instructions and
 * keypairs, converted.
 */

// The protocol's limits (kit declares them in its types but doesn't export them at runtime).
export const LEGACY_TRANSACTION_SIZE_LIMIT = 1232;
export const V1_TRANSACTION_SIZE_LIMIT = 4096;
// The most account data a transaction may load (64 MiB, the runtime's cap). A v1 header without it is held to 0.
const MAX_LOADED_ACCOUNTS_DATA_SIZE = 64 * 1024 * 1024;
// Legacy's compute default (200,000 units an instruction, at most 1.4 million), for a v1 transaction that names none.
const defaultComputeUnits = (count) => Math.min(200_000 * count, 1_400_000);

const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58();

/** The size `ixs` would take as a legacy transaction paid by `payer`, or Infinity if it doesn't fit. */
export function legacySize(ixs, payer) {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: PLACEHOLDER_BLOCKHASH }).add(...ixs);
  try {
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  } catch {
    return Infinity; // web3.js refuses to encode past the legacy limit
  }
}

const roleOf = (k) => (k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY);

/** A web3.js instruction as kit's, with each signer's kit signer attached. */
function kitInstruction(ix, kitSigners) {
  return {
    programAddress: address(ix.programId.toBase58()),
    accounts: ix.keys.map((k) => {
      const meta = { address: address(k.pubkey.toBase58()), role: roleOf(k) };
      const signer = k.isSigner ? kitSigners.get(k.pubkey.toBase58()) : null;
      return signer ? { ...meta, signer } : meta;
    }),
    data: new Uint8Array(ix.data),
  };
}

/** Builds and signs a v1 transaction: `signers` are web3.js Keypairs, the first pays. Returns { signed, wire, signature, size }. */
export async function buildV1(ixs, signers, { blockhash, lastValidBlockHeight, computeUnits } = {}) {
  const kitSigners = new Map();
  for (const kp of signers) kitSigners.set(kp.publicKey.toBase58(), await createKeyPairSignerFromBytes(kp.secretKey));
  const payer = kitSigners.get(signers[0].publicKey.toBase58());
  let message = setTransactionMessageFeePayerSigner(payer, createTransactionMessage({ version: 1 }));
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: BigInt(lastValidBlockHeight) }, message);
  message = appendTransactionMessageInstructions(ixs.map((ix) => kitInstruction(ix, kitSigners)), message);
  message = setTransactionMessageLoadedAccountsDataSizeLimit(MAX_LOADED_ACCOUNTS_DATA_SIZE, message);
  message = setTransactionMessageComputeUnitLimit(computeUnits || defaultComputeUnits(ixs.length), message);
  const signed = await signTransactionMessageWithSigners(message);
  const size = getTransactionEncoder().encode(signed).length;
  if (size > V1_TRANSACTION_SIZE_LIMIT) throw Object.assign(new Error(`That transaction is ${size} bytes, more than even a v1 Solana transaction holds (${V1_TRANSACTION_SIZE_LIMIT}).`), { userFacing: true });
  return { signed, wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed), size };
}

/**
 * An unsigned v1 transaction paid by `payer`, base64-encoded, for a
 * simulation with signature checks off (scripts/simulate-solana-action.mjs):
 * nobody needs to hold the payer's key. The RPC replaces the blockhash.
 */
export function unsignedV1(ixs, payer, { computeUnits } = {}) {
  let message = setTransactionMessageFeePayer(address(payer.toBase58()), createTransactionMessage({ version: 1 }));
  message = setTransactionMessageLifetimeUsingBlockhash({ blockhash: PLACEHOLDER_BLOCKHASH, lastValidBlockHeight: 0n }, message);
  message = appendTransactionMessageInstructions(ixs.map((ix) => kitInstruction(ix, new Map())), message);
  message = setTransactionMessageLoadedAccountsDataSizeLimit(MAX_LOADED_ACCOUNTS_DATA_SIZE, message);
  message = setTransactionMessageComputeUnitLimit(computeUnits || defaultComputeUnits(ixs.length), message);
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/**
 * Sends `ixs` as a v1 transaction over `connection` (a web3.js Connection:
 * it sends the raw bytes and confirms by signature, whatever the format).
 * Returns the signature; throws with the simulation's logs when the RPC's
 * preflight rejects it.
 */
export async function sendV1(connection, ixs, signers, { computeUnits } = {}) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const { wire, signature } = await buildV1(ixs, signers, { blockhash, lastValidBlockHeight, computeUnits });
  await connection.sendRawTransaction(Buffer.from(wire, "base64"), { preflightCommitment: "confirmed" });
  const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (value.err) {
    const failed = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 1 }).catch(() => null);
    throw Object.assign(new Error(`Transaction ${signature} failed: ${JSON.stringify(value.err)}`), { logs: failed?.meta?.logMessages ?? [] });
  }
  return signature;
}
