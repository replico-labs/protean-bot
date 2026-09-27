import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "chats.json");

function ensureDbFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}, null, 2));
}

function readDb() {
  ensureDbFile();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(data) {
  ensureDbFile();
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
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
 * `network` records which chain this DAO actually lives on - Monad,
 * Hyperliquid, or Base. Defaults to "monad" for every existing chat
 * registered before this field existed, since that's the only network
 * this bot has ever actually deployed to. Genuinely functional for
 * Monad today; Hyperliquid and Base can be recorded here once a real
 * factory exists on either, but nothing downstream (wallet clients,
 * governance adapters) is wired to act on those values yet - see
 * config.js and contracts.js, both still hardcoded to Monad.
 */
export function registerChat(chatId, governanceAddress, model = "tokenWeighted", platform = "telegram", creatorPlatformUserId = undefined, network = "monad") {
  const db = readDb();
  const k = key(chatId, platform);
  const creatorField = creatorPlatformUserId !== undefined
    ? { creatorPlatformUserId: String(creatorPlatformUserId) }
    : {};
  db[k] = { ...db[k], governanceAddress, model, platform, ...creatorField, network, registeredAt: Date.now() };
  writeDb(db);
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
    });
  }
  return daos;
}

/** Which network this chat's DAO lives on - "monad" for every DAO registered so far. */
export function getChatNetwork(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.network ?? "monad";
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
  const db = readDb();
  const k = key(chatId, platform);
  if (!db[k]) return;
  const { creatorPlatformUserId, ...rest } = db[k];
  db[k] = { ...rest, ...(keepCreator && creatorPlatformUserId ? { creatorPlatformUserId } : {}), linkedByPlatformUserId: String(platformUserId) };
  writeDb(db);
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
  const db = readDb();
  const k = key(chatId, platform);
  const tokens = { ...db[k]?.tokens, [ticker.toUpperCase()]: tokenAddress };
  db[k] = { ...db[k], tokens };
  writeDb(db);
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
  const db = readDb();
  const k = key(chatId, platform);
  db[k] = { ...db[k], distributorAddress, platform };
  writeDb(db);
}

/** Get the WelcomeDistributor address linked to a chat, or null if unset. */
export function getChatDistributor(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.distributorAddress ?? null;
}

/** Link a chat's NFTMarketplaceWrapper address (optional, separate from Governance/Treasury). */
export function registerNftWrapper(chatId, wrapperAddress, platform = "telegram") {
  const db = readDb();
  const k = key(chatId, platform);
  db[k] = { ...db[k], wrapperAddress, platform };
  writeDb(db);
}

/** Get the NFTMarketplaceWrapper address linked to a chat, or null if unset. */
export function getChatNftWrapper(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.wrapperAddress ?? null;
}

/** Link a chat's GuardWrapper address (optional - a DAO may never adopt one). */
export function registerGuardWrapper(chatId, guardWrapperAddress, platform = "telegram") {
  const db = readDb();
  const k = key(chatId, platform);
  db[k] = { ...db[k], guardWrapperAddress, platform };
  writeDb(db);
}

/** Get the GuardWrapper address linked to a chat, or null if unset. */
export function getChatGuardWrapper(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.guardWrapperAddress ?? null;
}

export function unregisterChat(chatId, platform = "telegram") {
  const db = readDb();
  delete db[key(chatId, platform)];
  writeDb(db);
}

/**
 * Link a chat to a deployed OpportunityMarket - orthogonal to DAO
 * registration above, not a replacement for it. A chat can have both a
 * governance DAO and an opportunity market linked at once; these are
 * two genuinely separate systems (different network, no shared state),
 * so they get their own field rather than overloading governanceAddress.
 */
export function registerMarket(chatId, marketAddress, platform = "telegram") {
  const db = readDb();
  const k = key(chatId, platform);
  db[k] = { ...db[k], marketAddress, marketRegisteredAt: Date.now(), platform };
  writeDb(db);
}

/** Get the OpportunityMarket address linked to a chat, or null if unregistered. */
export function getChatMarket(chatId, platform = "telegram") {
  const db = readDb();
  return db[key(chatId, platform)]?.marketAddress ?? null;
}

export function unregisterMarket(chatId, platform = "telegram") {
  const db = readDb();
  const k = key(chatId, platform);
  if (db[k]) {
    delete db[k].marketAddress;
    delete db[k].marketRegisteredAt;
    writeDb(db);
  }
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
  const db = readDb();
  const addresses = new Set();
  for (const chat of Object.values(db)) {
    if (chat.model === model && chat.governanceAddress) {
      addresses.add(chat.governanceAddress);
    }
  }
  return [...addresses];
}