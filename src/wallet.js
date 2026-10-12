import { keccak256, concat, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MASTER_WALLET_SEED = process.env.MASTER_WALLET_SEED;

if (!MASTER_WALLET_SEED) {
  console.warn(
    "MASTER_WALLET_SEED not set - fine unless users still have funds in the old seed-derived wallets: /migratewallet needs it. Wallets themselves are KMS-backed."
  );
} else if (MASTER_WALLET_SEED.length < 32) {
  console.warn(
    "MASTER_WALLET_SEED looks short - use a long, random value (e.g. `openssl rand -hex 32`), not a guessable string."
  );
}

/**
 * Deterministically derives a wallet for a given Telegram user ID.
 *
 * SECURITY: MASTER_WALLET_SEED is the single most sensitive value in this
 * entire system - anyone who obtains it can derive and control EVERY
 * user's private key, for every DAO this bot operates. It must never be
 * committed, logged, or transmitted anywhere. Treat it with more care than
 * any other secret in this project, including OPERATOR_PRIVATE_KEY.
 *
 * This is a custodial model: the bot's backend can always regenerate any
 * user's private key from their Telegram ID + this one seed. No private
 * keys are stored anywhere - they're recomputed on demand and never
 * persisted, but the backend that holds MASTER_WALLET_SEED is, in effect,
 * in full control of every derived wallet. This is a deliberate tradeoff
 * accepted in place of a non-custodial embedded-wallet provider.
 */
export function deriveUserWallet(telegramUserId) {
  if (!MASTER_WALLET_SEED) {
    throw new Error("MASTER_WALLET_SEED is not configured on this bot instance");
  }

  const seedBytes = stringToBytes(MASTER_WALLET_SEED);
  const idBytes = stringToBytes(String(telegramUserId));
  const privateKey = keccak256(concat([seedBytes, idBytes]));

  return privateKeyToAccount(privateKey);
}

export function isWalletDerivationConfigured() {
  return Boolean(MASTER_WALLET_SEED);
}
