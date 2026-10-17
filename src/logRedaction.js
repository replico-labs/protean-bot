import "dotenv/config";
import util from "node:util";

/**
 * Keeps secrets out of the logs. Errors quote whatever request failed, and
 * those requests carry credentials: a Telegram API URL holds the bot token,
 * a provider RPC URL its API key (QuickNode's sits in the path). Railway
 * keeps every line, so each console method is wrapped here to blank them
 * before they're written.
 *
 * Imported first by every entry point (index.js, the platform processes,
 * the keeper); importing it again does nothing.
 */

// Env vars whose values are credentials, matched by name.
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PRIVATE|SEED|_KEY$|_KEY_ID$|SIGNING/i;
// Env vars holding URLs that may carry a key (RPC endpoints).
const URL_NAME = /RPC_URLS?$|_URL$/i;

let secretValues = null;
/** Exact secret values from the environment, longest first, read once (after dotenv has loaded). */
function secrets() {
  if (secretValues) return secretValues;
  const values = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12) continue;
    if (SECRET_NAME.test(name)) values.push([value, name]);
    else if (URL_NAME.test(name)) {
      for (const url of value.split(",")) {
        const secret = urlSecret(url.trim());
        if (secret) values.push([secret, name]);
      }
    }
  }
  return (secretValues = values.sort((a, b) => b[0].length - a[0].length));
}

/** The part of a provider URL that is a key: a long token in its path, if any. */
function urlSecret(url) {
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split("/").filter(isKeyLike);
    return parts.sort((a, b) => b.length - a.length)[0] ?? null;
  } catch {
    return null;
  }
}

const PUBLIC_SEGMENT = /\/(tx|address|block|account|token|signature)\/$/i;
const isKeyLike = (part) => part.length >= 20 && /\d/.test(part) && /^[A-Za-z0-9_-]+$/.test(part) && !/^0x/i.test(part);

const PATTERNS = [
  // Telegram bot tokens, alone or in an API URL (".../bot123456:AAE.../getUpdates").
  [/\b(bot)?\d{6,12}:[A-Za-z0-9_-]{30,}/g, (_, bot) => `${bot ?? ""}<telegram-token>`],
  // Keys in query strings (?apikey=..., &token=...).
  [/([?&](?:api[-_]?key|key|token|access[-_]?token|auth)=)[^&\s"']+/gi, "$1<redacted>"],
  // Credentials inside a URL (https://user:pass@host).
  [/(https?:\/\/)[^\s/:@"']+:[^\s/@"']+@/gi, "$1<redacted>@"],
  // Long path tokens in RPC URLs (QuickNode, Alchemy /v2/<key>, Infura /v3/<key>...).
  // Explorer links (/tx/<hash>, /address/<addr>) and 0x values are public and kept.
  [/https?:\/\/[^\s"'<>]+/g, (url) => url.replace(/\/([^/?#\s]+)/g, (seg, part, at) => (isKeyLike(part) && !PUBLIC_SEGMENT.test(url.slice(0, at + 1)) ? "/<redacted>" : seg))],
];

/** `text` with every known secret blanked. */
export function redact(text) {
  let out = String(text);
  for (const [value, name] of secrets()) {
    if (out.includes(value)) out = out.split(value).join(`<${name}>`);
  }
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const INSTALLED = Symbol.for("protean.logRedaction");
if (!console[INSTALLED]) {
  console[INSTALLED] = true;
  for (const method of ["log", "info", "warn", "error", "debug", "trace"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => original(redact(util.format(...args)));
  }
}
