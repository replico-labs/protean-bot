import "dotenv/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicClient, createWalletClient, http, defineChain, parseEther } from "viem";
import { monad, monadTestnet, base, baseSepolia, hyperEvm, hyperliquidEvmTestnet } from "viem/chains";

/**
 * Every chain the governance side of the bot can run on. Opportunity
 * Market is separate (Sepolia, src/opportunityMarket/config.js) and is
 * not affected by any of this.
 *
 * Chain IDs, names and public RPCs come from viem's own chain list, not
 * typed by hand. Each network reads its settings from env vars under its
 * own prefix - e.g. BASE_RPC_URL, BASE_FACTORY_ADDRESS,
 * BASE_QUADRATIC_FACTORY_ADDRESS. Monad testnet has an empty prefix, so
 * every env var the bot already uses (RPC_URL, FACTORY_ADDRESS, ...)
 * keeps meaning exactly what it did.
 *
 * blockTimeMs matters because several governance periods are counted in
 * blocks, not seconds (see scaleBlockFields below). gas is what
 * ensureGasFunded tops a user wallet up with, in the native token - it
 * has to differ per chain: 0.1 MON is pocket change, 0.1 ETH is not.
 */
const DEFINITIONS = {
  "monad-testnet": {
    chain: monadTestnet,
    envPrefix: "",
    blockTimeMs: 400,
    gas: { min: "0.005", first: "0.1", repeat: "0.05" },
    // Monad charges the full gas limit, not gas used - see writeWithGasBuffer.
    chargesFullGasLimit: true,
  },
  "monad-mainnet": {
    chain: monad,
    envPrefix: "MONAD_MAINNET",
    blockTimeMs: 400,
    gas: { min: "0.005", first: "0.1", repeat: "0.05" },
    chargesFullGasLimit: true,
  },
  base: {
    chain: base,
    envPrefix: "BASE",
    blockTimeMs: 2000,
    gas: { min: "0.00002", first: "0.0002", repeat: "0.0001" },
    maxContractSize: 24_576,
  },
  "base-sepolia": {
    chain: baseSepolia,
    envPrefix: "BASE_SEPOLIA",
    blockTimeMs: 2000,
    gas: { min: "0.00002", first: "0.0002", repeat: "0.0001" },
    maxContractSize: 24_576,
  },
  hyperevm: {
    chain: hyperEvm,
    envPrefix: "HYPEREVM",
    // HyperEVM's small blocks (1s, 2M gas). Anything bigger than 2M gas
    // only fits in its big blocks - see the README's HyperEVM notes.
    blockTimeMs: 1000,
    gas: { min: "0.001", first: "0.01", repeat: "0.005" },
    maxContractSize: 24_576,
    smallBlockGasLimit: 2_000_000n,
  },
  "hyperevm-testnet": {
    chain: hyperliquidEvmTestnet,
    envPrefix: "HYPEREVM_TESTNET",
    blockTimeMs: 1000,
    gas: { min: "0.001", first: "0.01", repeat: "0.005" },
    maxContractSize: 24_576,
    smallBlockGasLimit: 2_000_000n,
  },
};

/** Words people can type, and values already stored in data/chats.json. */
const ALIASES = {
  // Every chat registered before this file existed stored "monad", and
  // meant the testnet - the only network the bot had ever run on.
  monad: "monad-testnet",
  "monad-test": "monad-testnet",
  monadtestnet: "monad-testnet",
  "monad-main": "monad-mainnet",
  basesepolia: "base-sepolia",
  hyperliquid: "hyperevm",
  hyperevmtestnet: "hyperevm-testnet",
  "hyperliquid-testnet": "hyperevm-testnet",
};

export const NETWORK_IDS = Object.keys(DEFINITIONS);

/** "base", "Base", "hyperliquid" -> canonical id, or null if unknown. */
export function resolveNetworkId(word) {
  if (!word) return null;
  const w = String(word).toLowerCase();
  if (DEFINITIONS[w]) return w;
  return ALIASES[w] ?? null;
}

export const DEFAULT_NETWORK = resolveNetworkId(process.env.DEFAULT_NETWORK) ?? "monad-testnet";

/**
 * Networks this bot instance accepts for new DAOs - NETWORKS env var,
 * comma separated. Defaults to just the default network, so nothing new
 * turns on until an admin sets it up (RPC, factories, gas funds).
 */
export const ENABLED_NETWORKS = (() => {
  const raw = process.env.NETWORKS;
  if (!raw) return [DEFAULT_NETWORK];
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const resolved = ids.map((id) => {
    const r = resolveNetworkId(id);
    if (!r) throw new Error(`NETWORKS lists unknown network "${id}". Known: ${NETWORK_IDS.join(", ")}`);
    return r;
  });
  if (!resolved.includes(DEFAULT_NETWORK)) resolved.unshift(DEFAULT_NETWORK);
  return [...new Set(resolved)];
})();

export function isNetworkEnabled(id) {
  return ENABLED_NETWORKS.includes(id);
}

/** Env var for `name` on network `id`: FACTORY_ADDRESS on Monad testnet, BASE_FACTORY_ADDRESS on Base. */
export function networkEnvName(id, name) {
  const prefix = DEFINITIONS[id].envPrefix;
  return prefix ? `${prefix}_${name}` : name;
}

export function networkEnv(id, name) {
  return process.env[networkEnvName(id, name)] || undefined;
}

const built = new Map();

/** Everything about one network, built once. */
export function getNetwork(id) {
  const canonical = resolveNetworkId(id);
  if (!canonical) throw new Error(`Unknown network "${id}". Known: ${NETWORK_IDS.join(", ")}`);
  if (built.has(canonical)) return built.get(canonical);

  const def = DEFINITIONS[canonical];
  const rpcUrl = networkEnv(canonical, "RPC_URL") || def.chain.rpcUrls.default.http[0];
  // Our own RPC goes into the chain object, so any client built from it
  // (including per-user wallet clients) uses it with a bare http().
  const chain = defineChain({ ...def.chain, rpcUrls: { default: { http: [rpcUrl] } } });
  const blockTimeMs = Number(networkEnv(canonical, "BLOCK_TIME_MS")) || def.blockTimeMs;
  const gasEnv = (name, fallback) => parseEther(networkEnv(canonical, name) || fallback);

  const network = {
    id: canonical,
    chain,
    rpcUrl,
    nativeSymbol: chain.nativeCurrency.symbol,
    explorerUrl: chain.blockExplorers?.default?.url ?? null,
    blockTimeMs,
    chargesFullGasLimit: Boolean(def.chargesFullGasLimit),
    maxContractSize: def.maxContractSize ?? null,
    smallBlockGasLimit: def.smallBlockGasLimit ?? null,
    gas: {
      min: gasEnv("GAS_MIN_BALANCE", def.gas.min),
      first: gasEnv("GAS_TOPUP_FIRST", def.gas.first),
      repeat: gasEnv("GAS_TOPUP_REPEAT", def.gas.repeat),
    },
    publicClient: createPublicClient({ chain, transport: http() }),
    walletClient: null, // set by attachOperator
  };
  built.set(canonical, network);
  return network;
}

let operator = null;

/** config.js hands over the operator account once it has parsed it. */
export function attachOperator(account) {
  operator = account;
}

export function operatorClientFor(network) {
  if (!operator) return null;
  if (!network.walletClient) {
    network.walletClient = createWalletClient({ account: operator, chain: network.chain, transport: http() });
  }
  return network.walletClient;
}

/*//////////////////////////////////////////////////////////////
                    WHICH NETWORK THIS CALL IS ON
//////////////////////////////////////////////////////////////*/

const context = new AsyncLocalStorage();

/**
 * Runs `fn` with every chain read and write inside it - including deep
 * inside the governance adapters, which just import publicClient -
 * pointed at network `id`. Each chat command, event-listener pass and
 * keeper pass runs inside one of these, so two chats on two chains can
 * be served at the same time without passing a client through every
 * function.
 */
export function runOnNetwork(id, fn) {
  return context.run(getNetwork(id), fn);
}

/** The network the current call is running on (the default outside runOnNetwork). */
export function currentNetwork() {
  return context.getStore() ?? getNetwork(DEFAULT_NETWORK);
}

/*//////////////////////////////////////////////////////////////
                BLOCK-COUNTED GOVERNANCE PERIODS
//////////////////////////////////////////////////////////////*/

/**
 * Config fields each model counts in BLOCKS (from the contracts' own
 * struct comments). Everything else - timelocks, execution windows,
 * Sowellian's challengePeriod, Decision Markets' tradingPeriod - is in
 * seconds and needs no adjustment. Conviction's growth rate is per block
 * too, but it is a rate, not a period, and is left as configured.
 */
const BLOCK_FIELDS = {
  tokenWeighted: ["votingDelay", "votingPeriod"],
  quadratic: ["votingDelay", "votingPeriod"],
  liquid: ["votingDelay", "votingPeriod"],
  sortition: ["votingDelay", "votingPeriod"],
  optimistic: ["challengePeriod", "votingDelay", "votingPeriod"],
  delegate: ["candidacyPeriod", "electionVotingPeriod", "votingDelay", "votingPeriod", "recallVotingPeriod"],
  sowellian: ["approvalVotingDelay", "approvalVotingPeriod", "adjudicationVotingPeriod"],
};

/** The chain the bot's default periods were written for (Monad, 400ms blocks). */
const REFERENCE_BLOCK_TIME_MS = 400;

/**
 * The bot's default configs were written for Monad's block time. On a
 * slower chain the same block count lasts much longer (50,400 blocks is
 * ~5.6h on Monad, ~28h on Base), so this rescales the block-counted
 * fields to keep roughly the same wall-clock length. Unchanged on Monad.
 */
export function scaleBlockFields(model, config, network = currentNetwork()) {
  const fields = BLOCK_FIELDS[model];
  if (!fields || network.blockTimeMs === REFERENCE_BLOCK_TIME_MS) return config;
  const scaled = { ...config };
  for (const f of fields) {
    if (scaled[f] === undefined) continue;
    const blocks = Math.max(1, Math.round((Number(scaled[f]) * REFERENCE_BLOCK_TIME_MS) / network.blockTimeMs));
    scaled[f] = typeof config[f] === "bigint" ? BigInt(blocks) : blocks;
  }
  return scaled;
}

/** Human-readable length of `blocks` on the current network, e.g. "~5.6h". */
export function blocksToDuration(blocks, network = currentNetwork()) {
  const hours = (Number(blocks) * network.blockTimeMs) / 3_600_000;
  if (hours < 1) return `~${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `~${hours.toFixed(1)}h`;
  return `~${(hours / 24).toFixed(1)}d`;
}

/** "Explorer: <url>/address/<addr>" on the current network, or null if it has no explorer. */
export function explorerAddressLine(address, network = currentNetwork()) {
  return network.explorerUrl ? `Explorer: ${network.explorerUrl}/address/${address}` : null;
}

/** Whether `word` means "native currency" here: the chain's symbol (MON, ETH, HYPE) or "native". */
export function isNativeTokenWord(word, network = currentNetwork()) {
  if (!word) return false;
  const w = String(word).toUpperCase();
  return w === "NATIVE" || w === network.nativeSymbol.toUpperCase();
}

/**
 * Pulls an optional network word out of a command's trailing arguments,
 * wherever it appears - a network name can never be confused with an
 * address (always 0x...), a number or a model name. Returns
 * { network, rest }; throws a user-facing Error for a network that is
 * known but not enabled on this bot. `fallback` is used when none is given.
 */
export function takeNetworkArg(args, fallback = currentNetwork().id) {
  const index = args.findIndex((a) => !/^0x/i.test(a) && resolveNetworkId(a));
  if (index === -1) return { network: fallback, rest: args };
  const network = resolveNetworkId(args[index]);
  if (!isNetworkEnabled(network)) {
    throw new Error(`${getNetwork(network).chain.name} isn't enabled on this bot yet. Available: ${ENABLED_NETWORKS.join(", ")}.`);
  }
  return { network, rest: [...args.slice(0, index), ...args.slice(index + 1)] };
}

/** One line describing a network, for /network and help. */
export function describeNetwork(network = currentNetwork()) {
  return `${network.chain.name} (\`${network.id}\`, chain ${network.chain.id}, gas in ${network.nativeSymbol})`;
}
