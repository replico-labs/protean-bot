import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatEther } from "viem";
import { Resvg } from "@resvg/resvg-js";
import { proposalTitle } from "./proposalPages.js";
import { marketsSnapshot } from "./governance/decisionMarkets.js";

/**
 * Chart images (PNG) for chat messages: drawn as SVG and rendered by resvg,
 * with the fonts bundled in assets/fonts so text looks the same wherever
 * the bot runs (no system fonts or native image libraries needed).
 *
 * barChartPng() is the general piece - a title, a subtitle, labelled bars
 * and a footer - meant to be reused for markets, futarchy prices and PnL
 * cards. proposalChart() turns a proposal (as the model adapters return it)
 * into one: For/Against/Abstain, Sowellian's approval and adjudication
 * votes, Decision Markets' pass/fail prices, Conviction's progress.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const FONT_FILES = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf"].map((f) => path.join(FONT_DIR, f));

const COLORS = {
  bg: "#140d24",
  panel: "#1d1433",
  track: "#2a2045",
  text: "#f2eefc",
  dim: "#a79fc0",
  accent: "#b49cff",
  for: "#4ade80",
  against: "#f48a8a",
  abstain: "#8f88a8",
};

const WIDTH = 800;
const SCALE = 1.5; // rendered at 1200px wide: sharp on phones, small enough to send fast

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const clip = (s, max) => {
  const chars = [...String(s ?? "")];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};

/** 1234.5 -> "1.23K"; small numbers keep up to 4 significant digits. */
export function compactNumber(n) {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) if (abs >= size) return `${Number((n / size).toPrecision(3))}${suffix}`;
  return String(Number(n.toPrecision(4)));
}

/**
 * bars: [{ label, value (a number), text? (shown at the end of the bar),
 * color?, marker? (a dashed line at that value) }], or { heading } rows that
 * start a new section. Bars are drawn against the largest value in their
 * section, or `max` if given. `percent: true` adds each bar's share of its
 * section's total.
 */
export function barChartSvg({ title, subtitle, bars, footer, max, percent = false }) {
  const top = 34;
  const titleLines = [clip(title, 38)];
  const headerH = 34 + (subtitle ? 26 : 0) + 22;
  const rowH = 66;
  const headingH = 34;
  const footerLines = (Array.isArray(footer) ? footer : footer ? [footer] : []).map((f) => clip(f, 74));
  const headings = bars.filter((b) => b.heading).length;
  const height = top + headerH + (bars.length - headings) * rowH + headings * headingH + footerLines.length * 24 + 34;

  // Each section (the rows between headings) has its own total and scale.
  const sections = [];
  for (const b of bars) {
    if (b.heading || !sections.length) sections.push([]);
    if (!b.heading) sections.at(-1).push(b);
  }
  const sectionOf = new Map();
  for (const rows of sections) {
    const total = rows.reduce((sum, b) => sum + Math.max(0, b.value), 0);
    const scaleMax = Math.max(max ?? 0, ...rows.map((b) => Math.max(b.value, b.marker ?? 0)), 0) || 1;
    for (const b of rows) sectionOf.set(b, { total, scaleMax });
  }
  const left = 40;
  const barW = WIDTH - left * 2;

  const parts = [
    `<rect width="${WIDTH}" height="${height}" fill="${COLORS.bg}"/>`,
    `<rect x="16" y="16" width="${WIDTH - 32}" height="${height - 32}" rx="18" fill="${COLORS.panel}"/>`,
    `<text x="${left}" y="${top + 34}" font-size="28" font-weight="bold" fill="${COLORS.text}">${escapeXml(titleLines[0])}</text>`,
  ];
  if (subtitle) parts.push(`<text x="${left}" y="${top + 62}" font-size="17" fill="${COLORS.dim}">${escapeXml(clip(subtitle, 66))}</text>`);

  let y = top + headerH + 20;
  for (const b of bars) {
    if (b.heading) {
      parts.push(`<text x="${left}" y="${y + 4}" font-size="16" font-weight="bold" fill="${COLORS.accent}">${escapeXml(clip(b.heading.toUpperCase(), 60))}</text>`);
      y += headingH;
      continue;
    }
    const { total, scaleMax } = sectionOf.get(b);
    const share = total > 0 ? (Math.max(0, b.value) / total) * 100 : 0;
    const right = [b.text, percent ? `${share.toFixed(share > 0 && share < 1 ? 1 : 0)}%` : null].filter(Boolean).join(" · ");
    const w = b.value > 0 ? Math.max(6, (Math.min(b.value, scaleMax) / scaleMax) * barW) : 0;
    parts.push(
      `<text x="${left}" y="${y}" font-size="19" font-weight="bold" fill="${COLORS.text}">${escapeXml(clip(b.label, 40))}</text>`,
      `<text x="${left + barW}" y="${y}" font-size="18" fill="${COLORS.dim}" text-anchor="end">${escapeXml(right)}</text>`,
      `<rect x="${left}" y="${y + 12}" width="${barW}" height="22" rx="11" fill="${COLORS.track}"/>`,
      w ? `<rect x="${left}" y="${y + 12}" width="${w.toFixed(1)}" height="22" rx="11" fill="${b.color ?? COLORS.accent}"/>` : "",
    );
    if (b.marker !== undefined && b.marker > 0) {
      const mx = left + (Math.min(b.marker, scaleMax) / scaleMax) * barW;
      parts.push(`<line x1="${mx.toFixed(1)}" y1="${y + 6}" x2="${mx.toFixed(1)}" y2="${y + 40}" stroke="${COLORS.text}" stroke-width="2" stroke-dasharray="4 3"/>`);
    }
    y += rowH;
  }
  for (const line of footerLines) {
    parts.push(`<text x="${left}" y="${y}" font-size="16" fill="${COLORS.dim}">${escapeXml(line)}</text>`);
    y += 24;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="DejaVu Sans">${parts.join("")}</svg>`;
}

export function svgToPng(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.round(WIDTH * SCALE) },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
  });
  return resvg.render().asPng();
}

export const barChartPng = (spec) => svgToPng(barChartSvg(spec));

/*//////////////////////////////////////////////////////////////
                         PROPOSALS
//////////////////////////////////////////////////////////////*/

const tokens = (v) => Number(formatEther(v ?? 0n));

/**
 * A chart for one proposal, or null when its model has nothing to draw
 * (Board's confirmations, or a vote nobody has joined yet when `skipEmpty`).
 * `p` is what the model adapter's getProposal returns; `state` its label.
 */
export function proposalChart({ p, state, title, subtitle, skipEmpty = false }) {
  const heading = title ? `#${p.id} ${title}` : `Proposal #${p.id}`;
  const sub = [subtitle, state].filter(Boolean).join(" · ");
  const voteBars = (f, a, ab, unit) => [
    { label: "For", value: f, text: `${compactNumber(f)}${unit}`, color: COLORS.for },
    { label: "Against", value: a, text: `${compactNumber(a)}${unit}`, color: COLORS.against },
    { label: "Abstain", value: ab, text: `${compactNumber(ab)}${unit}`, color: COLORS.abstain },
  ];

  if ("forVotes" in p) {
    const token = p.voteWeightUnit === "token";
    const v = (x) => (token ? tokens(x) : Number(x ?? 0n));
    const bars = voteBars(v(p.forVotes), v(p.againstVotes), v(p.abstainVotes), token ? "" : " votes");
    const cast = bars.reduce((s, b) => s + b.value, 0);
    if (skipEmpty && cast === 0) return null;
    const footer = [`${compactNumber(cast)} ${token ? "voting power" : "votes"} cast${token ? "" : " (weighted)"}`];
    if ("quorumVotes" in p) footer[0] += ` · quorum ${compactNumber(tokens(p.quorumVotes))}`;
    return { title: heading, subtitle: sub, bars, percent: true, footer };
  }
  if ("approvalForVotes" in p) return sowellianChart(p, heading, sub, skipEmpty);
  if ("passTWAP" in p || p.markets) return marketsChart(p, heading, sub, skipEmpty);
  if ("requiredConviction" in p) {
    const now = tokens(p.currentConviction);
    const need = tokens(p.requiredConviction);
    const pct = need > 0 ? Math.min(100, (now / need) * 100) : 0;
    return {
      title: heading,
      subtitle: sub,
      max: need,
      bars: [{ label: "Conviction", value: now, text: `${compactNumber(now)} / ${compactNumber(need)} · ${pct.toFixed(0)}%`, color: COLORS.accent }],
      footer: "Passes once the bar is full: conviction grows while support stays.",
    };
  }
  return null;
}

const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.01 ? 2 : 1)}%`;

/**
 * Sowellian: what has happened so far, in one picture - the approval vote,
 * the YES/NO backing once positions open, and the adjudication vote if the
 * outcome was challenged.
 */
function sowellianChart(p, heading, sub, skipEmpty) {
  const vote = (f, a, ab) => [
    { label: "For", value: f, text: compactNumber(f), color: COLORS.for },
    { label: "Against", value: a, text: compactNumber(a), color: COLORS.against },
    { label: "Abstain", value: ab, text: compactNumber(ab), color: COLORS.abstain },
  ];
  const approval = vote(tokens(p.approvalForVotes), tokens(p.approvalAgainstVotes), tokens(p.approvalAbstainVotes));
  const yes = tokens(p.yesPool);
  const no = tokens(p.noPool);
  const success = tokens(p.adjudicateSuccessVotes);
  const failure = tokens(p.adjudicateFailureVotes);
  const bars = [{ heading: "Approval vote: open it for positions?" }, ...approval];
  const footer = [];
  if (yes > 0 || no > 0) {
    bars.push(
      { heading: "Positions: will it meet its goal?" },
      { label: "YES (it works)", value: yes, text: compactNumber(yes), color: COLORS.for },
      { label: "NO (it doesn't)", value: no, text: compactNumber(no), color: COLORS.against },
    );
    const pool = yes + no;
    if (pool > 0) {
      footer.push(`${compactNumber(pool)} tokens backed; the winning side shares the whole pool.`);
      footer.push(`Payout per token: YES ${yes > 0 ? `${(pool / yes).toFixed(2)}x` : "-"} if it works, NO ${no > 0 ? `${(pool / no).toFixed(2)}x` : "-"} if not.`);
    }
  }
  if (success > 0 || failure > 0) {
    bars.push(
      { heading: "Adjudication: did it meet its goal?" },
      { label: "Success", value: success, text: compactNumber(success), color: COLORS.for },
      { label: "Failure", value: failure, text: compactNumber(failure), color: COLORS.against },
    );
  }
  if (skipEmpty && bars.every((b) => b.heading || b.value === 0)) return null;
  if (!footer.length) footer.push("Approved proposals open for YES/NO positions on whether they'll meet their goal.");
  return { title: heading, subtitle: sub, bars, percent: true, footer };
}

/**
 * Decision Markets: each market's price now, and its average price so far -
 * the TWAP that decides it - with the bar the pass average has to beat
 * (fail's, plus the governance's threshold) marked. `p.markets` is
 * { pass: { spot, twap }, fail: { spot, twap }, thresholdBps, settled } in
 * quote per base token; without it, just the stored TWAPs (as plain numbers).
 */
function marketsChart(p, heading, sub, skipEmpty) {
  const m = p.markets ?? { pass: { twap: Number(p.passTWAP ?? 0) }, fail: { twap: Number(p.failTWAP ?? 0) }, settled: true };
  const pass = m.pass.twap;
  const fail = m.fail.twap;
  if (skipEmpty && !pass && !fail && !m.pass.spot && !m.fail.spot) return null;
  const needed = m.thresholdBps !== undefined ? fail * (1 + m.thresholdBps / 10_000) : undefined;
  const bars = [
    { heading: m.settled ? "Average price over the trading window (decided it)" : "Average price so far (decides it)" },
    { label: "If it passes", value: pass, text: compactNumber(pass), color: COLORS.for, marker: needed },
    { label: "If it fails", value: fail, text: compactNumber(fail), color: COLORS.against },
  ];
  if (!m.settled && (m.pass.spot || m.fail.spot)) {
    bars.push(
      { heading: "Price now" },
      { label: "Pass market", value: m.pass.spot ?? 0, text: compactNumber(m.pass.spot ?? 0), color: COLORS.for },
      { label: "Fail market", value: m.fail.spot ?? 0, text: compactNumber(m.fail.spot ?? 0), color: COLORS.against },
    );
  }
  const footer = [];
  if (fail > 0) {
    const gap = pass / fail - 1;
    const need = m.thresholdBps !== undefined ? m.thresholdBps / 10_000 : null;
    const wins = need !== null ? gap > need : gap > 0;
    footer.push(`Pass vs fail: ${pct(gap)}${need !== null ? `, needs more than ${pct(need)}` : ""}. ${m.settled ? (wins ? "It passed." : "It failed.") : wins ? "Passing if trading ended now." : "Failing if trading ended now."}`);
  } else footer.push("The market-predicted value of the DAO token in each outcome; the higher average wins.");
  if (needed !== undefined) footer.push("The dashed line is the average the pass market has to beat.");
  return { title: heading, subtitle: sub, bars, footer };
}

/** PNG for a proposal, or null (see proposalChart). Never throws: a chart is an extra. */
export function proposalChartPng(args) {
  try {
    const spec = proposalChart(args);
    return spec ? barChartPng(spec) : null;
  } catch (err) {
    console.error("Chart rendering failed:", err.message);
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                       TRADING DESK CARDS
//////////////////////////////////////////////////////////////*/

const signed = (n) => `${n >= 0 ? "+" : ""}${compactNumber(n)}`;

/**
 * A trading desk's PnL card: one bar per open position (its value, against
 * the trader's `max` when there's one trader's mandate to measure it by),
 * green or red by its PnL, then the desk total against `total`, and the
 * collateral and overall PnL. positions: [{ symbol, side, size, mark, pnl,
 * owner? }] in `symbol` units. Returns null when there's nothing to show.
 */
export function deskCard({ title, subtitle, positions, symbol = "", mandate, deskNotional, collateral }) {
  const unit = symbol ? ` ${symbol}` : "";
  if (!positions.length && !collateral) return null;
  const bars = [{ heading: positions.length ? "Positions" : "No open positions" }];
  for (const p of positions) {
    const value = p.size * p.mark;
    const of = mandate ? ` of ${compactNumber(Number(mandate.max))}` : unit;
    bars.push({ label: `${p.symbol} ${p.side}${p.owner ? ` · ${p.owner}` : ""}`, value, text: `PnL ${signed(p.pnl)} · ${compactNumber(value)}${of}`, color: p.pnl >= 0 ? COLORS.for : COLORS.against });
  }
  if (mandate?.total) {
    bars.push(
      { heading: "Desk total" },
      { label: "All positions", value: deskNotional, text: `${compactNumber(deskNotional)} of ${compactNumber(Number(mandate.total))}`, color: COLORS.accent, marker: Number(mandate.total) },
    );
  }
  const pnl = positions.reduce((sum, p) => sum + p.pnl, 0);
  const footer = [`Collateral: ${collateral ?? "none yet"}${positions.length ? ` · unrealized PnL ${signed(pnl)}${unit}` : ""}`];
  if (mandate) footer.push(`Bars are measured against the mandate: ${compactNumber(Number(mandate.max))}${unit} a market${mandate.total ? `, ${compactNumber(Number(mandate.total))}${unit} in all` : ""}.`);
  return { title, subtitle, bars, max: mandate ? Number(mandate.max) : undefined, footer };
}

/** The desk card as { png, name }, or null. Never throws: a card is an extra. */
export function deskCardImage(spec) {
  try {
    const card = deskCard(spec);
    return card ? { png: barChartPng(card), name: "desk.png" } : null;
  } catch (err) {
    console.error("Desk card rendering failed:", err.message);
    return null;
  }
}

const MODEL_NAMES = {
  tokenWeighted: "Token-weighted",
  quadratic: "Quadratic",
  liquid: "Liquid",
  optimistic: "Optimistic",
  conviction: "Conviction",
  board: "Board",
  sortition: "Sortition",
  delegate: "Delegate",
  sowellian: "Sowellian",
  decisionMarkets: "Decision Markets",
};

const shortAddress = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a ?? ""));

/**
 * The image to send with a proposal message: { png, name } or null. Titled
 * with the details the proposer wrote on its page, when there are any.
 */
export async function proposalImage({ network, chainName, model, dao, p, state, skipEmpty = false }) {
  // EVM decision markets: the pools' prices and the TWAP so far, read now (Solana's come in p.markets already).
  if (model === "decisionMarkets" && !p.markets && typeof p.passPool === "string") {
    const markets = await marketsSnapshot(dao, p).catch((err) => console.error("Market prices for the chart failed:", err.message));
    if (markets) p = { ...p, markets };
  }
  const title = await proposalTitle(network, dao, p.id);
  const subtitle = [chainName, `${MODEL_NAMES[model] ?? model} DAO ${shortAddress(dao)}`].filter(Boolean).join(" · ");
  const png = proposalChartPng({ p, state, title, subtitle, skipEmpty });
  return png ? { png, name: `proposal-${p.id}.png` } : null;
}
