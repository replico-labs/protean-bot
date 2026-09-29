import { findWalletRecord, createWalletRecord, getWalletAccount, isWalletStoreConfigured } from "./walletStore.js";
import { deriveUserWallet, isWalletDerivationConfigured } from "./wallet.js";
import { publicClient } from "./config.js";
import { fundNewWallet } from "./gasSponsor.js";

/**
 * Resolves a user's signing account - the KMS-backed wallet if one
 * already exists, or a freshly created one for genuinely new users.
 * Keyed by (platform, platformUserId), matching walletStore.js, so a
 * Discord or Slack user gets their own wallet; `platform` defaults to
 * "telegram" so every existing caller behaves exactly as before.
 *
 * Deliberately does NOT silently migrate a user who already has funds
 * under the old master-seed-derived system (wallet.js) - if their old
 * wallet has a nonzero native balance, this throws a clear, actionable
 * error directing them to /migratewallet first, rather than quietly
 * creating a second, unrelated wallet and orphaning the old one's
 * funds. A genuinely new user (old wallet balance is zero, the common
 * case) gets a new KMS wallet created transparently, no extra step.
 */
export async function getOrCreateUserAccount(platformUserId, platform = "telegram") {
  if (!isWalletStoreConfigured()) {
    throw new Error("The KMS/Supabase wallet system is not configured on this bot instance.");
  }

  const existing = await findWalletRecord(platform, platformUserId);
  if (existing) {
    return getWalletAccount(platform, platformUserId);
  }

  // The old master-seed wallets were only ever derived from Telegram IDs,
  // so only Telegram users can have legacy funds to migrate.
  if (platform === "telegram" && isWalletDerivationConfigured()) {
    const telegramUserId = platformUserId;
    const oldAccount = deriveUserWallet(telegramUserId);
    const balance = await publicClient.getBalance({ address: oldAccount.address });
    if (balance > 0n) {
      throw new Error(
        `Your old wallet (${oldAccount.address}) has a balance - run /migratewallet first to move your funds ` +
          `to the new wallet system before continuing.`
      );
    }
  }

  await createWalletRecord(platform, platformUserId);
  const account = await getWalletAccount(platform, platformUserId);
  // Send the new wallet its starting gas now, so its first transaction
  // never waits on (or fails for want of) a top-up.
  await fundNewWallet(account.address);
  return account;
}

/**
 * Lightweight - just the address, no decryption and no wallet creation.
 * Prefers a KMS record's stored address (reading it needs no decrypt
 * call at all, unlike getOrCreateUserAccount); falls back to the old
 * derived address if no KMS record exists yet. Safe to call for a user
 * who's never interacted with the bot before - never creates anything,
 * unlike getOrCreateUserAccount.
 */
export async function getUserAddress(platformUserId, platform = "telegram") {
  const existing = await findWalletRecord(platform, platformUserId);
  if (existing) return existing.address;
  if (platform === "telegram" && isWalletDerivationConfigured()) return deriveUserWallet(platformUserId).address;
  throw new Error("No wallet system configured on this bot instance.");
}
