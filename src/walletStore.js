import { createClient } from "@supabase/supabase-js";
import { createEncryptedWallet, decryptWallet, isKmsWalletConfigured } from "./kmsWallet.js";

/**
 * Persistence layer for KMS-backed wallets, using Supabase (managed
 * Postgres) as durable storage - see kmsWallet.js's own header comment
 * for why durability matters here specifically: unlike the old
 * master-seed derivation, a lost record here means a permanently lost
 * wallet, not a recomputable one.
 *
 * SCOPE NOTE, IMPORTANT: this module only ever manages NEW, KMS-backed
 * wallets. It has no knowledge of wallet.js's master-seed derivation and
 * makes no attempt to check whether a given platform user already has an
 * old-style derived wallet before creating a new one here. That check is
 * a deliberate, visible decision that belongs at the call site (in
 * index.js/wallet.js), not something to bury silently in this module -
 * calling getOrCreateWallet for a user who already has funds sitting in
 * an old derived wallet would silently orphan them, not migrate them.
 * Wiring this in safely is the next, separate step.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
function getSupabaseClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set on this bot instance");
  }
  if (!supabase) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  }
  return supabase;
}

export function isWalletStoreConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) && isKmsWalletConfigured();
}

/**
 * Looks up an existing KMS-backed wallet record for this platform user,
 * or null if none exists yet. Does not decrypt anything - callers that
 * just need to know "does this user already have a new-style wallet"
 * (e.g., to decide whether to fall back to the old system) can use this
 * without paying for a KMS Decrypt call.
 */
export async function findWalletRecord(platform, platformUserId) {
  const { data, error } = await getSupabaseClient()
    .from("wallets")
    .select("*")
    .eq("platform", platform)
    .eq("platform_user_id", String(platformUserId))
    .maybeSingle();

  if (error) throw new Error(`Supabase lookup failed: ${error.message}`);
  return data; // null if no row found
}

/**
 * Creates a brand-new KMS-backed wallet for this platform user and
 * persists it. Throws if a record already exists for this user - callers
 * are expected to check findWalletRecord first, so an unexpected
 * duplicate here is a bug worth surfacing loudly, not silently
 * overwriting an existing wallet.
 */
export async function createWalletRecord(platform, platformUserId) {
  const existing = await findWalletRecord(platform, platformUserId);
  if (existing) {
    throw new Error(`A wallet record already exists for ${platform}:${platformUserId}`);
  }

  const wallet = await createEncryptedWallet();

  const { data, error } = await getSupabaseClient()
    .from("wallets")
    .insert({
      platform,
      platform_user_id: String(platformUserId),
      address: wallet.address,
      encrypted_private_key: wallet.encryptedPrivateKey,
      encrypted_data_key: wallet.encryptedDataKey,
      iv: wallet.iv,
      auth_tag: wallet.authTag,
    })
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  return data;
}

/**
 * Returns a ready-to-use viem Account for this platform user's KMS-backed
 * wallet, decrypting it fresh for this one call. Throws if no record
 * exists - this deliberately does NOT auto-create one, for the same
 * reason noted in the module-level scope comment above.
 */
export async function getWalletAccount(platform, platformUserId) {
  const record = await findWalletRecord(platform, platformUserId);
  if (!record) {
    throw new Error(`No wallet record found for ${platform}:${platformUserId}`);
  }

  return decryptWallet({
    encryptedPrivateKey: record.encrypted_private_key,
    encryptedDataKey: record.encrypted_data_key,
    iv: record.iv,
    authTag: record.auth_tag,
  });
}

/**
 * Records one gas top-up for this address and returns how many top-ups
 * it has now received, INCLUDING this one - so a return value of 1
 * means this was its first ever. Read-then-write, not atomic: under
 * truly concurrent top-ups for the same address this could under-count
 * by one, meaning a later top-up gets the larger first-time amount
 * instead of the smaller repeat one. Given how rarely the same user
 * gets topped up twice in close succession, and that the only
 * consequence is a slightly too-generous top-up (never too little,
 * never a security issue), this is an acceptable tradeoff against
 * adding a dedicated Postgres function just for this one counter.
 *
 * Returns null if this address has no wallet record at all - legacy
 * derived wallets (see wallet.js) were never written to this table, so
 * there's nowhere to persist their history. Callers should treat a null
 * return as "no history available" and decide their own fallback,
 * rather than this function inventing tracking for a wallet system it
 * has no other knowledge of.
 */
export async function recordGasTopup(address) {
  const client = getSupabaseClient();

  const { data: existing, error: selectError } = await client
    .from("wallets")
    .select("gas_topups_count")
    .eq("address", address)
    .maybeSingle();

  if (selectError) throw new Error(`Supabase lookup failed: ${selectError.message}`);
  if (!existing) return null;

  const newCount = existing.gas_topups_count + 1;
  const { error: updateError } = await client
    .from("wallets")
    .update({ gas_topups_count: newCount })
    .eq("address", address);

  if (updateError) throw new Error(`Supabase update failed: ${updateError.message}`);
  return newCount;
}

/*//////////////////////////////////////////////////////////////
                        SOLANA WALLETS
//////////////////////////////////////////////////////////////*/

/**
 * A user's Solana wallet lives on the same row as their EVM wallet, in
 * the `solana` jsonb column (supabase/schema.sql): { address, ciphertext,
 * encryptedDataKey, iv, authTag, topups } - the secret key, base58,
 * envelope-encrypted under the same KMS key. Same durability rule as the
 * EVM key: lose the row and the wallet is gone.
 */
export async function findSolanaWallet(platform, platformUserId) {
  const record = await findWalletRecord(platform, platformUserId);
  return record?.solana ?? null;
}

/**
 * Stores a new Solana wallet on an existing row, only if it has none yet
 * (so two concurrent first uses can't overwrite each other). Returns the
 * wallet that ends up stored - this one, or the one that won the race.
 */
export async function storeSolanaWallet(platform, platformUserId, solana) {
  const { error } = await getSupabaseClient()
    .from("wallets")
    .update({ solana })
    .eq("platform", platform)
    .eq("platform_user_id", String(platformUserId))
    .is("solana", null);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  const stored = await findSolanaWallet(platform, platformUserId);
  if (!stored) throw new Error(`No wallet row for ${platform}:${platformUserId} to add a Solana wallet to`);
  return stored;
}

/** Counts one SOL top-up for this user (see recordGasTopup); returns the new count. */
export async function recordSolanaTopup(platform, platformUserId) {
  const solana = await findSolanaWallet(platform, platformUserId);
  if (!solana) return null;
  const topups = (solana.topups ?? 0) + 1;
  const { error } = await getSupabaseClient()
    .from("wallets")
    .update({ solana: { ...solana, topups } })
    .eq("platform", platform)
    .eq("platform_user_id", String(platformUserId));
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return topups;
}
