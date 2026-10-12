import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import { readJson, writeJsonAtomic } from "../jsonFile.js";

/**
 * The WhatsApp link page: shows the bot's current WhatsApp QR code so the
 * bot's phone can scan it (WhatsApp > Linked devices > Link a device),
 * like linking WhatsApp Web.
 *
 * The WhatsApp process writes its current QR to data/whatsapp-link.json;
 * whichever process owns the public HTTP port (Slack's install server, or
 * index.js's) serves the page from it. The QR is drawn here, never by an
 * outside QR service: it carries the session's linking keys, and anyone
 * who scans it links *their* WhatsApp to the bot. So the page needs
 * WHATSAPP_LINK_SECRET: /whatsapp/link?key=<secret>.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "..", "data", "whatsapp-link.json");
// Baileys rotates the QR every 20 s; an older one has already expired.
const QR_MAX_AGE_MS = 60_000;

export const WHATSAPP_LINK_PATH = "/whatsapp/link";

export function whatsappLinkConfigured(env = process.env) {
  return Boolean(env.WHATSAPP_LINK_SECRET);
}

/** Called by the WhatsApp process: { qr } while waiting to be scanned, { linked, me } once linked. */
export function writeLinkState(state, file = STATE_FILE) {
  writeJsonAtomic(file, { ...state, updatedAt: Date.now() });
}

function readLinkState(file = STATE_FILE) {
  return readJson(file, {}) ?? {};
}

/** Constant-time comparison of the ?key= against the secret. */
export function keyMatches(given, secret) {
  if (!given || !secret) return false;
  const a = crypto.createHash("sha256").update(String(given)).digest();
  const b = crypto.createHash("sha256").update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

const failures = new Map();
/** At most 10 wrong keys per minute per address. */
function tooManyFailures(req) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 60_000);
  failures.set(ip, recent);
  if (failures.size > 10_000) failures.clear();
  return { blocked: recent.length >= 10, record: () => recent.push(now) };
}

function page(title, body, { refresh = 5 } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="${refresh}">
<title>${title}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#14171c;--muted:#5b6370;--ok:#137a3a}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--text:#e8eaee;--muted:#9aa3af;--ok:#4cc27a}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:16px;padding:24px;max-width:380px;width:100%;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{color:var(--muted);margin:8px 0}
.qr{background:#fff;padding:12px;border-radius:12px;margin:16px auto;max-width:300px}.qr svg{display:block;width:100%;height:auto}
.ok{color:var(--ok);font-size:40px;margin:8px 0}
</style></head><body><main>${body}</main></body></html>`;
}

/** Renders the page for a request; returns { status, html }. */
export async function renderLinkPage(query, { secret = process.env.WHATSAPP_LINK_SECRET, file = STATE_FILE, now = Date.now() } = {}) {
  if (!secret) return { status: 503, html: page("Not set up", "<h1>Not set up</h1><p>Set WHATSAPP_LINK_SECRET on the bot to use this page.</p>", { refresh: 3600 }) };
  if (!keyMatches(query.get("key"), secret)) return { status: 403, html: page("Wrong key", "<h1>Wrong key</h1><p>Open this page with <code>?key=</code> set to WHATSAPP_LINK_SECRET.</p>", { refresh: 3600 }) };

  const state = readLinkState(file);
  if (state.linked) {
    const who = state.me ? `<p>Linked as ${String(state.me).replace(/[^0-9+@.a-z]/gi, "")}</p>` : "";
    return { status: 200, html: page("WhatsApp linked", `<div class="ok">✓</div><h1>WhatsApp is linked</h1>${who}<p>The bot is online. You can close this page.</p>`, { refresh: 30 }) };
  }
  if (state.qr && now - (state.updatedAt ?? 0) < QR_MAX_AGE_MS) {
    const svg = await QRCode.toString(state.qr, { type: "svg", margin: 1, errorCorrectionLevel: "L" });
    return {
      status: 200,
      html: page(
        "Link WhatsApp",
        `<h1>Link the bot's WhatsApp</h1><p>On the bot's phone: WhatsApp → <b>Linked devices</b> → <b>Link a device</b>, then scan.</p><div class="qr">${svg}</div><p>The code changes every 20 seconds; this page keeps up by itself.</p>`
      ),
    };
  }
  return { status: 200, html: page("Waiting for WhatsApp", "<h1>Waiting for a code…</h1><p>The bot is connecting to WhatsApp. This page refreshes by itself.</p>") };
}

async function handle(req, res) {
  const query = new URL(req.url, "http://localhost").searchParams;
  const limiter = tooManyFailures(req);
  if (limiter.blocked) {
    res.writeHead(429, { "content-type": "text/plain" });
    return res.end("Too many attempts. Try again in a minute.");
  }
  try {
    const { status, html } = await renderLinkPage(query);
    if (status === 403) limiter.record();
    res.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
      "x-frame-options": "DENY",
    });
    res.end(html);
  } catch (err) {
    console.error("[whatsapp] Link page failed:", err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("Something went wrong.");
  }
}

export const handleWhatsAppLink = handle;

/** Route for Slack Bolt's customRoutes. */
export function whatsappLinkRoutes() {
  return [{ path: WHATSAPP_LINK_PATH, method: "GET", handler: handle }];
}
