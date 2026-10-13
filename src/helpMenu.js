/**
 * /help as a menu: a few lines and one button per topic, each showing just
 * that topic's commands with a button back. `/help <topic>` types the
 * same thing (WhatsApp has no buttons), and `/help all` is the whole list.
 * Telegram, Discord, Slack and WhatsApp, EVM and Solana DAOs all build
 * their sections and hand them here.
 */

// Topic keys, their button labels, in menu order.
const TOPICS = {
  setup: "⚙️ Setup",
  wallet: "👛 Wallet",
  tokens: "🪙 Tokens",
  dao: "🏛 The DAO",
  proposing: "📝 Proposing",
  deciding: "🗳 Deciding",
  proposals: "🗳 Proposals",
  council: "👥 Council",
  sowellian: "🔮 Sowellian",
  markets: "📈 Markets",
  guard: "🛡 Guard wrapper",
  opportunity: "🎯 Opportunity Market",
  welcome: "🎁 Welcome tokens",
};
const ORDER = Object.keys(TOPICS);

/**
 * The reply for `/help [topic]`: { text, buttons }.
 *   sections  [{ key, title, lines }] - empty sections are left out
 *   topic     the word after /help, if any
 *   intro     the first line(s): which DAO and model this chat has
 *   cmd       how this platform spells a command, e.g. (n) => `/${n}`
 */
export function helpReply({ sections, topic, intro, cmd }) {
  const present = sections.filter((s) => s.lines.length).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  // "/help @proteandao_bot" (with a space) passes the bot's name as a word: not a topic.
  const key = topic?.startsWith("@") ? undefined : topic?.toLowerCase();

  if (key === "all") {
    return { text: [intro, ...present.flatMap((s) => ["", `*${s.title}*`, ...s.lines])].join("\n"), buttons: [] };
  }
  const section = present.find((s) => s.key === key);
  if (section) {
    return { text: [`*${section.title}*`, "", ...section.lines].join("\n"), buttons: [[{ label: "◀ All topics", cmd: "help" }]] };
  }

  const topics = present.map((s) => ({ label: TOPICS[s.key] ?? s.title, cmd: `help ${s.key}` }));
  const rows = [];
  for (let i = 0; i < topics.length; i += 2) rows.push(topics.slice(i, i + 2));
  rows.push([{ label: "📜 Everything", cmd: "help all" }]);
  const text = [
    ...(key ? [`No help topic \`${key}\`.`, ""] : []),
    intro,
    "",
    "Pick a topic below, or type it:",
    `\`${cmd("help")} <topic>\` — ${present.map((s) => s.key).join(", ")}`,
    `\`${cmd("help")} all\` — every command at once`,
  ].join("\n");
  return { text, buttons: rows };
}
