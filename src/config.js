import "dotenv/config";
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL || "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

// Operator wallet - only needed for write actions (currently: distributing
// welcome tokens via WelcomeDistributor). Optional: the bot still works
// fully in read-only mode without this set, /claim and auto-distribution
// on join just won't be available.
const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;

let operatorAccount = null;
if (OPERATOR_PRIVATE_KEY) {
  try {
    operatorAccount = privateKeyToAccount(OPERATOR_PRIVATE_KEY);
  } catch (err) {
    console.error(
      "OPERATOR_PRIVATE_KEY is set but invalid (must be a 0x-prefixed 32-byte hex string):",
      err.message
    );
  }
}
export { operatorAccount };

export const walletClient = operatorAccount
  ? createWalletClient({
      account: operatorAccount,
      chain: monadTestnet,
      transport: http(),
    })
  : null;

if (!operatorAccount) {
  console.warn(
    "OPERATOR_PRIVATE_KEY not set - /claim and auto-distribution on join will not work until it is."
  );
}

export const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Needed for /createdao and for gas-funding derived user wallets. Bot works
// fine without it - those features just won't be available.
export const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
if (!FACTORY_ADDRESS) {
  console.warn("FACTORY_ADDRESS not set - /createdao will not work until it is.");
}

/**
 * One factory address per model, keyed the same way SUPPORTED_MODELS
 * names them. /createdao looks up the right one for whichever model the
 * caller asked for; a model with no address set here simply can't be
 * created through the bot yet (an existing DAO of that model can still
 * be linked with /register - this only gates *creating new ones*).
 */
export const FACTORY_ADDRESSES = {
  tokenWeighted: FACTORY_ADDRESS,
  quadratic: process.env.QUADRATIC_FACTORY_ADDRESS,
  liquid: process.env.LIQUID_FACTORY_ADDRESS,
  optimistic: process.env.OPTIMISTIC_FACTORY_ADDRESS,
  delegate: process.env.DELEGATE_FACTORY_ADDRESS,
  board: process.env.BOARD_FACTORY_ADDRESS,
  sortition: process.env.SORTITION_FACTORY_ADDRESS,
  conviction: process.env.CONVICTION_FACTORY_ADDRESS,
  sowellian: process.env.SOWELLIAN_FACTORY_ADDRESS,
  decisionMarkets: process.env.DECISION_MARKETS_FACTORY_ADDRESS,
};

/**
 * The randomness source every new Sortition DAO gets wired to at
 * creation time - a backend default rather than something each
 * /createdao caller has to know and type correctly. Deliberately one
 * shared value, not per-DAO: this bot only ever points at one deployed
 * randomness adapter at a time. If a genuinely different provider is
 * ever needed for a specific DAO, that's still possible by deploying
 * an existing DAO's governance contract change separately - this
 * default only affects DAOs created fresh through /createdao.
 */
export const SORTITION_RANDOMNESS_SOURCE = process.env.SORTITION_RANDOMNESS_SOURCE;

/**
 * The reusable Switchboard price-feed adapter every Sowellian oracle-
 * track proposal can reference by typing "switchboard" instead of a raw
 * address - one deployment, reused across every feed Switchboard
 * covers, since the adapter itself takes the feedId per-call. Genuinely
 * optional and not exclusive with Chainlink - a DAO can use both
 * providers side by side; this just removes the need to paste this one
 * address by hand every time.
 */
export const SWITCHBOARD_ORACLE_ADAPTER = process.env.SWITCHBOARD_ORACLE_ADAPTER;

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
  const estimate = await publicClient.estimateContractGas({ ...contractParams, account: client.account });
  const gas = (estimate * 150n) / 100n;
  return client.writeContract({ ...contractParams, gas });
}