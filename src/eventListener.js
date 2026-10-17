import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAllRegisteredDaos } from "./db.js";
import { formatEther, parseEventLogs, toEventSelector, toHex } from "viem";
import { publicClient, walletClient } from "./config.js";
import { resolveDelegationsBehind, activeProposalIds, queueSweep } from "./governance/liquid.js";
import { runOnNetwork, explorerTxUrl, currentNetwork, networkEnv } from "./networks.js";
import { readJson, writeJsonAtomic } from "./jsonFile.js";
import { startSolanaListener } from "./solana/listener.js";

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

// Monad testnet's eth_getLogs enforces a hard 100-block range per call
// (confirmed directly from a real RPC error: "eth_getLogs is limited to
// a 100 range") - both the initial lookback window and any gap between
// polls (a bot restart, a slow cycle, anything) must respect this, or
// every single request in that range fails identically, forever, since
// a thrown error here means lastProcessedBlock never advances and the
// same oversized range gets recomputed on the next poll too.
const MAX_BLOCK_RANGE = 90n; // kept safely under the 100 limit, not flush against it

// Other RPCs allow less: QuickNode's free plan answers "eth_getLogs is
// limited to a 5 range". The first such error teaches the listener that
// network's limit (or set <PREFIX>_LOGS_BLOCK_RANGE), and it carries on in
// chunks that size.
const learnedRange = new Map();
function blockRange() {
  const network = currentNetwork();
  const configured = Number(networkEnv(network.id, "LOGS_BLOCK_RANGE"));
  if (configured > 0) return BigInt(Math.floor(configured));
  return learnedRange.get(network.id) ?? MAX_BLOCK_RANGE;
}
function learnRange(err) {
  const m = `${err?.details ?? ""} ${err?.message ?? ""}`.match(/limited to an? (\d+)[- ]?(?:block)? ?range/i);
  if (!m) return false;
  const limit = BigInt(Math.max(1, Number(m[1])));
  const id = currentNetwork().id;
  if (learnedRange.get(id) === limit) return false;
  learnedRange.set(id, limit);
  console.log(`Event listener: ${id}'s RPC reads at most ${limit} blocks of events per call - using that from now on.`);
  return true;
}

// Far behind (the bot was down, or a small-range RPC fell back): skip to
// the last MAX_CATCHUP_BLOCKS rather than replaying stale notifications
// one tiny chunk at a time. EVENT_LISTENER_MAX_CATCHUP_BLOCKS overrides.
const MAX_CATCHUP_BLOCKS = BigInt(Number(process.env.EVENT_LISTENER_MAX_CATCHUP_BLOCKS) || 600);

/**
 * What one DAO wants from the logs: its events, where its progress is kept,
 * and the first block still to read. Null when there's nothing to watch.
 */
function watchFor(dao, currentBlock, state) {
  const abiName = modelToAbiName(dao.model);
  const abi = abiName && loadAbi(abiName);
  if (!abi) return null;

  // Liquid DAOs: votes and delegations trigger delegated-vote sweeps (not
  // chat posts). Needs the operator wallet, which pays for them.
  const sweepEvents = dao.model === "liquid" && walletClient ? LIQUID_SWEEP_EVENTS : [];
  const events = abi.filter((item) => item.type === "event" && (INTERESTING_EVENT_NAMES.includes(item.name) || sweepEvents.includes(item.name)));
  if (events.length === 0) return null;

  // Block numbers only mean something on one chain, so the key includes
  // the network - except Monad testnet, which keeps the key it had before
  // networks existed so existing progress isn't thrown away.
  const baseKey = `${dao.platform}:${dao.chatId}:${dao.governanceAddress}`;
  const stateKey = dao.network === "monad-testnet" ? baseKey : `${dao.network}:${baseKey}`;
  const lastProcessed = state[stateKey]?.lastProcessedBlock;

  // First time seeing this DAO: start from a recent window rather than
  // scanning the contract's entire history - avoids a flood of
  // long-past notifications the first time the listener runs against it.
  let from = lastProcessed !== undefined ? BigInt(lastProcessed) + 1n : currentBlock - MAX_BLOCK_RANGE > 0n ? currentBlock - MAX_BLOCK_RANGE : 0n;
  if (from > currentBlock) return null;
  if (currentBlock - from > MAX_CATCHUP_BLOCKS) {
    console.log(`Event listener: DAO ${dao.governanceAddress} is ${currentBlock - from} blocks behind - skipping to the last ${MAX_CATCHUP_BLOCKS}.`);
    from = currentBlock - MAX_CATCHUP_BLOCKS;
    state[stateKey] = { lastProcessedBlock: (from - 1n).toString() };
  }
  return { dao, stateKey, events, sweepEvents, from, address: dao.governanceAddress.toLowerCase() };
}

// Addresses per eth_getLogs call - providers cap the list (commonly ~1000).
const ADDRESSES_PER_CALL = 100;

/**
 * Checks every DAO on one network for interesting events since each was
 * last processed, and posts what it finds to the linked chats. One
 * eth_getLogs per block range covers them all (every DAO's address and
 * event in one filter), so RPC use doesn't grow with the number of DAOs -
 * metered providers (QuickNode's free plan) bill per call. Each DAO keeps
 * its own progress; `save` persists it after every range. Never throws: an
 * RPC problem is logged and the next poll resumes from the saved progress.
 */
async function checkNetwork(notify, daos, currentBlock, state, save) {
  const watches = daos.map((dao) => watchFor(dao, currentBlock, state)).filter(Boolean);
  if (watches.length === 0) return;
  const addresses = [...new Set(watches.map((w) => w.address))];
  const topics = [...new Set(watches.flatMap((w) => w.events.map((e) => toEventSelector(e))))];

  // Walk from the furthest-behind DAO to the head in ranges the RPC
  // accepts, saving progress after each - a failure part way keeps
  // everything already read.
  let chunkStart = watches.reduce((min, w) => (w.from < min ? w.from : min), currentBlock);
  while (chunkStart <= currentBlock) {
    const range = blockRange();
    const chunkEnd = chunkStart + range - 1n > currentBlock ? currentBlock : chunkStart + range - 1n;

    const logs = [];
    try {
      for (let i = 0; i < addresses.length; i += ADDRESSES_PER_CALL) {
        const filter = { address: addresses.slice(i, i + ADDRESSES_PER_CALL), topics: [topics], fromBlock: toHex(chunkStart), toBlock: toHex(chunkEnd) };
        logs.push(...(await publicClient.request({ method: "eth_getLogs", params: [filter] })));
      }
    } catch (err) {
      if (learnRange(err)) continue; // retry this range at the RPC's own limit
      console.error(`Event listener: couldn't read events for ${watches.length} DAO(s), blocks ${chunkStart}-${chunkEnd}:`, err.shortMessage ?? err.message);
      return; // already-saved ranges stay saved; the next poll resumes from there
    }

    for (const w of watches) {
      if (w.from > chunkEnd) continue;
      // Each DAO decodes only its own logs with its own ABI (the same event
      // name can differ between models), and only blocks it hasn't seen.
      const mine = logs.filter((log) => log.address.toLowerCase() === w.address && BigInt(log.blockNumber) >= w.from);
      for (const log of parseEventLogs({ abi: w.events, logs: mine })) {
        if (w.sweepEvents.includes(log.eventName)) {
          scheduleLiquidSweep(notify, w.dao, log.eventName, log.args ?? {});
          continue;
        }
        const url = log.transactionHash ? explorerTxUrl(log.transactionHash) : null;
        const message = formatEvent(log.eventName, log.args ?? {}) + (url ? `\n🔗 ${url}` : "");
        try {
          await notify(w.dao.chatId, message);
        } catch (sendErr) {
          console.error(`Event listener: couldn't notify chat ${w.dao.chatId}:`, sendErr.message);
        }
      }
      state[w.stateKey] = { lastProcessedBlock: chunkEnd.toString() };
    }
    save();
    chunkStart = chunkEnd + 1n;
  }
}

/*//////////////////////////////////////////////////////////////
              LIQUID: RESOLVING DELEGATED VOTES
//////////////////////////////////////////////////////////////*/

const LIQUID_SWEEP_EVENTS = ["VoteCast", "DelegateChanged"];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * In Liquid governance a delegate's vote carries only their own weight;
 * each delegator's is added by a separate resolveDelegatedVote call while
 * voting is open. Every vote (VoteCast) sweeps everyone behind that voter,
 * and every new delegation (DelegateChanged) resolves the delegator - and
 * anyone behind them - on each open proposal. Runs on the process's single
 * sweep queue, paid by the operator wallet; posts only when votes were added.
 */
function scheduleLiquidSweep(notify, dao, eventName, args) {
  queueSweep(() =>
    runOnNetwork(dao.network, async () => {
      const jobs =
        eventName === "VoteCast"
          ? [{ proposalId: args.proposalId, root: args.voter, includeRoot: false }]
          : args.newDelegate && args.newDelegate !== ZERO_ADDRESS
            ? (await activeProposalIds(dao.governanceAddress)).map((proposalId) => ({ proposalId, root: args.account, includeRoot: true }))
            : [];
      for (const job of jobs) {
        const r = await resolveDelegationsBehind({ client: walletClient, governanceAddress: dao.governanceAddress, ...job });
        if (r.resolved > 0) {
          const who = eventName === "VoteCast" ? `behind \`${short(job.root)}\`` : `after \`${short(job.root)}\` delegated`;
          const text = `🗳️ Added ${r.resolved} delegated vote${r.resolved === 1 ? "" : "s"} (${trimAmount(r.weight)} voting power) ${who} on proposal #${job.proposalId}.`;
          await notify(dao.chatId, text).catch((err) => console.error(`Event listener: couldn't notify chat ${dao.chatId}:`, err.message));
        }
      }
    })
  ).catch((err) => console.error(`Event listener: delegated-vote sweep failed for ${dao.governanceAddress}:`, err.shortMessage || err.message));
}

function trimAmount(wei) {
  return String(Number(Number(formatEther(wei)).toPrecision(6)));
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

  // A pass can outlast the interval (a far-behind DAO, a small-range RPC):
  // never run two at once, or both would post the same notifications.
  let polling = false;
  async function pollOnce() {
    if (polling) return;
    polling = true;
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
            // Progress is saved after every range, so it survives a restart mid-pass.
            await checkNetwork(notify, networkDaos, currentBlock, state, () => writeState(statePath, state));
          });
        } catch (err) {
          // One unreachable network must not stop notifications for the others.
          console.error(`Event listener: ${network} pass failed:`, err.message);
        }
      }

      writeState(statePath, state);
    } catch (err) {
      console.error("Event listener: poll cycle failed:", err.message);
    } finally {
      polling = false;
    }
  }

  console.log(`Event listener (${platform}) starting - polling every ${pollIntervalMs / 1000}s`);
  pollOnce();
  setInterval(pollOnce, pollIntervalMs);
  // Chats linked to Solana DAOs (src/solana; nothing unless SOLANA_ENABLED).
  startSolanaListener({ platform, notify });
}
