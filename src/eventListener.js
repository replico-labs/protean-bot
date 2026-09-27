import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllRegisteredDaos } from "./db.js";
import { publicClient } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "eventListenerState.json");

// Every governance model uses its own separate ABI file, but most share
// the same *names* for their core lifecycle events (each was built
// following the same GovernanceEvents.sol pattern, even where the
// underlying contract is fully standalone). Rather than hardcode which
// events exist per model, this list is just "the ones worth notifying
// about if a given model happens to have them" - watchEventsForDao()
// below filters this against each model's own real ABI, so a model
// missing one of these names simply isn't watched for it, instead of
// crashing or requiring a per-model special case.
const INTERESTING_EVENT_NAMES = [
  "ProposalCreated",
  "ProposalQueued",
  "ProposalExecuted",
  "ProposalCancelled",
  "ElectionStarted",
  "CandidateRegistered",
  "WinningTotalRevealRequested",
];

function modelToAbiName(model) {
  const map = {
    tokenWeighted: "Governance",
    quadratic: "QuadraticGovernance",
    liquid: "LiquidGovernance",
    optimistic: "OptimisticGovernance",
    conviction: "ConvictionGovernance",
    board: "BoardGovernance",
    sortition: "SortitionGovernance",
    delegate: "DelegateGovernance",
    sowellian: "SowellianGovernance",
    decisionMarkets: "DecisionMarketsGovernance",
  };
  return map[model] ?? null;
}

function loadAbi(name) {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function ensureStateFile() {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) fs.writeFileSync(STATE_PATH, JSON.stringify({}, null, 2));
}

function readState() {
  ensureStateFile();
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function writeState(state) {
  ensureStateFile();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Formats one decoded event log into a short, human-readable line for
 * the chat. Falls back to a generic line for any event this doesn't
 * have a specific format for, rather than skipping it silently - a
 * plain "X happened" is better than no notification at all.
 */
function formatEvent(eventName, args) {
  switch (eventName) {
    case "ProposalCreated":
      return `📝 New proposal #${args.proposalId} created by \`${short(args.proposer)}\`.`;
    case "ProposalQueued":
      return `⏳ Proposal #${args.proposalId} passed and is now queued.`;
    case "ProposalExecuted":
      return `✅ Proposal #${args.proposalId} executed.`;
    case "ProposalCancelled":
      return `❌ Proposal #${args.proposalId} was cancelled.`;
    case "ElectionStarted":
      return `🗳️ A new council election has started (#${args.electionId ?? "?"}).`;
    case "CandidateRegistered":
      return `🙋 \`${short(args.candidate)}\` declared candidacy.`;
    case "WinningTotalRevealRequested":
      return `🔓 The winning total reveal was requested.`;
    default:
      return `📣 ${eventName} event fired.`;
  }
}

function short(address) {
  if (typeof address !== "string" || address.length < 10) return String(address);
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Checks one DAO for any interesting events since the last time it was
 * processed, and posts each one found to its linked chat. Never throws
 * - a problem with one DAO (a bad ABI, an RPC hiccup) is logged and
 * skipped, so it can't take down the whole polling loop for every
 * other DAO.
 */
// Monad testnet's eth_getLogs enforces a hard 100-block range per call
// (confirmed directly from a real RPC error: "eth_getLogs is limited to
// a 100 range") - both the initial lookback window and any gap between
// polls (a bot restart, a slow cycle, anything) must respect this, or
// every single request in that range fails identically, forever, since
// a thrown error here means lastProcessedBlock never advances and the
// same oversized range gets recomputed on the next poll too.
const MAX_BLOCK_RANGE = 90n; // kept safely under the 100 limit, not flush against it

async function checkDao(bot, dao, currentBlock, state) {
  const abiName = modelToAbiName(dao.model);
  if (!abiName) return;

  const abi = loadAbi(abiName);
  if (!abi) return;

  const watchableEvents = abi.filter((item) => item.type === "event" && INTERESTING_EVENT_NAMES.includes(item.name));
  if (watchableEvents.length === 0) return;

  const stateKey = `${dao.platform}:${dao.chatId}:${dao.governanceAddress}`;
  const lastProcessed = state[stateKey]?.lastProcessedBlock;

  // First time seeing this DAO: start from a recent window rather than
  // scanning the contract's entire history - avoids a flood of
  // long-past notifications the first time the listener ever runs
  // against it. Deliberately sized to MAX_BLOCK_RANGE itself, not some
  // larger number, since anything larger just becomes the first chunk
  // to process below anyway.
  const fromBlock = lastProcessed !== undefined ? BigInt(lastProcessed) + 1n : currentBlock - MAX_BLOCK_RANGE > 0n ? currentBlock - MAX_BLOCK_RANGE : 0n;

  if (fromBlock > currentBlock) return;

  // Walk the full range in <=MAX_BLOCK_RANGE chunks, saving progress
  // after each one succeeds - if a later chunk fails (a transient RPC
  // issue, say), everything already fetched stays saved, and the next
  // poll resumes from there rather than redoing the whole backlog.
  let chunkStart = fromBlock;
  while (chunkStart <= currentBlock) {
    const chunkEnd = chunkStart + MAX_BLOCK_RANGE - 1n > currentBlock ? currentBlock : chunkStart + MAX_BLOCK_RANGE - 1n;

    try {
      const logs = await publicClient.getLogs({
        address: dao.governanceAddress,
        events: watchableEvents,
        fromBlock: chunkStart,
        toBlock: chunkEnd,
      });

      for (const log of logs) {
        const message = formatEvent(log.eventName, log.args ?? {});
        try {
          await bot.api.sendMessage(dao.chatId, message, { parse_mode: "Markdown" });
        } catch (sendErr) {
          console.error(`Event listener: couldn't notify chat ${dao.chatId}:`, sendErr.message);
        }
      }

      state[stateKey] = { lastProcessedBlock: chunkEnd.toString() };
    } catch (err) {
      console.error(`Event listener: couldn't check DAO ${dao.governanceAddress} (${dao.model}), blocks ${chunkStart}-${chunkEnd}:`, err.message);
      return; // stop here for this poll - already-saved chunks stay saved, resume from here next time
    }

    chunkStart = chunkEnd + 1n;
  }
}

/**
 * Starts the polling loop. Call once at bot startup, alongside the
 * sortition keeper - same pattern, a separate background interval that
 * runs independently of any command a user types.
 */
export function startEventListener(bot, pollIntervalMs = 20_000) {
  async function pollOnce() {
    try {
      const daos = getAllRegisteredDaos();
      if (daos.length === 0) return;

      const currentBlock = await publicClient.getBlockNumber();
      const state = readState();

      for (const dao of daos) {
        await checkDao(bot, dao, currentBlock, state);
      }

      writeState(state);
    } catch (err) {
      console.error("Event listener: poll cycle failed:", err.message);
    }
  }

  console.log(`Event listener starting - polling every ${pollIntervalMs / 1000}s`);
  pollOnce();
  setInterval(pollOnce, pollIntervalMs);
}