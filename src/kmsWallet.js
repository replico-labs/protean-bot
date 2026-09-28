import { KMSClient, GenerateDataKeyCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import crypto from "crypto";

/**
 * KMS-backed wallet creation and decryption, using envelope encryption.
 *
 * REPLACES wallet.js's deterministic derivation model. That difference
 * matters operationally, not just cryptographically: the old system could
 * always regenerate any user's wallet from MASTER_WALLET_SEED + their
 * Telegram ID, even from a completely empty database. This system cannot.
 * Each wallet's private key is independently generated once, and the only
 * copy of it - encrypted - lives wherever the caller persists the record
 * this module returns. KMS itself never stores a user's private key, only
 * the one shared key used to encrypt/decrypt each user's individual data
 * key. If a stored record is lost, that wallet is gone permanently, no
 * matter how intact KMS_KEY_ID and its AWS permissions are. This makes
 * durable, non-ephemeral storage for wallet records a hard requirement,
 * not an optimization - see the accompanying persistence-layer decision.
 *
 * The actual pattern - envelope encryption with one shared symmetric KMS
 * key - is the same one used by Tatum's KMS product and is the standard
 * approach for "many secrets, one cheap shared master key" at low cost:
 * one $1/month key regardless of user count, versus one key per user.
 */

const KMS_KEY_ID = process.env.KMS_KEY_ID;
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

let kmsClient = null;
function getKmsClient() {
  if (!kmsClient) kmsClient = new KMSClient({ region: AWS_REGION });
  return kmsClient;
}

export function isKmsWalletConfigured() {
  return Boolean(KMS_KEY_ID);
}

/**
 * Generates a brand-new, independent wallet and encrypts its private key
 * via KMS envelope encryption. Returns everything needed to persist the
 * wallet - this function never touches storage itself, so where these
 * fields actually get saved is entirely the caller's decision.
 *
 * @returns {{address: string, encryptedPrivateKey: string, encryptedDataKey: string, iv: string, authTag: string}}
 *          All binary fields are base64-encoded, ready to store as plain
 *          text columns/fields.
 */
export async function createEncryptedWallet() {
  if (!KMS_KEY_ID) {
    throw new Error("KMS_KEY_ID is not configured on this bot instance");
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const { ciphertext, encryptedDataKey, iv, authTag } = await encryptSecret(privateKey);

  return { address: account.address, encryptedPrivateKey: ciphertext, encryptedDataKey, iv, authTag };
}

/**
 * Decrypts a stored wallet record back into a usable viem Account, for
 * exactly one signing operation. Callers should use the returned account
 * immediately and let it go out of scope afterward - nothing here
 * persists the decrypted key anywhere, and it should stay that way at
 * every call site too.
 *
 * @param {{encryptedPrivateKey: string, encryptedDataKey: string, iv: string, authTag: string}} record
 */
export async function decryptWallet(record) {
  if (!KMS_KEY_ID) {
    throw new Error("KMS_KEY_ID is not configured on this bot instance");
  }

  const privateKey = await decryptSecret({ ...record, ciphertext: record.encryptedPrivateKey });
  return privateKeyToAccount(privateKey);
}

/**
 * Envelope-encrypts any secret string (a wallet key, a Slack workspace's
 * bot token) under the shared KMS master key. Returns base64 fields,
 * ready to store as plain text columns.
 *
 * @returns {Promise<{ciphertext: string, encryptedDataKey: string, iv: string, authTag: string}>}
 */
export async function encryptSecret(plaintext) {
  if (!KMS_KEY_ID) {
    throw new Error("KMS_KEY_ID is not configured on this bot instance");
  }

  // One data key per secret, itself encrypted ("wrapped") by the single
  // shared KMS master key - this is what keeps cost flat regardless of
  // user count: only one thing (the master key) ever lives inside KMS
  // itself, billed at $1/month total, not per secret.
  const { Plaintext: dataKeyPlaintext, CiphertextBlob: dataKeyCiphertext } = await getKmsClient().send(
    new GenerateDataKeyCommand({ KeyId: KMS_KEY_ID, KeySpec: "AES_256" })
  );

  const iv = crypto.randomBytes(12); // 96-bit IV, the standard size for GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKeyPlaintext, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Best-effort only: JS gives no hard guarantee of zeroing memory the
  // way lower-level languages can, but there's no reason to keep a
  // reference to the plaintext data key any longer than this function
  // body - it goes out of scope the moment this function returns.

  return {
    ciphertext: ciphertext.toString("base64"),
    encryptedDataKey: Buffer.from(dataKeyCiphertext).toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * Reverses encryptSecret.
 *
 * @param {{ciphertext: string, encryptedDataKey: string, iv: string, authTag: string}} record
 */
export async function decryptSecret(record) {
  if (!KMS_KEY_ID) {
    throw new Error("KMS_KEY_ID is not configured on this bot instance");
  }

  // KeyId is passed explicitly here, not just relied on implicitly from
  // the ciphertext blob - AWS's own guidance is to always pin Decrypt
  // calls to the expected key, specifically to prevent a substitution
  // attack where ciphertext encrypted under a different, less-trusted
  // key gets fed in and blindly decrypted as if it were legitimate.
  const { Plaintext: dataKeyPlaintext } = await getKmsClient().send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(record.encryptedDataKey, "base64"),
      KeyId: KMS_KEY_ID,
    })
  );

  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKeyPlaintext, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
