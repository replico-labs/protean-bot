import { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { encryptSecret, decryptSecret } from "../kmsWallet.js";
import { findWalletRecord, findSolanaWallet, storeSolanaWallet, recordSolanaTopup, isWalletStoreConfigured } from "../walletStore.js";
import { getOrCreateUserAccount } from "../walletResolver.js";
import { getSolanaOperator } from "./config.js";

const bs58 = anchor.utils.bytes.bs58;

/**
 * Each user's Solana wallet: generated once, its secret key envelope-
 * encrypted under the bot's KMS key and stored on the user's wallet row
 * (walletStore.js), decrypted fresh for each signature. Same model as the
 * EVM wallets in kmsWallet.js.
 */

/** The user's Solana keypair, creating their wallet (and their EVM one, if new) on first use. */
export async function getOrCreateSolanaKeypair(platformUserId, platform = "telegram") {
  if (!isWalletStoreConfigured()) throw new Error("Wallets aren't set up on this bot yet - ask an admin.");
  let stored = await findSolanaWallet(platform, platformUserId);
  if (!stored) {
    // The Solana wallet sits on the user's wallet row, so make sure it exists.
    if (!(await findWalletRecord(platform, platformUserId))) await getOrCreateUserAccount(platformUserId, platform);
    const keypair = Keypair.generate();
    const { ciphertext, encryptedDataKey, iv, authTag } = await encryptSecret(bs58.encode(keypair.secretKey));
    stored = await storeSolanaWallet(platform, platformUserId, {
      address: keypair.publicKey.toBase58(),
      ciphertext,
      encryptedDataKey,
      iv,
      authTag,
      topups: 0,
    });
  }
  const secret = await decryptSecret(stored);
  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  if (keypair.publicKey.toBase58() !== stored.address) throw new Error("Stored Solana wallet doesn't match its address");
  return keypair;
}

/** The user's Solana address, or null if they don't have one yet. Never creates anything. */
export async function getSolanaAddress(platformUserId, platform = "telegram") {
  if (!isWalletStoreConfigured()) return null;
  const stored = await findSolanaWallet(platform, platformUserId);
  return stored ? new PublicKey(stored.address) : null;
}

/**
 * Tops the user's wallet up with SOL from the operator when it's below
 * the network's minimum, so they can pay fees and rent (voter, proposal
 * and vote accounts). The first top-up is larger than later ones. `need`
 * (lamports) is what the next action costs, such as a proposal account's
 * rent: the wallet is topped up to cover it plus the minimum.
 */
export async function ensureSolFunded(network, platformUserId, platform, address, need = 0) {
  const operator = getSolanaOperator();
  if (!operator) return;
  const balance = await network.connection.getBalance(address);
  if (balance >= network.topup.min + need) return;
  const stored = await findSolanaWallet(platform, platformUserId);
  const usual = (stored?.topups ?? 0) === 0 ? network.topup.first : network.topup.repeat;
  const amount = Math.max(usual, network.topup.min + need - balance);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: address, lamports: amount }));
  await sendAndConfirmTransaction(network.connection, tx, [operator], { commitment: "confirmed" });
  await recordSolanaTopup(platform, platformUserId);
}
