/**
 * Links in bot messages, written once as `[label](url)` and shown the way
 * each platform makes a label clickable, so replies carry short labels
 * ("View transaction", "Proposal page") instead of long raw URLs.
 *
 * - Telegram: legacy Markdown reads `[label](url)` itself; plain-text
 *   messages get the label with a text_link entity (telegramLinks).
 * - Discord: `[label](<url>)` (the angle brackets skip the preview card).
 * - Slack: `<url|label>`.
 * - WhatsApp has no link labels: `label: url`.
 */

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** `[label](url)`, or just the label when there's no URL (no explorer, no pages). */
export function link(label, url) {
  return url ? `[${label}](${url})` : label;
}

/** Whether `text` has any `[label](url)` links. */
export function hasLinks(text) {
  return typeof text === "string" && text.search(LINK) !== -1;
}

/** `text` with its links in `platform`'s own form. */
export function renderLinks(text, platform) {
  if (typeof text !== "string") return text;
  switch (platform) {
    case "discord":
      return text.replace(LINK, (_, label, url) => `[${label}](<${url}>)`);
    case "slack":
      return text.replace(LINK, (_, label, url) => `<${url}|${label.replace(/[<>|]/g, "")}>`);
    case "whatsapp":
      return text.replace(LINK, (_, label, url) => `${label}: ${url}`);
    default:
      return text;
  }
}

/**
 * A Telegram message without parse_mode: its links become labels with
 * text_link entities (offsets in UTF-16 units, which is what JS strings
 * count). Returns null when there are no links, or entities already set.
 */
export function telegramLinks(text, entities) {
  if (entities?.length || !hasLinks(text)) return null;
  let out = "";
  let last = 0;
  const found = [];
  for (const m of text.matchAll(LINK)) {
    out += text.slice(last, m.index);
    found.push({ type: "text_link", offset: out.length, length: m[1].length, url: m[2] });
    out += m[1];
    last = m.index + m[0].length;
  }
  return { text: out + text.slice(last), entities: found };
}

/**
 * "Treasury: `0x…` · explorer": an address in full, as code (tap to copy on
 * Telegram; Slack shows it plain), linked to its explorer page when there is one.
 */
export function addressLine(label, address, url) {
  return `${label}: \`${address}\`${url ? ` · ${link("explorer", url)}` : ""}`;
}
