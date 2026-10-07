import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "baileys";
import { COMMANDS, runCommand, ADMIN_COMMANDS } from "./commands.js";
import { attemptClaim } from "./commands/setup.js";
import { getChatNetwork } from "../db.js";
import { runOnNetwork } from "../networks.js";
import { startEventListener } from "../eventListener.js";
import { splitArgs } from "../args.js";

/**
 * WhatsApp front-end for the shared command core (commands.js), through
 * Baileys - an unofficial client that links to a real WhatsApp number as
 * a "linked device", the way WhatsApp Web does.
 *
 * Commands are plain messages starting with "/" (e.g. `/vote 3 for`), in
 * a group or a DM with the bot's number. One WhatsApp group links to one
 * DAO, like a Telegram group. Wallets are keyed ("whatsapp", LID): the
 * LID is WhatsApp's per-account privacy ID, which stays the same if a
 * member changes phone number and never exposes the number itself.
 *
 * WhatsApp has no private-in-group replies, so anything Discord/Slack
 * show only to the caller (wallet details, confidential bets, a
 * proposer's edit link) is sent to the caller's DM instead, with a short
 * pointer in the group.
 *
 * Run as its own process: `npm run whatsapp`. Env: WHATSAPP_PHONE_NUMBER
 * (the bot's number, digits only with country code - only needed until
 * it's linked), optional WHATSAPP_AUTH_DIR (default data/whatsapp-auth,
 * which must be on the persistent volume), plus the same chain/wallet env
 * as the Telegram bot. The first start prints a pairing code to the logs:
 * on the bot's phone open WhatsApp > Linked devices > Link a device >
 * Link with phone number instead, and enter it.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AUTH_DIR = path.join(__dirname, "..", "..", "data", "whatsapp-auth");

const PREFIX = "/";
// Messages WhatsApp delivers late (e.g. sent while the bot was offline)
// are ignored rather than acted on minutes after the fact.
const MAX_MESSAGE_AGE_SECONDS = 5 * 60;
const GROUP_CACHE_MS = 5 * 60 * 1000;
const RECONNECT_MAX_MS = 60_000;
const SEND_GAP_MS = 400;
const READY_WAIT_MS = 60_000;

/** The text of a message, unwrapping disappearing/view-once wrappers. */
export function messageText(message) {
  const content = normalizeMessageContent(message);
  return content?.conversation || content?.extendedTextMessage?.text || "";
}

/** "/vote 3 for" -> ["vote", ["3", "for"]], or null when it isn't a command. */
export function parseWhatsAppCommand(text) {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith(PREFIX) || trimmed.length === PREFIX.length) return null;
  const [name, ...args] = splitArgs(trimmed.slice(PREFIX.length));
  if (!name) return null;
  // "/vote@bot" style suffixes aren't a WhatsApp thing, but strip them anyway.
  return [name.toLowerCase().split("@")[0], args];
}

/**
 * The sender's LID JID (e.g. "123456789012345@lid"). Baileys gives the
 * sender in whichever form the chat uses plus, usually, the other form in
 * participantAlt/remoteJidAlt; a phone-number-only sender is looked up in
 * Baileys' own LID mapping. Null if WhatsApp hasn't told us the LID yet.
 */
export async function senderLid(key, lidMapping) {
  const group = isJidGroup(key.remoteJid);
  const candidates = (group ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt]).filter(Boolean);
  const lid = candidates.find((jid) => isLidUser(jid));
  if (lid) return jidNormalizedUser(lid);
  const pn = candidates.find((jid) => isPnUser(jid));
  if (pn && lidMapping) {
    const mapped = await lidMapping.getLIDForPN(jidNormalizedUser(pn)).catch(() => null);
    if (mapped) return jidNormalizedUser(mapped);
  }
  return null;
}

/** All the JIDs a sender might appear under in group metadata. */
function senderJids(key, lidJid) {
  const group = isJidGroup(key.remoteJid);
  return new Set([lidJid, ...(group ? [key.participant, key.participantAlt] : [key.remoteJid, key.remoteJidAlt])].filter(Boolean).map(jidNormalizedUser));
}

/** True/false from a group's participant list, undefined if the sender isn't in it. */
export function isGroupAdmin(metadata, jids) {
  const me = metadata?.participants?.find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((j) => jids.has(jidNormalizedUser(j))));
  if (!me) return undefined;
  return Boolean(me.admin || me.isAdmin || me.isSuperAdmin);
}

/**
 * Where each part of a command's result goes. Commands Discord answers
 * privately (`ephemeralByDefault` - wallet, contribute, confidential
 * bets...) go to the caller's DM when run in a group; errors stay in the
 * group as a reply to the command; `privateFollowUp` always goes to DM.
 */
export function routeResult(command, result, isDirect) {
  const toDm = [];
  const toChat = [];
  if (!isDirect && command?.ephemeralByDefault) {
    toDm.push(result.text);
    toChat.push("📩 Sent you the details in a private message.");
  } else {
    toChat.push(result.text);
  }
  if (result.privateFollowUp) {
    if (isDirect) toChat.push(result.privateFollowUp);
    else toDm.push(result.privateFollowUp);
  }
  return { toChat, toDm };
}

/** Waits `ms` - used to space out sends and reconnects. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One WhatsApp connection that reconnects by itself. `sock` is replaced
 * on every reconnect, so everything reads `bot.sock` at use time.
 */
export function createWhatsAppBot({ authDir = DEFAULT_AUTH_DIR, phoneNumber, logger, socketFactory = makeWASocket, authStateFactory = useMultiFileAuthState } = {}) {
  const log = logger ?? pino({ level: process.env.WHATSAPP_LOG_LEVEL || "warn" });
  const groupCache = new Map();
  const userQueues = new Map();
  let sendChain = Promise.resolve();
  let ready = false;
  let readyWaiters = [];
  let attempt = 0;
  let stopped = false;

  const bot = {
    sock: null,
    get ready() {
      return ready;
    },
  };

  function setReady(value) {
    ready = value;
    if (value) {
      for (const resolve of readyWaiters) resolve();
      readyWaiters = [];
    }
  }

  function waitUntilReady(ms = READY_WAIT_MS) {
    if (ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WhatsApp isn't connected")), ms);
      readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function groupMetadata(jid) {
    const hit = groupCache.get(jid);
    if (hit && Date.now() - hit.at < GROUP_CACHE_MS) return hit.metadata;
    const metadata = await bot.sock.groupMetadata(jid);
    groupCache.set(jid, { metadata, at: Date.now() });
    return metadata;
  }

  /**
   * Every outgoing message goes through one queue with a short gap, so a
   * burst (help split, listener catch-up) doesn't look like spam to
   * WhatsApp. Groups with disappearing messages get the same timer.
   */
  function send(jid, content, options = {}) {
    const job = sendChain.then(async () => {
      await waitUntilReady();
      let extra = {};
      if (isJidGroup(jid)) {
        const duration = (await groupMetadata(jid).catch(() => null))?.ephemeralDuration;
        if (duration) extra = { ephemeralExpiration: duration };
      }
      const sent = await bot.sock.sendMessage(jid, content, { ...extra, ...options });
      await wait(SEND_GAP_MS);
      return sent;
    });
    sendChain = job.catch(() => {});
    return job;
  }

  bot.send = send;

  /** Runs one command message. Exported via bot for tests. */
  async function handleMessage(m) {
    const key = m.key;
    if (!key?.remoteJid || key.fromMe) return;
    if (isJidBroadcast(key.remoteJid) || isJidNewsletter(key.remoteJid)) return;
    const age = Date.now() / 1000 - Number(m.messageTimestamp || 0);
    if (age > MAX_MESSAGE_AGE_SECONDS) return;

    const parsed = parseWhatsAppCommand(messageText(m.message));
    if (!parsed) return;
    const [name, args] = parsed;
    const chatId = key.remoteJid;
    const isDirect = !isJidGroup(chatId);

    const lid = await senderLid(key, bot.sock.signalRepository?.lidMapping);
    if (!lid) {
      await send(chatId, { text: "Couldn't identify your WhatsApp account yet - send the command again in a moment." }, { quoted: m });
      return;
    }
    const userId = jidDecode(lid).user;

    let isAdmin;
    if (ADMIN_COMMANDS.has(name) && !isDirect) {
      const metadata = await groupMetadata(chatId).catch(() => null);
      isAdmin = metadata ? isGroupAdmin(metadata, senderJids(key, lid)) ?? false : undefined;
    }

    const ctx = { platform: "whatsapp", chatId, userId, args, isAdmin, isDirect, cmd: (sub) => `${PREFIX}${sub}` };
    const command = COMMANDS[name];
    if (!command) {
      // In a group an unknown "/word" is probably not meant for the bot.
      if (isDirect) await send(chatId, { text: `Unknown command \`${name}\`. Try \`${PREFIX}help\`.` }, { quoted: m });
      return;
    }

    const result = await runCommand(name, ctx);
    const { toChat, toDm } = routeResult(command, result, isDirect);
    for (const text of toDm) {
      await send(lid, { text }).catch(async (err) => {
        log.warn({ err: err.message }, "couldn't DM a WhatsApp user");
        await send(chatId, { text: "I couldn't message you privately - send me a DM first, then run the command again." }, { quoted: m });
      });
    }
    for (const text of toChat) await send(chatId, { text }, { quoted: m });
  }

  /**
   * Commands from one person run one at a time (the grammY
   * sequentialize() equivalent), so two quick commands can't race each
   * other's nonce; different people run in parallel.
   */
  function enqueue(m) {
    const who = m.key.participant || m.key.remoteJid;
    const previous = userQueues.get(who) ?? Promise.resolve();
    const next = previous
      .then(() => handleMessage(m))
      .catch((err) => console.error("[whatsapp] Message failed:", err))
      .finally(() => {
        if (userQueues.get(who) === next) userQueues.delete(who);
      });
    userQueues.set(who, next);
    return next;
  }

  bot.handleMessage = enqueue;

  /** Telegram's automatic welcome grant for new group members. */
  async function handleParticipants(event) {
    groupCache.delete(event.id);
    if (event.action !== "add") return;
    for (const participant of event.participants ?? []) {
      const raw = typeof participant === "string" ? { id: participant } : participant;
      let lid = [raw.lid, raw.id].find((j) => isLidUser(j));
      if (!lid) {
        const pn = [raw.phoneNumber, raw.id].find((j) => isPnUser(j));
        lid = pn ? await bot.sock.signalRepository?.lidMapping?.getLIDForPN(jidNormalizedUser(pn)).catch(() => null) : null;
      }
      if (!lid) continue;
      lid = jidNormalizedUser(lid);
      const ctx = { platform: "whatsapp", chatId: event.id, userId: jidDecode(lid).user };
      const result = await runOnNetwork(getChatNetwork(ctx.chatId, ctx.platform), () => attemptClaim(ctx)).catch((err) => ({ status: "error", error: err.message }));
      if (result.status === "sent") {
        await send(event.id, { text: `🎉 Welcome, @${jidDecode(lid).user}! Sent your welcome tokens.`, mentions: [lid] }).catch(() => {});
      }
    }
  }

  async function connect() {
    if (stopped) return;
    fs.mkdirSync(authDir, { recursive: true });
    const { state, saveCreds } = await authStateFactory(authDir);
    const sock = socketFactory({
      auth: state,
      logger: log,
      browser: Browsers.ubuntu("Protean DAO"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      cachedGroupMetadata: async (jid) => groupCache.get(jid)?.metadata,
    });
    bot.sock = sock;
    let pairingRequested = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // A QR means WhatsApp is waiting for a new link; we use the
      // phone-number pairing code instead, since a QR can't be scanned
      // from server logs.
      if (qr && !sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true;
        if (!phoneNumber) {
          console.error("[whatsapp] Not linked yet - set WHATSAPP_PHONE_NUMBER (digits only, with country code) and restart to get a pairing code.");
          return;
        }
        try {
          const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ""));
          console.log(`[whatsapp] Pairing code: ${code.match(/.{1,4}/g).join("-")} - on the bot's phone: WhatsApp > Linked devices > Link a device > Link with phone number instead.`);
        } catch (err) {
          console.error("[whatsapp] Couldn't get a pairing code:", err.message);
        }
      }

      if (connection === "open") {
        attempt = 0;
        setReady(true);
        console.log(`[whatsapp] Connected as ${jidNormalizedUser(sock.user?.id) || "unknown"}`);
      }

      if (connection === "close") {
        setReady(false);
        const status = lastDisconnect?.error?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          // Unlinked from the phone: the saved session is dead. Clear it
          // so the next connection prints a fresh pairing code.
          console.error("[whatsapp] Logged out (the device was unlinked). Clearing the saved session to pair again.");
          fs.rmSync(authDir, { recursive: true, force: true });
          attempt = 0;
        } else if (status === DisconnectReason.connectionReplaced) {
          console.error("[whatsapp] Another session took over this WhatsApp link - is a second bot process running with the same session? Stopping this one.");
          stopped = true;
          return;
        }
        const delay = status === DisconnectReason.restartRequired ? 0 : Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempt++);
        if (delay) console.error(`[whatsapp] Connection closed (${status ?? lastDisconnect?.error?.message ?? "unknown"}), reconnecting in ${delay / 1000}s`);
        setTimeout(() => connect().catch((err) => console.error("[whatsapp] Reconnect failed:", err)), delay);
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) enqueue(m);
    });

    sock.ev.on("group-participants.update", (event) => {
      handleParticipants(event).catch((err) => console.error("[whatsapp] Welcome grant failed:", err));
    });
    sock.ev.on("groups.update", (updates) => {
      for (const u of updates) if (u.id) groupCache.delete(u.id);
    });
  }

  bot.start = connect;
  bot.stop = () => {
    stopped = true;
    bot.sock?.end?.(undefined);
  };
  return bot;
}

export async function startWhatsAppBot({ phoneNumber = process.env.WHATSAPP_PHONE_NUMBER, authDir = process.env.WHATSAPP_AUTH_DIR || DEFAULT_AUTH_DIR } = {}) {
  const bot = createWhatsAppBot({ phoneNumber, authDir });
  await bot.start();
  // Listener notifications wait for the connection, so a brief reconnect
  // doesn't drop them.
  startEventListener({ platform: "whatsapp", notify: (chatId, text) => bot.send(chatId, { text }) });
  console.log("[whatsapp] Started; listening for /commands in groups and DMs");
  return bot;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWhatsAppBot().catch((err) => {
    console.error("[whatsapp] Fatal error:", err);
    process.exit(1);
  });
}
