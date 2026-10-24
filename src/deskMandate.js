/**
 * A trading desk's mandate, shared by both venues (src/desk.js on Perpl,
 * src/deskHypercore.js on HyperCore): what the group agreed the trader may
 * do, written into the appointment proposal and checked by the bot before
 * every trade.
 *
 * - markets: the markets the trader may open positions in ("all" for any)
 * - max: the largest position in one market, in the collateral token, at the order's limit price
 * - total: optional, the largest sum of all open positions (cross margin
 *   means one market's loss eats every market's collateral)
 * - lev: the most leverage
 * - days: how long the mandate lasts from the proposal's execution
 *
 * Closing is never limited: it only reduces what's at risk. Pausing
 * (desk pause, by the chat's admins or the DAO's creator) stops new
 * positions for every trader straight away, without waiting for a vote.
 *
 * A desk can have several traders, each with their own mandate: on Perpl
 * each gets their own desk account, on HyperCore their own markets.
 */

export class DeskError extends Error {}

const MAX_DAYS = 365;

/** `apply` words -> mandate: { markets: [..] | "all", max, total?, lev, days }. */
export function parseMandate(words) {
  const w = words.filter(Boolean);
  const opts = Object.fromEntries(w.filter((x) => x.includes("=")).map((x) => [x.split("=")[0].toLowerCase(), x.slice(x.indexOf("=") + 1)]));
  const marketsWord = opts.markets ?? w.find((x) => !x.includes("="));
  if (!marketsWord) throw new DeskError("Name the markets the trader may trade (e.g. `BTC,ETH`, or `all`).");
  const markets = marketsWord.toLowerCase() === "all" ? "all" : [...new Set(marketsWord.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean))];
  const num = (v, what) => {
    if (!/^\d+(\.\d+)?$/.test(String(v ?? "").replace(/,/g, ""))) throw new DeskError(`${what} must be a number.`);
    return String(v).replace(/,/g, "");
  };
  if (opts.max === undefined) throw new DeskError("Set the largest position the trader may hold: `max=<size>` in the collateral token (e.g. `max=500`).");
  const max = num(opts.max, "max");
  const total = opts.total === undefined ? undefined : num(opts.total, "total");
  const lev = num((opts.lev ?? opts.leverage ?? "2").replace(/x$/i, ""), "lev");
  const days = Number(num(opts.days ?? "30", "days"));
  if (Number(max) <= 0) throw new DeskError("max must be more than 0.");
  if (total !== undefined && Number(total) < Number(max)) throw new DeskError("total is the limit for all positions together, so it can't be less than max.");
  if (Number(lev) < 1) throw new DeskError("lev must be at least 1.");
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new DeskError(`days must be a whole number from 1 to ${MAX_DAYS}.`);
  return { markets, max, ...(total !== undefined ? { total } : {}), lev, days };
}

export function mandateText(m, symbol = "") {
  const markets = m.markets === "all" ? "any market" : m.markets.join(", ");
  const unit = symbol ? ` ${symbol}` : "";
  return `${markets}; positions up to ${m.max}${unit}${m.total ? ` each, ${m.total}${unit} in all` : ""}; up to ${m.lev}x leverage; for ${m.days} day${m.days === 1 ? "" : "s"}`;
}

/**
 * The checks before `trader` opens or adds to a position, in the collateral
 * token: `notional` is this market's position after the order (at the
 * limit price), `othersNotional` every other open position's value that
 * `total` counts.
 */
export function checkOpen(desk, trader, { market, leverage, notional, othersNotional = 0, symbol = "" }) {
  if (desk.paused) throw new DeskError(`The desk is paused${desk.paused.by ? ` (by ${desk.paused.by})` : ""}: no new positions until it's resumed. You can still close positions.`);
  if (Date.now() > trader.expiresAt) throw new DeskError("Your mandate has ended - the DAO needs to appoint you again to open positions. You can still close them.");
  const { mandate } = trader;
  if (!covers(mandate, market)) throw new DeskError(`Your mandate covers ${mandate.markets.join(", ")}, not ${market}.`);
  if (Number(leverage) > Number(mandate.lev)) throw new DeskError(`Your mandate allows up to ${mandate.lev}x, not ${leverage}x.`);
  const unit = symbol ? ` ${symbol}` : "";
  if (notional > Number(mandate.max)) throw new DeskError(`That makes the ${market} position ${fmt(notional, 2)}${unit} at your limit price; your mandate allows up to ${mandate.max}.`);
  if (mandate.total && notional + othersNotional > Number(mandate.total)) {
    throw new DeskError(`That makes the desk's positions ${fmt(notional + othersNotional, 2)}${unit} in all; your mandate allows up to ${mandate.total} in all.`);
  }
}

/** Whether `mandate` lets its trader trade `market`. */
export const covers = (mandate, market) => mandate.markets === "all" || mandate.markets.includes(String(market).toUpperCase());

/** The chat member a desk record names: same platform, user and wallet. */
export const isTrader = (t, chat, address) => Boolean(t) && t.platform === chat.platform && String(t.userId) === String(chat.userId) && (!address || t.address.toLowerCase() === String(address).toLowerCase());

/**
 * One of the desk's traders, by the number /desk shows (1, 2, ...) or their
 * address; with no word, the only one. `list` is [{ address, ... }] in /desk's order.
 */
export function pickTrader(list, word, what = "trader") {
  if (!list.length) throw new DeskError(`The desk has no ${what}s.`);
  if (word === undefined || word === null || word === "") {
    if (list.length === 1) return list[0];
    throw new DeskError(`The desk has ${list.length} ${what}s - say which: its number in \`desk\` (1-${list.length}) or the trader's address.`);
  }
  const w = String(word).replace(/^#/, "");
  if (/^\d+$/.test(w)) {
    const t = list[Number(w) - 1];
    if (!t) throw new DeskError(`There's no ${what} ${w} - \`desk\` lists 1-${list.length}.`);
    return t;
  }
  const t = list.find((x) => x.address.toLowerCase() === w.toLowerCase());
  if (!t) throw new DeskError(`\`${w}\` isn't one of the desk's ${what}s.`);
  return t;
}

/** `for=<trader>` among a command's words: [the word or undefined, the rest]. */
export function takeFor(words) {
  const at = words.findIndex((w) => /^for=/i.test(w));
  if (at < 0) return [undefined, words];
  return [words[at].slice(4), [...words.slice(0, at), ...words.slice(at + 1)]];
}

export const fmt = (n, digits = 4) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "?");
