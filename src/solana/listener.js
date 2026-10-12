import path from "path";
import { fileURLToPath } from "url";
import { PublicKey } from "@solana/web3.js";
import { getAllSolanaChats, updateChatSolana } from "../db.js";
import { readJson, writeJsonAtomic } from "../jsonFile.js";
import { SOLANA_ENABLED, getSolanaNetwork, getSolanaOperator } from "./config.js";
import * as v from "./vortex.js";

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

const LABEL = { tokenWeighted: "token-weighted", quadratic: "quadratic", optimistic: "optimistic", board: "board", conviction: "conviction", delegate: "delegate" };
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
    default:
      return null;
  }
}

/** The DAO's new events since `until` (oldest first), and its newest signature. */
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
    events.push(...programEvents(tx?.meta?.logMessages ?? [], d.gp, coder));
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

/** Applies the DAO's pending switch once it's due, telling the chat. */
async function settleSwitch(network, d, notify, chat) {
  const pending = d.record.pendingSwitch;
  if (!pending || !getSolanaOperator()) return;
  if ((await v.clusterNow(network)) < num(pending.readyAt)) return;
  await v.applySwitch(network, d);
  const model = v.modelOf(network, pending.program);
  if (model) updateChatSolana(chat.chatId, { model }, chat.platform);
  await notify(chat.chatId, `🔀 *${plain(d.record.name)}* now runs on ${LABEL[model] ?? "a new"} governance, with the same treasury.`);
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
        if (events.length) {
          const now = await v.clusterNow(network);
          for (const ev of events) {
            const text = formatSolanaEvent(ev.name, ev.data, { model: d.model, now, name: d.record.name });
            if (text) await notify(chat.chatId, text).catch((err) => console.error(`[solana listener] couldn't notify ${chat.chatId}:`, err.message));
          }
        }
        if (newest) state[k] = newest;
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
