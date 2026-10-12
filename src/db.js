import path from "path";
import { fileURLToPath } from "url";
import { resolveNetworkId, currentNetwork, DEFAULT_NETWORK } from "./networks.js";
import { readJson, updateJson } from "./jsonFile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "chats.json");

function readDb() {
  return readJson(DB_PATH, {});
}

/**
 * Every change goes through here: the Telegram, Discord and Slack bots
 * (and the keepers) are separate processes sharing this one file, so a
 * change re-reads the file under a lock and writes it back atomically -
 * otherwise two bots saving at the same moment would lose one's change.
 * `mutate` edits `db` in place; returning false skips the write.
 */
function updateDb(mutate) {
  updateJson(DB_PATH, {}, mutate);
}

/**
 * Composite key, matching walletStore.js's own (platform, platform_user_id)
 * design - a bare chatId alone isn't safe once more than one platform
 * exists, since Discord guild IDs, Slack channel IDs, and Telegram chat
 * IDs all share the same plain-number/string namespace with nothing
 * stopping a collision. `platform` defaults to "telegram" everywhere
 * below, so every existing call site keeps working unchanged - only the
 * underlying storage key actually changes.
 */
function key(chatId, platform) {
  return `${platform}:${chatId}`;
}

/**
 * Link a chat to a deployed governance contract, and record which
 * governance model it uses - the shared adapter registry in
 * src/governance/index.js needs this to know which contract shape it's
 * actually talking to. Defaults to "tokenWeighted" for any chat that
 * doesn't specify one, matching the model every chat used before this
 * field existed.
 *
 * `creatorPlatformUserId` is the platform user (e.g. Telegram ID) who
 * actually ran /createdao - deliberately NOT read from the deployed
 * contract's own on-chain creator() field, which is always the bot's
 * operator wallet (since the operator wallet is what signs every
 * createDAO transaction, regardless of who typed the command). This is
 * the bot's own, separate record of who the DAO actually belongs to
 * from a chat-management perspective - things like /tip's authorization
 * check need this, not the on-chain field. Leave unset (undefined) when
 * linking an already-existing, externally-deployed DAO via /register,
 * since the bot has no real basis for saying who "created" that one.
 */
/**
 * `network` records which chain this DAO lives on (a networks.js id:
 * "monad-testnet", "base", "hyperevm", ...). Every command in the chat
 * then runs on that network. Defaults to whatever network the current
 * call is running on. Chats registered before networks existed stored
 * "monad", which resolveNetworkId reads as Monad testnet.
 */
export function registerChat(chatId, governanceAddress, model = "tokenWeighted", platform = "telegram", creatorPlatformUserId = undefined, network = currentNetwork().id) {
  updateDb((db) => {
    const k = key(chatId, platform);
    const creatorField = creatorPlatformUserId !== undefined
      ? { creatorPlatformUserId: String(creatorPlatformUserId) }
      : {};
    let previous = db[k] ?? {};
    // An EVM DAO replaces a Solana one linked here (see registerSolanaChat).
    if (previous.solana) {
      const { solana, ...rest } = previous;
      previous = rest;
    }
    // Wrappers, distributors and registered tickers are contracts on the
    // old DAO's chain - carrying them to another chain would point commands
    // at addresses that don't exist there (or are someone else's).
    if (previous.governanceAddress && (resolveNetworkId(previous.network) ?? DEFAULT_NETWORK) !== network) {
      const { tokens, distributorAddress, wrapperAddress, guardWrapperAddress, ...rest } = previous;
      previous = rest;
    }
    db[k] = { ...previous, governanceAddress, model, platform, ...creatorField, network, registeredAt: Date.now() };
  });
}

/**
 * Every chat currently linked to a governance contract - used by the
 * event listener to know which DAOs to watch and which chat each one's
 * events should be posted back to. Returns only entries that actually
 * have a governanceAddress set (skips chats only linked to a market or
 * wrapper, with no DAO at all).
 */
export function getAllRegisteredDaos() {
  const db = readDb();
  const daos = [];
  for (const [k, entry] of Object.entries(db)) {
    if (!entry?.governanceAddress) continue;
    const [platform, ...rest] = k.split(":");
    daos.push({
      chatId: rest.join(":"),
      platform,
      governanceAddress: entry.governanceAddress,
      model: entry.model ?? "tokenWeighted",
      network: resolveNetworkId(entry.network) ?? DEFAULT_NETWORK,
    });
  }
  return daos;
}

/**
 * Which network this chat's DAO lives on, as a networks.js id. Chats with
 * no DAO (and DMs) use the bot's default network.
 */
export function getChatNetwork(chatId, platform = "telegram") {
  const db = readDb();
  const entry = db[key(chatId, platform)];
  if (!entry?.governanceAddress) return DEFAULT_NETWORK;
  return resolveNetworkId(entry.network) ?? DEFAULT_NETWORK;
}

/**
 * The platform user ID (e.g. Telegram ID) who actually created this
 * chat's DAO through the bot, or null if unknown - either because the
 * DAO was linked via /register rather than created here, or because it
 * was created before this field existed.
 */
export function getChatCreator(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.creatorPlatformUserId ?? null;
}

/**
 * Records who linked this chat to an externally-deployed DAO (Discord /
 * Slack `register`), so only they - or a platform admin - can relink or
 * unlink it later. Deliberately separate from creatorPlatformUserId:
 * linking a DAO proves nothing about who created it, and the creator
 * field unlocks /tip, which spends operator-held tokens. Any creator left
 * over from a DAO this chat was previously linked to is cleared too.
 */
export function recordChatLinker(chatId, platformUserId, platform = "telegram", { keepCreator = false } = {}) {
  updateDb((db) => {
    const k = key(chatId, platform);
    if (!db[k]) return false;
    const { creatorPlatformUserId, ...rest } = db[k];
    db[k] = { ...rest, ...(keepCreator && creatorPlatformUserId ? { creatorPlatformUserId } : {}), linkedByPlatformUserId: String(platformUserId) };
  });
}

/** Who linked this chat to its DAO (see recordChatLinker), or null. */
export function getChatLinker(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.linkedByPlatformUserId ?? null;
}

/**
 * Registers a ticker -> token address mapping for this chat, on top of
 * (not replacing) the DAO's own token, which contracts.js's
 * resolveTokenReference already resolves by reading its real, on-chain
 * symbol(). This registry is for every OTHER token a community wants a
 * memorable shortcut for - a treasury-held asset, a partner token,
 * anything worth referencing without pasting a raw address each time.
 * Ticker is stored uppercase so lookups are case-insensitive without
 * needing to normalize at every call site.
 */
export function registerToken(chatId, ticker, tokenAddress, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    const tokens = { ...db[k]?.tokens, [ticker.toUpperCase()]: tokenAddress };
    db[k] = { ...db[k], tokens };
  });
}

/** Looks up one registered ticker for this chat, or null if not registered. */
export function getRegisteredToken(chatId, ticker, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.tokens?.[ticker.toUpperCase()] ?? null;
}

/** Every ticker registered for this chat, as { TICKER: address } - used to list all known treasury assets at once. */
export function getRegisteredTokens(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.tokens ?? {};
}

/** Get the Governance address linked to a chat, or null if unregistered. */
export function getChatDAO(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.governanceAddress ?? null;
}

/**
 * Get the governance model linked to a chat. Defaults to "tokenWeighted"
 * if a chat was registered before this field existed (or somehow has no
 * value set) - this was the only model the bot supported until now, so
 * that's the only correct default for pre-existing registrations.
 */
export function getChatModel(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.model ?? "tokenWeighted";
}

/** Link a chat's WelcomeDistributor address (optional, separate from Governance). */
export function registerDistributor(chatId, distributorAddress, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    db[k] = { ...db[k], distributorAddress, platform };
  });
}

/** Get the WelcomeDistributor address linked to a chat, or null if unset. */
export function getChatDistributor(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.distributorAddress ?? null;
}

/** Link a chat's NFTMarketplaceWrapper address (optional, separate from Governance/Treasury). */
export function registerNftWrapper(chatId, wrapperAddress, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    db[k] = { ...db[k], wrapperAddress, platform };
  });
}

/** Get the NFTMarketplaceWrapper address linked to a chat, or null if unset. */
export function getChatNftWrapper(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.wrapperAddress ?? null;
}

/** Link a chat's GuardWrapper address (optional - a DAO may never adopt one). */
export function registerGuardWrapper(chatId, guardWrapperAddress, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    db[k] = { ...db[k], guardWrapperAddress, platform };
  });
}

/** Get the GuardWrapper address linked to a chat, or null if unset. */
export function getChatGuardWrapper(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.guardWrapperAddress ?? null;
}

export function unregisterChat(chatId, platform = "telegram") {
  updateDb((db) => {
    delete db[key(chatId, platform)];
  });
}

/**
 * Slack only: which workspace a linked channel belongs to. With the
 * multi-workspace install each workspace has its own bot token, and the
 * event listener only knows the channel ID, so it looks the workspace up
 * here. Recorded on every /protean call in a linked channel.
 */
export function recordSlackTeam(channelId, teamId) {
  updateDb((db) => {
    const k = key(channelId, "slack");
    if (!db[k] || !teamId || db[k].slackTeamId === teamId) return false;
    db[k].slackTeamId = teamId;
  });
}

export function getSlackTeam(channelId) {
  return readDb()[key(channelId, "slack")]?.slackTeamId ?? null;
}

/** Linked Slack channels whose workspace isn't recorded yet (linked before the multi-workspace install). */
export function getSlackChannelsWithoutTeam() {
  return Object.entries(readDb())
    .filter(([k, entry]) => k.startsWith("slack:") && !entry?.slackTeamId)
    .map(([k]) => k.slice("slack:".length));
}

/**
 * Link a chat to a deployed OpportunityMarket - orthogonal to DAO
 * registration above, not a replacement for it. A chat can have both a
 * governance DAO and an opportunity market linked at once; these are
 * two genuinely separate systems (different network, no shared state),
 * so they get their own field rather than overloading governanceAddress.
 */
export function registerMarket(chatId, marketAddress, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    db[k] = { ...db[k], marketAddress, marketRegisteredAt: Date.now(), platform };
  });
}

/** Get the OpportunityMarket address linked to a chat, or null if unregistered. */
export function getChatMarket(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.marketAddress ?? null;
}

export function unregisterMarket(chatId, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    if (db[k]) {
      delete db[k].marketAddress;
      delete db[k].marketRegisteredAt;
    }
  });
}

/**
 * Every distinct, registered governance address using a given model,
 * deduplicated - multiple chats (on any platform) can register the same
 * DAO, and this should only list it once. Used by the Sortition
 * randomness keeper to know which DAOs to watch. Platform-agnostic by
 * design - iterates every registration regardless of which platform it
 * came from, since the keeper cares about the DAO, not which chat app
 * registered it.
 */
export function getGovernanceAddressesByModel(model) {
  return [...new Set(getGovernanceDaosByModel(model).map((d) => d.governanceAddress))];
}

/**
 * Same, with each DAO's network - the keepers use this to act on each DAO
 * on its own chain. Deduplicated per (network, address).
 */
export function getGovernanceDaosByModel(model) {
  const db = readDb();
  const seen = new Map();
  for (const chat of Object.values(db)) {
    if (chat.model === model && chat.governanceAddress) {
      const network = resolveNetworkId(chat.network) ?? DEFAULT_NETWORK;
      seen.set(`${network}:${chat.governanceAddress.toLowerCase()}`, { governanceAddress: chat.governanceAddress, network });
    }
  }
  return [...seen.values()];
}
/*//////////////////////////////////////////////////////////////
                          SOLANA DAOS
//////////////////////////////////////////////////////////////*/

/**
 * Links a chat to a Solana (Vortexes) DAO. Kept in its own `solana` field,
 * never in governanceAddress, so nothing EVM - commands, the event
 * listener, keepers, proposal pages - ever sees a Solana address. Linking
 * one replaces whatever EVM DAO (and its wrappers, distributor and
 * tickers) the chat had; an Opportunity Market link is untouched.
 *
 * `link`: { network, dao, model, mint?, symbol?, creatorPlatformUserId? }
 */
export function registerSolanaChat(chatId, link, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    const {
      governanceAddress, model, network, creatorPlatformUserId, linkedByPlatformUserId,
      tokens, distributorAddress, wrapperAddress, guardWrapperAddress, solana, ...rest
    } = db[k] ?? {};
    db[k] = { ...rest, platform, solana: { ...link, registeredAt: Date.now() } };
  });
}

/** This chat's Solana DAO link, or null. */
export function getChatSolana(chatId, platform = "telegram") {
  return readDb()[key(chatId, platform)]?.solana ?? null;
}

/** Merges `fields` into this chat's Solana link (e.g. its model after a switch). */
export function updateChatSolana(chatId, fields, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    if (!db[k]?.solana) return false;
    db[k].solana = { ...db[k].solana, ...fields };
  });
}

/** Every chat linked to a Solana DAO: [{ chatId, platform, link }]. */
export function getAllSolanaChats() {
  const chats = [];
  for (const [k, entry] of Object.entries(readDb())) {
    if (!entry?.solana) continue;
    const [platform, ...rest] = k.split(":");
    chats.push({ chatId: rest.join(":"), platform, link: entry.solana });
  }
  return chats;
}

/** Removes this chat's Solana DAO link (leaving any market link). */
export function unregisterSolanaChat(chatId, platform = "telegram") {
  updateDb((db) => {
    const k = key(chatId, platform);
    if (!db[k]?.solana) return false;
    delete db[k].solana;
  });
}
