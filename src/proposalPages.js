import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { formatEther, getAddress, isAddress } from "viem";
import { getAllRegisteredDaos } from "./db.js";
import { getAdapter } from "./governance/index.js";
import { PROPOSAL_STATE_LABELS } from "./governance/common.js";
import { getNetwork, resolveNetworkId, runOnNetwork, NETWORK_IDS } from "./networks.js";

/**
 * Proposal pages: every proposal gets a page on the website
 * (PROPOSAL_SITE_URL/p/<network>/<dao>/<id>) holding details its proposer
 * writes there, next to live on-chain data.
 *
 * The bot is the backend. The website is static (Vercel), so it fetches
 * GET /api/proposals/<network>/<dao>/<id> from here for the details and
 * the live state (read through the same model adapters as /proposal),
 * and POSTs the form back. Only the proposer can write: right after
 * proposing, the bot sends them privately an edit link carrying a token
 * signed with PROPOSAL_LINK_SECRET. The details are submitted ONCE and never
 * change afterwards, and only before anyone has voted or backed the
 * proposal, within EDIT_WINDOW_HOURS - so what people back is what they
 * read. Until then, /proposal re-sends the proposer their link.
 *
 * Details live in Supabase (proposal_details, see supabase/schema.sql).
 */

const EDIT_WINDOW_HOURS = 72;
const LIMITS = { title: 140, summary: 600, body: 20_000, links: 10, link: 500 };

export function proposalPagesConfigured() {
  return Boolean(siteUrl() && process.env.PROPOSAL_LINK_SECRET && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function siteUrl() {
  return (process.env.PROPOSAL_SITE_URL || "").replace(/\/+$/, "");
}

/** The public page for a proposal, or null when pages aren't set up. */
export function proposalPageUrl(network, dao, proposalId) {
  if (!proposalPagesConfigured()) return null;
  return `${siteUrl()}/p/${network}/${getAddress(dao)}/${proposalId}`;
}

/*//////////////////////////////////////////////////////////////
                            EDIT TOKENS
//////////////////////////////////////////////////////////////*/

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload) {
  return b64url(crypto.createHmac("sha256", process.env.PROPOSAL_LINK_SECRET).update(payload).digest());
}

/** A token letting its holder edit one proposal's details until it expires. */
export function editToken({ network, dao, proposalId, platform, userId }) {
  const payload = b64url(
    JSON.stringify({ n: network, d: getAddress(dao).toLowerCase(), i: String(proposalId), p: platform, u: String(userId), e: Date.now() + EDIT_WINDOW_HOURS * 3_600_000 })
  );
  return `${payload}.${sign(payload)}`;
}

/** The token's claims, if it was signed by this bot, matches the proposal and hasn't expired. */
export function verifyEditToken(token, { network, dao, proposalId }) {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (claims.n !== network || claims.d !== dao.toLowerCase() || claims.i !== String(proposalId)) return null;
  if (!(claims.e > Date.now())) return null;
  return claims;
}

/** The edit link sent privately to the proposer. */
export function proposalEditUrl(args) {
  const page = proposalPageUrl(args.network, args.dao, args.proposalId);
  return page ? `${page}?edit=${editToken(args)}` : null;
}

/*//////////////////////////////////////////////////////////////
                            STORAGE
//////////////////////////////////////////////////////////////*/

let supabase = null;
const db = () => (supabase ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY));

const key = (network, dao, proposalId) => ({ network, dao: dao.toLowerCase(), proposal_id: String(proposalId) });

/** Records a new proposal so its page exists (details still empty). */
export async function recordProposal({ network, dao, proposalId, model, platform }) {
  const { error } = await db()
    .from("proposal_details")
    .upsert({ ...key(network, dao, proposalId), model, chat_platform: platform }, { onConflict: "network,dao,proposal_id", ignoreDuplicates: true });
  if (error) throw new Error(`Couldn't record the proposal page: ${error.message}`);
}

async function readDetails(network, dao, proposalId) {
  const k = key(network, dao, proposalId);
  const { data, error } = await db().from("proposal_details").select("*").match(k).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

function contentHash({ title, summary, body, links }) {
  return crypto.createHash("sha256").update(JSON.stringify([title, summary, body, links])).digest("hex");
}

/** Validates and cleans what the form sent; throws a message fit to show. */
export function cleanDetails(input) {
  const text = (v, max, name) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length > max) throw new Error(`${name} is too long (max ${max} characters).`);
    return s;
  };
  const title = text(input?.title, LIMITS.title, "Title");
  if (!title) throw new Error("A title is required.");
  const summary = text(input?.summary, LIMITS.summary, "Summary");
  const body = text(input?.body, LIMITS.body, "Details");
  const links = Array.isArray(input?.links) ? input.links : [];
  if (links.length > LIMITS.links) throw new Error(`At most ${LIMITS.links} links.`);
  const cleanLinks = links
    .map((l) => ({ label: text(l?.label, 80, "Link label"), url: text(l?.url, LIMITS.link, "Link") }))
    .filter((l) => l.url);
  for (const l of cleanLinks) {
    let u;
    try {
      u = new URL(l.url);
    } catch {
      throw new Error(`"${l.url}" isn't a link.`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Links must start with https://");
  }
  return { title, summary, body, links: cleanLinks };
}

/*//////////////////////////////////////////////////////////////
                    AFTER PROPOSING (bot side)
//////////////////////////////////////////////////////////////*/

const editMessage = (proposalId, edit, page, cmd) =>
  `📝 Add the details for proposal #${proposalId} - a title, summary and links - here (only you have this link):\n${edit}\n\n` +
  `You submit them once; they can't be changed afterwards. Do it before anyone votes or backs it, and within ${EDIT_WINDOW_HOURS} hours. ` +
  `Everyone sees them at ${page} and through ${cmd("proposal")} ${proposalId}. Lost this link? ${cmd("proposal")} ${proposalId} sends it again.`;

/**
 * Called right after a proposal is created: records its page and returns
 * the public link plus the private edit message for the proposer, or
 * null when proposal pages aren't set up. Never throws - a page problem
 * mustn't hide that the proposal itself went through.
 */
export async function proposalCreated({ network, dao, model, proposalId, platform, userId, cmd }) {
  if (!proposalPagesConfigured()) return null;
  try {
    await recordProposal({ network, dao, proposalId, model, platform });
  } catch (err) {
    console.error("[proposalPages]", err.message);
    return null;
  }
  const page = proposalPageUrl(network, dao, proposalId);
  const edit = proposalEditUrl({ network, dao, proposalId, platform, userId });
  return { page, edit, editText: editMessage(proposalId, edit, page, cmd) };
}

/**
 * The submit link again, but only while it's still useful: the caller's
 * bot wallet (`walletAddress`) must be the proposal's on-chain proposer,
 * and the details must still be open (not submitted, nobody has voted or
 * backed it, inside the window). Otherwise null - callers stay quiet.
 */
export async function pendingSubmitLink({ network, dao, model, proposalId, platform, userId, walletAddress, cmd }) {
  if (!proposalPagesConfigured() || !walletAddress) return null;
  const live = await liveProposal(network, dao, model, proposalId);
  if (!live.proposer || getAddress(live.proposer) !== getAddress(walletAddress)) return null;
  await recordProposal({ network, dao, proposalId, model, platform });
  const row = await readDetails(network, dao, proposalId);
  if (!submittable(row, live)) return null;
  const page = proposalPageUrl(network, dao, proposalId);
  return editMessage(proposalId, proposalEditUrl({ network, dao, proposalId, platform, userId }), page, cmd);
}

/** Telegram /start payload naming one proposal (deep links allow 64 chars of [A-Za-z0-9_-]). */
export function proposalStartPayload(network, dao, proposalId) {
  return `pp_${NETWORK_IDS.indexOf(network)}_${getAddress(dao).slice(2).toLowerCase()}_${proposalId}`;
}

export function parseProposalStartPayload(payload) {
  const m = /^pp_(\d+)_([0-9a-f]{40})_(\d+)$/.exec(String(payload ?? ""));
  if (!m || !NETWORK_IDS[Number(m[1])]) return null;
  return { network: NETWORK_IDS[Number(m[1])], dao: getAddress(`0x${m[2]}`), proposalId: m[3] };
}

/** The DAO's model, if this bot knows the DAO. */
export function knownDaoModel(network, dao) {
  return findDao(network, dao)?.model ?? null;
}

/*//////////////////////////////////////////////////////////////
                            LIVE DATA
//////////////////////////////////////////////////////////////*/

/** The registered DAO at this address on this network, if the bot knows it. */
function findDao(network, dao) {
  return getAllRegisteredDaos().find((d) => d.network === network && d.governanceAddress.toLowerCase() === dao.toLowerCase()) ?? null;
}

/** Everything /proposal shows, as data the page can render. */
async function liveProposal(network, dao, model, proposalId) {
  const p = await runOnNetwork(network, () => getAdapter(model).getProposal(dao, BigInt(proposalId)));
  const fmt = (v) => formatEther(v);
  const facts = [];
  let started = false;
  if ("forVotes" in p) {
    const unit = p.voteWeightUnit === "token" ? fmt : (v) => v.toString();
    facts.push({ label: "For", value: unit(p.forVotes) }, { label: "Against", value: unit(p.againstVotes) }, { label: "Abstain", value: unit(p.abstainVotes) });
    if ("quorumVotes" in p) facts.push({ label: "Quorum needed", value: fmt(p.quorumVotes) });
    started = p.forVotes + p.againstVotes + p.abstainVotes > 0n;
  } else if ("requiredConviction" in p) {
    facts.push({ label: "Conviction", value: fmt(p.currentConviction) }, { label: "Needed", value: fmt(p.requiredConviction) });
    if (p.budget?.text) facts.push({ label: "May spend", value: p.budget.text });
    if (p.budget?.weakensRules) facts.push({ label: "Note", value: "Changes the DAO's spending rules or hands over control" });
    started = p.currentConviction > 0n || p.conviction > 0n;
  } else if ("confirmations" in p) {
    facts.push({ label: "Confirmations", value: String(p.confirmations) });
    started = BigInt(p.confirmations) > 0n;
  } else if ("passTWAP" in p) {
    facts.push({ label: "Pass TWAP", value: String(p.passTWAP) }, { label: "Fail TWAP", value: String(p.failTWAP) });
  } else if ("approvalForVotes" in p) {
    facts.push(
      { label: "Approval for", value: fmt(p.approvalForVotes) },
      { label: "Approval against", value: fmt(p.approvalAgainstVotes) },
      { label: "Approval abstain", value: fmt(p.approvalAbstainVotes) }
    );
    started = p.approvalForVotes + p.approvalAgainstVotes + p.approvalAbstainVotes > 0n;
  }
  const time = (v) => (v !== undefined && BigInt(v) > 0n ? Number(v) : null);
  const net = getNetwork(network);
  return {
    network,
    chain: net.chain.name,
    chainId: net.chain.id,
    explorer: net.explorerUrl,
    nativeSymbol: net.nativeSymbol,
    model,
    id: String(p.id ?? proposalId),
    state: p.stateLabel ?? p.statusLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown",
    description: p.metadataURI ?? "",
    proposer: p.proposer ?? null,
    facts,
    voting: p.startBlock !== undefined && p.endBlock !== undefined ? { startBlock: String(p.startBlock), endBlock: String(p.endBlock) } : null,
    tradingDeadline: time(p.tradingDeadline),
    queuedAt: time(p.queuedAt),
    executableAfter: time(p.executableAfter),
    actions: (p.actions ?? []).map((a) => ({ target: a.target, value: fmt(a.value ?? 0n), data: a.data })),
    started,
  };
}

/** Details can be submitted once: not yet submitted, nobody has voted or backed it, inside the window. */
function submittable(row, live) {
  if (!row || row.title) return false;
  if (live.started) return false;
  return Date.now() - new Date(row.created_at).getTime() < EDIT_WINDOW_HOURS * 3_600_000;
}

/** GET: details + live data for one proposal. */
export async function getProposalPage(networkRaw, daoRaw, idRaw) {
  const network = resolveNetworkId(networkRaw);
  if (!network || !isAddress(daoRaw) || !/^\d+$/.test(String(idRaw))) return { status: 400, body: { error: "Bad proposal address." } };
  const reg = findDao(network, daoRaw);
  if (!reg) return { status: 404, body: { error: "This bot doesn't know that DAO." } };
  let live;
  try {
    live = await liveProposal(network, reg.governanceAddress, reg.model, idRaw);
  } catch (err) {
    return { status: 404, body: { error: `Couldn't read proposal #${idRaw}: ${err.shortMessage || err.message}` } };
  }
  const row = await readDetails(network, reg.governanceAddress, idRaw);
  const details = row?.title
    ? { title: row.title, summary: row.summary, body: row.body, links: row.links ?? [], updatedAt: row.updated_at, contentHash: row.content_hash }
    : null;
  return { status: 200, body: { live, details, submittable: submittable(row, live) } };
}

/** POST: the proposer saves the form. */
export async function saveProposalPage(networkRaw, daoRaw, idRaw, input) {
  const network = resolveNetworkId(networkRaw);
  if (!network || !isAddress(daoRaw) || !/^\d+$/.test(String(idRaw))) return { status: 400, body: { error: "Bad proposal address." } };
  const reg = findDao(network, daoRaw);
  if (!reg) return { status: 404, body: { error: "This bot doesn't know that DAO." } };
  if (!verifyEditToken(input?.token, { network, dao: reg.governanceAddress, proposalId: idRaw })) {
    return { status: 403, body: { error: "This edit link isn't valid or has expired." } };
  }
  const row = await readDetails(network, reg.governanceAddress, idRaw);
  const live = await liveProposal(network, reg.governanceAddress, reg.model, idRaw);
  if (row?.title) return { status: 409, body: { error: "The details were already submitted - they can't be changed." } };
  if (!submittable(row, live)) {
    return { status: 409, body: { error: "It's too late to add details: people have started voting or backing this proposal, or the 72-hour window has closed." } };
  }
  let details;
  try {
    details = cleanDetails(input);
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
  const hash = contentHash(details);
  // `title is null` makes the write itself once-only, even for two
  // submissions racing each other.
  const { data: written, error } = await db()
    .from("proposal_details")
    .update({ ...details, content_hash: hash, updated_at: new Date().toISOString() })
    .match(key(network, reg.governanceAddress, idRaw))
    .is("title", null)
    .select("proposal_id");
  if (error) return { status: 500, body: { error: error.message } };
  if (!written?.length) return { status: 409, body: { error: "The details were already submitted - they can't be changed." } };
  return { status: 200, body: { ok: true, contentHash: hash } };
}

/*//////////////////////////////////////////////////////////////
                            HTTP
//////////////////////////////////////////////////////////////*/

const hits = new Map();
/** At most `max` requests per minute per address, per kind. */
function rateLimited(req, kind, max) {
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "").split(",")[0].trim();
  const k = `${kind}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(k) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(k, recent);
  if (hits.size > 10_000) hits.clear();
  return recent.length > max;
}

function send(res, status, body) {
  const origin = siteUrl() ? new URL(siteUrl()).origin : "*";
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Not JSON."));
      }
    });
    req.on("error", reject);
  });
}

async function handle(req, res, { network, dao, id }) {
  try {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (!proposalPagesConfigured()) return send(res, 503, { error: "Proposal pages aren't set up on this bot." });
    if (req.method === "GET") {
      if (rateLimited(req, "get", 120)) return send(res, 429, { error: "Too many requests." });
      const { status, body } = await getProposalPage(network, dao, id);
      return send(res, status, body);
    }
    if (req.method === "POST") {
      if (rateLimited(req, "post", 20)) return send(res, 429, { error: "Too many requests." });
      const input = await readJson(req);
      const { status, body } = await saveProposalPage(network, dao, id, input);
      return send(res, status, body);
    }
    return send(res, 405, { error: "Method not allowed." });
  } catch (err) {
    console.error("[proposalPages]", err);
    return send(res, 500, { error: "Something went wrong." });
  }
}

export const PROPOSAL_API_PATH = "/api/proposals/:network/:dao/:id";

/** Routes for Slack Bolt's customRoutes (served on the install page's HTTP server). */
export function proposalApiRoutes() {
  const handler = (req, res) => handle(req, res, req.params);
  return ["GET", "POST", "OPTIONS"].map((method) => ({ path: PROPOSAL_API_PATH, method, handler }));
}

/**
 * The same routes on a plain HTTP server, for when Slack's isn't running,
 * plus `extraRoutes` ({ path, handler }, exact path, GET) such as the
 * WhatsApp link page.
 */
export async function startProposalApi(port, extraRoutes = []) {
  const { createServer } = await import("node:http");
  const re = /^\/api\/proposals\/([^/]+)\/([^/]+)\/([^/]+)\/?$/;
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const extra = extraRoutes.find((r) => r.path === pathname.replace(/\/+$/, "") && req.method === (r.method ?? "GET"));
    if (extra) return extra.handler(req, res);
    const m = re.exec(pathname);
    if (!m) {
      res.writeHead(404);
      return res.end();
    }
    return handle(req, res, { network: decodeURIComponent(m[1]), dao: decodeURIComponent(m[2]), id: decodeURIComponent(m[3]) });
  });
  await new Promise((resolve) => server.listen(port, resolve));
  console.log(`[http] Public routes on port ${port}`);
  return server;
}
