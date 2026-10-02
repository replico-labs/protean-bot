import { walletClient, operatorAccount } from "../config.js";
import { currentNetwork, runOnNetwork, resolveNetworkId, DEFAULT_NETWORK } from "../networks.js";
import { getGovernanceDaosByModel } from "../db.js";
import { sortitionStatus, finalizeSortition } from "../governance/sortition.js";

/**
 * Sortition keeper: finalizes each Sortition DAO's round as soon as its
 * randomness has arrived.
 *
 * Pyth Entropy is push-based - it calls the adapter back by itself,
 * usually within seconds of startSortition - so there's nothing to
 * settle. What's left is finalizeSortition, which anyone may call; this
 * keeper calls it with the operator wallet so a council is seated
 * without anyone having to remember /finalizesortition.
 *
 * Standalone, long-running process, separate from the bot (a Railway
 * worker, pm2, systemd). One process per network: KEEPER_NETWORK=base.
 */

const POLL_INTERVAL_MS = 30_000;

async function checkOne(governanceAddress) {
  const status = await sortitionStatus(governanceAddress);
  if (!status.active || !status.fulfilled) return;
  try {
    const { hash } = await finalizeSortition(walletClient, governanceAddress);
    console.log(`[sortitionKeeper] Finalized round ${status.round} for ${governanceAddress} (tx ${hash})`);
  } catch (err) {
    // Usually someone else finalized it first - nothing to do.
    console.log(`[sortitionKeeper] finalizeSortition skipped for ${governanceAddress}: ${err.shortMessage || err.message}`);
  }
}

async function pollOnce() {
  const daos = getGovernanceDaosByModel("sortition").filter((d) => d.network === currentNetwork().id);
  for (const { governanceAddress } of daos) {
    try {
      await checkOne(governanceAddress);
    } catch (err) {
      console.error(`[sortitionKeeper] Error checking ${governanceAddress}:`, err.shortMessage || err.message);
    }
  }
}

export async function startSortitionKeeper() {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured - the keeper needs a funded wallet to pay for finalizeSortition.");
  }
  const networkId = currentNetwork().id;
  console.log(`[sortitionKeeper] Started on ${networkId}, polling every ${POLL_INTERVAL_MS / 1000}s`);
  await pollOnce();
  setInterval(() => {
    runOnNetwork(networkId, () => pollOnce());
  }, POLL_INTERVAL_MS);
}

// `node src/keepers/sortitionKeeper.js` runs it as its own process.
if (import.meta.url === `file://${process.argv[1]}`) {
  const network = resolveNetworkId(process.env.KEEPER_NETWORK) ?? DEFAULT_NETWORK;
  runOnNetwork(network, () => startSortitionKeeper()).catch((err) => {
    console.error("[sortitionKeeper] Fatal error:", err);
    process.exit(1);
  });
}
