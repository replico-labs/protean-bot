import { createClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret, isKmsWalletConfigured } from "../kmsWallet.js";

/**
 * Where the Slack bot keeps each workspace's install ("Add to Slack"):
 * one row per workspace in Supabase's slack_installations table (see
 * supabase/schema.sql), holding Bolt's whole installation object -
 * which includes that workspace's bot token - envelope-encrypted under
 * the same KMS key as the wallets. Nothing token-bearing is written in
 * plaintext, and nothing lives in .env any more.
 *
 * Bolt calls fetchInstallation on every incoming command and event, so
 * decrypted installations are cached in memory; storeInstallation and
 * deleteInstallation keep the cache in step (this process is the only
 * writer).
 *
 * `backend` and the crypto functions are injectable for tests.
 */

const TABLE = "slack_installations";

export function isSlackInstallationStoreConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) && isKmsWalletConfigured();
}

function supabaseBackend() {
  let supabase = null;
  const db = () => (supabase ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));
  return {
    async get(installKey) {
      const { data, error } = await db().from(TABLE).select("*").eq("install_key", installKey).maybeSingle();
      if (error) throw new Error(`Supabase read failed: ${error.message}`);
      return data;
    },
    async put(row) {
      const { error } = await db().from(TABLE).upsert(row, { onConflict: "install_key" });
      if (error) throw new Error(`Supabase write failed: ${error.message}`);
    },
    async remove(installKey) {
      const { error } = await db().from(TABLE).delete().eq("install_key", installKey);
      if (error) throw new Error(`Supabase delete failed: ${error.message}`);
    },
  };
}

/** Org-wide (Enterprise Grid) installs are keyed by enterprise, everything else by workspace. */
function installKeyFor({ isEnterpriseInstall, enterpriseId, teamId }) {
  if (isEnterpriseInstall && enterpriseId) return `E:${enterpriseId}`;
  if (!teamId) throw new Error("Slack installation has no team ID");
  return `T:${teamId}`;
}

/**
 * @param {object} [options]
 * @param {(installation: object) => Promise<void>} [options.onStored] runs after a workspace installs (or reinstalls)
 */
export function createInstallationStore({ backend = supabaseBackend(), encrypt = encryptSecret, decrypt = decryptSecret, onStored } = {}) {
  const cache = new Map();

  return {
    async storeInstallation(installation) {
      const installKey = installKeyFor({
        isEnterpriseInstall: installation.isEnterpriseInstall,
        enterpriseId: installation.enterprise?.id,
        teamId: installation.team?.id,
      });
      const { ciphertext, encryptedDataKey, iv, authTag } = await encrypt(JSON.stringify(installation));
      await backend.put({
        install_key: installKey,
        team_id: installation.team?.id ?? null,
        enterprise_id: installation.enterprise?.id ?? null,
        encrypted_installation: ciphertext,
        encrypted_data_key: encryptedDataKey,
        iv,
        auth_tag: authTag,
        updated_at: new Date().toISOString(),
      });
      cache.set(installKey, installation);
      console.log(`[slack] Installed in ${installation.team?.name ?? installation.enterprise?.name ?? installKey}`);
      if (onStored) await onStored(installation).catch((err) => console.error("[slack] Post-install step failed:", err.message));
    },

    async fetchInstallation(query) {
      const installKey = installKeyFor(query);
      if (cache.has(installKey)) return cache.get(installKey);
      const row = await backend.get(installKey);
      if (!row) throw new Error(`Protean isn't installed in this Slack workspace (${installKey}) - install it from /slack/install`);
      const installation = JSON.parse(
        await decrypt({ ciphertext: row.encrypted_installation, encryptedDataKey: row.encrypted_data_key, iv: row.iv, authTag: row.auth_tag })
      );
      cache.set(installKey, installation);
      return installation;
    },

    async deleteInstallation(query) {
      const installKey = installKeyFor(query);
      await backend.remove(installKey);
      cache.delete(installKey);
      console.log(`[slack] Removed installation ${installKey}`);
    },
  };
}
