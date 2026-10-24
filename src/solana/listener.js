import path from "path";
import { fileURLToPath } from "url";
import { PublicKey } from "@solana/web3.js";
import { getAllSolanaChats, updateChatSolana } from "../db.js";
import { readJson, writeJsonAtomic } from "../jsonFile.js";
import { SOLANA_ENABLED, getSolanaNetwork, getSolanaOperator, explorerUrl } from "./config.js";
import { proposalPageUrl } from "../proposalPages.js";
import * as v from "./vortex.js";
import { solanaProposalImage } from "./charts.js";
import { link } from "../links.js";
import { proposalButtons } from "../buttons.js";

/**
 * Notifications for chats linked to a Solana DAO - the Solana side of
 * eventListener.js, started from it with the same { platform, notify }.
 *
 * Every Vortexes governance instruction touches the DAO's governance
 * account, so each poll asks the RPC for that account's new transactions
 * and reads the program's Anchor events from their logs (proposal
 * executions arrive through the hub's call into the governance program).
 * The first look at a DAO only records where it is, so linking a busy
 * DAO doesn't replay its history. A model switch that's due is applied
 * here too, as anyone may.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statePathFor = (platform) => path.join(__dirname, "..", "..", "data", `solanaListenerState.${platform}.json`);

const LABEL = {
  tokenWeighted: "token-weighted",
  quadratic: "quadratic",
  optimistic: "optimistic",
  board: "board",
  conviction: "conviction",
  delegate: "delegate",
  liquid: "liquid",
  sortition: "sortition",
  sowellian: "Sowellian",
  decisionMarkets: "decision markets",
};
const short = (k) => {
  const s = k.toBase58 ? k.toBase58() : String(k);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = s / 3600;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

const num = (x) => Number(x.toString());
/** An Anchor enum value ({ success: {} }) as its name. */
const variantName = (e) => Object.keys(e ?? {})[0] ?? "?";
/** User text without Markdown's control characters (Telegram's notify has no plain-text fallback). */
const plain = (text) => String(text).replace(/[_*`[\]]/g, "");

/** One event as a chat line, or null for events not worth a message. */
export function formatSolanaEvent(name, e, { model, now, name: daoName }) {
  const dao = daoName ? ` in *${plain(daoName)}*` : "";
  // Anchor's coder names events in camelCase ("proposalExecuted").
  switch (name.charAt(0).toUpperCase() + name.slice(1)) {
    case "ProposalCreated": {
      const tail = {
        optimistic: e.challengeDeadline ? ` It passes unless challenged within ${duration(num(e.challengeDeadline) - now)}.` : "",
        board: " Signers can confirm it.",
        conviction: " Members can back it with their stake.",
        delegate: " The council can vote on it.",
        sortition: " The council can vote on it.",
        sowellian: e.approvalEndsAt ? ` Its approval vote closes in ${duration(num(e.approvalEndsAt) - now)}.` : "",
        decisionMarkets: e.tradingDeadline ? ` Its pass and fail markets trade for ${duration(num(e.tradingDeadline) - now)}.` : "",
      }[model] ?? (e.votingEndsAt ? ` Voting closes in ${duration(num(e.votingEndsAt) - now)}.` : "");
      return `📝 New proposal #${e.id}${dao}: "${plain(e.metadataUri)}" (by \`${short(e.proposer)}\`).${tail}`;
    }
    case "Challenged":
      return `⚔️ Proposal #${e.id}${dao} was challenged by \`${short(e.challenger)}\` - a vote is open for ${duration(num(e.votingEndsAt) - now)}.`;
    case "ChallengeSettled":
      return e.passed ? `✅ The challenge to proposal #${e.id}${dao} failed - the proposal passes.` : `❌ Proposal #${e.id}${dao} was voted down after its challenge.`;
    case "ProposalQueued":
      return `⏳ Proposal #${e.id}${dao} is queued - it can run in ${duration(num(e.executableAt) - now)}.`;
    case "ProposalExecuted":
      return `✅ Proposal #${e.id}${dao} has run.`;
    case "ProposalCancelled":
      return `🚫 Proposal #${e.id}${dao} was cancelled.`;
    case "ElectionStarted":
      return `🗳 Election #${e.id}${dao} is open: candidates can stand for ${duration(num(e.candidacyEndsAt) - now)}, then voting runs until ${duration(num(e.votingEndsAt) - now)} from now.`;
    case "ElectionFinalized":
      return e.seated ? `🏛 Election #${e.id}${dao} is decided. The new council: ${e.council.map((m) => `\`${short(m)}\``).join(", ")}.` : `Election #${e.id}${dao} closed with no votes; the council stays.`;
    case "RecallStarted":
      return `⚠️ A recall of council member \`${short(e.member)}\`${dao} is open for ${duration(num(e.endsAt) - now)}.`;
    case "RecallFinalized":
      return e.removed ? `Council member \`${short(e.member)}\` was recalled${dao}.` : `The recall of \`${short(e.member)}\`${dao} failed.`;
    // sortition
    case "DrawStarted":
      return `🎲 Council draw #${e.number}${dao} ${e.restart ? "restarted" : "started"} from ${e.poolSize} member(s) - the council is seated once the randomness arrives.`;
    case "DrawFinalized":
      return `🏛 Council draw #${e.number}${dao} is done. The new council: ${e.council.map((m) => `\`${short(m)}\``).join(", ")}.`;
    // sowellian
    case "ApprovalFinalized":
      return e.approved ? `✅ Proposal #${e.id}${dao} is approved - YES/NO positions are open for ${duration(num(e.positionsDeadline) - now)}.` : `❌ Proposal #${e.id}${dao} wasn't approved.`;
    case "ResolutionProposed":
      return `⚖️ \`${short(e.resolver)}\` says proposal #${e.id}${dao} was a *${variantName(e.outcome)}* - it can be challenged for ${duration(num(e.challengeDeadline) - now)}.`;
    case "ResolutionChallenged":
      return `⚔️ The resolution of proposal #${e.id}${dao} was challenged - an adjudication vote is open for ${duration(num(e.adjudicationEndsAt) - now)}.`;
    case "OutcomeFinalized":
    case "ResolvedViaOracle":
      return `🏁 Proposal #${e.id}${dao} is resolved: *${variantName(e.outcome)}*${name === "resolvedViaOracle" ? " (from Pyth)" : ""}. Winners can collect.`;
    case "ProposalVoided":
      return `Proposal #${e.id}${dao} wasn't run in time and is void - positions are refunded.`;
    // decision markets
    case "ProposalFinalized":
      return e.passed ? `✅ Proposal #${e.id}${dao} passed its markets - it can run after the timelock.` : `❌ Proposal #${e.id}${dao} failed its markets.`;
    default:
      return null;
  }
}

/** The DAO's new events since `until` (oldest first, each with its transaction's signature), and its newest signature. */
async function newEvents(network, d, until) {
  const conn = network.connection;
  const sigs = await conn.getSignaturesForAddress(d.governance, until ? { until, limit: 100 } : { limit: 1 }, "confirmed");
  const newest = sigs[0]?.signature ?? until ?? null;
  if (!until) return { newest, events: [] };
  const coder = v.programFor(network, d.model).coder;
  const events = [];
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (const ev of programEvents(tx?.meta?.logMessages ?? [], d.gp, coder)) events.push({ ...ev, signature: s.signature });
  }
  return { newest, events };
}

/**
 * The Anchor events `programId` emitted, read from a transaction's logs:
 * its "Program data:" lines while it's the running program, including
 * inside the hub's call into it. (Anchor's own EventParser loses track at
 * the "Program return:" line a CPI with return data writes.)
 */
export function programEvents(logs, programId, coder) {
  const id = programId.toBase58();
  const stack = [];
  const events = [];
  for (const line of logs) {
    const invoke = line.match(/^Program (\w+) invoke \[\d+\]$/);
    if (invoke) stack.push(invoke[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith("Program data: ") && stack[stack.length - 1] === id) {
      const ev = coder.events.decode(line.slice("Program data: ".length));
      if (ev) events.push(ev);
    }
  }
  return events;
}

/*
 * Vote results, as on EVM (eventListener.js): every proposal seen opening
 * a vote (or a challenge window, approval vote or trading) is tracked by
 * when that ends, read once it has, and its result posted with its chart.
 */
const VOTE_MODELS = new Set(["tokenWeighted", "quadratic", "liquid", "delegate", "sortition", "optimistic", "sowellian", "decisionMarkets"]);
// States in which the vote (or challenge window, approval vote, trading) is still going.
const STILL_OPEN = new Set(["Pending", "Active", "ChallengeWindow", "Trading"]);
const MAX_TRACKED = 50; // per DAO
const TRACK_DAYS = 30;

/** When the vote an event opens ends (cluster seconds), or null if the event opens none. */
function voteEndsAt(name, e) {
  switch (name.charAt(0).toUpperCase() + name.slice(1)) {
    case "ProposalCreated":
      return num(e.votingEndsAt ?? e.challengeDeadline ?? e.approvalEndsAt ?? e.tradingDeadline ?? 0) || null;
    case "Challenged":
      return num(e.votingEndsAt);
    default:
      return null;
  }
}

function trackVote(open, model, name, e) {
  if (!VOTE_MODELS.has(model) || e.id === undefined) return;
  const endsAt = voteEndsAt(name, e);
  if (!endsAt) return;
  const id = String(e.id);
  if (!open[id] && Object.keys(open).length >= MAX_TRACKED) return;
  open[id] = { endsAt, since: open[id]?.since ?? Date.now() };
}

/** Posts the result of each tracked vote that has ended, then stops tracking it. */
async function postVoteCloses(network, d, chat, open, notify) {
  const now = await v.clusterNow(network);
  let g = null;
  for (const [id, t] of Object.entries(open)) {
    if (Date.now() - t.since > TRACK_DAYS * 86_400_000) {
      delete open[id];
      continue;
    }
    if (now < t.endsAt) continue;
    g ??= await v.readGovernance(network, d.model, d.governance);
    const p = await v.readProposal(network, d.model, d.proposal(Number(id)));
    if (!p) {
      delete open[id];
      continue;
    }
    const state = v.proposalState(d.model, p, g, now);
    if (STILL_OPEN.has(state)) {
      // e.g. an optimistic proposal challenged since: follow its vote instead.
      const next = num(p.votingEndsAt ?? 0);
      t.endsAt = next > now ? next : now + 60;
      continue;
    }
    delete open[id];
    if (state === "Cancelled") continue; // already announced by ProposalCancelled
    const image = await solanaProposalImage({ network, networkId: chat.link.network, model: d.model, governance: d.governance, id, p, g, now, state, skipEmpty: true });
    const page = proposalPageUrl(chat.link.network, d.governance.toBase58(), id);
    const unchallenged = d.model === "optimistic" && !p.challenged ? " Nobody challenged it." : "";
    const text = `🗳️ Voting on proposal #${id}${d.record.name ? ` in *${plain(d.record.name)}*` : ""} has closed: *${state}*.${image ? "" : unchallenged}${page ? `\n📄 ${link("Proposal page", page)}` : ""}`;
    await notify(chat.chatId, text, { image, buttons: proposalButtons({ model: d.model, id, state, page, solana: true }) }).catch((err) => console.error(`[solana listener] couldn't notify ${chat.chatId}:`, err.message));
  }
}

/**
 * The buttons under a notice about a proposal (buttons.js), as on EVM: a
 * new proposal's straight away, any other event's from the proposal's
 * state now. None for events without a proposal, ones that are over, or
 * when the read fails.
 */
async function noticeButtons(network, d, chat, ev, now) {
  const id = ev.data?.id;
  if (id === undefined || /executed|cancel/i.test(ev.name)) return null;
  const page = proposalPageUrl(chat.link.network, d.governance.toBase58(), String(id));
  if (/^proposalCreated$/i.test(ev.name)) return proposalButtons({ model: d.model, id: String(id), page, solana: true });
  try {
    const [g, p] = await Promise.all([v.readGovernance(network, d.model, d.governance), v.readProposal(network, d.model, d.proposal(Number(id)))]);
    if (!p) return null;
    const track = d.model === "sowellian" ? v.variant(p.criteria.method) : undefined;
    return proposalButtons({ model: d.model, id: String(id), state: v.proposalState(d.model, p, g, now), page, solana: true, track });
  } catch {
    return null;
  }
}

/** Applies the DAO's pending switch once it's due, telling the chat. */
async function settleSwitch(network, d, notify, chat) {
  const pending = d.record.pendingSwitch;
  if (!pending || !getSolanaOperator()) return;
  if ((await v.clusterNow(network)) < num(pending.readyAt)) return;
  await v.applySwitch(network, d);
  const model = v.modelOf(network, pending.program);
  if (model) updateChatSolana(chat.chatId, { model }, chat.platform);
  const stakes = v.STAKE_MODELS.includes(d.model);
  const lines = [`🔀 *${plain(d.record.name)}* now runs on ${LABEL[model] ?? "a new"} governance, with the same treasury.`];
  // Each model keeps its own vault: stake doesn't follow by itself.
  if (stakes) lines.push(`Your stake is still in the ${LABEL[d.model] ?? "old"} vault. Run /migrate to move it${v.STAKE_MODELS.includes(model) ? " here" : " back to your wallet"}.`);
  await notify(chat.chatId, lines.join("\n"));
}

/** Starts polling Solana DAOs linked on `platform`; returns a function that stops it. Does nothing unless SOLANA_ENABLED. */
export function startSolanaListener({ platform, notify }, pollIntervalMs = 30_000, statePath = statePathFor(platform)) {
  if (!SOLANA_ENABLED) return () => {};
  async function pollOnce() {
    const chats = getAllSolanaChats().filter((c) => c.platform === platform);
    if (chats.length === 0) return;
    const state = readJson(statePath, {});
    for (const chat of chats) {
      try {
        const network = getSolanaNetwork(chat.link.network);
        const d = await v.readDao(network, new PublicKey(chat.link.dao));
        if (!d.model) continue;
        await settleSwitch(network, d, notify, chat).catch((err) => console.error("[solana listener] applying a switch failed:", err.message));
        // Keyed by governance account, so a switched DAO starts afresh in its new program.
        const k = `${chat.chatId}:${d.governance.toBase58()}`;
        const { newest, events } = await newEvents(network, d, state[k]);
        const open = (state[`${k}#votes`] ??= {});
        for (const ev of events) trackVote(open, d.model, ev.name, ev.data);
        if (events.length) {
          const now = await v.clusterNow(network);
          for (const ev of events) {
            const text = formatSolanaEvent(ev.name, ev.data, { model: d.model, now, name: d.record.name });
            if (!text) continue;
            // Like the EVM notices: the transaction reported, and a new proposal's page.
            const page = /^proposalCreated$/i.test(ev.name) ? proposalPageUrl(chat.link.network, d.governance.toBase58(), String(ev.data.id)) : null;
            const links = `\n🔗 ${link("View transaction", explorerUrl(network, "tx", ev.signature))}${page ? ` · 📄 ${link("Proposal page", page)}` : ""}`;
            const buttons = await noticeButtons(network, d, chat, ev, now);
            await notify(chat.chatId, text + links, { buttons }).catch((err) => console.error(`[solana listener] couldn't notify ${chat.chatId}:`, err.message));
          }
        }
        if (newest) state[k] = newest;
        await postVoteCloses(network, d, chat, open, notify);
      } catch (err) {
        console.error(`[solana listener] ${chat.link.dao} failed:`, err.message);
      }
    }
    writeJsonAtomic(statePath, state);
  }

  console.log(`Solana listener (${platform}) starting - polling every ${pollIntervalMs / 1000}s`);
  const tick = () => pollOnce().catch((err) => console.error("[solana listener] poll failed:", err.message));
  tick();
  const timer = setInterval(tick, pollIntervalMs);
  return () => clearInterval(timer);
}
