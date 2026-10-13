/**
 * Buttons under proposal messages, the same on Telegram, Discord and Slack.
 *
 * A button is a command run as whoever presses it - "vote 3 for",
 * "queue 3" - so it goes through exactly the checks and replies the typed
 * command does, with the presser's own wallet. Typed commands keep
 * working; WhatsApp, which has no bot buttons, only has those.
 *
 * Buttons are rows of { label, cmd } (runs a command) or { label, url }
 * (opens a link). Each platform renders them its own way and sends the
 * press back through decodeButton().
 */

const VOTE = ["tokenWeighted", "quadratic", "liquid", "sortition", "delegate"];
// No queue step: the board queues itself on enough confirmations; decision
// markets and Sowellian have their own finalize commands.
const NO_QUEUE = new Set(["board", "decisionMarkets", "sowellian"]);

const voteRow = (id) => [
  { label: "✅ For", cmd: `vote ${id} for` },
  { label: "❌ Against", cmd: `vote ${id} against` },
  { label: "➖ Abstain", cmd: `vote ${id} abstain` },
];

/** What a member can do with a proposal in `state` ("new" right after it's made). */
function actionRows(model, id, state) {
  if (state === "Queued") return [[{ label: "▶️ Execute", cmd: `execute ${id}` }]];
  if (state === "Succeeded" && !NO_QUEUE.has(model)) return [[{ label: "⏳ Queue", cmd: `queue ${id}` }]];
  const open = state === "new" || state === "Active" || state === "Pending";
  switch (model) {
    case "optimistic":
      if (state === "new" || state === "ChallengeWindow") return [[{ label: "⚔️ Challenge", cmd: `challenge ${id}` }]];
      return state === "Active" ? [voteRow(id)] : [];
    case "conviction":
      return open ? [[{ label: "💪 Support", cmd: `support ${id}` }]] : [];
    case "board":
      return open ? [[{ label: "✍️ Confirm", cmd: `confirm ${id}` }]] : [];
    default:
      return VOTE.includes(model) && open ? [voteRow(id)] : [];
  }
}

/**
 * The buttons for proposal `id`: what can be done with it now, then a
 * status refresh and its page. `state` is the proposal's state label
 * (Active, Succeeded, Queued, ...), or "new" for one just made.
 */
export function proposalButtons({ model, id, state = "new", page = null }) {
  const rows = actionRows(model, String(id), state);
  const last = [{ label: "🔄 Status", cmd: `proposal ${id}` }];
  if (page) last.push({ label: "📄 Details", url: page });
  return [...rows, last];
}

// Button payloads: "c:" + the command line. Telegram allows 64 bytes, and
// every command above is far shorter.
const PREFIX = "c:";

export function encodeButton(cmd) {
  const data = PREFIX + cmd;
  if (Buffer.byteLength(data) > 64) throw new Error(`Button command too long: ${cmd}`);
  return data;
}

/** A pressed button's command as [name, args], or null if it isn't one of ours. */
export function decodeButton(data) {
  if (typeof data !== "string" || !data.startsWith(PREFIX)) return null;
  const words = data.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const name = words.shift()?.toLowerCase();
  if (!name || !/^[a-z]+$/.test(name)) return null;
  if (!words.every((w) => /^[a-z0-9]+$/i.test(w))) return null;
  return [name, words];
}

/** Only these commands can come from a button - a forged payload can't run anything else. */
export const BUTTON_COMMANDS = new Set(["vote", "challenge", "support", "confirm", "queue", "execute", "proposal"]);

/** Telegram's inline keyboard for `rows`. */
export function telegramKeyboard(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeButton(b.cmd) }))),
  };
}
