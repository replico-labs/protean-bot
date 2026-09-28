import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllRegisteredDaos } from "./db.js";
import { publicClient } from "./config.js";
import { runOnNetwork } from "./networks.js";
import { readJson, writeJsonAtomic } from "./jsonFile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One state file per platform process: Telegram keeps the original file
// name, and Discord/Slack (separate processes) each get their own, so two
// processes never overwrite each other's progress.
function statePathFor(platform) {
  const name = platform === "telegram" ? "eventListenerState.json" : `eventListenerState.${platform}.json`;
  return path.join(__dirname, "..", "data", name);
}

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

function readState(statePath) {
  return readJson(statePath, {});
}

function writeState(statePath, state) {
  writeJsonAtomic(statePath, state);
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

async function checkDao(notify, dao, currentBlock, state) {
  const abiName = modelToAbiName(dao.model);
  if (!abiName) return;

  const abi = loadAbi(abiName);
  if (!abi) return;

  const watchableEvents = abi.filter((item) => item.type === "event" && INTERESTING_EVENT_NAMES.includes(item.name));
  if (watchableEvents.length === 0) return;

  // Block numbers only mean something on one chain, so the key includes
  // the network - except Monad testnet, which keeps the key it had before
  // networks existed so existing progress isn't thrown away.
  const baseKey = `${dao.platform}:${dao.chatId}:${dao.governanceAddress}`;
  const stateKey = dao.network === "monad-testnet" ? baseKey : `${dao.network}:${baseKey}`;
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
          await notify(dao.chatId, message);
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
 * Starts the polling loop. Call once at startup of each platform process.
 *
 * `target` is either a grammY bot (Telegram, the original behavior) or
 * `{ platform, notify }`, where notify(chatId, markdownText) posts to one
 * channel on that platform. Only DAOs linked on that platform are
 * watched, so each platform process notifies its own channels.
 */
export function startEventListener(target, pollIntervalMs = 20_000) {
  const { platform, notify } =
    target && target.api && typeof target.api.sendMessage === "function"
      ? { platform: "telegram", notify: (chatId, text) => target.api.sendMessage(chatId, text, { parse_mode: "Markdown" }) }
      : target;
  const statePath = statePathFor(platform);

  async function pollOnce() {
    try {
      const daos = getAllRegisteredDaos().filter((dao) => dao.platform === platform);
      if (daos.length === 0) return;

      const state = readState(statePath);
      // One pass per network: each has its own block height and RPC.
      const byNetwork = new Map();
      for (const dao of daos) byNetwork.set(dao.network, [...(byNetwork.get(dao.network) ?? []), dao]);

      for (const [network, networkDaos] of byNetwork) {
        try {
          await runOnNetwork(network, async () => {
            const currentBlock = await publicClient.getBlockNumber();
            for (const dao of networkDaos) {
              await checkDao(notify, dao, currentBlock, state);
            }
          });
        } catch (err) {
          // One unreachable network must not stop notifications for the others.
          console.error(`Event listener: ${network} pass failed:`, err.message);
        }
      }

      writeState(statePath, state);
    } catch (err) {
      console.error("Event listener: poll cycle failed:", err.message);
    }
  }

  console.log(`Event listener (${platform}) starting - polling every ${pollIntervalMs / 1000}s`);
  pollOnce();
  setInterval(pollOnce, pollIntervalMs);
}
