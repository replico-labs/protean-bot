import { CrossbarClient } from "@switchboard-xyz/common";
import { zeroHash } from "viem";
import { publicClient, walletClient, operatorAccount, writeWithGasBuffer } from "../config.js";
import { currentNetwork, runOnNetwork, resolveNetworkId, DEFAULT_NETWORK, networkEnv, networkEnvName } from "../networks.js";
import { getGovernanceDaosByModel } from "../db.js";

/**
 * Switchboard randomness keeper for SortitionGovernance.
 *
 * The gap this closes: SortitionGovernance.startSortition() requests
 * randomness, but nothing settles it automatically. Switchboard is a
 * PULL oracle - after the configured minSettlementDelay passes,
 * something has to fetch the oracle's signed response off-chain (via
 * Crossbar) and submit it on-chain via settleRandomness(), directly on
 * the Switchboard contract itself, not on SwitchboardRandomnessAdapter
 * or SortitionGovernance. Without this running somewhere, a sortition
 * draw sits stuck indefinitely after startSortition() - finalizeSortition()
 * can never succeed, since it checks isFulfilled() first.
 *
 * This is a standalone, long-running process - not part of request
 * handling in index.js. Run it as its own process (a systemd service,
 * a Railway background worker, pm2, etc.), separate from the bot
 * itself. It uses the bot's own operator wallet to pay gas for
 * settlement transactions - anyone could technically call
 * settleRandomness() once Crossbar has produced the encoded response
 * (it's not access-controlled), but this keeper is what actually goes
 * and does it, since nothing else in this system does.
 *
 * Verified against the real, installed packages this file imports
 * (@switchboard-xyz/common@5.8.5's actual type definitions for
 * resolveEVMRandomness, and @switchboard-xyz/on-demand-solidity@1.1.0's
 * real ISwitchboard interface for the on-chain calls) - not written
 * from documentation alone.
 */

const POLL_INTERVAL_MS = 30_000;
const CROSSBAR_URL = "https://crossbar.switchboard.xyz";

// Minimal, hand-written ABI fragments - no pre-built ABI JSON ships in
// @switchboard-xyz/on-demand-solidity@1.1.0 (only .sol source), so
// these are written directly from ISwitchboard.sol/SwitchboardTypes.sol's
// real, verified interface rather than a shipped artifact.
const SWITCHBOARD_ABI = [
  {
    type: "function",
    name: "getRandomness",
    inputs: [{ name: "randomnessId", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "randId", type: "bytes32" },
          { name: "createdAt", type: "uint256" },
          { name: "authority", type: "address" },
          { name: "rollTimestamp", type: "uint256" },
          { name: "minSettlementDelay", type: "uint64" },
          { name: "oracle", type: "address" },
          { name: "value", type: "uint256" },
          { name: "settledAt", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isRandomnessReady",
    inputs: [{ name: "randomnessId", type: "bytes32" }],
    outputs: [{ name: "ready", type: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "settleRandomness",
    inputs: [{ name: "encodedRandomness", type: "bytes" }],
    outputs: [],
    stateMutability: "payable",
  },
];

const SORTITION_GOVERNANCE_ABI = [
  { type: "function", name: "sortitionRound", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "requestIdOfRound", inputs: [{ type: "uint256" }], outputs: [{ type: "bytes32" }], stateMutability: "view" },
  { type: "function", name: "finalizeSortition", inputs: [], outputs: [], stateMutability: "nonpayable" },
];

function switchboardContract(switchboardAddress) {
  return { address: switchboardAddress, abi: SWITCHBOARD_ABI };
}

function sortitionContract(governanceAddress) {
  return { address: governanceAddress, abi: SORTITION_GOVERNANCE_ABI };
}

/**
 * Checks one Sortition DAO's current round and settles its randomness
 * request if it's ready and not already settled. Safe to call
 * repeatedly - does nothing if there's no pending request, or if it's
 * not yet past minSettlementDelay, or if it's already settled.
 */
async function checkAndSettleOne(governanceAddress, switchboardAddress, crossbar) {
  const gov = sortitionContract(governanceAddress);

  const round = await publicClient.readContract({ ...gov, functionName: "sortitionRound" }).catch(() => 0n);
  if (round === 0n) return;

  const requestId = await publicClient.readContract({ ...gov, functionName: "requestIdOfRound", args: [round] });
  if (!requestId || requestId === zeroHash) return;

  const sb = switchboardContract(switchboardAddress);
  const randomness = await publicClient.readContract({ ...sb, functionName: "getRandomness", args: [requestId] });

  if (randomness.settledAt > 0n) {
    // Already settled on Switchboard's side - just needs finalizeSortition()
    // called, which anyone can do, including this keeper as a convenience.
    try {
      const hash = await writeWithGasBuffer(walletClient, { ...gov, functionName: "finalizeSortition", args: [] });
      await publicClient.waitForTransactionReceipt({ hash });
      console.log(`[sortitionKeeper] Finalized round ${round} for ${governanceAddress} (tx ${hash})`);
    } catch (err) {
      // Likely already finalized by someone else, or the round moved on - not an error worth failing loudly over.
      console.log(`[sortitionKeeper] finalizeSortition skipped for ${governanceAddress}: ${err.shortMessage || err.message}`);
    }
    return;
  }

  const ready = await publicClient.readContract({ ...sb, functionName: "isRandomnessReady", args: [requestId] });
  if (!ready) return;

  console.log(`[sortitionKeeper] Settling round ${round} for ${governanceAddress}, requestId ${requestId}…`);

  const { encoded } = await crossbar.resolveEVMRandomness({
    chainId: currentNetwork().chain.id,
    randomnessId: requestId,
    timestamp: Number(randomness.rollTimestamp),
    minStalenessSeconds: Number(randomness.minSettlementDelay),
    oracle: randomness.oracle,
  });

  const hash = await writeWithGasBuffer(walletClient, { ...sb, functionName: "settleRandomness", args: [encoded] });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[sortitionKeeper] Settled requestId ${requestId} for ${governanceAddress} (tx ${hash})`);

  // Immediately try finalizing too, so a single poll cycle can complete
  // a whole draw rather than waiting for the next tick.
  try {
    const finalizeHash = await writeWithGasBuffer(walletClient, { ...gov, functionName: "finalizeSortition", args: [] });
    await publicClient.waitForTransactionReceipt({ hash: finalizeHash });
    console.log(`[sortitionKeeper] Finalized round ${round} for ${governanceAddress} (tx ${finalizeHash})`);
  } catch (err) {
    console.log(`[sortitionKeeper] finalizeSortition after settlement failed for ${governanceAddress}: ${err.shortMessage || err.message}`);
  }
}

async function pollOnce(switchboardAddress, crossbar) {
  // Each keeper process serves one network (KEEPER_NETWORK).
  const daos = getGovernanceDaosByModel("sortition").filter((d) => d.network === currentNetwork().id);
  if (daos.length === 0) return;

  for (const { governanceAddress } of daos) {
    try {
      await checkAndSettleOne(governanceAddress, switchboardAddress, crossbar);
    } catch (err) {
      console.error(`[sortitionKeeper] Error checking ${governanceAddress}:`, err.shortMessage || err.message);
    }
  }
}

export async function startSortitionKeeper(switchboardAddress) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured - the keeper needs a funded wallet to pay for settlement transactions.");
  }
  if (!switchboardAddress) {
    throw new Error("switchboardAddress is required - the Switchboard proxy address for the chain this bot's Sortition DAOs are deployed on.");
  }

  const crossbar = new CrossbarClient(CROSSBAR_URL);

  console.log(`[sortitionKeeper] Started, polling every ${POLL_INTERVAL_MS / 1000}s, watching Switchboard at ${switchboardAddress}`);

  // Run once immediately, then on the interval - don't wait a full
  // cycle before the first check after startup.
  const networkId = currentNetwork().id;
  await pollOnce(switchboardAddress, crossbar);
  setInterval(() => {
    runOnNetwork(networkId, () => pollOnce(switchboardAddress, crossbar));
  }, POLL_INTERVAL_MS);
}

// Allow running this file directly (`node src/keepers/sortitionKeeper.js`)
// as its own standalone process, separate from the main bot.
if (import.meta.url === `file://${process.argv[1]}`) {
  // One process per network: KEEPER_NETWORK=base reads BASE_SWITCHBOARD_ADDRESS etc.
  const network = resolveNetworkId(process.env.KEEPER_NETWORK) ?? DEFAULT_NETWORK;
  const switchboardAddress = networkEnv(network, "SWITCHBOARD_ADDRESS");
  if (!switchboardAddress) {
    console.error(`${networkEnvName(network, "SWITCHBOARD_ADDRESS")} env var is required to run the keeper for ${network}.`);
    process.exit(1);
  }
  runOnNetwork(network, () => startSortitionKeeper(switchboardAddress)).catch((err) => {
    console.error("[sortitionKeeper] Fatal error:", err);
    process.exit(1);
  });
}