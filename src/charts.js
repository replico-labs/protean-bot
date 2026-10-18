import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { formatEther } from "viem";
import { Resvg } from "@resvg/resvg-js";
import { proposalTitle } from "./proposalPages.js";

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
 * color? }]. Bars are drawn against the largest value, or `max` if given.
 * `percent: true` adds each bar's share of the total.
 */
export function barChartSvg({ title, subtitle, bars, footer, max, percent = false }) {
  const top = 34;
  const titleLines = [clip(title, 38)];
  const headerH = 34 + (subtitle ? 26 : 0) + 22;
  const rowH = 66;
  const footerLines = (Array.isArray(footer) ? footer : footer ? [footer] : []).map((f) => clip(f, 74));
  const height = top + headerH + bars.length * rowH + footerLines.length * 24 + 34;

  const total = bars.reduce((s, b) => s + Math.max(0, b.value), 0);
  const scaleMax = Math.max(max ?? 0, ...bars.map((b) => b.value), 0) || 1;
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
  if ("approvalForVotes" in p) {
    const adjudicating = (p.adjudicateSuccessVotes ?? 0n) > 0n || (p.adjudicateFailureVotes ?? 0n) > 0n;
    if (adjudicating) {
      const s = tokens(p.adjudicateSuccessVotes);
      const f = tokens(p.adjudicateFailureVotes);
      return {
        title: heading,
        subtitle: sub,
        percent: true,
        bars: [
          { label: "Success", value: s, text: compactNumber(s), color: COLORS.for },
          { label: "Failure", value: f, text: compactNumber(f), color: COLORS.against },
        ],
        footer: "Adjudication vote: did the proposal meet its goal?",
      };
    }
    const bars = voteBars(tokens(p.approvalForVotes), tokens(p.approvalAgainstVotes), tokens(p.approvalAbstainVotes), "");
    if (skipEmpty && bars.every((b) => b.value === 0)) return null;
    return { title: heading, subtitle: sub, bars, percent: true, footer: "Approval vote: should this open for positions?" };
  }
  if ("passTWAP" in p) {
    const pass = Number(p.passTWAP ?? 0);
    const fail = Number(p.failTWAP ?? 0);
    if (skipEmpty && pass === 0 && fail === 0) return null;
    return {
      title: heading,
      subtitle: sub,
      bars: [
        { label: "If it passes", value: pass, text: compactNumber(pass), color: COLORS.for },
        { label: "If it fails", value: fail, text: compactNumber(fail), color: COLORS.against },
      ],
      footer: "Market-predicted value (TWAP) in each outcome. The higher one wins.",
    };
  }
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
  const title = await proposalTitle(network, dao, p.id);
  const subtitle = [chainName, `${MODEL_NAMES[model] ?? model} DAO ${shortAddress(dao)}`].filter(Boolean).join(" · ");
  const png = proposalChartPng({ p, state, title, subtitle, skipEmpty });
  return png ? { png, name: `proposal-${p.id}.png` } : null;
}
