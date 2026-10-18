import { publicClient } from "./config.js";
import { currentNetwork } from "./networks.js";
import { daoTreasury } from "./proposalBuilder.js";
import { IntegrationError } from "./integrations/index.js";
import { perps as perpl } from "./integrations/perpl.js";
import { perps as hypercore } from "./integrations/hypercore.js";

/**
 * /perps: one set of words for perpetuals on whichever exchange the chat's
 * network has - Perpl on Monad, HyperCore on HyperEVM. Reading (positions,
 * markets) answers straight away; trading and moving collateral become an
 * ordinary proposal through the exchange's /proposeaction action
 * (perpl-open, hypercore-order, ...), so the Treasury only trades by vote.
 *
 * Every order is immediate-or-cancel at a limit price: a proposal executes
 * hours or days after it's written, and the limit is what keeps a stale
 * proposal from filling at a bad price.
 */

const VENUES = {
  "monad-testnet": perpl,
  "monad-mainnet": perpl,
  hyperevm: hypercore,
  "hyperevm-testnet": hypercore,
};

export class PerpsError extends Error {}

const NUMBER = /^\d+(\.\d+)?$/;
const isOption = (w) => /^[A-Za-z][A-Za-z0-9]*=/.test(w);
const cleanNumber = (w) => String(w ?? "").replace(/,/g, "");

export function perpsUsage(cmd) {
  const c = cmd("perps");
  return [
    `\`${c}\` - the Treasury's collateral and open positions`,
    `\`${c} markets\` - prices on this network's exchange`,
    `\`${c} long|short <market> <size> at <limitPrice> [3x] [description]\` - propose opening (or adding to) a position`,
    `\`${c} close <market> <size|all> at <limitPrice> [description]\` - propose closing (or reducing) one`,
    `\`${c} deposit <amount>\` / \`${c} withdraw <amount>\` - propose moving collateral`,
    "Orders fill at the limit price or better when the proposal executes, or not at all.",
  ].join("\n");
}

/** Words after /perps -> what was asked. */
export function parsePerps(words) {
  const w = words.filter(Boolean);
  const sub = (w[0] ?? "").toLowerCase();
  if (!sub || sub === "positions") return { kind: "overview" };
  if (sub === "markets" || sub === "prices") return { kind: "markets" };
  if (sub === "help") return { kind: "help" };

  if (sub === "deposit" || sub === "withdraw") {
    const amount = cleanNumber(w[1]);
    if (!NUMBER.test(amount)) throw new PerpsError(`Give an amount: \`${sub} <amount>\`.`);
    return { kind: sub, amount, rest: w.slice(2) };
  }

  const side = { long: "long", buy: "long", short: "short", sell: "short" }[sub];
  if (side || sub === "close") {
    const [market, sizeWord] = w.slice(1, 3);
    let i = 3;
    if ((w[i] ?? "").toLowerCase() === "at" || w[i] === "@") i++;
    const price = cleanNumber(w[i++]);
    const size = cleanNumber(sizeWord);
    const shape = side ? `${sub} <market> <size> at <limitPrice> [3x]` : "close <market> <size|all> at <limitPrice>";
    if (!market || !(NUMBER.test(size) || (!side && size.toLowerCase() === "all")) || !NUMBER.test(price)) throw new PerpsError(`Usage: \`${shape} [description]\``);
    let leverage;
    const lev = /^(\d+(\.\d+)?)x$/i.exec(w[i] ?? "");
    if (side && lev) {
      leverage = lev[1];
      i++;
    }
    return { kind: side ? "open" : "close", side, market: market.toUpperCase(), size, price, leverage, rest: w.slice(i) };
  }
  throw new PerpsError(`Unknown \`perps ${sub}\`.`);
}

/** The chat's exchange, or a PerpsError saying there isn't one. */
function venue() {
  const network = currentNetwork();
  const v = VENUES[network.id];
  if (!v) throw new PerpsError(`There's no perps exchange for ${network.chain.name} DAOs yet - Perpl (Monad) and HyperCore (HyperEVM) are the ones supported.`);
  return v;
}

async function venueCtx(model, governanceAddress) {
  return { network: currentNetwork(), publicClient, treasury: await daoTreasury(model, governanceAddress) };
}

const fmt = (n, digits = 4) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "?");
const signed = (n) => `${n >= 0 ? "+" : ""}${fmt(n, 2)}`;

/** Text for /perps and /perps markets. */
export async function perpsView({ kind, model, governanceAddress }) {
  const v = venue();
  const ctx = await venueCtx(model, governanceAddress);
  const where = `${v.venue} (${ctx.network.chain.name})`;
  try {
    if (kind === "markets") {
      const { rows, note } = await v.markets(ctx);
      const body = rows.map((r) => `${r.symbol.padEnd(7)} ${fmt(r.mark).padStart(12)}${r.fundingPerHour !== undefined ? `  funding ${signed(r.fundingPerHour).padStart(6)}%` : ""}${r.openInterest !== undefined ? `  OI ${fmt(r.openInterest, 2)}` : ""}`);
      return [`*${where} markets*`, "```", ...body, "```", note].filter(Boolean).join("\n");
    }
    const o = await v.overview(ctx);
    if (o.empty) return [`*Treasury on ${where}*`, o.empty, o.note].filter(Boolean).join("\n");
    const body = o.positions.length
      ? o.positions.map((p) => `${p.symbol.padEnd(6)} ${p.side.padEnd(5)} ${fmt(p.size)} @ ${fmt(p.entry)}  mark ${fmt(p.mark)}  PnL ${signed(p.pnl)}  margin ${p.margin}`)
      : ["No open positions."];
    return [`*Treasury on ${where}*`, `Collateral: ${o.collateral}`, "```", ...body, "```", o.note].filter(Boolean).join("\n");
  } catch (err) {
    if (err instanceof IntegrationError) throw new PerpsError(err.message);
    throw err;
  }
}

/** A trading /perps request -> { actionId, words } for proposeaction's integration path. */
export async function perpsProposalWords({ request, model, governanceAddress }) {
  const v = venue();
  let mapped;
  try {
    mapped = await v.translate(await venueCtx(model, governanceAddress), request);
  } catch (err) {
    if (err instanceof IntegrationError) throw new PerpsError(err.message);
    throw err;
  }
  const [actionId, ...words] = mapped;
  const rest = request.rest ?? [];
  const described = rest.some((w) => !isOption(w));
  return { actionId, words: [...words, ...rest, ...(described ? [] : [defaultDescription(request, v.venue)])] };
}

function defaultDescription(r, venueName) {
  if (r.kind === "open") return `Perps: ${r.leverage ? `${r.leverage}x ` : ""}${r.side} ${r.size} ${r.market} at ${r.price} or better on ${venueName}`;
  if (r.kind === "close") return `Perps: close ${r.size} ${r.market} at ${r.price} or better on ${venueName}`;
  return `Perps: ${r.kind} ${r.amount} collateral on ${venueName}`;
}
