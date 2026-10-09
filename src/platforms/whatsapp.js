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
import { whatsappLinkConfigured, writeLinkState, whatsappLinkRoutes, WHATSAPP_LINK_PATH } from "./whatsappLink.js";
import { startProposalApi } from "../proposalPages.js";

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
 * WhatsApp has no private-in-group replies, so results that are actually
 * private (confidential bets and balances, the treasury address, a
 * proposer's edit link) go to the caller's DM instead, with a short
 * pointer in the group. Everything else is answered in the group.
 *
 * Run as its own process: `npm run whatsapp`. Linking the bot's number,
 * one of:
 * - WHATSAPP_LINK_SECRET: scan a QR at <public url>/whatsapp/link?key=<secret>
 *   (whatsappLink.js), like WhatsApp Web.
 * - WHATSAPP_PHONE_NUMBER (digits with country code): the logs print a
 *   pairing code to enter under Linked devices > Link a device > Link with
 *   phone number instead. When set, it's used instead of the QR.
 * Optional WHATSAPP_AUTH_DIR (default data/whatsapp-auth, which must be on
 * the persistent volume), plus the same chain/wallet env as the Telegram
 * bot.
 *
 * WHATSAPP_STANDALONE=true runs it as its own service (its own container
 * and volume): it then serves the QR link page itself on PORT, since the
 * Telegram process that otherwise serves it can't read this volume.
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
 * Discord shows these only to the caller just to keep the channel tidy;
 * nothing in them is private (a wallet address is public on-chain), and
 * Telegram answers them in the group too.
 */
export const ANSWER_IN_GROUP = new Set(["help", "wallet", "listactions", "actioninfo"]);

/**
 * Where each part of a command's result goes. Results that are actually
 * private (confidential bets and balances, rewards, the treasury address
 * from contribute, handover proposals) go to the caller's DM when run in a
 * group, with a pointer in the group; everything else, errors included,
 * is answered in the group. `privateFollowUp` (a proposer's edit link)
 * always goes to DM.
 */
export function routeResult(name, command, result, isDirect) {
  const toDm = [];
  const toChat = [];
  if (!isDirect && command?.ephemeralByDefault && !ANSWER_IN_GROUP.has(name)) {
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
export function createWhatsAppBot({
  authDir = DEFAULT_AUTH_DIR,
  phoneNumber,
  logger,
  socketFactory = makeWASocket,
  authStateFactory = useMultiFileAuthState,
  onLinkState = (state) => whatsappLinkConfigured() && writeLinkState(state),
} = {}) {
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
    const { toChat, toDm } = routeResult(name, command, result, isDirect);
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
      // Pairing codes are only accepted from a browser WhatsApp knows
      // (Chrome, Firefox, Safari...); a custom name gets "couldn't link".
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      cachedGroupMetadata: async (jid) => groupCache.get(jid)?.metadata,
    });
    bot.sock = sock;
    let pairingRequested = false;
    let qrHintShown = false;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // A QR means WhatsApp is waiting for a new link. With a phone
      // number we ask for a pairing code instead; without one, the QR goes
      // to the link page (whatsappLink.js) to scan.
      if (qr && !sock.authState.creds.registered) {
        if (!phoneNumber) {
          onLinkState({ qr });
          if (!qrHintShown) {
            qrHintShown = true;
            // Standalone, the page is on this service's own domain (Railway sets RAILWAY_PUBLIC_DOMAIN).
            const own = process.env.WHATSAPP_STANDALONE === "true" && process.env.RAILWAY_PUBLIC_DOMAIN;
            const base = (own ? `https://${own}` : process.env.SLACK_PUBLIC_URL || "https://<your-bot-domain>").replace(/\/+$/, "");
            console.log(
              whatsappLinkConfigured()
                ? `[whatsapp] Not linked yet - open ${base}${WHATSAPP_LINK_PATH}?key=<WHATSAPP_LINK_SECRET> and scan the QR from the bot's phone (WhatsApp > Linked devices > Link a device).`
                : "[whatsapp] Not linked yet - set WHATSAPP_LINK_SECRET to scan a QR code on the link page, or WHATSAPP_PHONE_NUMBER to get a pairing code, and restart."
            );
          }
        } else if (!pairingRequested) {
          pairingRequested = true;
          try {
            const digits = phoneNumber.replace(/\D/g, "");
            const code = await sock.requestPairingCode(digits);
            // Enough of the number to spot a typo without logging all of it.
            console.log(`[whatsapp] Requesting a pairing code for the number ${digits.slice(0, 3)}…${digits.slice(-4)} (${digits.length} digits)`);
            console.log(`[whatsapp] Pairing code: ${code.match(/.{1,4}/g).join("-")} - on the bot's phone: WhatsApp > Linked devices > Link a device > Link with phone number instead. Only the latest code printed works; it lasts about 2 minutes.`);
          } catch (err) {
            console.error("[whatsapp] Couldn't get a pairing code:", err.message);
          }
        }
      }

      if (connection === "open") {
        attempt = 0;
        setReady(true);
        console.log(`[whatsapp] Connected as ${jidNormalizedUser(sock.user?.id) || "unknown"}`);
        onLinkState({ linked: true, me: jidNormalizedUser(sock.user?.id) });
      }

      // The phone accepted the code; WhatsApp now restarts the connection.
      if (update.isNewLogin) console.log("[whatsapp] Code accepted - finishing the link...");

      if (connection === "close") {
        setReady(false);
        onLinkState({ linked: false });
        const status = lastDisconnect?.error?.output?.statusCode;
        // `account` is only set once a phone has actually linked this session.
        const linked = Boolean(sock.authState.creds.account || sock.authState.creds.registered);
        if (status === DisconnectReason.connectionReplaced) {
          console.error("[whatsapp] Another session took over this WhatsApp link - is a second bot process running with the same session? Stopping this one.");
          stopped = true;
          return;
        }
        if (status !== DisconnectReason.restartRequired && !linked) {
          // Never linked (usually a pairing code expiring unused). Requesting
          // a code saves a half-made session that WhatsApp refuses to log in
          // with, so start the next attempt from a clean one.
          fs.rmSync(authDir, { recursive: true, force: true });
          if (phoneNumber) console.error("[whatsapp] Pairing code expired without being used - printing a new one.");
          setTimeout(() => connect().catch((err) => console.error("[whatsapp] Reconnect failed:", err)), 2000);
          return;
        }
        if (status === DisconnectReason.loggedOut) {
          // Unlinked from the phone: the saved session is dead. Clear it
          // so the next connection prints a fresh pairing code.
          console.error("[whatsapp] Logged out (the device was unlinked). Clearing the saved session to pair again.");
          fs.rmSync(authDir, { recursive: true, force: true });
          attempt = 0;
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
  if (whatsappLinkConfigured()) writeLinkState({ linked: false });
  if (process.env.WHATSAPP_STANDALONE === "true" && whatsappLinkConfigured()) {
    await startProposalApi(Number(process.env.PORT || 3000), whatsappLinkRoutes());
    console.log(`[whatsapp] Standalone: the link page is at ${WHATSAPP_LINK_PATH}?key=<WHATSAPP_LINK_SECRET> on this service's domain`);
  }
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
