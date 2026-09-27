import { CrossbarClient, EVMUtils } from "@switchboard-xyz/common";
import { getAddress } from "viem";
import { publicClient, walletClient, operatorAccount, writeWithGasBuffer } from "../config.js";
import { getGovernanceAddressesByModel } from "../db.js";

/**
 * Switchboard price-feed keeper for SowellianGovernance's oracle track.
 *
 * The gap this closes: SwitchboardPriceFeedAdapter.latestValue() only
 * reads back whatever was last pushed to Switchboard for a feedId -
 * Switchboard feeds are PULL-based, so nothing updates them on its own.
 * resolveViaOracle() then rejects anything older than the DAO's
 * maxOracleStaleness. Without a keeper, an oracle-track proposal whose
 * measurement period has ended can sit unresolvable indefinitely.
 *
 * What this does, every poll:
 *   1. Proposal-driven: for every registered Sowellian DAO, finds
 *      proposals that are Executed, on the Oracle track, past their
 *      measurementDeadline, and whose `oracle` is a Switchboard-backed
 *      adapter (i.e. its switchboard() matches SWITCHBOARD_ADDRESS).
 *      For each, fetches a fresh oracle-signed quote for the proposal's
 *      oracleSelector from Crossbar, submits it via updateFeeds(bytes),
 *      then calls resolveViaOracle() in the same poll cycle - the
 *      staleness window starts at the update, so updating and resolving
 *      back to back is what keeps it inside maxOracleStaleness.
 *   2. Standing refresh (optional): feed IDs listed in
 *      SWITCHBOARD_FEED_IDS are refreshed every
 *      SWITCHBOARD_REFRESH_SECONDS regardless of proposals, so the
 *      value a bot command shows is never far behind.
 *
 * Chainlink-backed adapters are skipped - Chainlink feeds are push
 * oracles that its own network keeps current.
 *
 * Run as its own long-lived process (Railway worker, pm2, systemd),
 * separate from the bot, same as sortitionKeeper.js:
 *   node src/keepers/switchboardPriceKeeper.js
 * Env: OPERATOR_PRIVATE_KEY (funded - pays gas AND Switchboard's
 * updateFee), SWITCHBOARD_ADDRESS, optional SWITCHBOARD_NETWORK
 * ("testnet" default, "mainnet"), SWITCHBOARD_FEED_IDS,
 * SWITCHBOARD_REFRESH_SECONDS, CROSSBAR_URL.
 *
 * Verified against the installed packages: @switchboard-xyz/common@5.8.5
 * (CrossbarClient.fetchOracleQuote returns V2UpdateResponse + `encoded`;
 * EVMUtils.convertToEVMUpdateData builds the same bytes if `encoded` is
 * absent) and @switchboard-xyz/on-demand-solidity@1.1.0 (Switchboard.sol's
 * updateFeeds(bytes) requires msg.value >= updateFee() and refunds any
 * excess). Written against the CURRENT SowellianGovernance source, whose
 * Proposal struct includes oracleSelector - a Sowellian factory deployed
 * before that field existed won't match this ABI (see the morning report).
 * NOT live-tested: this environment can't reach Crossbar or Monad RPC.
 */

const POLL_INTERVAL_MS = 60_000;
const CROSSBAR_URL = process.env.CROSSBAR_URL || "https://crossbar.switchboard.xyz";
const SWITCHBOARD_NETWORK = process.env.SWITCHBOARD_NETWORK || "testnet";
const REFRESH_SECONDS = Number(process.env.SWITCHBOARD_REFRESH_SECONDS || 300);

// SowellianGovernance enums, in declaration order from the current source.
const PHASE_EXECUTED = 3;
const PHASE_FINALIZED = 7;
const PHASE_CANCELLED = 8;
const PHASE_REJECTED = 1;
const RESOLUTION_ORACLE = 0;

// Hand-written from ISwitchboard.sol (on-demand-solidity@1.1.0), which
// ships no ABI JSON. updateFeeds is overloaded there; only the
// single-`bytes` variant is included so viem resolves it unambiguously.
const SWITCHBOARD_ABI = [
  { type: "function", name: "updateFeeds", inputs: [{ name: "feeds", type: "bytes" }], outputs: [], stateMutability: "payable" },
  { type: "function", name: "updateFee", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    type: "function",
    name: "getLatestValue",
    inputs: [{ name: "feedId", type: "bytes32" }],
    outputs: [{ name: "value", type: "int128" }, { name: "timestamp", type: "uint256" }, { name: "slotNumber", type: "uint64" }],
    stateMutability: "view",
  },
];

const ADAPTER_ABI = [
  { type: "function", name: "switchboard", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
];

// Only the fields this keeper reads, from the current Proposal struct -
// the full tuple must still be declared in order for decoding.
const SOWELLIAN_ABI = [
  { type: "function", name: "proposalCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "resolveViaOracle", inputs: [{ name: "proposalId", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "getProposal",
    inputs: [{ name: "proposalId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "proposer", type: "address" },
          {
            name: "actions",
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "data", type: "bytes" },
            ],
          },
          { name: "metadataURI", type: "string" },
          { name: "phase", type: "uint8" },
          { name: "resolutionMethod", type: "uint8" },
          { name: "oracle", type: "address" },
          { name: "oracleSelector", type: "bytes32" },
          { name: "targetValue", type: "int256" },
          { name: "targetIsMinimum", type: "bool" },
          { name: "measurementPeriod", type: "uint256" },
          { name: "approvalSnapshotBlock", type: "uint256" },
          { name: "approvalStartBlock", type: "uint256" },
          { name: "approvalEndBlock", type: "uint256" },
          { name: "positionsDeadline", type: "uint256" },
          { name: "executedAt", type: "uint256" },
          { name: "measurementDeadline", type: "uint256" },
          { name: "challengeDeadline", type: "uint256" },
          { name: "positionsOpenSnapshotBlock", type: "uint256" },
          { name: "adjudicationEndBlock", type: "uint256" },
          { name: "approvalForVotes", type: "uint256" },
          { name: "approvalAgainstVotes", type: "uint256" },
          { name: "approvalAbstainVotes", type: "uint256" },
          { name: "proposalBond", type: "uint256" },
          { name: "yesPool", type: "uint256" },
          { name: "noPool", type: "uint256" },
          { name: "resolver", type: "address" },
          { name: "resolutionBond", type: "uint256" },
          { name: "proposedOutcome", type: "uint8" },
          { name: "challenger", type: "address" },
          { name: "challengeBond", type: "uint256" },
          { name: "adjudicateSuccessVotes", type: "uint256" },
          { name: "adjudicateFailureVotes", type: "uint256" },
          { name: "finalOutcome", type: "uint8" },
        ],
      },
    ],
    stateMutability: "view",
  },
];

// Proposals in a terminal phase never need checking again. In-memory
// only - after a restart the keeper re-reads them once and re-learns.
const settled = new Set();
const adapterIsSwitchboard = new Map();
let lastStandingRefresh = 0;
let polling = false;

/** Crossbar feed hashes are plain hex; accept config/selector values with or without 0x. */
function feedHash(feedId) {
  return feedId.toLowerCase().replace(/^0x/, "");
}

async function isSwitchboardAdapter(adapterAddress, switchboardAddress) {
  if (adapterIsSwitchboard.has(adapterAddress)) return adapterIsSwitchboard.get(adapterAddress);
  let result = false;
  try {
    const sb = await publicClient.readContract({ address: adapterAddress, abi: ADAPTER_ABI, functionName: "switchboard" });
    result = getAddress(sb) === switchboardAddress;
  } catch {
    // No switchboard() - a Chainlink adapter or something else entirely.
  }
  adapterIsSwitchboard.set(adapterAddress, result);
  return result;
}

/**
 * Fetches one oracle-signed update covering `feedIds` and submits it.
 * One quote can carry several feeds, and updateFeeds(bytes) charges a
 * single updateFee for the whole payload.
 */
async function pushFeedUpdate(switchboardAddress, crossbar, feedIds) {
  const quote = await crossbar.fetchOracleQuote(feedIds.map(feedHash), SWITCHBOARD_NETWORK);
  const encoded = quote.encoded || EVMUtils.convertToEVMUpdateData(quote);
  if (!encoded) throw new Error("Crossbar returned no encoded update");

  const sb = { address: switchboardAddress, abi: SWITCHBOARD_ABI };
  const fee = await publicClient.readContract({ ...sb, functionName: "updateFee" });
  const hash = await writeWithGasBuffer(walletClient, {
    ...sb,
    functionName: "updateFeeds",
    args: [encoded.startsWith("0x") ? encoded : `0x${encoded}`],
    value: fee,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

async function checkDao(governanceAddress, switchboardAddress, crossbar) {
  const gov = { address: governanceAddress, abi: SOWELLIAN_ABI };
  const count = await publicClient.readContract({ ...gov, functionName: "proposalCount" });
  const now = BigInt(Math.floor(Date.now() / 1000));

  for (let id = 1n; id <= count; id++) {
    const key = `${governanceAddress}:${id}`;
    if (settled.has(key)) continue;

    const p = await publicClient.readContract({ ...gov, functionName: "getProposal", args: [id] });
    if ([PHASE_FINALIZED, PHASE_CANCELLED, PHASE_REJECTED].includes(p.phase) || p.resolutionMethod !== RESOLUTION_ORACLE) {
      settled.add(key);
      continue;
    }
    if (p.phase !== PHASE_EXECUTED || now < p.measurementDeadline) continue;
    if (!(await isSwitchboardAdapter(getAddress(p.oracle), switchboardAddress))) {
      settled.add(key); // Chainlink-backed - nothing for this keeper to do
      continue;
    }

    console.log(`[switchboardPriceKeeper] Updating feed ${p.oracleSelector} for ${governanceAddress} proposal ${id}…`);
    const updateHash = await pushFeedUpdate(switchboardAddress, crossbar, [p.oracleSelector]);
    console.log(`[switchboardPriceKeeper] Feed updated (tx ${updateHash}), resolving…`);

    try {
      const resolveHash = await writeWithGasBuffer(walletClient, { ...gov, functionName: "resolveViaOracle", args: [id] });
      await publicClient.waitForTransactionReceipt({ hash: resolveHash });
      settled.add(key);
      console.log(`[switchboardPriceKeeper] Resolved ${governanceAddress} proposal ${id} (tx ${resolveHash})`);
    } catch (err) {
      // Someone else may have resolved it between our read and write.
      console.log(`[switchboardPriceKeeper] resolveViaOracle skipped for ${governanceAddress} proposal ${id}: ${err.shortMessage || err.message}`);
    }
  }
}

async function pollOnce(switchboardAddress, crossbar, standingFeedIds) {
  // A slow Crossbar fetch must not let the next tick start a second,
  // overlapping cycle that double-submits the same update.
  if (polling) return;
  polling = true;
  try {
    await pollCycle(switchboardAddress, crossbar, standingFeedIds);
  } finally {
    polling = false;
  }
}

async function pollCycle(switchboardAddress, crossbar, standingFeedIds) {
  for (const governanceAddress of getGovernanceAddressesByModel("sowellian")) {
    try {
      await checkDao(getAddress(governanceAddress), switchboardAddress, crossbar);
    } catch (err) {
      console.error(`[switchboardPriceKeeper] Error checking ${governanceAddress}:`, err.shortMessage || err.message);
    }
  }

  if (standingFeedIds.length > 0 && Date.now() - lastStandingRefresh >= REFRESH_SECONDS * 1000) {
    try {
      const hash = await pushFeedUpdate(switchboardAddress, crossbar, standingFeedIds);
      lastStandingRefresh = Date.now();
      console.log(`[switchboardPriceKeeper] Refreshed ${standingFeedIds.length} standing feed(s) (tx ${hash})`);
    } catch (err) {
      console.error("[switchboardPriceKeeper] Standing refresh failed:", err.shortMessage || err.message);
    }
  }
}

export async function startSwitchboardPriceKeeper(switchboardAddress, standingFeedIds = []) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured - the keeper needs a funded wallet to pay gas and Switchboard's update fee.");
  }
  if (!switchboardAddress) {
    throw new Error("switchboardAddress is required - the Switchboard proxy address on the chain the Sowellian DAOs are deployed on.");
  }

  const sbAddress = getAddress(switchboardAddress);
  const crossbar = new CrossbarClient(CROSSBAR_URL);

  console.log(
    `[switchboardPriceKeeper] Started, polling every ${POLL_INTERVAL_MS / 1000}s, Switchboard ${sbAddress}, network ${SWITCHBOARD_NETWORK}` +
      (standingFeedIds.length ? `, refreshing ${standingFeedIds.length} standing feed(s) every ${REFRESH_SECONDS}s` : "")
  );

  await pollOnce(sbAddress, crossbar, standingFeedIds);
  setInterval(() => {
    pollOnce(sbAddress, crossbar, standingFeedIds);
  }, POLL_INTERVAL_MS);
}

// Allow running this file directly as its own standalone process.
if (import.meta.url === `file://${process.argv[1]}`) {
  const switchboardAddress = process.env.SWITCHBOARD_ADDRESS;
  if (!switchboardAddress) {
    console.error("SWITCHBOARD_ADDRESS env var is required to run the keeper standalone.");
    process.exit(1);
  }
  const standingFeedIds = (process.env.SWITCHBOARD_FEED_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  startSwitchboardPriceKeeper(switchboardAddress, standingFeedIds).catch((err) => {
    console.error("[switchboardPriceKeeper] Fatal error:", err);
    process.exit(1);
  });
}
