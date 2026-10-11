import { Client, Events, GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder, MessageFlags } from "discord.js";
import { COMMANDS, runCommand, ADMIN_COMMANDS } from "./commands.js";
import { OPPORTUNITY_COMMANDS } from "./commands/opportunity.js";
import { SOWELLIAN_COMMANDS } from "./commands/sowellian.js";
import { MARKET_COMMANDS } from "./commands/markets.js";
import { startEventListener } from "../eventListener.js";

/**
 * Discord front-end for the shared command core (commands.js).
 *
 * Every command is a Discord slash command with typed options built from
 * the core's own option list. One Discord channel links to one DAO, the
 * way one Telegram group does; wallets are keyed ("discord", user ID).
 * Replies are deferred immediately, since on-chain actions take longer
 * than Discord's 3-second acknowledgement window.
 *
 * Run as its own process: `npm run discord`.
 * Env: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, optional
 * DISCORD_GUILD_ID (registers commands to one server instantly, for
 * testing; without it they register globally, which Discord can take up
 * to an hour to roll out), plus the same chain/wallet env as the
 * Telegram bot. TELEGRAM_BOT_TOKEN is not needed.
 */

const DISCORD_MAX_MESSAGE = 2000;
// Changing which DAO a channel points at is a server-management action.
// Hidden from members without Manage Server (runCommand enforces it too).
const MANAGE_COMMANDS = ADMIN_COMMANDS;

/**
 * Discord allows 100 slash commands per bot, and the bot has more. The
 * specialist ones are grouped under one command each as subcommands
 * (up to 25 per group): /market back, /sowellian takeposition,
 * /decision-market trade, /guard confirminstruction. Subcommands keep the
 * names every other platform uses. Admin commands stay top-level, since
 * Discord can only hide a whole command from non-admins.
 */
export const DISCORD_GROUPS = {
  market: { description: "Opportunity Market: deposit, back, bets, rewards", names: Object.keys(OPPORTUNITY_COMMANDS).filter((n) => !MANAGE_COMMANDS.has(n)) },
  sowellian: { description: "Sowellian DAO: criteria, approval votes, positions, resolution", names: Object.keys(SOWELLIAN_COMMANDS) },
  "decision-market": { description: "Decision Markets DAO: propose, split, trade, finalize, redeem", names: Object.keys(MARKET_COMMANDS) },
  guard: {
    description: "Guard wrapper: deploy, hand over, confirm or reject instructions",
    names: ["deployguardwrapper", "registerguardwrapper", "handovertowrapper", "guardwrapper", "instruction", "confirminstruction", "rejectinstruction", "revokeconfirmation"],
  },
};
const GROUP_OF = Object.fromEntries(Object.entries(DISCORD_GROUPS).flatMap(([group, g]) => g.names.map((n) => [n, group])));

/** How a command is typed on Discord: "/market back" for a grouped one, "/vote" otherwise. */
export const discordCommand = (name) => (GROUP_OF[name] ? `/${GROUP_OF[name]} ${name}` : `/${name}`);

/** Telegram-style *bold* -> Discord **bold**, leaving `code` spans alone. */
export function toDiscordMarkdown(text) {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") ? part : part.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1**$2**")))
    .join("");
}

/**
 * Splits text into Discord-sized messages at line breaks (a single line
 * longer than the limit is hard-cut), so long replies like help arrive
 * complete across several messages instead of being truncated.
 */
export function splitForDiscord(text, limit = DISCORD_MAX_MESSAGE) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    const pieces = line.length > limit ? line.match(new RegExp(`.{1,${limit}}`, "g")) : [line];
    for (const piece of pieces) {
      if (current && current.length + 1 + piece.length > limit) {
        chunks.push(current);
        current = piece;
      } else {
        current = current ? `${current}\n${piece}` : piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

/** Adds a command's options to a slash command or subcommand builder. */
function addOptions(builder, command) {
  // Discord requires every required option to come before any optional one.
  const ordered = [...command.options].sort((a, b) => Number(b.required) - Number(a.required));
  for (const opt of ordered) {
    const configure = (o) => {
      o.setName(opt.name).setDescription(opt.description.slice(0, 100)).setRequired(Boolean(opt.required));
      if (opt.choices) o.addChoices(...opt.choices.slice(0, 25).map((c) => ({ name: c, value: c })));
      return o;
    };
    if (opt.type === "integer") builder.addIntegerOption((o) => configure(o).setMinValue(1));
    else builder.addStringOption(configure);
  }
  return builder;
}

/** Builds the slash-command definitions Discord's API expects, from the core's option lists. */
export function buildSlashCommands() {
  const single = Object.entries(COMMANDS)
    .filter(([name]) => !GROUP_OF[name])
    .map(([name, command]) => {
      const builder = new SlashCommandBuilder().setName(name).setDescription(command.description.slice(0, 100)).setDMPermission(false);
      if (MANAGE_COMMANDS.has(name)) builder.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
      return addOptions(builder, command).toJSON();
    });
  const grouped = Object.entries(DISCORD_GROUPS).map(([group, g]) => {
    const builder = new SlashCommandBuilder().setName(group).setDescription(g.description.slice(0, 100)).setDMPermission(false);
    for (const name of g.names) {
      builder.addSubcommand((sub) => addOptions(sub.setName(name).setDescription(COMMANDS[name].description.slice(0, 100)), COMMANDS[name]));
    }
    return builder.toJSON();
  });
  const all = [...single, ...grouped];
  if (all.length > 100) throw new Error(`Discord allows 100 slash commands; the bot now has ${all.length}. Group more of them in DISCORD_GROUPS.`);
  return all;
}

/**
 * Turns an interaction's options back into the core's positional args,
 * in the command's declared order. Free-text options are split into
 * words so the core sees exactly what a Slack/Telegram user would type.
 */
export function argsFromOptions(command, getOption) {
  const args = [];
  for (const opt of command.options) {
    const value = getOption(opt.name);
    if (value === null || value === undefined || value === "") continue;
    const text = String(value).trim();
    if (opt.rest || opt.name === "args") args.push(...text.split(/\s+/).filter(Boolean));
    else args.push(text);
  }
  return args;
}

async function registerCommands(token, applicationId, guildId) {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildSlashCommands();
  const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId);
  await rest.put(route, { body });
  console.log(`[discord] Registered ${body.length} slash commands ${guildId ? `to guild ${guildId}` : "globally"}`);
}

/** Handles one slash-command interaction. Exported for tests. */
export async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  // A grouped command arrives as /<group> <name>.
  const name = DISCORD_GROUPS[interaction.commandName] ? interaction.options.getSubcommand(false) : interaction.commandName;
  const command = COMMANDS[name];
  if (!command) return;

  // Only ephemeral commands (help, wallet, listactions) stay private;
  // everything else is posted to the channel, like the Telegram bot.
  await interaction.deferReply(command.ephemeralByDefault ? { flags: MessageFlags.Ephemeral } : {});

  const ctx = {
    platform: "discord",
    chatId: interaction.channelId,
    userId: interaction.user.id,
    args: argsFromOptions(command, (n) => interaction.options.get(n)?.value),
    named: Object.fromEntries(command.options.map((o) => [o.name, interaction.options.get(o.name)?.value?.toString()])),
    isAdmin: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
    cmd: discordCommand,
  };

  const result = await runCommand(name, ctx);
  const [first, ...more] = splitForDiscord(toDiscordMarkdown(result.text));
  const privateFlags = { flags: MessageFlags.Ephemeral };

  // A deferred public reply can't become ephemeral after the fact, so
  // private results (errors, wallet details) go in ephemeral follow-ups
  // and the public placeholder is removed.
  if (result.ephemeral && !command.ephemeralByDefault) {
    await interaction.deleteReply().catch(() => {});
    await interaction.followUp({ content: first, ...privateFlags });
  } else {
    await interaction.editReply({ content: first });
  }
  const private_ = Boolean(result.ephemeral || command.ephemeralByDefault);
  for (const content of more) await interaction.followUp({ content, ...(private_ ? privateFlags : {}) });
  // Something only the caller should see after a public reply (a proposal's edit link).
  if (result.privateFollowUp) await interaction.followUp({ content: toDiscordMarkdown(result.privateFollowUp), ...privateFlags });
}

export async function startDiscordBot({ token, applicationId, guildId } = {}) {
  if (!token || !applicationId) throw new Error("DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required.");

  await registerCommands(token, applicationId, guildId);

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.InteractionCreate, (interaction) => {
    handleInteraction(interaction).catch((err) => console.error("[discord] Interaction failed:", err));
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] Logged in as ${c.user.tag}`);
    startEventListener({
      platform: "discord",
      notify: async (channelId, text) => {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) return;
        for (const content of splitForDiscord(toDiscordMarkdown(text))) await channel.send(content);
      },
    });
  });

  await client.login(token);
  return client;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startDiscordBot({
    token: process.env.DISCORD_BOT_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    guildId: process.env.DISCORD_GUILD_ID,
  }).catch((err) => {
    console.error("[discord] Fatal error:", err);
    process.exit(1);
  });
}
