import bolt from "@slack/bolt";
import { COMMANDS, runCommand } from "./commands.js";
import { attemptClaim } from "./commands/setup.js";
import { startEventListener } from "../eventListener.js";

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
 * Uses Socket Mode, so the bot needs no public URL - it connects out to
 * Slack. Run as its own process: `npm run slack`.
 * Env: SLACK_BOT_TOKEN (xoxb-...), SLACK_APP_TOKEN (xapp-..., with
 * connections:write), plus the same chain/wallet env as the Telegram bot.
 * TELEGRAM_BOT_TOKEN is not needed.
 *
 * Admin detection: Slack only exposes workspace admin status through an
 * extra users.info call, so isAdmin comes from that (is_admin/is_owner).
 * If the lookup fails it's left undefined, and only whoever linked the
 * channel can relink or unlink it.
 */

const SLASH_COMMAND = process.env.SLACK_COMMAND || "/protean";

/** Splits "/protean vote 3 for because" into ["vote", ["3", "for", "because"]]. */
export function parseSlackText(text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
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
    isAdmin: name === "register" || name === "unregister" ? await lookupIsAdmin(client, command.user_id) : undefined,
    cmd: (sub) => `${SLASH_COMMAND} ${sub}`,
  };

  const result = await runCommand(name, ctx);
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
  const result = await attemptClaim(ctx).catch((err) => ({ status: "error", error: err.message }));
  if (result.status === "sent") {
    await client.chat.postMessage({ channel: event.channel, text: `🎉 Welcome, <@${event.user}>! Sent your welcome tokens.` });
  }
}

export async function startSlackBot({ token, appToken } = {}) {
  if (!token || !appToken) throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required.");

  const app = new App({ token, appToken, socketMode: true });

  app.command(SLASH_COMMAND, handleSlashCommand);
  app.event("member_joined_channel", ({ event, client }) => handleMemberJoined(event, client));

  await app.start();
  console.log(`[slack] Connected in Socket Mode, listening for ${SLASH_COMMAND}`);

  startEventListener({
    platform: "slack",
    notify: (channelId, text) => app.client.chat.postMessage({ channel: channelId, text, mrkdwn: true }),
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSlackBot({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
  }).catch((err) => {
    console.error("[slack] Fatal error:", err);
    process.exit(1);
  });
}
