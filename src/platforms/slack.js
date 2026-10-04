import bolt from "@slack/bolt";
import { COMMANDS, runCommand, ADMIN_COMMANDS } from "./commands.js";
import { attemptClaim } from "./commands/setup.js";
import { getChatNetwork, recordSlackTeam, getSlackTeam, getSlackChannelsWithoutTeam } from "../db.js";
import { runOnNetwork } from "../networks.js";
import { startEventListener } from "../eventListener.js";
import { createInstallationStore, isSlackInstallationStoreConfigured } from "./slackInstallations.js";
import { splitArgs } from "../args.js";

const { App } = bolt;

/**
 * Slack front-end for the shared command core (commands.js).
 *
 * Slack apps register slash commands one by one in the app config, so
 * this uses a single command, `/protean <subcommand> <args...>` (e.g.
 * `/protean vote 3 for`), which needs only one entry in the manifest
 * (docs/slack-app-manifest.yml). One Slack channel links to one DAO;
 * wallets are keyed ("slack", user ID).
 *
 * Uses Socket Mode: commands and events arrive over a socket the bot
 * opens to Slack. Run as its own process: `npm run slack`. Two ways to
 * run it, picked by whether SLACK_CLIENT_ID is set:
 *
 * - Any workspace (SLACK_CLIENT_ID set): workspaces install through
 *   "Add to Slack" at <SLACK_PUBLIC_URL>/slack/install, a small HTTP
 *   server this process runs for the OAuth flow only. Each workspace's
 *   bot token is stored encrypted in Supabase (slackInstallations.js).
 *   Env: SLACK_APP_TOKEN, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET,
 *   SLACK_STATE_SECRET, SLACK_PUBLIC_URL, plus Supabase + KMS.
 * - One workspace (no SLACK_CLIENT_ID): SLACK_BOT_TOKEN (xoxb-...) and
 *   SLACK_APP_TOKEN (xapp-..., with connections:write).
 *
 * Both need the same chain/wallet env as the Telegram bot;
 * TELEGRAM_BOT_TOKEN is not needed.
 *
 * Admin detection: Slack only exposes workspace admin status through an
 * extra users.info call, so isAdmin comes from that (is_admin/is_owner).
 * Only they may create, register or unregister a channel's DAO or market
 * (commands.js ADMIN_COMMANDS); if the lookup fails, those are refused.
 */

const SLASH_COMMAND = process.env.SLACK_COMMAND || "/protean";

/** Must match oauth_config.scopes.bot in docs/slack-app-manifest.yml. */
export const SLACK_BOT_SCOPES = ["commands", "chat:write", "chat:write.public", "users:read", "channels:read", "groups:read"];

const REDIRECT_PATH = "/slack/oauth_redirect";

/** Splits "/protean vote 3 for because" into ["vote", ["3", "for", "because"]]. */
export function parseSlackText(text) {
  const words = splitArgs(text);
  const [name = "help", ...args] = words;
  return [name.toLowerCase(), args];
}

async function lookupIsAdmin(client, userId) {
  try {
    const { user } = await client.users.info({ user: userId });
    return Boolean(user?.is_admin || user?.is_owner);
  } catch {
    return undefined;
  }
}

/** Handles one `/protean ...` invocation. Exported for tests. */
export async function handleSlashCommand({ command, ack, respond, client }) {
  // Slack needs an ack within 3 seconds; the real answer follows via respond().
  await ack();

  const [name, args] = parseSlackText(command.text);
  const known = COMMANDS[name];
  if (known && !known.ephemeralByDefault) {
    await respond({ response_type: "ephemeral", text: `⏳ Working on \`${name}\`…` });
  }

  const ctx = {
    platform: "slack",
    chatId: command.channel_id,
    userId: command.user_id,
    args,
    isAdmin: ADMIN_COMMANDS.has(name) ? await lookupIsAdmin(client, command.user_id) : undefined,
    isDirect: command.channel_name === "directmessage",
    cmd: (sub) => `${SLASH_COMMAND} ${sub}`,
  };

  const result = await runCommand(name, ctx);
  recordSlackTeam(command.channel_id, command.team_id);
  // Public results post to the channel so the whole group sees votes and
  // proposals, same as Telegram; errors and private details stay ephemeral.
  await respond({ response_type: result.ephemeral ? "ephemeral" : "in_channel", text: result.text, mrkdwn: true });
}

/**
 * Telegram's automatic welcome grant: when someone joins a channel with a
 * welcome distributor linked, send them their tokens. Silent unless it
 * worked - failures surface when they run `/protean claim` themselves.
 */
export async function handleMemberJoined(event, client) {
  const ctx = { platform: "slack", chatId: event.channel, userId: event.user };
  const result = await runOnNetwork(getChatNetwork(ctx.chatId, ctx.platform), () => attemptClaim(ctx)).catch((err) => ({ status: "error", error: err.message }));
  if (result.status === "sent") {
    await client.chat.postMessage({ channel: event.channel, text: `🎉 Welcome, <@${event.user}>! Sent your welcome tokens.` });
  }
}

/**
 * Reads the multi-workspace settings from env, or null to run on a
 * single SLACK_BOT_TOKEN.
 */
export function slackOAuthConfigFromEnv(env = process.env) {
  if (!env.SLACK_CLIENT_ID) return null;
  const missing = ["SLACK_CLIENT_SECRET", "SLACK_STATE_SECRET", "SLACK_PUBLIC_URL"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`SLACK_CLIENT_ID is set, so ${missing.join(", ")} must be too.`);
  return {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    stateSecret: env.SLACK_STATE_SECRET,
    publicUrl: env.SLACK_PUBLIC_URL.replace(/\/+$/, ""),
    port: Number(env.SLACK_INSTALL_PORT || env.PORT || 3000),
  };
}

/**
 * After a workspace installs, find its channels that were linked before
 * the multi-workspace install (no workspace recorded) - a channel ID is
 * only visible to its own workspace, so conversations.info succeeding
 * means it belongs to this one.
 */
async function adoptUnassignedChannels(client, installation) {
  const token = installation.bot?.token;
  const teamId = installation.team?.id;
  if (!token || !teamId) return;
  for (const channelId of getSlackChannelsWithoutTeam()) {
    const ok = await client.conversations.info({ token, channel: channelId }).then(() => true, () => false);
    if (ok) recordSlackTeam(channelId, teamId);
  }
}

/**
 * Posts a listener notification. With per-workspace installs the token
 * comes from the channel's workspace, recorded by recordSlackTeam.
 */
export function createSlackNotify(app, store) {
  return async (channelId, text) => {
    if (!store) return app.client.chat.postMessage({ channel: channelId, text, mrkdwn: true });
    const teamId = getSlackTeam(channelId);
    if (!teamId) throw new Error("workspace not known yet - run any /protean command in the channel");
    const installation = await store.fetchInstallation({ teamId, isEnterpriseInstall: false });
    return app.client.chat.postMessage({ token: installation.bot.token, channel: channelId, text, mrkdwn: true });
  };
}

/**
 * `installationStoreOptions` and `clientOptions` exist for tests (an
 * in-memory backend, a fake Slack API URL).
 */
export async function startSlackBot({ token, appToken, oauth = null, installationStoreOptions = null, clientOptions = undefined } = {}) {
  if (!appToken) throw new Error("SLACK_APP_TOKEN is required.");
  if (!oauth && !token) throw new Error("Set SLACK_BOT_TOKEN, or SLACK_CLIENT_ID etc. to install into any workspace.");

  let app;
  let store = null;
  if (oauth) {
    if (!installationStoreOptions && !isSlackInstallationStoreConfigured()) {
      throw new Error("Installing into any workspace stores each workspace's token encrypted in Supabase - set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and KMS_KEY_ID.");
    }
    store = createInstallationStore({ ...installationStoreOptions, onStored: (installation) => adoptUnassignedChannels(app.client, installation) });
    app = new App({
      appToken,
      socketMode: true,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      stateSecret: oauth.stateSecret,
      scopes: SLACK_BOT_SCOPES,
      redirectUri: `${oauth.publicUrl}${REDIRECT_PATH}`,
      installationStore: store,
      installerOptions: { port: oauth.port, directInstall: true, redirectUriPath: REDIRECT_PATH, clientOptions },
      clientOptions,
    });
  } else {
    app = new App({ token, appToken, socketMode: true, clientOptions });
  }

  app.command(SLASH_COMMAND, handleSlashCommand);
  app.event("member_joined_channel", ({ event, client }) => handleMemberJoined(event, client));

  if (oauth) {
    // Removing the app from a workspace revokes its token - drop ours too.
    const forget = ({ context }) =>
      store.deleteInstallation({
        teamId: context.teamId,
        enterpriseId: context.enterpriseId,
        isEnterpriseInstall: context.isEnterpriseInstall,
      });
    app.event("app_uninstalled", forget);
    app.event("tokens_revoked", async (args) => {
      if (args.event.tokens?.bot?.length) await forget(args);
    });
  }

  await app.start();
  console.log(`[slack] Connected in Socket Mode, listening for ${SLASH_COMMAND}`);
  if (oauth) console.log(`[slack] Add to Slack: ${oauth.publicUrl}/slack/install (HTTP on port ${oauth.port})`);

  startEventListener({ platform: "slack", notify: createSlackNotify(app, store) });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(() =>
      startSlackBot({
        token: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        oauth: slackOAuthConfigFromEnv(),
      })
    )
    .catch((err) => {
      console.error("[slack] Fatal error:", err);
      process.exit(1);
    });
}
