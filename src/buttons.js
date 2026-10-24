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

const voteRow = (id, command = "vote") => [
  { label: "✅ For", cmd: `${command} ${id} for` },
  { label: "❌ Against", cmd: `${command} ${id} against` },
  { label: "➖ Abstain", cmd: `${command} ${id} abstain` },
];

const b = (label, cmd) => ({ label, cmd });

/**
 * A Sowellian proposal's buttons through its phases. State names differ
 * a little between EVM (the contract's phase) and Solana (worked out from
 * the clock too): ApprovalVoting vs Pending/Active/ApprovalClosed,
 * ResolutionPending vs AwaitingResolution, Finalized vs Resolved.
 * `track` ("oracle" or "human", when known) picks how it gets resolved.
 */
function sowellianRows(id, state, track) {
  const close = b("🔒 Close approval vote", `finalizeapproval ${id}`);
  switch (state) {
    case "new":
    case "Pending":
    case "Active":
      return [voteRow(id, "castapprovalvote")];
    case "ApprovalVoting":
      return [voteRow(id, "castapprovalvote"), [close]];
    case "ApprovalClosed":
      return [[close]];
    case "PositionsOpen":
      return [[b("🟢 Back YES", `ask amount takeposition ${id} yes`), b("🔴 Back NO", `ask amount takeposition ${id} no`)]];
    case "ResolutionPending":
    case "AwaitingResolution":
      return [
        ...(track !== "human" ? [[b("🔮 Resolve from the oracle", `resolveviaoracle ${id}`)]] : []),
        ...(track !== "oracle" ? [[b("📣 It worked", `ask sure proposeresolution ${id} success`), b("📣 It didn't", `ask sure proposeresolution ${id} failure`)]] : []),
      ];
    case "ResolutionProposed":
      return [[b("⚔️ Challenge", `ask sure challengeresolution ${id}`), b("✅ Lock it in", `finalizeunchallenged ${id}`)]];
    case "Adjudicating":
      return [
        [b("✅ It worked", `castadjudicationvote ${id} success`), b("❌ It didn't", `castadjudicationvote ${id} failure`)],
        [b("🔒 Close the vote", `finalizeadjudication ${id}`)],
      ];
    case "Finalized":
    case "Resolved":
      return [[b("💰 Claim winnings", `claimposition ${id}`)]];
    default:
      return [];
  }
}

/**
 * A decision-markets proposal's buttons: trading while its markets are
 * open (EVM says Open or Seeded, Solana Trading), settling once trading
 * ends, redeeming the winning side once settled. Amounts go through a
 * picker (buttonMenus.js).
 */
function marketRows(id, state, solana) {
  const settle = b("🏁 Settle markets", `finalizeproposal ${id}`);
  if (["new", "Open", "Seeded", "Trading"].includes(state)) {
    return [
      [b("🟢 Buy pass", `ask amount trade ${id} pass buy`), b("🔴 Buy fail", `ask amount trade ${id} fail buy`)],
      [b("Sell pass", `ask amount trade ${id} pass sell`), b("Sell fail", `ask amount trade ${id} fail sell`)],
      [b("➗ Split quote", `ask amount split ${id} quote`), b("➗ Split tokens", `ask amount split ${id} base`), ...(state === "Open" ? [settle] : [])],
    ];
  }
  if (state === "TradingClosed") return [[settle]];
  if (["Queued", "Defeated", "Failed", "Executed", "Expired"].includes(state)) {
    return [solana ? [b("💰 Redeem", `redeem ${id}`)] : [b("💰 Redeem tokens", `redeem ${id} base`), b("💰 Redeem quote", `redeem ${id} quote`)]];
  }
  return [];
}

/** What a member can do with a proposal in `state` ("new" right after it's made). */
function modelRows(model, id, state, solana, track) {
  const open = state === "new" || state === "Active" || state === "Pending";
  switch (model) {
    case "optimistic":
      if (state === "new" || state === "ChallengeWindow") return [[b("⚔️ Challenge", `challenge ${id}`)]];
      return state === "Active" ? [voteRow(id)] : [];
    case "conviction":
      return open ? [[b("💪 Support", `support ${id}`)]] : [];
    case "board":
      return open ? [[b("✍️ Confirm", `confirm ${id}`)]] : [];
    case "sowellian":
      return sowellianRows(id, state, track);
    case "decisionMarkets":
      return marketRows(id, state, solana);
    default:
      return VOTE.includes(model) && open ? [voteRow(id)] : [];
  }
}

function actionRows(model, id, state, solana, track) {
  const rows = modelRows(model, id, state, solana, track);
  if (state === "Queued") return [[b("▶️ Execute", `execute ${id}`)], ...rows];
  if (state === "Succeeded" && !NO_QUEUE.has(model)) return [[b("⏳ Queue", `queue ${id}`)], ...rows];
  return rows;
}

/**
 * The buttons for proposal `id`: what can be done with it now, then a
 * status refresh and its page. `state` is the proposal's state label
 * (Active, Succeeded, Queued, ...), or "new" for one just made. `solana`:
 * a Vortexes DAO, whose few commands take different words. `track`: a
 * Sowellian proposal's resolution track (sowellian.js buttonHint on EVM).
 */
export function proposalButtons({ model, id, state = "new", page = null, solana = false, track }) {
  const rows = actionRows(model, String(id), state, solana, track);
  const last = [b("🔄 Status", `proposal ${id}`)];
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
  if (!words.every((w) => /^[a-z0-9.]+$/i.test(w))) return null;
  return [name, words];
}

/** Only these commands can come from a button - a forged payload can't run anything else. */
export const BUTTON_COMMANDS = new Set([
  "vote", "challenge", "support", "confirm", "queue", "execute", "proposal", "help",
  // Sowellian
  "castapprovalvote", "finalizeapproval", "takeposition", "resolveviaoracle", "proposeresolution", "challengeresolution",
  "finalizeunchallenged", "castadjudicationvote", "finalizeadjudication", "claimposition",
  // Decision markets
  "trade", "split", "finalizeproposal", "redeem",
  // A second-step menu (buttonMenus.js): an amount picker or a confirmation.
  "ask",
]);

/** Telegram's inline keyboard for `rows`. */
export function telegramKeyboard(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => (b.url ? { text: b.label, url: b.url } : { text: b.label, callback_data: encodeButton(b.cmd) }))),
  };
}
