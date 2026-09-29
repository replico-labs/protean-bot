import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { currentNetwork, networkEnv, attachOperator, operatorClientFor } from "./networks.js";
import { ensureCanAfford, feesFor, estimateWithFunding } from "./gasSponsor.js";

/**
 * Everything below that touches a chain follows whichever network the
 * current call runs on (networks.js runOnNetwork) - Monad testnet unless
 * a chat's DAO lives elsewhere. They are live views, not fixed objects:
 * `publicClient.readContract(...)` inside a Base chat's command reads
 * Base. That is what lets every governance adapter keep importing
 * publicClient unchanged.
 */
function followsNetwork(pick) {
  return new Proxy(
    {},
    {
      get(_, prop) {
        const target = pick(currentNetwork());
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
      has(_, prop) {
        return prop in pick(currentNetwork());
      },
    }
  );
}

export const publicClient = followsNetwork((n) => n.publicClient);

/** The current network's viem chain (id, name, nativeCurrency, blockExplorers). */
export const activeChain = followsNetwork((n) => n.chain);

// Operator wallet - only needed for write actions (currently: distributing
// welcome tokens via WelcomeDistributor). Optional: the bot still works
// fully in read-only mode without this set, /claim and auto-distribution
// on join just won't be available.
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;

let operatorAccount = null;
if (OPERATOR_PRIVATE_KEY) {
  try {
    operatorAccount = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
    attachOperator(operatorAccount);
  } catch (err) {
    console.error(
      "OPERATOR_PRIVATE_KEY is set but invalid (must be a 0x-prefixed 32-byte hex string):",
      err.message
    );
  }
}
export { operatorAccount };

// The same operator key signs on every network (same address everywhere);
// it needs gas funds on each network the bot is enabled for.
export const walletClient = operatorAccount ? followsNetwork((n) => operatorClientFor(n)) : null;

if (!operatorAccount) {
  console.warn(
    "OPERATOR_PRIVATE_KEY not set - /claim and auto-distribution on join will not work until it is."
  );
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!process.env.FACTORY_ADDRESS) {
  console.warn("FACTORY_ADDRESS not set - /createdao will not work on Monad testnet until it is.");
}

/** Env var name (without the network prefix) holding each model's factory. */
export const FACTORY_ENV_NAMES = {
  tokenWeighted: "FACTORY_ADDRESS",
  quadratic: "QUADRATIC_FACTORY_ADDRESS",
  liquid: "LIQUID_FACTORY_ADDRESS",
  optimistic: "OPTIMISTIC_FACTORY_ADDRESS",
  delegate: "DELEGATE_FACTORY_ADDRESS",
  board: "BOARD_FACTORY_ADDRESS",
  sortition: "SORTITION_FACTORY_ADDRESS",
  conviction: "CONVICTION_FACTORY_ADDRESS",
  sowellian: "SOWELLIAN_FACTORY_ADDRESS",
  decisionMarkets: "DECISION_MARKETS_FACTORY_ADDRESS",
};

/**
 * One factory address per model on the current network - FACTORY_ADDRESS
 * on Monad testnet, BASE_FACTORY_ADDRESS on Base, and so on. /createdao
 * looks up the right one for whichever model the caller asked for; a
 * model with no address set here simply can't be created through the
 * bot on that network yet (an existing DAO can still be linked with
 * /register - this only gates *creating new ones*).
 */
export const FACTORY_ADDRESSES = new Proxy(
  {},
  {
    get(_, model) {
      const envName = FACTORY_ENV_NAMES[model];
      return envName ? networkEnv(currentNetwork().id, envName) : undefined;
    },
  }
);

/**
 * The randomness source every new Sortition DAO gets wired to at
 * creation time - a backend default rather than something each
 * /createdao caller has to know and type correctly. One value per
 * network (SORTITION_RANDOMNESS_SOURCE, BASE_SORTITION_RANDOMNESS_SOURCE,
 * ...), not per-DAO. If a genuinely different provider is
 * ever needed for a specific DAO, that's still possible by deploying
 * an existing DAO's governance contract change separately - this
 * default only affects DAOs created fresh through /createdao.
 */
export function sortitionRandomnessSource() {
  return networkEnv(currentNetwork().id, "SORTITION_RANDOMNESS_SOURCE");
}

/**
 * The reusable Switchboard price-feed adapter every Sowellian oracle-
 * track proposal can reference by typing "switchboard" instead of a raw
 * address - one deployment per network, reused across every feed
 * Switchboard covers, since the adapter itself takes the feedId per-call. Genuinely
 * optional and not exclusive with Chainlink - a DAO can use both
 * providers side by side; this just removes the need to paste this one
 * address by hand every time.
 */
export function switchboardOracleAdapter() {
  return networkEnv(currentNetwork().id, "SWITCHBOARD_ORACLE_ADAPTER");
}

/**
 * Estimates real gas for a contract write, applies a modest, controlled
 * buffer, then submits with that as an EXPLICIT limit - rather than
 * letting the write auto-estimate on its own.
 *
 * Confirmed directly from Monad's own docs, and directly against a real
 * transaction: Monad charges for the full gas_limit specified, not just
 * gas actually consumed - genuinely different from Ethereum, where an
 * overestimated limit costs nothing extra. Left to viem's own default
 * estimation, a real Board executeTransaction call whose traced,
 * actual work only needed ~150,000 gas was estimated at ~9.94 million -
 * just over Monad's documented 8.1M low/high gas-pool boundary,
 * consistent with the request falling into the high-gas pool - and the
 * full, inflated amount was genuinely charged: roughly 1 extra MON for
 * what should have cost a small fraction of that.
 *
 * A 50% buffer over a real, per-call estimate (Monad's own docs use
 * this exact multiple as a starting point before a system has enough
 * production history to tighten it) stays comfortably clear of state
 * changing between estimation and execution, without ever risking the
 * runaway inflation this bot has now observed directly in production.
 */
export async function writeWithGasBuffer(client, contractParams) {
  const estimate = await estimateWithFunding(client, contractParams);
  let gas = (estimate * 150n) / 100n;

  // HyperEVM only fits transactions up to 2M gas in its fast small blocks;
  // anything larger needs the sender switched to big blocks (a HyperCore
  // setting, ~1 minute per block). Keep the buffer inside the small-block
  // limit when the call itself fits, and say plainly when it doesn't.
  const { smallBlockGasLimit, chain } = currentNetwork();
  if (smallBlockGasLimit && gas > smallBlockGasLimit) {
    if (estimate > smallBlockGasLimit) {
      throw new Error(
        `This transaction needs ~${estimate} gas, more than ${chain.name}'s ${smallBlockGasLimit} small-block limit. ` +
          `The sending wallet must be switched to big blocks first (see README: HyperEVM).`
      );
    }
    gas = smallBlockGasLimit;
  }

  // Monad takes gas x maxFeePerGas up front, so fund the wallet for exactly
  // that (read fresh, never cached) and send with the same fees.
  const { fees, gasCost } = await feesFor(gas);
  await ensureCanAfford(client.account.address, gasCost, contractParams.value ?? 0n);
  return client.writeContract({ ...contractParams, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
}