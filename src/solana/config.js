import "dotenv/config";
import { Connection, Keypair, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createRequire } from "module";
import anchor from "@coral-xyz/anchor";

/**
 * Solana (Vortexes) settings. Everything Solana is off unless
 * SOLANA_ENABLED=true: no command, help line or wallet field changes for
 * anyone until then, on any platform.
 *
 * Solana DAOs run on the Vortexes programs (github.com/replico-labs/
 * Vortexes): one hub per cluster holds every DAO's treasury, and the DAO's
 * governance program decides. Only devnet is deployed so far.
 */

export const SOLANA_ENABLED = process.env.SOLANA_ENABLED === "true";

const require = createRequire(import.meta.url);
export const IDLS = {
  hub: require("./idl/vortex_hub.json"),
  tokenWeighted: require("./idl/vortex_token_weighted.json"),
  quadratic: require("./idl/vortex_quadratic.json"),
  optimistic: require("./idl/vortex_optimistic.json"),
  board: require("./idl/vortex_board.json"),
  conviction: require("./idl/vortex_conviction.json"),
  delegate: require("./idl/vortex_delegate.json"),
};
/** vortex-core's GovError, by code: { "6000": { name, msg } }. */
export const GOV_ERRORS = require("./idl/gov_errors.json");

const DEFINITIONS = {
  "solana-devnet": {
    name: "Solana devnet",
    envPrefix: "SOLANA_DEVNET",
    defaultRpc: clusterApiUrl("devnet"),
    explorerCluster: "devnet",
  },
};

/** Words people can type for a Solana network. Only devnet exists so far. */
const ALIASES = { solana: "solana-devnet", sol: "solana-devnet", "solana-dev": "solana-devnet", soldevnet: "solana-devnet" };

export const SOLANA_NETWORK_IDS = Object.keys(DEFINITIONS);

/** "solana", "Solana-Devnet" -> "solana-devnet", or null. Null whenever Solana is off. */
export function resolveSolanaNetwork(word) {
  if (!SOLANA_ENABLED || !word) return null;
  const w = String(word).toLowerCase();
  if (DEFINITIONS[w]) return w;
  return ALIASES[w] ?? null;
}

/** Models Solana DAOs can be created with from the bot (stage 1). */
export const SOLANA_MODELS = ["tokenWeighted", "board"];

const env = (id, name) => process.env[`${DEFINITIONS[id].envPrefix}_${name}`] || undefined;

const built = new Map();

/** Everything about one Solana network, built once. */
export function getSolanaNetwork(id) {
  if (!DEFINITIONS[id]) throw new Error(`Unknown Solana network "${id}"`);
  if (built.has(id)) return built.get(id);
  const def = DEFINITIONS[id];
  const rpcUrl = env(id, "RPC_URL") || def.defaultRpc;
  // Program IDs default to the Vortexes devnet deployment (its README).
  const pid = (name, fallback) => new PublicKey(env(id, `${name}_PROGRAM_ID`) || fallback);
  const network = {
    id,
    name: def.name,
    rpcUrl,
    connection: new Connection(rpcUrl, "confirmed"),
    explorerCluster: def.explorerCluster,
    programs: {
      hub: pid("HUB", IDLS.hub.address),
      tokenWeighted: pid("TOKEN_WEIGHTED", IDLS.tokenWeighted.address),
      quadratic: pid("QUADRATIC", IDLS.quadratic.address),
      optimistic: pid("OPTIMISTIC", IDLS.optimistic.address),
      board: pid("BOARD", IDLS.board.address),
      conviction: pid("CONVICTION", IDLS.conviction.address),
      delegate: pid("DELEGATE", IDLS.delegate.address),
    },
    /** SOL top-ups for user wallets, in lamports. */
    topup: {
      min: sol(env(id, "TOPUP_MIN") ?? "0.01"),
      first: sol(env(id, "TOPUP_FIRST") ?? "0.03"),
      repeat: sol(env(id, "TOPUP_REPEAT") ?? "0.02"),
    },
    /** Short voting periods and timelocks, for trying things out on devnet. */
    fastTimings: env(id, "FAST_TIMINGS") === "true",
  };
  built.set(id, network);
  return network;
}

function sol(amount) {
  return Math.round(Number(amount) * LAMPORTS_PER_SOL);
}

/** "https://explorer.solana.com/address/<key>?cluster=devnet" */
export function explorerUrl(network, kind, value) {
  const cluster = network.explorerCluster === "mainnet-beta" ? "" : `?cluster=${network.explorerCluster}`;
  return `https://explorer.solana.com/${kind}/${value}${cluster}`;
}

let operator;

/**
 * The bot's Solana operator: creates DAOs (as their creator), pays for
 * queue/execute, and funds user wallets. SOLANA_OPERATOR_KEY is a
 * base58 secret key (Phantom's "private key" export) or a JSON byte array
 * (a `solana-keygen` file's contents).
 */
export function getSolanaOperator() {
  if (operator !== undefined) return operator;
  const raw = process.env.SOLANA_OPERATOR_KEY?.trim();
  if (!raw) return (operator = null);
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : anchor.utils.bytes.bs58.decode(raw);
  operator = Keypair.fromSecretKey(bytes);
  return operator;
}
