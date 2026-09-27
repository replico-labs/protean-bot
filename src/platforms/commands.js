import { getChatDAO, getChatModel, getChatMarket, getChatGuardWrapper } from "../db.js";
import { hasToken } from "../governance/common.js";
import { UserError, reply } from "./helpers.js";
import { CORE_COMMANDS } from "./commands/core.js";
import { SETUP_COMMANDS } from "./commands/setup.js";
import { TOKEN_COMMANDS } from "./commands/tokens.js";
import { MODEL_COMMANDS } from "./commands/models.js";
import { SOWELLIAN_COMMANDS } from "./commands/sowellian.js";
import { MARKET_COMMANDS } from "./commands/markets.js";
import { OPPORTUNITY_COMMANDS } from "./commands/opportunity.js";

export { UserError };

/**
 * Platform-neutral command registry for the Discord and Slack front-ends.
 * Every Telegram command is here except /start (use help) and
 * /migratewallet (legacy seed wallets only ever existed for Telegram IDs).
 *
 * Each command takes a context and returns a reply; the platform file
 * only handles transport. Context:
 *   platform  "discord" | "slack" - the db.js / walletStore.js key prefix
 *   chatId    channel ID - one channel links to one DAO, like a Telegram group
 *   userId    platform user ID - one KMS wallet per (platform, userId)
 *   command   this command's name (set by runCommand)
 *   args      positional string tokens, in each command's `options` order
 *   named     optional { optionName: rawString } for platforms with separate
 *             fields per option (Discord), used where word boundaries matter
 *   isAdmin   true/false if the platform can tell, undefined if it can't
 *   cmd(name) how this platform spells a command, for usage hints
 *
 * Replies use Telegram-style markdown (*bold*, `code`); Discord converts
 * bold to its own syntax, Slack mrkdwn matches as-is. A reply is
 * { text, ephemeral? }. `ephemeralByDefault` tells a platform up front
 * that the reply is private (Discord must choose before running).
 *
 * `options` drives Discord slash-command registration: name, description,
 * required, optional `type: "integer"` and `choices`, and `rest: true` on
 * a last option that swallows the remaining words. `section`, `usage` and
 * `models` drive help.
 */

// Help metadata for the core commands, which predate the per-command fields.
const CORE_META = {
  register: ["Setup", "<governanceAddress> [model]"],
  unregister: ["Setup", ""],
  wallet: ["Your wallet", ""],
  balance: ["Your wallet", "[address]"],
  stake: ["Your wallet", "<amount>", true],
  unstake: ["Your wallet", "<amount>", true],
  dao: ["The DAO", ""],
  treasury: ["The DAO", ""],
  proposals: ["The DAO", ""],
  proposal: ["The DAO", "<id>"],
  listactions: ["Proposing", ""],
  proposeaction: ["Proposing", "<actionId> <args...> <description>"],
  propose: ["Proposing", "<target> <valueWei> <data> <description>"],
  vote: ["Deciding", "<id> for|against|abstain [reason]"],
  queue: ["Deciding", "<id>"],
  execute: ["Deciding", "<id> [nativeValue]"],
  cancel: ["Deciding", "<id>"],
};
for (const [name, [section, usage, tokenOnly]] of Object.entries(CORE_META)) {
  Object.assign(CORE_COMMANDS[name], { section, usage, ...(tokenOnly ? { tokenOnly: true } : {}) });
}

const SECTION_ORDER = [
  "Setup",
  "Your wallet",
  "Tokens",
  "The DAO",
  "Proposing",
  "Deciding",
  "Council",
  "Sowellian",
  "Decision markets",
  "Guard wrapper",
  "Opportunity Market",
];

const help = {
  section: "Help",
  usage: "",
  description: "Show the commands that apply to this channel",
  ephemeralByDefault: true,
  options: [],
  async run(ctx) {
    const hasDao = Boolean(getChatDAO(ctx.chatId, ctx.platform));
    const model = hasDao ? getChatModel(ctx.chatId, ctx.platform) : null;
    const hasMarket = Boolean(getChatMarket(ctx.chatId, ctx.platform));
    const hasGuard = Boolean(getChatGuardWrapper(ctx.chatId, ctx.platform));

    // Same idea as Telegram's /help: only what works for this channel's DAO.
    const applies = (name, c) => {
      if (c.models && (!model || !c.models.includes(model))) return false;
      if (c.tokenOnly && model && !hasToken(model)) return false;
      if (c.section === "Opportunity Market") return hasMarket || ["registermarket", "createmarket"].includes(name);
      if (c.section === "Guard wrapper") return hasDao && (hasGuard || ["deployguardwrapper", "registerguardwrapper", "handovertowrapper"].includes(name));
      return true;
    };

    const lines = [model ? `*Protean DAO* — this channel's DAO uses *${model}* governance` : "*Protean DAO* — no DAO linked here yet"];
    for (const section of SECTION_ORDER) {
      const entries = Object.entries(COMMANDS).filter(([name, c]) => c.section === section && applies(name, c));
      if (!entries.length) continue;
      lines.push("", `*${section}*`);
      for (const [name, c] of entries) lines.push(`\`${ctx.cmd(name)}${c.usage ? " " + c.usage : ""}\` — ${c.description}`);
    }
    return reply(lines.join("\n"), { ephemeral: true });
  },
};

export const COMMANDS = {
  help,
  ...CORE_COMMANDS,
  ...SETUP_COMMANDS,
  ...TOKEN_COMMANDS,
  ...MODEL_COMMANDS,
  ...SOWELLIAN_COMMANDS,
  ...MARKET_COMMANDS,
  ...OPPORTUNITY_COMMANDS,
};

/**
 * Runs one command and always returns a reply - never throws. UserErrors
 * are shown as-is; chain errors show viem's short message; anything else
 * is logged and reported generically. Errors are always private.
 */
export async function runCommand(name, ctx) {
  const command = COMMANDS[name];
  if (!command) return reply(`Unknown command \`${name}\`. Try \`${ctx.cmd("help")}\`.`, { ephemeral: true });
  try {
    return await command.run({ ...ctx, command: name });
  } catch (err) {
    if (err instanceof UserError) return reply(err.message, { ephemeral: true });
    console.error(`[${ctx.platform}] ${name} failed:`, err);
    // viem's shortMessage says only "reverted"; the decoded custom error
    // (e.g. AlreadyConfirmed) is what actually tells the user why.
    const errorName = typeof err.walk === "function" ? err.walk((e) => e?.data?.errorName)?.data?.errorName : undefined;
    const why = errorName ? ` (${errorName})` : "";
    return reply(`Couldn't complete \`${name}\`: ${err.shortMessage || err.message || "unknown error"}${why}`, { ephemeral: true });
  }
}
