/**
 * Explorer links for the transactions a command sends, without threading
 * hashes through every adapter: the places EVM transactions leave the bot
 * (writeWithGasBuffer, deployWithGasLimit, sendNativeSponsored, and
 * Opportunity Market's two Sepolia senders) call trackTx(), and the reply
 * that follows picks the links up - runCommand() for Discord, Slack and
 * WhatsApp, a Telegram API transformer for Telegram (index.js). Outside a
 * tracked command (event listener, keepers, gas top-ups) nothing is
 * recorded.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

/** Runs `fn` collecting the links of transactions it sends. `chatId`: where they may be shown. */
export function withTxTracking(fn, chatId = null) {
  return store.run({ pending: [], chatId }, fn);
}

/**
 * Records a sent transaction's explorer page (null: its network has no
 * explorer). Imports nothing from the bot, so Opportunity Market's
 * self-contained Sepolia code can use it too.
 */
export function trackTx(url) {
  if (url) store.getStore()?.pending.push(url);
}

/** The chat the current tracked command runs in, if any. */
export function trackedChatId() {
  return store.getStore()?.chatId ?? null;
}

/** The links not shown yet, as lines for the end of a reply ("" if none); marks them shown. */
export function takeTxLinks() {
  const s = store.getStore();
  if (!s?.pending.length) return "";
  const urls = [...new Set(s.pending.splice(0))];
  return "\n\n" + urls.map((u) => `🔗 ${u}`).join("\n");
}
