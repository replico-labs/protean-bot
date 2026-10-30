import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getChatSolana, registerSolanaChat, unregisterSolanaChat, updateChatSolana } from "../db.js";
import { proposalButtons } from "../buttons.js";
import { solanaProposalImage } from "./charts.js";
import { helpReply } from "../helpMenu.js";
import { SOLANA_ENABLED, SOLANA_MODELS, getSolanaNetwork, resolveSolanaNetwork, explorerUrl, getSolanaOperator } from "./config.js";
import { getOrCreateSolanaKeypair, getSolanaAddress, ensureSolFunded } from "./wallets.js";
import { ACTIONS, MODEL_WORDS, actionApplies, listActionsText, actionInfoText } from "./actions.js";
import { runPhoenixDesk } from "./deskPhoenix.js";
import * as v from "./vortex.js";
import { proposalCreated, proposalPageUrl, pendingSubmitLink, proposalStartPayload } from "../proposalPages.js";
import { takeModelOptions, oracleGoalValue, oracleFeedLine } from "../modelProposal.js";
import { lookupPythFeed } from "../governance/sowellian.js";
import { parseDuration } from "../integrations/common.js";
import { link as linkTo, addressLine } from "../links.js";

/**
 * Commands for chats linked to a Solana (Vortexes) DAO, shared by every
 * platform: Telegram's middleware and the Discord/Slack/WhatsApp
 * registry both hand a command here first (runSolanaCommand), with the
 * same platform-neutral context the registry uses ({ platform, chatId,
 * userId, args, named?, isAdmin, isDirect, cmd }). A reply is { text }.
 *
 * All ten Vortexes models: token-weighted, quadratic, optimistic,
 * conviction, delegate, liquid, sortition, Sowellian and decision markets
 * DAOs (each with a new token), and board DAOs. Command names match the
 * EVM side's, so members use the same words.
 */

class SolanaUserError extends Error {}
const fail = (msg) => {
  throw new SolanaUserError(msg);
};
const reply = (text, extra = {}) => ({ text, ...extra });

/** Commands that have nothing to do with the chat's DAO, so they keep working in a Solana chat (the Opportunity Market runs on Sepolia). */
const PASS_THROUGH = new Set([
  "start", "migratewallet",
  "registermarket", "unregistermarket", "createmarket", "listopportunity", "deposit", "back", "mybalance", "mybet", "allbets",
  "analytics", "fundrewardpool", "cancelmarket", "resolve", "revealwinningtotal", "reclaimstake", "computereward", "withdraw", "withdrawreward",
]);

const SLOW = new Set(["createdao", "createboarddao", "execute", "proposeaction", "startsortition", "desk"]);

/** Whether a command may take a while (Telegram shows a "working" note first). */
export function isSlowSolanaCommand(name) {
  return SLOW.has(name);
}

const MODEL_LABEL = {
  tokenWeighted: "token-weighted",
  quadratic: "quadratic",
  optimistic: "optimistic",
  board: "board",
  conviction: "conviction",
  delegate: "delegate",
  liquid: "liquid",
  sortition: "sortition",
  sowellian: "Sowellian",
  decisionMarkets: "decision markets",
};
const TOKEN = v.TOKEN_MODELS;
const STAKE = v.STAKE_MODELS;
const COUNCIL = v.COUNCIL_MODELS;
const CHOICES = ["for", "against", "abstain"];
const OUTCOMES = ["success", "failure"];

// ---------------------------------------------------------------
// formatting
// ---------------------------------------------------------------

const short = (k) => {
  const s = k.toBase58 ? k.toBase58() : String(k);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
const sol = (lamports) => `${v.formatUnits(BigInt(lamports), 9)} SOL`;
const num = (x) => Number(x.toString());
const pct = (bps) => `${bps / 100}%`;

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = s / 3600;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

function parseKey(text, what) {
  try {
    return new PublicKey(text);
  } catch {
    return fail(`"${text}" isn't a Solana address (${what}).`);
  }
}

function parseId(text, usage) {
  if (!/^\d+$/.test(text ?? "")) fail(`Usage: \`${usage}\``);
  return Number(text);
}

function parseChoice(text, usage) {
  const choice = (text ?? "").toLowerCase();
  if (!CHOICES.includes(choice)) fail(`Usage: \`${usage}\``);
  return choice;
}

const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];

/** What one stored instruction does, in words; null for plumbing (token-account creation, conviction's budget steps). */
export function describeInstruction(network, ix) {
  const data = Buffer.from(ix.data);
  if (ix.programId.equals(SystemProgram.programId) && data.length >= 12 && data.readUInt32LE(0) === 2) {
    return `pay ${sol(data.readBigUInt64LE(4))} to \`${ix.accounts[1].pubkey.toBase58()}\``;
  }
  if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return null;
  if (TOKEN_PROGRAMS.some((p) => p.equals(ix.programId))) {
    // TransferChecked (12) and MintToChecked (14): amount u64, decimals u8.
    if ((data[0] === 12 || data[0] === 14) && data.length >= 10) {
      const amount = v.formatUnits(data.readBigUInt64LE(1), data[9]);
      return data[0] === 12
        ? `pay ${amount} of token \`${short(ix.accounts[1].pubkey)}\` to token account \`${short(ix.accounts[2].pubkey)}\``
        : `mint ${amount} of token \`${short(ix.accounts[0].pubkey)}\` to token account \`${short(ix.accounts[1].pubkey)}\``;
    }
    return "a token instruction";
  }
  const decoded = v.decodeInstruction(network, ix);
  if (!decoded) return `a call to program \`${short(ix.programId)}\``;
  const { program, name, data: args } = decoded;
  const label = MODEL_LABEL[program] ?? program;
  switch (`${program}.${name}`) {
    case "conviction.recordBalances":
    case "conviction.checkBudget":
      return null;
    case "hub.proposeSwitch":
      return `switch the DAO to ${MODEL_LABEL[v.modelOf(network, args.newProgram)] ?? `program \`${short(args.newProgram)}\``} governance (2 days after this runs)`;
    case "hub.cancelSwitch":
      return "call off the pending model switch";
    case "board.addSigner":
      return `add signer \`${args.signer.toBase58()}\``;
    case "board.removeSigner":
      return `remove signer \`${args.signer.toBase58()}\``;
    case "board.updateConfig":
      return `require ${args.config.requiredApprovals} confirmations, ${duration(args.config.timelock)} timelock`;
    case "conviction.addAsset":
      return `protect token \`${short(ix.accounts[2].pubkey)}\` with spending budgets`;
    default:
      if (name === "initGovernance") return `set up ${label} governance for this DAO`;
      if (name === "updateConfig") return `change the ${label} rules`;
      return `${label}: ${name}`;
  }
}

/** What a proposal does, in words. */
function describeProposal(network, p) {
  const words = p.core.instructions.map((ix) => describeInstruction(network, ix)).filter(Boolean);
  return words.length ? words.join("; ") : `${p.core.instructions.length} instruction(s)`;
}

// ---------------------------------------------------------------
// context helpers
// ---------------------------------------------------------------

function requireLink(ctx) {
  const link = getChatSolana(ctx.chatId, ctx.platform);
  if (!link) fail("No Solana DAO is linked to this chat.");
  return { link, network: getSolanaNetwork(link.network) };
}

/**
 * Applies the DAO's pending model switch if it's due (anyone may, and the
 * bot does it as soon as someone uses the DAO), recording the new model
 * on the chat's link.
 */
async function settleSwitch(ctx, network, d) {
  const pending = d.record.pendingSwitch;
  if (!pending || !getSolanaOperator()) return d;
  if ((await v.clusterNow(network)) < num(pending.readyAt)) return d;
  try {
    await v.applySwitch(network, d);
    const next = await v.readDao(network, d.dao);
    if (next.model) updateChatSolana(ctx.chatId, { model: next.model }, ctx.platform);
    return next;
  } catch (err) {
    console.error("[solana] applying a due switch failed:", err.message);
    return d;
  }
}

/** The chat's DAO, its rules, and (token models) its token: { decimals, symbol, fmt, parse }. */
async function loadDao(ctx) {
  const { link, network } = requireLink(ctx);
  const d = await settleSwitch(ctx, network, await v.readDao(network, new PublicKey(link.dao)));
  if (!d.model) fail("This DAO now runs on a governance model the bot doesn't know.");
  const governance = await v.readGovernance(network, d.model, d.governance);
  let tok = null;
  if (TOKEN.includes(d.model)) {
    const { decimals } = await v.mintInfo(network, governance.mint);
    tok = {
      decimals,
      symbol: link.symbol ?? "tokens",
      fmt: (raw) => v.formatUnits(raw, decimals),
      parse: (text) => v.parseUnits(text, decimals),
    };
  }
  return { link, network, d, model: d.model, governance, tok };
}

function requireModel(model, expected, what) {
  const list = [].concat(expected);
  if (!list.includes(model)) fail(`${what} only applies to ${list.map((m) => MODEL_LABEL[m]).join(" and ")} DAOs; this one is ${MODEL_LABEL[model]}.`);
}

/** The member's keypair, with enough SOL for fees and rent (plus `rentBytes` of new account, if given). */
async function member(ctx, network, rentBytes = 0) {
  const kp = await getOrCreateSolanaKeypair(ctx.userId, ctx.platform);
  const need = rentBytes ? await network.connection.getMinimumBalanceForRentExemption(rentBytes) : 0;
  await ensureSolFunded(network, ctx.userId, ctx.platform, kp.publicKey, need);
  return kp;
}

/**
 * A generous size for a new proposal account carrying `instructions`:
 * the largest model's fixed part (delegate's room for 15 council votes,
 * conviction's watched assets and budget) plus the instructions and
 * conviction's two budget steps.
 */
function proposalBytes(instructions, description) {
  const ixBytes = instructions.reduce((n, ix) => n + 36 + 34 * ix.accounts.length + 4 + ix.data.length, 0);
  return 1_400 + ixBytes + Buffer.byteLength(description);
}

const U32_MAX = 2 ** 32 - 1;

/**
 * Sowellian's resolution criteria from its name=value words (the EVM
 * side's: track, feed, goal, when, measure). The oracle is always Pyth on
 * Solana: the proposal names a feed, and resolving reads Pyth's sponsored
 * price account for it.
 */
async function sowellianCriteria(network, options) {
  const track = (options.track ?? "human").toLowerCase();
  if (track !== "human" && track !== "oracle") fail("track= must be human or oracle.");
  const when = (options.when ?? "min").toLowerCase();
  if (when !== "min" && when !== "max") fail("when= must be min (success if the result is at least goal) or max (at most goal).");
  let measurementPeriod;
  try {
    measurementPeriod = parseDuration(options.measure, 7 * 86_400);
  } catch (err) {
    fail(`measure=: ${err.message}`);
  }
  if (measurementPeriod <= 0 || measurementPeriod > U32_MAX) fail("measure= must be longer than zero (and under 136 years).");
  const base = { targetIsMinimum: when === "min", measurementPeriod };
  if (track === "human") {
    if (options.oracle || options.feed) fail("oracle= and feed= only apply with track=oracle.");
    if (options.goal !== undefined && !/^-?\d+$/.test(options.goal)) fail("On the human track goal= is a whole number (it's only recorded; people decide the outcome).");
    return { criteria: { method: { human: {} }, feedId: new Array(32).fill(0), targetValue: new v.BN(options.goal ?? "0"), ...base }, notes: [] };
  }
  if (options.oracle && options.oracle.toLowerCase() !== "pyth") fail("On Solana the oracle is always Pyth - leave out oracle=.");
  if (!options.feed) fail("The oracle track needs feed=<pair>, e.g. feed=SOL/USD (or a Pyth feed ID, 0x + 64 hex).");
  if (options.goal === undefined) fail("The oracle track needs goal=<price> - what the feed's price is compared against, e.g. goal=150.");
  const targetValue = new v.BN(oracleGoalValue(options.goal).toString());
  const feed = await lookupPythFeed(options.feed);
  const feedId = Buffer.from(feed.id.slice(2), "hex");
  const account = v.pythFeedAccount(feedId);
  const notes = [oracleFeedLine(feed)];
  if (!(await network.connection.getAccountInfo(account))) {
    notes.push(`⚠️ Pyth keeps no sponsored price account for this feed on ${network.name}, so resolving it will need a price update account's address: \`resolveviaoracle <id> <account>\`.`);
  }
  return { criteria: { method: { oracle: {} }, feedId: [...feedId], targetValue, ...base }, notes };
}

/**
 * The settings a Sowellian or decision markets proposal carries, from
 * name=value words anywhere in `words`, and the words left over. Checks
 * the proposer's wallet holds what proposing takes (the bond; the seeds).
 * Returns { opts, rest, notes }.
 */
async function proposalOptions(ctx, c, words, kp) {
  const { model, network, governance: g, tok } = c;
  if (model !== "sowellian" && model !== "decisionMarkets") return { opts: {}, rest: words, notes: [] };
  const { options, rest } = takeModelOptions(model, words);
  if (model === "sowellian") {
    const { criteria, notes } = await sowellianCriteria(network, options);
    const bond = BigInt(g.config.proposalBond.toString());
    const held = await v.tokenBalance(network, g.mint, kp.publicKey);
    if (held < bond) fail(`Proposing posts a ${tok.fmt(bond)} ${tok.symbol} bond from your wallet (returned once it's settled, kept by the treasury if the approval vote fails); you hold ${tok.fmt(held)}.`);
    return { opts: { criteria }, rest, notes };
  }
  if (!options.seed || !options.quote) fail(`A decision markets proposal seeds both markets from your wallet: add \`seed=<${tok.symbol}>\` and \`quote=<${v.quoteIsSol(g) ? "SOL" : "quote tokens"}>\`, e.g. \`seed=100 quote=0.5\`.`);
  const quote = await v.mintInfo(network, g.quoteMint);
  const seeds = { base: tok.parse(options.seed), quote: v.parseUnits(options.quote, quote.decimals) };
  const quoteName = v.quoteIsSol(g) ? "SOL" : "quote tokens";
  if (seeds.base < BigInt(g.config.minBaseSeed.toString())) fail(`seed= must be at least ${tok.fmt(g.config.minBaseSeed)} ${tok.symbol}.`);
  if (seeds.quote < BigInt(g.config.minQuoteSeed.toString())) fail(`quote= must be at least ${v.formatUnits(g.config.minQuoteSeed, quote.decimals)} ${quoteName}.`);
  const heldBase = await v.tokenBalance(network, g.mint, kp.publicKey);
  if (heldBase < seeds.base) fail(`You hold ${tok.fmt(heldBase)} ${tok.symbol}, less than the ${tok.fmt(seeds.base)} seed.`);
  await requireQuote(network, g, kp, seeds.quote, quote.decimals);
  return { opts: { seeds }, rest, notes: [] };
}

/** Refuses unless the member's wallet holds `raw` of the quote token (SOL: plus a little for fees and rent). */
async function requireQuote(network, g, kp, raw, decimals) {
  if (v.quoteIsSol(g)) {
    const have = BigInt(await network.connection.getBalance(kp.publicKey));
    const margin = 5_000_000n;
    if (have < raw + margin) fail(`That takes ${sol(raw)} from your own wallet, plus ~0.005 SOL for fees and rent; it holds ${sol(have)}. Send SOL to \`${kp.publicKey.toBase58()}\` first (the bot only tops up fees).`);
    return;
  }
  const have = await v.tokenBalance(network, g.quoteMint, kp.publicKey);
  if (have < raw) fail(`You hold ${v.formatUnits(have, decimals)} of the quote token, less than the ${v.formatUnits(raw, decimals)} needed.`);
}

/** Quadratic votes (√ of raw stake) shown on the token's scale: √600 tokens ≈ 24.49 votes. */
function votesText(raw, tok) {
  return tok.decimals % 2 === 0 ? v.formatUnits(raw, tok.decimals / 2) : String(raw);
}

/** A tally line, in tokens (or votes, for quadratic). */
function tallyLine(model, t, tok) {
  const f = model === "quadratic" ? (x) => votesText(x, tok) : tok.fmt;
  const unit = model === "quadratic" ? "votes" : tok.symbol;
  return `For ${f(t.forVotes)} · Against ${f(t.againstVotes)} · Abstain ${f(t.abstainVotes)} ${unit}`;
}

function requireCouncil(governance, kp) {
  if (!governance.council.some((m) => m.equals(kp.publicKey))) fail(`Only council members can do that here. Your Solana address is \`${kp.publicKey.toBase58()}\`.`);
}

function requireSigner(governance, kp) {
  if (!governance.signers.some((s) => s.equals(kp.publicKey))) fail(`You're not a signer of this board. Your Solana address is \`${kp.publicKey.toBase58()}\`.`);
}

/** The member's deposit record, refusing if they have nothing staked. */
async function requireStake(ctx, network, d, model, kp) {
  const voter = await v.readVoter(network, model, d.voter(kp.publicKey));
  if (!voter || BigInt(voter.amount.toString()) === 0n) fail(`You have nothing staked here - stake first with \`${ctx.cmd("stake")} <amount>\`.`);
  return voter;
}

/** The next step after a proposal is made, per model. */
async function nextStep(ctx, c, id) {
  const { model, governance: g, tok } = c;
  switch (model) {
    case "board":
      return `Your confirmation counts already. Other signers: \`${ctx.cmd("confirm")} ${id}\`.`;
    case "optimistic":
      return `It passes unless someone challenges it within ${duration(g.config.challengePeriod)} (\`${ctx.cmd("challenge")} ${id}\`, posting a ${tok.fmt(g.config.challengeBond)} ${tok.symbol} bond). Then: \`${ctx.cmd("queue")} ${id}\`.`;
    case "conviction": {
      const p = await v.readProposal(c.network, model, c.d.proposal(id));
      return `Back it with \`${ctx.cmd("support")} ${id}\`. It needs ${tok.fmt(p.requiredConviction)} conviction, which builds up while support holds.`;
    }
    case "delegate":
    case "sortition":
      return `Council members vote: \`${ctx.cmd("vote")} ${id} for|against|abstain\` (votes last ${duration(g.config.votingPeriod)}).`;
    case "liquid":
      return `Vote with \`${ctx.cmd("vote")} ${id} for|against|abstain\` (votes last ${duration(g.config.votingPeriod)}). A delegate's vote carries their delegators' stake too; a delegator who votes themselves overrides it.`;
    case "sowellian":
      return `First an approval vote on opening it for positions, for ${duration(g.config.approvalVotingPeriod)}: \`${ctx.cmd("vote")} ${id} for|against|abstain\`. Then \`${ctx.cmd("finalizeapproval")} ${id}\`.`;
    case "decisionMarkets":
      return `Both markets trade for ${duration(g.config.tradingPeriod)}. Get conditional tokens with \`${ctx.cmd("split")} ${id} base|quote <amount>\`, then back pass or fail with \`${ctx.cmd("trade")} ${id} pass|fail buy|sell <amount>\`. Then \`${ctx.cmd("finalizeproposal")} ${id}\`.`;
    default:
      return `Vote with \`${ctx.cmd("vote")} ${id} for|against|abstain\` (votes last ${duration(g.config.votingPeriod)}).`;
  }
}

/**
 * The reply after a proposal is made: the public message with its page
 * link, and the proposer's private link for adding the details (when
 * proposal pages are set up). `startPayload` lets Telegram hand the link
 * over in a private chat when it can't message the proposer first.
 */
async function proposalMade(ctx, c, id, text) {
  const args = { network: c.link.network, dao: c.d.governance.toBase58(), model: c.model, proposalId: id };
  const page = await proposalCreated({ ...args, platform: ctx.platform, userId: ctx.userId, cmd: ctx.cmd });
  const buttons = proposalButtons({ model: c.model, id, page: page?.page, solana: true });
  if (!page) return reply(text, { buttons });
  return { text: `${text}\n\n📄 ${linkTo("Proposal page", page.page)} - the proposer is adding the details there.`, privateFollowUp: page.editText, startPayload: proposalStartPayload(args.network, args.dao, id), buttons };
}

/** The extra settings a model's proposals take, for usage lines ("" for most). */
function optionsUsage(model) {
  if (model === "sowellian") return "\nSowellian settings, anywhere after the action: `[track=human|oracle] [feed=SOL/USD] [goal=<price>] [when=min|max] [measure=7d]` (default: human track, measured 7 days after it runs).";
  if (model === "decisionMarkets") return "\nDecision markets settings, anywhere after the action: `seed=<DAO tokens> quote=<SOL>` - both markets' starting liquidity, from your wallet.";
  return "";
}

/** The DAO's rules in words. */
async function rulesLines(ctx, c, now) {
  const { model, governance: g, tok, network, d } = c;
  const cfg = g.config;
  const run = (timelock, exec) => `${duration(timelock)} timelock, ${duration(exec)} to run`;
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
      return [
        `Rules: ${pct(cfg.quorumBps)} quorum, ${pct(cfg.approvalBps)} approval, votes last ${duration(cfg.votingPeriod)}, ${run(cfg.timelock, cfg.executionPeriod)}`,
        ...(model === "quadratic" ? ["Each member's votes are the square root of their stake, so large holders count for less."] : []),
      ];
    case "optimistic":
      return [
        `Rules: proposals pass unless challenged within ${duration(cfg.challengePeriod)}. A challenge posts a ${tok.fmt(cfg.challengeBond)} ${tok.symbol} bond and opens a ${duration(cfg.votingPeriod)} vote (${pct(cfg.quorumBps)} quorum, ${pct(cfg.approvalBps)} approval); the bond goes to the treasury if the proposal still passes, back to the challenger if not. ${run(cfg.timelock, cfg.executionPeriod)}.`,
      ];
    case "conviction":
      return [
        `Rules: a proposal needs conviction of at least ${tok.fmt(cfg.minConviction)} or ${pct(cfg.supportBps)} of all staked ${tok.symbol}, plus its spending budget's share of the treasury. Conviction builds toward the stake backing it by up to ${tok.fmt(BigInt(cfg.growthRate.toString()) * 3600n)} an hour. ${run(cfg.timelock, cfg.executionPeriod)}.`,
        "",
        ...(await assetLines(network, d, g, tok, now)),
      ];
    case "delegate": {
      const ends = num(g.termEndsAt);
      return [
        `Council (${g.council.length} of ${cfg.councilSize} seats):`,
        ...g.council.map((m) => `• \`${m.toBase58()}\``),
        `${cfg.councilQuorum} council votes and ${pct(cfg.councilApprovalBps)} approval pass a proposal; votes last ${duration(cfg.votingPeriod)}, ${run(cfg.timelock, cfg.executionPeriod)}.`,
        g.electionOpen ? `An election is open: \`${ctx.cmd("council")}\`.` : ends > now ? `The council's term ends in ${duration(ends - now)}.` : `The council's term is over - anyone can \`${ctx.cmd("startelection")}\`.`,
      ];
    }
    case "board":
      return [`Signers (${cfg.requiredApprovals} of ${g.signers.length} must confirm):`, ...g.signers.map((s) => `• \`${s.toBase58()}\``), `Timelock ${duration(cfg.timelock)}, ${duration(cfg.executionPeriod)} to run`];
    case "liquid":
      return [
        `Rules: ${pct(cfg.quorumBps)} quorum, ${pct(cfg.approvalBps)} approval, votes last ${duration(cfg.votingPeriod)}, ${run(cfg.timelock, cfg.executionPeriod)}`,
        `Members can hand their stake's vote to someone with \`${ctx.cmd("delegate")} <address>\` (one hop: a delegate can't delegate). Voting yourself always overrides your delegate.`,
      ];
    case "sortition": {
      const ends = num(g.termEndsAt);
      const pool = await v.readPool(network, d);
      return [
        `Council (${g.council.length} of ${cfg.councilSize} seats), drawn by lot from ${pool?.members.length ?? 0} member(s) in the pool:`,
        ...g.council.map((m) => `• \`${m.toBase58()}\``),
        `${v.sortitionQuorum(g)} council votes and ${pct(cfg.councilApprovalBps)} approval pass a proposal; votes last ${duration(cfg.votingPeriod)}, ${run(cfg.timelock, cfg.executionPeriod)}.`,
        g.drawOpen ? `A draw is under way: \`${ctx.cmd("finalizesortition")}\` seats the council once the randomness arrives.` : ends > now ? `The council's term ends in ${duration(ends - now)}.` : `The council's term is over - anyone can \`${ctx.cmd("startsortition")}\`.`,
      ];
    }
    case "sowellian":
      return [
        `Rules: proposing posts a ${tok.fmt(cfg.proposalBond)} ${tok.symbol} bond. An approval vote (${pct(cfg.approvalQuorumBps)} quorum, ${pct(cfg.approvalThresholdBps)}) runs ${duration(cfg.approvalVotingPeriod)}; then members back YES or NO with tokens for ${duration(cfg.positionsWindow)}, and it runs after a ${duration(cfg.executionTimelock)} timelock (${duration(cfg.executionPeriod)} to run).`,
        `After its measurement period, an oracle (Pyth) or a person settles whether it worked. A person's answer posts a ${tok.fmt(cfg.resolutionBond)} bond and can be challenged within ${duration(cfg.challengePeriod)} (${tok.fmt(cfg.challengeBond)} bond), which opens a ${duration(cfg.adjudicationVotingPeriod)} vote. The winning side splits the whole pot.`,
      ];
    case "decisionMarkets": {
      const quote = await v.mintInfo(network, g.quoteMint);
      const quoteName = v.quoteIsSol(g) ? "SOL" : `token \`${short(g.quoteMint)}\``;
      return [
        `Rules: no votes. Each proposal opens a pass and a fail market for ${duration(cfg.tradingPeriod)}; it passes if the pass market's average price of ${tok.symbol} beats the fail market's by more than ${pct(cfg.thresholdBps)}. ${run(cfg.timelock, cfg.executionPeriod)}.`,
        `Proposers seed both markets with at least ${tok.fmt(cfg.minBaseSeed)} ${tok.symbol} and ${v.formatUnits(cfg.minQuoteSeed, quote.decimals)} ${quoteName}.`,
      ];
    }
    default:
      return [];
  }
}

/** Conviction's protected assets: weight, what the treasury holds, pending changes. */
async function assetLines(network, d, g, tok, now) {
  const lines = ["Protected assets (spending them raises a proposal's bar):"];
  for (const a of g.assets) {
    const isSol = a.mint.equals(v.SOL_ASSET);
    let held;
    if (isSol) held = sol(await network.connection.getBalance(d.treasury));
    else {
      const info = await v.mintInfo(network, a.mint).catch(() => null);
      const raw = info ? await v.tokenBalance(network, a.mint, d.treasury) : 0n;
      held = info ? `${v.formatUnits(raw, info.decimals)} ${a.mint.equals(g.mint) ? tok.symbol : `of \`${short(a.mint)}\``}` : "?";
    }
    let line = `• ${isSol ? "SOL" : a.mint.equals(g.mint) ? tok.symbol : `\`${short(a.mint)}\``}: weight ${tok.fmt(a.weight)}, treasury holds ${held}`;
    if (a.pending) {
      const at = num(a.pending.effectiveAt);
      line += a.pending.remove ? ` (removal due in ${duration(at - now)})` : ` (cut to ${tok.fmt(a.pending.weight)} due in ${duration(at - now)})`;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------
// commands
// ---------------------------------------------------------------

// /help's topics: [topic, title, commands]. A command left out of every
// topic still works; it just isn't listed.
const HELP_SECTIONS = [
  ["setup", "Setup", ["network", "unregister"]],
  ["wallet", "Your wallet", ["wallet", "balance", "stake", "unstake", "migrate"]],
  ["dao", "The DAO", ["dao", "treasury", "tip", "proposals", "proposal"]],
  ["proposing", "Proposing", ["propose", "proposeaction", "listactions", "actioninfo"]],
  ["deciding", "Deciding", ["vote", "delegate", "undelegate", "challenge", "support", "withdrawsupport", "mysupport", "assets", "confirm", "revoke", "queue", "execute", "cancel"]],
  ["council", "Council", ["council", "startelection", "declarecandidacy", "voteinelection", "finalizeelection", "initiaterecall", "voterecall", "finalizerecall", "registereligible", "withdraweligibility", "startsortition", "finalizesortition"]],
  ["sowellian", "Sowellian", ["castapprovalvote", "finalizeapproval", "takeposition", "resolveviaoracle", "proposeresolution", "challengeresolution", "finalizeunchallenged", "castadjudicationvote", "finalizeadjudication", "claimposition"]],
  ["markets", "Markets", ["split", "trade", "merge", "finalizeproposal", "redeem", "reclaimliquidity"]],
  ["desk", "Trading desk", ["desk"]],
];

const COMMANDS = {
  perps: {
    description: "Perpetuals for Solana DAOs",
    async run(ctx) {
      return reply(`Solana DAOs trade perps through the trading desk on Phoenix (mainnet): \`${ctx.cmd("desk")}\`. Traders appointed by proposal trade their own isolated subaccount, without a vote per trade.`);
    },
  },
  desk: {
    usage: "[register | apply <markets> max=<size> | fund|withdraw <amount> [for=<n>] | remove [n] | resign | pause | resume | mine | long|short|close …]",
    description: "Trading desk on Phoenix perps: traders appointed by proposal trade the Treasury's subaccounts, never withdraw",
    async run(ctx) {
      const c = await loadDao(ctx);
      return runPhoenixDesk(ctx, c, {
        propose: (actionId, args, description) => proposeAction(ctx, c, actionId, args, description, description.split(/\s+/)),
        isCreator: async () => {
          const me = await getSolanaAddress(ctx.userId, ctx.platform);
          return Boolean(me && c.d.record.creator.equals(me));
        },
      });
    },
  },
  help: {
    usage: "[topic]",
    description: "The commands for this chat's Solana DAO, by topic",
    async run(ctx) {
      const link = getChatSolana(ctx.chatId, ctx.platform);
      const sections = HELP_SECTIONS.map(([key, title, names]) => ({
        key,
        title,
        lines: names
          .filter((name) => COMMANDS[name] && !(COMMANDS[name].models && !COMMANDS[name].models.includes(link.model)))
          .map((name) => `\`${ctx.cmd(name)}${COMMANDS[name].usage ? " " + COMMANDS[name].usage : ""}\` — ${COMMANDS[name].description}`),
      }));
      const intro = [
        `*Protean DAO on Solana* — ${MODEL_LABEL[link.model] ?? link.model} DAO on ${getSolanaNetwork(link.network).name}`,
        "Opportunity Market commands work here as usual.",
      ].join("\n");
      const { text, buttons } = helpReply({ sections, topic: ctx.args?.[0], intro, cmd: ctx.cmd });
      return reply(text, { buttons });
    },
  },

  network: {
    usage: "",
    description: "Which network this chat's DAO is on",
    async run(ctx) {
      const { network } = requireLink(ctx);
      return reply(`This chat's DAO is on *${network.name}* (\`${network.id}\`). Fees and rent are paid in SOL.`);
    },
  },

  dao: {
    usage: "",
    description: "This DAO: treasury, rules, proposals",
    async run(ctx) {
      const c = await loadDao(ctx);
      const { network, d, model, governance, tok } = c;
      const [treasurySol, now] = await Promise.all([network.connection.getBalance(d.treasury), v.clusterNow(network)]);
      const at = (key) => explorerUrl(network, "address", key.toBase58());
      const lines = [
        `*${d.record.name}* — ${MODEL_LABEL[model]} DAO on ${network.name}`,
        "",
        addressLine("DAO", d.dao.toBase58(), at(d.dao)),
        addressLine("Governance", d.governance.toBase58(), at(d.governance)),
        ...(tok ? [addressLine("Token", governance.mint.toBase58(), at(governance.mint))] : []),
        addressLine("Treasury", d.treasury.toBase58(), at(d.treasury)),
        "",
        `Treasury holds: ${sol(treasurySol)}`,
      ];
      if (tok) {
        lines.push(`  and ${tok.fmt(await v.tokenBalance(network, governance.mint, d.treasury))} ${tok.symbol}`);
        lines.push(`Staked: ${tok.fmt(governance.totalDeposited)} ${tok.symbol}`);
      } else lines.push("");
      lines.push(...(await rulesLines(ctx, c, now)));
      lines.push("", `Proposals so far: ${governance.proposalCount.toString()}`, `Governance setup #${d.record.epoch}`);
      if (d.record.pendingSwitch) {
        const ps = d.record.pendingSwitch;
        const to = MODEL_LABEL[v.modelOf(network, ps.program)] ?? `program \`${short(ps.program)}\``;
        lines.push(`⚠️ Switching to ${to} in ${duration(num(ps.readyAt) - now)} (same treasury). A proposal running \`cancelswitch\` can still stop it.`);
      }
      return reply(lines.join("\n"));
    },
  },

  treasury: {
    usage: "",
    description: "The treasury's address and balance",
    async run(ctx) {
      const { network, d, governance, tok } = await loadDao(ctx);
      const lines = [`Treasury: \`${d.treasury.toBase58()}\``, `Holds: ${sol(await network.connection.getBalance(d.treasury))}`];
      if (tok) lines.push(`  and ${tok.fmt(await v.tokenBalance(network, governance.mint, d.treasury))} ${tok.symbol}`);
      lines.push("", "Anyone can send SOL to this address to fund the DAO.", `🔍 ${linkTo("View on explorer", explorerUrl(network, "address", d.treasury.toBase58()))}`);
      return reply(lines.join("\n"));
    },
  },

  wallet: {
    usage: "",
    description: "Your Solana wallet",
    async run(ctx) {
      const { network } = requireLink(ctx);
      const kp = await getOrCreateSolanaKeypair(ctx.userId, ctx.platform);
      const balance = await network.connection.getBalance(kp.publicKey);
      return reply(`Your Solana wallet:\n\`${kp.publicKey.toBase58()}\`\n\nBalance: ${sol(balance)}. The bot tops it up with a little SOL when you need fees or rent.`);
    },
  },

  balance: {
    usage: "",
    description: "Your SOL, tokens and stake in this DAO",
    async run(ctx) {
      const { network, d, model, governance, tok } = await loadDao(ctx);
      const me = await getSolanaAddress(ctx.userId, ctx.platform);
      if (!me) return reply(`You don't have a Solana wallet yet - run \`${ctx.cmd("wallet")}\` to create one.`);
      const lines = [`\`${me.toBase58()}\``, `SOL: ${sol(await network.connection.getBalance(me))}`];
      if (model === "decisionMarkets") {
        lines.push(`${tok.symbol} in your wallet: ${tok.fmt(await v.tokenBalance(network, governance.mint, me))}`, `Your pass/fail balances are per proposal: \`${ctx.cmd("proposal")} <id>\`.`);
      } else if (tok) {
        const voter = await v.readVoter(network, model, d.voter(me));
        lines.push(`${tok.symbol} in your wallet: ${tok.fmt(await v.tokenBalance(network, governance.mint, me))}`, `Staked here: ${tok.fmt(voter?.amount ?? 0)}`);
        const now = await v.clusterNow(network);
        const lockedUntil = num(voter?.lockedUntil ?? 0);
        if (lockedUntil > now) lines.push(`Locked for ${duration(lockedUntil - now)} more (until the votes you cast close)`);
        if (model === "conviction" && voter && !voter.supporting.equals(PublicKey.default)) {
          const p = await v.readProposal(network, model, voter.supporting);
          lines.push(`Backing proposal #${p?.id.toString() ?? "?"} with ${tok.fmt(voter.supportWeight)} (locked until you withdraw that support)`);
        }
        if (COUNCIL.includes(model)) lines.push(governance.council.some((m) => m.equals(me)) ? "You're on the council." : "You're not on the council.");
        if (model === "sortition") lines.push(voter?.eligible ? "You're in the pool for the next draw." : `You're not in the draw pool (\`${ctx.cmd("registereligible")}\`).`);
        if (model === "liquid" && voter) {
          if (!voter.delegate.equals(PublicKey.default)) {
            lines.push(`Your vote is delegated to \`${voter.delegate.toBase58()}\` (voting yourself overrides it).`);
            const held = num((await v.readVoter(network, model, d.voter(voter.delegate)))?.powerLockedUntil ?? 0);
            if (held > now) lines.push(`Your delegation and stake can't change for ${duration(held - now)} (a vote your delegate cast with it is open).`);
          }
          if (voter.delegators > 0) {
            lines.push(`${voter.delegators} member(s) delegate ${tok.fmt(voter.delegatedPower)} ${tok.symbol} to you; your votes carry it.`);
            const powerLocked = num(voter.powerLockedUntil);
            if (powerLocked > now) lines.push(`They can't change their delegation for ${duration(powerLocked - now)} (a vote of yours that counted it is open).`);
          }
        }
      } else {
        lines.push(governance.signers.some((s) => s.equals(me)) ? "You're a signer of this board." : "You're not a signer of this board.");
      }
      return reply(lines.join("\n"));
    },
  },

  stake: {
    usage: "<amount>",
    description: "Stake tokens to vote with them",
    models: STAKE,
    async run(ctx) {
      const { network, d, model, governance, tok } = await loadDao(ctx);
      requireModel(model, STAKE, "Staking");
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("stake")} <amount>\``);
      const raw = tok.parse(ctx.args[0]);
      const kp = await member(ctx, network);
      await v.deposit(network, model, kp, d, governance, raw);
      const extra =
        model === "conviction" ? `\nTo back a proposal with it, \`${ctx.cmd("support")} <id>\` (again, if you already back one).`
        : model === "sortition" ? `\nTo be in the next council draw, \`${ctx.cmd("registereligible")}\`.`
        : "";
      return reply(`✅ Staked ${tok.fmt(raw)} ${tok.symbol}.${extra}`);
    },
  },

  unstake: {
    usage: "<amount>",
    description: "Withdraw staked tokens",
    models: STAKE,
    async run(ctx) {
      const { network, d, model, governance, tok } = await loadDao(ctx);
      requireModel(model, STAKE, "Unstaking");
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("unstake")} <amount>\``);
      const raw = tok.parse(ctx.args[0]);
      const kp = await member(ctx, network);
      await v.withdraw(network, model, kp, d, governance, raw);
      return reply(`✅ Unstaked ${tok.fmt(raw)} ${tok.symbol}.`);
    },
  },

  migrate: {
    usage: "",
    description: "Move your stake from models this DAO ran before into the current one",
    async run(ctx) {
      const { network, d, model, governance, link } = await loadDao(ctx);
      const kp = await member(ctx, network, 200);
      const me = kp.publicKey;
      // Each model keeps the DAO's deposits in its own vault, found from the
      // DAO's address alone: look in every one the DAO isn't using now.
      const found = [];
      for (const old of v.STAKE_MODELS) {
        if (old === model || !network.programs[old]) continue;
        const od = v.addresses(network, d.dao, network.programs[old]);
        const voter = await v.readVoter(network, old, od.voter(me)).catch(() => null);
        if (voter && BigInt(voter.amount.toString()) > 0n) found.push({ old, od, voter, amount: BigInt(voter.amount.toString()) });
      }
      if (found.length === 0) return reply(`You have no stake left in models this DAO ran before - nothing to move.`);

      const target = v.STAKE_MODELS.includes(model) ? governance.mint : null;
      const lines = [];
      let moved = 0n;
      let mint = target;
      let decimals = target ? (await v.mintInfo(network, target)).decimals : null;
      for (const { old, od, voter, amount } of found) {
        const og = await v.readGovernance(network, old, od.governance);
        const label = MODEL_LABEL[old];
        const oldDecimals = (await v.mintInfo(network, og.mint)).decimals;
        const fmt = `${v.formatUnits(amount, oldDecimals)} ${link.symbol ?? "tokens"}`;
        if (mint && !og.mint.equals(mint)) {
          lines.push(`• ${label}: ${fmt} of another token (\`${og.mint.toBase58()}\`) - left there; the DAO changed its token since.`);
          continue;
        }
        try {
          // What would hold the stake there: support for an old Conviction
          // proposal, or a seat in an old Sortition draw pool.
          if (old === "conviction" && voter.supporting && !voter.supporting.equals(PublicKey.default)) await v.withdrawSupport(network, kp, od, voter.supporting);
          if (old === "sortition" && voter.eligible) await v.leavePool(network, kp, od);
          await v.withdraw(network, old, kp, od, og, amount);
          moved += amount;
          mint ??= og.mint;
          decimals ??= oldDecimals;
          lines.push(`• ${label}: took out ${fmt}.`);
        } catch (err) {
          lines.push(`• ${label}: ${fmt} stays there for now - ${err.message}`);
        }
      }
      if (moved > 0n && target) {
        await v.deposit(network, model, kp, d, governance, moved);
        lines.push("", `✅ Staked ${v.formatUnits(moved, decimals)} ${link.symbol ?? "tokens"} in ${MODEL_LABEL[model]}.`);
      } else if (moved > 0n) {
        lines.push("", `✅ ${v.formatUnits(moved, decimals)} ${link.symbol ?? "tokens"} are back in your wallet (${MODEL_LABEL[model]} has no staking).`);
      }
      return reply(lines.join("\n"));
    },
  },

  tip: {
    usage: "<amount> <address|treasury>",
    description: "Send the DAO's starting tokens (creator only)",
    models: TOKEN,
    async run(ctx) {
      const { network, d, model, governance, link, tok } = await loadDao(ctx);
      requireModel(model, TOKEN, "Tipping");
      if (!link.creatorPlatformUserId || link.creatorPlatformUserId !== String(ctx.userId)) fail("Only the person who created this DAO through the bot can tip its starting tokens.");
      const [amount, to] = ctx.args;
      if (!amount || !to) fail(`Usage: \`${ctx.cmd("tip")} <amount> <address|treasury>\``);
      const recipient = to.toLowerCase() === "treasury" ? d.treasury : parseKey(to, "the recipient");
      const raw = tok.parse(amount);
      await v.tipTokens(network, governance.mint, recipient, raw);
      return reply(`✅ Sent ${tok.fmt(raw)} ${tok.symbol} to \`${short(recipient)}\`.`);
    },
  },

  propose: {
    usage: "<recipient> <amount> <SOL|token> <description>",
    description: "Propose a payment from the treasury",
    async run(ctx) {
      const usage = `${ctx.cmd("propose")} <recipient> <amount> <SOL|token> <description>`;
      const [to, amount, asset, ...allWords] = ctx.args;
      if (!to || !amount || !asset || allWords.length === 0) fail(`Usage: \`${usage}\`\nExample: \`${ctx.cmd("propose")} 7Xf…k2 0.5 SOL Pay the designer\`\n\`token\` means this DAO's token; any token's mint address works too.`);
      const c = await loadDao(ctx);
      const { network, d, model, governance, tok } = c;
      const recipient = parseKey(to, "the recipient");
      const words = model === "sowellian" || model === "decisionMarkets" ? takeModelOptions(model, allWords).rest : allWords;
      const description = words.join(" ");
      if (!description) fail(`Usage: \`${usage}\`${optionsUsage(model)}`);
      if (Buffer.byteLength(description) > 200) fail("Keep the description to 200 characters.");

      let mint = null;
      let raw;
      let label;
      if (asset.toUpperCase() === "SOL") {
        raw = v.parseUnits(amount, 9);
        label = sol(raw);
      } else {
        const own = tok && (asset.toLowerCase() === "token" || asset.toUpperCase() === tok.symbol.toUpperCase());
        if (own) mint = governance.mint;
        else if (asset.toLowerCase() === "token") fail("A board DAO has no token of its own - give the token's mint address instead.");
        else mint = parseKey(asset, "the token's mint");
        const { decimals } = await v.mintInfo(network, mint);
        raw = v.parseUnits(amount, decimals);
        label = `${v.formatUnits(raw, decimals)} ${own ? tok.symbol : `of token ${short(mint)}`}`;
      }
      const { instructions, budget } = await v.paymentInstructions(network, d, { recipient, raw, mint });
      const kp = await member(ctx, network, proposalBytes(instructions, description));
      if (COUNCIL.includes(model)) requireCouncil(governance, kp);
      if (model === "board") requireSigner(governance, kp);
      const { opts, notes } = await proposalOptions(ctx, c, allWords, kp);
      const { id } = await v.propose(network, kp, d, model, instructions, description, { budget, ...opts });
      return proposalMade(ctx, c, id, [`✅ Proposal *#${id}*: pay ${label} to \`${short(recipient)}\``, `_${description}_`, ...notes, "", await nextStep(ctx, c, id)].join("\n"));
    },
  },

  proposals: {
    usage: "",
    description: "Recent proposals",
    async run(ctx) {
      const { network, d, model, governance } = await loadDao(ctx);
      const count = num(governance.proposalCount);
      if (count === 0) return reply(`No proposals yet. Make one with \`${ctx.cmd("propose")}\`.`);
      const now = await v.clusterNow(network);
      const lines = ["*Recent proposals*"];
      for (let id = count; id >= 1 && id > count - 10; id--) {
        const p = await v.readProposal(network, model, d.proposal(id));
        if (p) lines.push(`*#${id}* — ${v.proposalState(model, p, governance, now)} — ${p.metadataUri}`);
      }
      lines.push("", `Details: \`${ctx.cmd("proposal")} <id>\``);
      return reply(lines.join("\n"));
    },
  },

  proposal: {
    usage: "<id>",
    description: "One proposal's details and state",
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("proposal")} <id>`);
      const { link, network, d, model, governance: g, tok } = await loadDao(ctx);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      const now = await v.clusterNow(network);
      const state = v.proposalState(model, p, g, now);
      const lines = [`*Proposal #${id}* — ${state}`, `_${p.metadataUri}_`, "", `Does: ${describeProposal(network, p)}`, `Proposed by \`${short(p.proposer)}\``];
      if (p.core.epoch !== d.record.epoch) lines.push("⚠️ Made under an earlier governance setup - it can no longer run.");
      const q = ctx.cmd("queue");
      const me = await getSolanaAddress(ctx.userId, ctx.platform).catch(() => null);
      switch (model) {
        case "tokenWeighted":
        case "quadratic":
        case "liquid":
          lines.push(tallyLine(model, p.tally, tok));
          if (state === "Active") lines.push(`Voting closes in ${duration(num(p.votingEndsAt) - now)}`);
          if (state === "Succeeded") lines.push(`Passed - queue it: \`${q} ${id}\``);
          break;
        case "optimistic":
          if (!p.challenged) {
            if (state === "ChallengeWindow") lines.push(`Unchallenged so far. Challenge window closes in ${duration(num(p.challengeDeadline) - now)}: \`${ctx.cmd("challenge")} ${id}\` (bond ${tok.fmt(g.config.challengeBond)} ${tok.symbol}).`);
            if (state === "Succeeded") lines.push(`Passed unchallenged - queue it: \`${q} ${id}\``);
          } else {
            lines.push(`Challenged by \`${short(p.challenger)}\` (bond ${tok.fmt(p.challengeBond)} ${tok.symbol})`, tallyLine(model, p.tally, tok));
            if (state === "Active") lines.push(`Vote: \`${ctx.cmd("vote")} ${id} for|against|abstain\`, closes in ${duration(num(p.votingEndsAt) - now)}`);
            if ((state === "Succeeded" || state === "Defeated") && !p.bondResolved) lines.push(`Voting is over - settle it: \`${q} ${id}\``);
          }
          break;
        case "conviction": {
          const conviction = v.convictionAt(p, g.config.growthRate, now);
          lines.push(`Conviction: ${tok.fmt(conviction)} of ${tok.fmt(p.requiredConviction)} needed`, `Backed by ${tok.fmt(p.totalSupport)} staked ${tok.symbol}`);
          if (p.budget.length) {
            const parts = [];
            for (const b of p.budget) {
              if (b.mint.equals(v.SOL_ASSET)) parts.push(sol(b.amount));
              else parts.push(`${v.formatUnits(b.amount, (await v.mintInfo(network, b.mint)).decimals)} ${b.mint.equals(g.mint) ? tok.symbol : `of \`${short(b.mint)}\``}`);
            }
            lines.push(`Budget: at most ${parts.join(", ")}`);
          }
          if (p.weakensRules) lines.push("It changes the rules or control of the DAO, so it faces the bar of spending everything.");
          if (state === "Active") {
            if (conviction >= BigInt(p.requiredConviction.toString())) lines.push(`Enough conviction - queue it: \`${q} ${id}\``);
            else lines.push(`Back it: \`${ctx.cmd("support")} ${id}\``);
          }
          break;
        }
        case "delegate": {
          const t = v.councilTally(g, p);
          lines.push(`Council votes: For ${t.for} · Against ${t.against} · Abstain ${t.abstain} (needs ${g.config.councilQuorum} votes, ${pct(g.config.councilApprovalBps)} approval)`);
          if (state === "Active") lines.push(`Council members vote with \`${ctx.cmd("vote")} ${id} for|against|abstain\`; closes in ${duration(num(p.votingEndsAt) - now)}`);
          if (state === "Succeeded") lines.push(`Passed - queue it: \`${q} ${id}\``);
          break;
        }
        case "board":
          lines.push(`Confirmed by ${p.confirmations.length} of ${g.signers.length} (needs ${g.config.requiredApprovals})`);
          if (state === "Active") lines.push(`Signers confirm with \`${ctx.cmd("confirm")} ${id}\``);
          break;
        case "sortition": {
          const t = v.sortitionTally(p);
          lines.push(`Council votes: For ${t.for} · Against ${t.against} · Abstain ${t.abstain} (needs ${v.sortitionQuorum(g)} votes, ${pct(g.config.councilApprovalBps)} approval)`);
          if (state === "Active") lines.push(`Council members vote with \`${ctx.cmd("vote")} ${id} for|against|abstain\`; closes in ${duration(num(p.votingEndsAt) - now)}`);
          if (state === "Succeeded") lines.push(`Passed - queue it: \`${q} ${id}\``);
          break;
        }
        case "sowellian":
          lines.push(...(await sowellianLines(ctx, network, d, g, p, id, state, now, tok, me)));
          break;
        case "decisionMarkets":
          lines.push(...(await marketLines(ctx, network, d, g, p, id, state, now, tok, me)));
          break;
      }
      if (state === "Queued" && model === "sowellian") {
        const at = v.sowellianExecutableAt(p, g.config);
        lines.push(at > now ? `Positions are closed. It can run in ${duration(at - now)}: \`${ctx.cmd("execute")} ${id}\`` : `Ready to run: \`${ctx.cmd("execute")} ${id}\` (that starts its measurement period)`);
      } else if (state === "Queued") {
        const at = num(p.queuedAt) + g.config.timelock;
        lines.push(at > now ? `Can run in ${duration(at - now)}: \`${ctx.cmd("execute")} ${id}\`` : `Ready to run: \`${ctx.cmd("execute")} ${id}\``);
      }
      const page = proposalPageUrl(link.network, d.governance.toBase58(), id);
      const buttons = proposalButtons({ model, id, state, page, solana: true, track: model === "sowellian" ? v.variant(p.criteria.method) : undefined });
      const image = await solanaProposalImage({ network, networkId: link.network, model, governance: d.governance, id, p, g, now, state });
      if (!page) return reply(lines.join("\n"), { buttons, image });
      lines.push("", `📄 ${linkTo("Proposal page: details and live status", page)}`);
      // The proposer, before submitting details: their link again, privately.
      const args = { network: link.network, dao: d.governance.toBase58(), model, proposalId: id };
      const submit = await pendingSubmitLink({ ...args, platform: ctx.platform, userId: ctx.userId, walletAddress: await getSolanaAddress(ctx.userId, ctx.platform).catch(() => null), cmd: ctx.cmd }).catch(() => null);
      return submit ? { text: lines.join("\n"), privateFollowUp: submit, startPayload: proposalStartPayload(args.network, args.dao, id), buttons, image } : reply(lines.join("\n"), { buttons, image });
    },
  },

  vote: {
    usage: "<id> for|against|abstain",
    description: "Vote on a proposal",
    models: ["tokenWeighted", "quadratic", "optimistic", "delegate", "liquid", "sortition", "sowellian"],
    async run(ctx) {
      const usage = `${ctx.cmd("vote")} <id> for|against|abstain`;
      const id = parseId(ctx.args[0], usage);
      const word = (ctx.args[1] ?? "").toLowerCase();
      const c = await loadDao(ctx);
      const { network, d, model, governance, tok } = c;
      if (model === "board") fail(`Board DAOs don't vote - signers confirm: \`${ctx.cmd("confirm")} ${id}\`.`);
      if (model === "conviction") fail(`Conviction DAOs don't vote - back a proposal with \`${ctx.cmd("support")} ${id}\`.`);
      if (model === "decisionMarkets") fail(`Decision markets don't vote - trade on the outcome: \`${ctx.cmd("trade")} ${id} pass|fail buy|sell <amount>\`.`);
      if (model === "sowellian") {
        const p = await v.readProposal(network, model, d.proposal(id));
        if (!p) fail(`There's no proposal #${id}.`);
        if (v.variant(p.phase) === "adjudicating") return castSowellian(ctx, c, "adjudication", id, word);
        return castSowellian(ctx, c, "approval", id, word);
      }
      const choice = parseChoice(word, usage);
      const kp = await member(ctx, network);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (COUNCIL.includes(model)) {
        requireCouncil(governance, kp);
        if (p.votes.some((x) => x.member.equals(kp.publicKey))) fail(`You've already voted on #${id}.`);
        await v.vote(network, kp, d, model, id, choice);
        return reply(`✅ Voted *${choice}* on #${id} (one vote per council seat).`);
      }
      if (model === "optimistic" && !p.challenged) fail(`Optimistic proposals only take votes once challenged. To dispute #${id}: \`${ctx.cmd("challenge")} ${id}\`.`);
      const voter = await requireStake(ctx, network, d, model, kp);
      if (await network.connection.getAccountInfo(d.vote(d.proposal(id), kp.publicKey))) fail(`You've already voted on #${id}.`);
      await v.vote(network, kp, d, model, id, choice);
      if (model === "liquid") {
        const own = BigInt(voter.amount.toString());
        if (!voter.delegate.equals(PublicKey.default)) return reply(`✅ Voted *${choice}* on #${id} with your own ${tok.fmt(own)} staked, overriding your delegate \`${short(voter.delegate)}\` on this proposal. Your stake stays locked until voting closes.`);
        const delegated = BigInt(voter.delegatedPower.toString());
        const rec = await v.programFor(network, model).account.voteRecord.fetchNullable(d.vote(d.proposal(id), kp.publicKey));
        const carried = rec ? BigInt(rec.delegated.toString()) : 0n;
        const extra = delegated > 0n ? ` plus ${tok.fmt(carried)} delegated to you${carried < delegated ? ` (${tok.fmt(delegated - carried)} more is delegated, but came after this proposal opened or its owners voted themselves)` : ""}` : "";
        return reply(`✅ Voted *${choice}* on #${id} with ${tok.fmt(own)} staked${extra}. Your stake stays locked until voting closes.`);
      }
      const weight =
        model === "quadratic" ? `${votesText(BigInt(voter.amount.toString()) === 0n ? 0n : sqrt(BigInt(voter.amount.toString())), tok)} votes (√ of your ${tok.fmt(voter.amount)} staked)` : `${tok.fmt(voter.amount)} staked`;
      return reply(`✅ Voted *${choice}* on #${id} with ${weight}. Your stake stays locked until voting closes.`);
    },
  },

  castapprovalvote: {
    usage: "<id> for|against|abstain",
    description: "Vote on opening a proposal for positions",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("castapprovalvote")} <id> for|against|abstain`);
      const c = await loadDao(ctx);
      requireModel(c.model, "sowellian", "The approval vote");
      return castSowellian(ctx, c, "approval", id, (ctx.args[1] ?? "").toLowerCase());
    },
  },

  castadjudicationvote: {
    usage: "<id> success|failure",
    description: "Vote on the true outcome of a challenged resolution",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("castadjudicationvote")} <id> success|failure`);
      const c = await loadDao(ctx);
      requireModel(c.model, "sowellian", "Adjudication");
      return castSowellian(ctx, c, "adjudication", id, (ctx.args[1] ?? "").toLowerCase());
    },
  },

  challenge: {
    usage: "<id>",
    description: "Dispute a proposal, posting a bond and forcing a vote",
    models: ["optimistic"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("challenge")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "optimistic", "Challenging");
      const kp = await member(ctx, network);
      const bond = BigInt(g.config.challengeBond.toString());
      const held = await v.tokenBalance(network, g.mint, kp.publicKey);
      if (held < bond) fail(`A challenge posts a ${tok.fmt(bond)} ${tok.symbol} bond from your wallet (not your stake); you hold ${tok.fmt(held)}.`);
      await v.challenge(network, kp, d, g, id);
      return reply(
        `✅ Challenged #${id}, posting ${tok.fmt(bond)} ${tok.symbol}. A ${duration(g.config.votingPeriod)} vote is open: \`${ctx.cmd("vote")} ${id} for|against|abstain\`. If the proposal still passes, your bond goes to the treasury; if not, it comes back to you.`
      );
    },
  },

  support: {
    usage: "<id>",
    description: "Back a proposal with your whole stake",
    models: ["conviction"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("support")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "conviction", "Supporting");
      const kp = await member(ctx, network);
      const voter = await requireStake(ctx, network, d, model, kp);
      const proposal = d.proposal(id);
      if (!(await v.readProposal(network, model, proposal))) fail(`There's no proposal #${id}.`);
      if (voter.supporting.equals(proposal) && voter.supportWeight.toString() === voter.amount.toString()) fail(`You already back #${id} with your whole stake.`);
      await v.support(network, kp, d, id);
      const p = await v.readProposal(network, model, proposal);
      const now = await v.clusterNow(network);
      const [have, need, behind, rate] = [v.convictionAt(p, g.config.growthRate, now), BigInt(p.requiredConviction.toString()), BigInt(p.totalSupport.toString()), BigInt(g.config.growthRate.toString())];
      const outlook =
        behind < need
          ? `It needs ${tok.fmt(need - behind)} more ${tok.symbol} behind it to ever reach its bar of ${tok.fmt(need)}.`
          : `At this support it reaches its bar of ${tok.fmt(need)} in about ${duration(Number((need - have + rate - 1n) / rate))}; then \`${ctx.cmd("queue")} ${id}\`.`;
      return reply(`✅ Backing #${id} with ${tok.fmt(voter.amount)} ${tok.symbol} (locked until you withdraw your support). ${outlook}`);
    },
  },

  withdrawsupport: {
    usage: "",
    description: "Stop backing your current proposal",
    models: ["conviction"],
    async run(ctx) {
      const { network, d, model } = await loadDao(ctx);
      requireModel(model, "conviction", "Withdrawing support");
      const kp = await member(ctx, network);
      const voter = await v.readVoter(network, model, d.voter(kp.publicKey));
      if (!voter || voter.supporting.equals(PublicKey.default)) fail("You're not backing any proposal.");
      await v.withdrawSupport(network, kp, d, voter.supporting);
      return reply("✅ Support withdrawn. Your stake is unlocked.");
    },
  },

  mysupport: {
    usage: "",
    description: "Which proposal you're backing",
    models: ["conviction"],
    async run(ctx) {
      const { network, d, model, tok } = await loadDao(ctx);
      requireModel(model, "conviction", "Support");
      const me = await getSolanaAddress(ctx.userId, ctx.platform);
      const voter = me ? await v.readVoter(network, model, d.voter(me)) : null;
      if (!voter || voter.supporting.equals(PublicKey.default)) return reply("You're not backing any proposal.");
      const p = await v.readProposal(network, model, voter.supporting);
      return reply(`You're backing proposal #${p?.id.toString() ?? "?"} with ${tok.fmt(voter.supportWeight)} ${tok.symbol}.`);
    },
  },

  assets: {
    usage: "",
    description: "Protected assets and their weights",
    models: ["conviction"],
    async run(ctx) {
      const { network, d, model, governance, tok } = await loadDao(ctx);
      requireModel(model, "conviction", "The asset list");
      const lines = await assetLines(network, d, governance, tok, await v.clusterNow(network));
      lines.push("", `Add one with \`${ctx.cmd("proposeaction")} addasset <mint> <weight> <description>\`.`);
      return reply(lines.join("\n"));
    },
  },

  confirm: {
    usage: "<id>",
    description: "Confirm a proposal (signers)",
    models: ["board"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("confirm")} <id>`);
      const { network, d, model, governance } = await loadDao(ctx);
      requireModel(model, "board", "Confirming");
      const kp = await member(ctx, network);
      requireSigner(governance, kp);
      await v.confirm(network, kp, d, id);
      const p = await v.readProposal(network, model, d.proposal(id));
      const queued = num(p.queuedAt) !== 0;
      return reply(`✅ Confirmed #${id} (${p.confirmations.length} of ${governance.config.requiredApprovals} needed).${queued ? ` It's queued and can run after the ${duration(governance.config.timelock)} timelock.` : ""}`);
    },
  },

  revoke: {
    usage: "<id>",
    description: "Withdraw your confirmation (signers)",
    models: ["board"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("revoke")} <id>`);
      const { network, d, model } = await loadDao(ctx);
      requireModel(model, "board", "Revoking");
      const kp = await member(ctx, network);
      await v.revoke(network, kp, d, id);
      return reply(`✅ Withdrew your confirmation of #${id}.`);
    },
  },

  queue: {
    usage: "<id>",
    description: "Queue a passed proposal (optimistic: settle it)",
    models: ["tokenWeighted", "quadratic", "optimistic", "conviction", "delegate", "liquid", "sortition", "sowellian", "decisionMarkets"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("queue")} <id>`);
      const c = await loadDao(ctx);
      const { network, d, model, governance: g, tok } = c;
      if (model === "board") fail("Board proposals queue themselves once enough signers confirm.");
      if (model === "sowellian") return settleSowellian(ctx, c, id);
      if (model === "decisionMarkets") return finalizeMarkets(ctx, c, id);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (model === "conviction" && num(p.queuedAt) === 0 && !p.executed && !p.cancelled) {
        const have = v.convictionAt(p, g.config.growthRate, await v.clusterNow(network));
        if (have < BigInt(p.requiredConviction.toString())) fail(`Not enough conviction yet: ${tok.fmt(have)} of ${tok.fmt(p.requiredConviction)}. \`${ctx.cmd("proposal")} ${id}\` shows how it's going.`);
      }
      await v.queue(network, d, model, id);
      const after = await v.readProposal(network, model, d.proposal(id));
      if (num(after.queuedAt) === 0) return reply(`The challenge vote on #${id} failed: the proposal is defeated and the bond went back to the challenger.`);
      const bond = model === "optimistic" && p.challenged ? " The challenge failed, so the bond went to the treasury." : "";
      return reply(`✅ Queued #${id}.${bond} It can run in ${duration(g.config.timelock)}: \`${ctx.cmd("execute")} ${id}\``);
    },
  },

  execute: {
    usage: "<id>",
    description: "Run a queued proposal through the treasury",
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("execute")} <id>`);
      const { network, d, model } = await loadDao(ctx);
      await v.execute(network, d, model, id);
      return reply(`✅ Proposal #${id} executed - the treasury has done what it said.`);
    },
  },

  cancel: {
    usage: "<id>",
    description: "Cancel your own proposal",
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("cancel")} <id>`);
      const { network, d, model, governance } = await loadDao(ctx);
      const kp = await member(ctx, network);
      await v.cancel(network, kp, d, model, id);
      if (model === "optimistic") {
        const p = await v.readProposal(network, model, d.proposal(id));
        if (p.challenged && !p.bondResolved) {
          await v.reclaimBond(network, d, governance, id, p.challenger);
          return reply(`✅ Cancelled #${id}, and returned the challenger's bond.`);
        }
      }
      const after =
        model === "conviction" ? " Its supporters can now withdraw their support."
        : model === "sowellian" ? ` Positions are refunded with \`${ctx.cmd("claimposition")} ${id}\`, and the proposer's bond too.`
        : model === "decisionMarkets" ? ` It settles as failed: fail balances redeem 1:1 (\`${ctx.cmd("redeem")} ${id}\`), and the proposer can \`${ctx.cmd("reclaimliquidity")} ${id}\`.`
        : "";
      return reply(`✅ Cancelled #${id}.${after}`);
    },
  },

  // ---- delegate: council, elections, recalls ----

  council: {
    usage: "",
    description: "The council, its term, and any election or draw",
    models: ["delegate", "sortition"],
    async run(ctx) {
      const c = await loadDao(ctx);
      const { network, d, model, governance: g, tok } = c;
      requireModel(model, COUNCIL, "The council");
      const now = await v.clusterNow(network);
      if (model === "sortition") {
        const lines = await rulesLines(ctx, c, now);
        const pool = await v.readPool(network, d);
        if (pool?.members.length) lines.push("", `Draw pool (${pool.members.length}):`, ...pool.members.slice(0, 30).map((m) => `• \`${m.toBase58()}\``));
        else lines.push("", `The draw pool is empty - stake and \`${ctx.cmd("registereligible")}\`.`);
        return reply(lines.join("\n"));
      }
      const ends = num(g.termEndsAt);
      const lines = [`*Council* (${g.council.length} of ${g.config.councilSize} seats)`, ...g.council.map((m) => `• \`${m.toBase58()}\``), ""];
      lines.push(ends > now ? `Term ends in ${duration(ends - now)}.` : "The term is over.");
      const count = num(g.electionCount);
      if (count > 0) {
        const e = await v.readElection(network, d.election(count));
        lines.push("", ...electionLines(ctx, e, now, tok));
      }
      if (!g.electionOpen && ends <= now) lines.push("", `Anyone can open an election: \`${ctx.cmd("startelection")}\``);
      return reply(lines.join("\n"));
    },
  },

  startelection: {
    usage: "",
    description: "Open a council election (once the term is over)",
    models: ["delegate"],
    async run(ctx) {
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "delegate", "Elections");
      if (g.electionOpen) fail(`An election is already open: \`${ctx.cmd("council")}\`.`);
      const now = await v.clusterNow(network);
      if (num(g.termEndsAt) > now) fail(`The council's term ends in ${duration(num(g.termEndsAt) - now)}; an election can start then.`);
      const id = await v.startElection(network, d);
      return reply(
        `✅ Election #${id} is open. Stand with \`${ctx.cmd("declarecandidacy")} ${id}\` within ${duration(g.config.candidacyPeriod)} (you need tokens staked); then voting runs ${duration(g.config.electionVotingPeriod)}: \`${ctx.cmd("voteinelection")} ${id} <candidate...>\`.`
      );
    },
  },

  declarecandidacy: {
    usage: "[electionId]",
    description: "Stand in the open election",
    models: ["delegate"],
    async run(ctx) {
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "delegate", "Elections");
      const id = ctx.args[0] ? parseId(ctx.args[0], `${ctx.cmd("declarecandidacy")} [electionId]`) : num(g.electionCount);
      if (id === 0) fail(`No election has been started. \`${ctx.cmd("startelection")}\` opens one once the term is over.`);
      const kp = await member(ctx, network);
      if (!(await v.readVoter(network, model, d.voter(kp.publicKey)))) fail(`Stake some tokens first: \`${ctx.cmd("stake")} <amount>\`.`);
      await v.declareCandidacy(network, kp, d, id);
      return reply(`✅ You're standing in election #${id} as \`${kp.publicKey.toBase58()}\`. Your stake stays locked until voting ends.`);
    },
  },

  voteinelection: {
    usage: "<electionId> <candidate...>",
    description: "Vote for council candidates",
    models: ["delegate"],
    async run(ctx) {
      const usage = `${ctx.cmd("voteinelection")} <electionId> <candidate...>`;
      const id = parseId(ctx.args[0], usage);
      const candidates = ctx.args.slice(1).map((a) => parseKey(a, "a candidate"));
      if (candidates.length === 0) fail(`Usage: \`${usage}\``);
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "delegate", "Elections");
      if (candidates.length > g.config.councilSize) fail(`You can vote for at most ${g.config.councilSize} candidates (the council's size).`);
      if (new Set(candidates.map((c) => c.toBase58())).size !== candidates.length) fail("You named the same candidate twice.");
      const e = await v.readElection(network, d.election(id));
      if (!e) fail(`There's no election #${id}.`);
      const unknown = candidates.find((c) => !e.candidates.some((x) => x.key.equals(c)));
      if (unknown) fail(`\`${unknown.toBase58()}\` isn't standing in election #${id}. \`${ctx.cmd("council")}\` lists the candidates.`);
      const kp = await member(ctx, network);
      await requireStake(ctx, network, d, model, kp);
      if (await network.connection.getAccountInfo(d.ballot(d.election(id), kp.publicKey))) fail(`You've already voted in election #${id}.`);
      await v.voteInElection(network, kp, d, id, candidates);
      return reply(`✅ Voted for ${candidates.length} candidate(s) in election #${id}; each gets your whole stake. It stays locked until voting ends.`);
    },
  },

  finalizeelection: {
    usage: "[electionId]",
    description: "Close the election and seat the winners",
    models: ["delegate"],
    async run(ctx) {
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "delegate", "Elections");
      const id = ctx.args[0] ? parseId(ctx.args[0], `${ctx.cmd("finalizeelection")} [electionId]`) : num(g.electionCount);
      if (id === 0) fail("No election has been started.");
      await v.finalizeElection(network, d, id);
      const after = await v.readGovernance(network, model, d.governance);
      if (after.councilTerm === g.councilTerm) return reply(`Election #${id} closed with no votes, so the council stays. A new election can start right away.`);
      return reply([`✅ Election #${id} closed. The new council:`, ...after.council.map((m) => `• \`${m.toBase58()}\``), "", "Proposals from the previous council can no longer run."].join("\n"));
    },
  },

  initiaterecall: {
    usage: "<councilMember>",
    description: "Start a vote to remove a council member",
    models: ["delegate"],
    async run(ctx) {
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("initiaterecall")} <councilMember>\``);
      const target = parseKey(ctx.args[0], "the council member");
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "delegate", "Recalls");
      if (!g.council.some((m) => m.equals(target))) fail("They're not on the council.");
      const kp = await member(ctx, network);
      if (!(await v.readVoter(network, model, d.voter(kp.publicKey)))) fail(`Stake some tokens first: \`${ctx.cmd("stake")} <amount>\`.`);
      const id = await v.initiateRecall(network, kp, d, target);
      return reply(
        `✅ Recall #${id} of \`${short(target)}\` is open for ${duration(g.config.recallVotingPeriod)}: \`${ctx.cmd("voterecall")} ${id} for|against|abstain\` (${pct(g.config.recallQuorumBps)} quorum, ${pct(g.config.recallApprovalBps)} approval). Then \`${ctx.cmd("finalizerecall")} ${id}\`.`
      );
    },
  },

  voterecall: {
    usage: "<recallId> for|against|abstain",
    description: "Vote on a recall",
    models: ["delegate"],
    async run(ctx) {
      const usage = `${ctx.cmd("voterecall")} <recallId> for|against|abstain`;
      const id = parseId(ctx.args[0], usage);
      const choice = parseChoice(ctx.args[1], usage);
      const { network, d, model } = await loadDao(ctx);
      requireModel(model, "delegate", "Recalls");
      const kp = await member(ctx, network);
      await requireStake(ctx, network, d, model, kp);
      if (await network.connection.getAccountInfo(d.recallVote(d.recall(id), kp.publicKey))) fail(`You've already voted on recall #${id}.`);
      await v.voteRecall(network, kp, d, id, choice);
      return reply(`✅ Voted *${choice}* on recall #${id}. Your stake stays locked until it closes.`);
    },
  },

  finalizerecall: {
    usage: "<recallId>",
    description: "Close a recall vote",
    models: ["delegate"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("finalizerecall")} <recallId>`);
      const { network, d, model } = await loadDao(ctx);
      requireModel(model, "delegate", "Recalls");
      await v.finalizeRecall(network, d, id);
      const r = await v.readRecall(network, d.recall(id));
      return reply(r.removed ? `✅ Recall #${id} passed: \`${short(r.member)}\` is off the council; the seat stays empty until the next election.` : `Recall #${id} closed without removing \`${short(r.member)}\`.`);
    },
  },

  // ---- liquid: delegation ----

  delegate: {
    usage: "<address>",
    description: "Hand your stake's vote to another member",
    models: ["liquid"],
    async run(ctx) {
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("delegate")} <address>\` - their votes then carry your stake; voting yourself overrides them.`);
      const to = parseKey(ctx.args[0], "the delegate");
      const { network, d, model, tok } = await loadDao(ctx);
      requireModel(model, "liquid", "Delegating");
      const kp = await member(ctx, network, 200);
      if (to.equals(kp.publicKey)) fail("You can't delegate to yourself.");
      const voter = await requireStake(ctx, network, d, model, kp);
      if (!voter.delegate.equals(PublicKey.default)) fail(`You already delegate to \`${short(voter.delegate)}\`. \`${ctx.cmd("undelegate")}\` first.`);
      if (voter.delegators > 0) fail("Members delegate to you, so you can't delegate yourself (one hop only).");
      const now = await v.clusterNow(network);
      if (num(voter.lockedUntil) > now) fail(`A vote you cast is still open, so you can delegate in ${duration(num(voter.lockedUntil) - now)}.`);
      const target = await v.readVoter(network, model, d.voter(to));
      if (target && !target.delegate.equals(PublicKey.default)) fail(`\`${short(to)}\` has delegated their own vote, so they can't take yours (one hop only).`);
      await v.delegateTo(network, kp, d, to);
      return reply(`✅ Your ${tok.fmt(voter.amount)} ${tok.symbol} now votes with \`${short(to)}\` on proposals they vote on from now. Vote yourself any time to override them; \`${ctx.cmd("undelegate")}\` takes it back.`);
    },
  },

  undelegate: {
    usage: "",
    description: "Take your vote back from your delegate",
    models: ["liquid"],
    async run(ctx) {
      const { network, d, model } = await loadDao(ctx);
      requireModel(model, "liquid", "Delegating");
      const kp = await member(ctx, network);
      const voter = await v.readVoter(network, model, d.voter(kp.publicKey));
      if (!voter || voter.delegate.equals(PublicKey.default)) fail("You haven't delegated.");
      const now = await v.clusterNow(network);
      if (num(voter.lockedUntil) > now) fail(`A vote you cast yourself is still open, so your delegation holds for ${duration(num(voter.lockedUntil) - now)} more.`);
      const delegate = await v.readVoter(network, model, d.voter(voter.delegate));
      const held = num(delegate?.powerLockedUntil ?? 0);
      if (held > now) fail(`A vote your delegate cast with your stake is still open, so your delegation holds for ${duration(held - now)} more. You can still vote yourself to override it.`);
      await v.undelegate(network, kp, d, voter.delegate);
      return reply(`✅ You no longer delegate to \`${short(voter.delegate)}\`; your stake votes only when you do.`);
    },
  },

  // ---- sortition: the pool and draws ----

  registereligible: {
    usage: "",
    description: "Join the pool the next council is drawn from",
    models: ["sortition"],
    async run(ctx) {
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "sortition", "The draw pool");
      const kp = await member(ctx, network);
      const voter = await v.readVoter(network, model, d.voter(kp.publicKey));
      const need = BigInt(g.config.eligibilityThreshold.toString());
      if (!voter) fail(`Stake some tokens first: \`${ctx.cmd("stake")} <amount>\`${need > 0n ? ` (at least ${tok.fmt(need)})` : ""}.`);
      if (voter.eligible) fail("You're already in the pool.");
      if (BigInt(voter.amount.toString()) < need) fail(`Joining takes at least ${tok.fmt(need)} ${tok.symbol} staked; you have ${tok.fmt(voter.amount)}.`);
      if (g.drawOpen) fail(`A draw is under way, so the pool is frozen until \`${ctx.cmd("finalizesortition")}\`.`);
      await v.joinPool(network, kp, d);
      const pool = await v.readPool(network, d);
      return reply(`✅ You're in the pool for the next council draw (${pool.members.length} member(s)). Your stake stays locked while you're in it.`);
    },
  },

  withdraweligibility: {
    usage: "",
    description: "Leave the draw pool",
    models: ["sortition"],
    async run(ctx) {
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "sortition", "The draw pool");
      const kp = await member(ctx, network);
      const voter = await v.readVoter(network, model, d.voter(kp.publicKey));
      if (!voter?.eligible) fail("You're not in the pool.");
      if (g.drawOpen) fail(`A draw is under way, so the pool is frozen until \`${ctx.cmd("finalizesortition")}\`.`);
      await v.leavePool(network, kp, d);
      return reply("✅ You've left the draw pool. A council seat you already hold is kept until the term ends.");
    },
  },

  startsortition: {
    usage: "",
    description: "Start the next council draw (once the term is over)",
    models: ["sortition"],
    async run(ctx) {
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "sortition", "Draws");
      const now = await v.clusterNow(network);
      if (num(g.termEndsAt) > now) fail(`The council's term ends in ${duration(num(g.termEndsAt) - now)}; a draw can start then.`);
      const pool = await v.readPool(network, d);
      if (!pool?.members.length) fail(`Nobody is in the draw pool yet - members join with \`${ctx.cmd("registereligible")}\`.`);
      if (g.drawOpen) {
        const status = await v.drawStatus(network, g);
        if (status === "fulfilled") fail(`The randomness for this draw has arrived: \`${ctx.cmd("finalizesortition")}\`.`);
        const retry = num(g.drawStartedAt) + g.config.randomnessTimeout;
        if (now < retry) fail(`A draw is waiting for its randomness. \`${ctx.cmd("finalizesortition")}\` once it arrives; if it never does, a new draw can start in ${duration(retry - now)}.`);
      }
      const { number, restart } = await v.startDraw(network, d);
      return reply(`✅ Draw #${number}${restart ? " restarted with a new randomness request" : " started"}: ${Math.min(g.config.councilSize, pool.members.length)} seat(s) from ${pool.members.length} member(s). ORAO's randomness usually arrives within seconds - then \`${ctx.cmd("finalizesortition")}\` (anyone).`);
    },
  },

  finalizesortition: {
    usage: "",
    description: "Seat the council once the draw's randomness arrives",
    models: ["sortition"],
    async run(ctx) {
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "sortition", "Draws");
      if (!g.drawOpen) fail(`No draw is under way. \`${ctx.cmd("startsortition")}\` starts one once the term is over.`);
      const status = await v.drawStatus(network, g);
      if (status !== "fulfilled") fail(`The randomness hasn't arrived yet - try again in a few seconds.${status === "missing" ? " (Its request account can't be found.)" : ""}`);
      await v.finalizeDraw(network, d);
      const after = await v.readGovernance(network, model, d.governance);
      return reply([`✅ Draw #${after.drawCount.toString()} is done. The new council:`, ...after.council.map((m) => `• \`${m.toBase58()}\``), "", `Its term ends in ${duration(num(after.termEndsAt) - (await v.clusterNow(network)))}. Proposals from the previous council can no longer run.`].join("\n"));
    },
  },

  // ---- sowellian: approval, positions, resolution ----

  finalizeapproval: {
    usage: "<id>",
    description: "Close the approval vote (opens positions if it passed)",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("finalizeapproval")} <id>`);
      const c = await loadDao(ctx);
      requireModel(c.model, "sowellian", "The approval vote");
      return settleSowellian(ctx, c, id, "approvalVoting");
    },
  },

  takeposition: {
    usage: "<id> yes|no <amount>",
    description: "Back whether it will work, with tokens from your wallet",
    models: ["sowellian"],
    async run(ctx) {
      const usage = `${ctx.cmd("takeposition")} <id> yes|no <amount>`;
      const id = parseId(ctx.args[0], usage);
      const side = (ctx.args[1] ?? "").toLowerCase();
      if (!["yes", "no"].includes(side) || !ctx.args[2]) fail(`Usage: \`${usage}\` - yes: it will meet its goal; no: it won't. Winners split the whole pot.`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "sowellian", "Positions");
      const raw = tok.parse(ctx.args[2]);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (v.variant(p.phase) !== "positionsOpen" || (await v.clusterNow(network)) >= num(p.positionsDeadline)) fail(`#${id} isn't taking positions. \`${ctx.cmd("proposal")} ${id}\` shows where it is.`);
      const kp = await member(ctx, network, 120);
      const held = await v.tokenBalance(network, g.mint, kp.publicKey);
      if (held < raw) fail(`You hold ${tok.fmt(held)} ${tok.symbol} in your wallet (staked tokens don't count).`);
      await v.takePosition(network, kp, d, g, id, side, raw);
      const after = await v.readProposal(network, model, d.proposal(id));
      return reply(`✅ Backed *${side.toUpperCase()}* on #${id} with ${tok.fmt(raw)} ${tok.symbol}. The pot: YES ${tok.fmt(after.yesPool)} · NO ${tok.fmt(after.noPool)}. Positions can grow but not shrink.`);
    },
  },

  resolveviaoracle: {
    usage: "<id> [priceAccount]",
    description: "Settle an oracle-track proposal from Pyth",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("resolveviaoracle")} <id> [priceAccount]`);
      const account = ctx.args[1] ? parseKey(ctx.args[1], "the Pyth price update account") : undefined;
      const { network, d, model, governance: g } = await loadDao(ctx);
      requireModel(model, "sowellian", "Oracle resolution");
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (v.variant(p.criteria.method) !== "oracle") fail(`#${id} is resolved by people: \`${ctx.cmd("proposeresolution")} ${id} success|failure\`.`);
      const now = await v.clusterNow(network);
      if (v.variant(p.phase) !== "executed") fail(`#${id} isn't waiting for a result (${v.sowellianState(p, g.config, now)}).`);
      if (now < num(p.measurementDeadline)) fail(`#${id} is measured in ${duration(num(p.measurementDeadline) - now)}.`);
      const priceAccount = account ?? v.pythFeedAccount(p.criteria.feedId);
      if (!(await network.connection.getAccountInfo(priceAccount))) fail(`There's no Pyth price account at \`${priceAccount.toBase58()}\` on ${network.name}. Pass a PriceUpdateV2 account for this feed: \`${ctx.cmd("resolveviaoracle")} ${id} <account>\`.`);
      await v.resolveViaOracle(network, d, id, priceAccount);
      const after = await v.readProposal(network, model, d.proposal(id));
      return reply(`✅ #${id} is resolved from Pyth: *${v.variant(after.finalOutcome)}*. Collect what you're owed with \`${ctx.cmd("claimposition")} ${id}\`.`);
    },
  },

  proposeresolution: {
    usage: "<id> success|failure",
    description: "State the outcome of a human-track proposal (posts a bond)",
    models: ["sowellian"],
    async run(ctx) {
      const usage = `${ctx.cmd("proposeresolution")} <id> success|failure`;
      const id = parseId(ctx.args[0], usage);
      const outcome = (ctx.args[1] ?? "").toLowerCase();
      if (!OUTCOMES.includes(outcome)) fail(`Usage: \`${usage}\``);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "sowellian", "Resolution");
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (v.variant(p.criteria.method) !== "human") fail(`#${id} is resolved by its oracle: \`${ctx.cmd("resolveviaoracle")} ${id}\`.`);
      const now = await v.clusterNow(network);
      if (v.variant(p.phase) !== "executed" || now < num(p.measurementDeadline)) fail(`#${id} isn't waiting for a result (${v.sowellianState(p, g.config, now)}).`);
      const kp = await member(ctx, network);
      const bond = BigInt(g.config.resolutionBond.toString());
      const held = await v.tokenBalance(network, g.mint, kp.publicKey);
      if (held < bond) fail(`Stating the outcome posts a ${tok.fmt(bond)} ${tok.symbol} bond from your wallet; you hold ${tok.fmt(held)}.`);
      await v.proposeResolution(network, kp, d, g, id, outcome);
      return reply(`✅ You said #${id} was a *${outcome}*, posting ${tok.fmt(bond)} ${tok.symbol}. Anyone can challenge it for ${duration(g.config.challengePeriod)} (\`${ctx.cmd("challengeresolution")} ${id}\`); if nobody does, \`${ctx.cmd("finalizeunchallenged")} ${id}\` and your bond comes back.`);
    },
  },

  challengeresolution: {
    usage: "<id>",
    description: "Dispute a proposed resolution (posts a bond, opens a vote)",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("challengeresolution")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "sowellian", "Challenging a resolution");
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (v.variant(p.phase) !== "resolutionProposed") fail(`#${id} has no proposed resolution to challenge.`);
      const kp = await member(ctx, network);
      const bond = BigInt(g.config.challengeBond.toString());
      const held = await v.tokenBalance(network, g.mint, kp.publicKey);
      if (held < bond) fail(`A challenge posts a ${tok.fmt(bond)} ${tok.symbol} bond from your wallet; you hold ${tok.fmt(held)}.`);
      await v.challengeResolution(network, kp, d, g, id);
      return reply(`✅ Challenged the resolution of #${id}, posting ${tok.fmt(bond)} ${tok.symbol}. A ${duration(g.config.adjudicationVotingPeriod)} vote decides the true outcome: \`${ctx.cmd("vote")} ${id} success|failure\`. Whoever was wrong loses their bond to the treasury.`);
    },
  },

  finalizeunchallenged: {
    usage: "<id>",
    description: "Lock in a resolution nobody challenged",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("finalizeunchallenged")} <id>`);
      const c = await loadDao(ctx);
      requireModel(c.model, "sowellian", "Resolution");
      return settleSowellian(ctx, c, id, "resolutionProposed");
    },
  },

  finalizeadjudication: {
    usage: "<id>",
    description: "Close the adjudication vote and settle the bonds",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("finalizeadjudication")} <id>`);
      const c = await loadDao(ctx);
      requireModel(c.model, "sowellian", "Adjudication");
      return settleSowellian(ctx, c, id, "adjudicating");
    },
  },

  claimposition: {
    usage: "<id>",
    description: "Collect your winnings, refund or bonds",
    models: ["sowellian"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("claimposition")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "sowellian", "Claiming");
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      const kp = await member(ctx, network);
      const me = kp.publicKey;
      const done = [];
      const phase = v.variant(p.phase);
      const pos = await v.readPosition(network, model, d.position(d.proposal(id), me));
      if (pos && !pos.claimed && (phase === "finalized" || phase === "cancelled")) {
        const winning = phase === "cancelled" ? BigInt(pos.yes.toString()) + BigInt(pos.no.toString()) : BigInt((v.variant(p.finalOutcome) === "success" ? pos.yes : pos.no).toString());
        if (winning > 0n) {
          const before = await v.tokenBalance(network, g.mint, me);
          await v.claimPosition(network, kp, d, g, id);
          done.push(`${phase === "cancelled" ? "your refund" : "your winnings"}: ${tok.fmt((await v.tokenBalance(network, g.mint, me)) - before)} ${tok.symbol}`);
        }
      }
      const owed = (who, amount) => who.equals(me) && BigInt(amount.toString()) > 0n;
      if (owed(p.proposer, p.owedProposer) || owed(p.resolver, p.owedResolver) || owed(p.challenger, p.owedChallenger)) {
        const before = await v.tokenBalance(network, g.mint, me);
        await v.claimBond(network, kp, d, g, id);
        done.push(`your bond: ${tok.fmt((await v.tokenBalance(network, g.mint, me)) - before)} ${tok.symbol}`);
      }
      if (!done.length) fail(phase === "finalized" || phase === "cancelled" ? `There's nothing for you to collect on #${id}.` : `#${id} isn't settled yet. \`${ctx.cmd("proposal")} ${id}\` shows what's next.`);
      return reply(`✅ Collected ${done.join(" and ")}.`);
    },
  },

  // ---- decision markets ----

  split: {
    usage: "<id> base|quote <amount>",
    description: "Turn tokens (or SOL) into equal pass and fail balances to trade",
    models: ["decisionMarkets"],
    async run(ctx) {
      const usage = `${ctx.cmd("split")} <id> base|quote <amount>`;
      const id = parseId(ctx.args[0], usage);
      const side = (ctx.args[1] ?? "").toLowerCase();
      if (!["base", "quote"].includes(side) || !ctx.args[2]) fail(`Usage: \`${usage}\` - base: this DAO's token; quote: SOL (or the DAO's quote token).`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "decisionMarkets", "Splitting");
      const q = await quoteToken(network, g);
      const raw = side === "base" ? tok.parse(ctx.args[2]) : q.parse(ctx.args[2]);
      const kp = await member(ctx, network, 165 + 200);
      if (side === "base") {
        const held = await v.tokenBalance(network, g.mint, kp.publicKey);
        if (held < raw) fail(`You hold ${tok.fmt(held)} ${tok.symbol}.`);
      } else await requireQuote(network, g, kp, raw, q.decimals);
      await v.split(network, kp, d, g, id, side === "base" ? raw : 0n, side === "quote" ? raw : 0n);
      const pos = await v.readPosition(network, model, d.position(d.proposal(id), kp.publicKey));
      return reply([`✅ Split ${side === "base" ? `${tok.fmt(raw)} ${tok.symbol}` : q.fmt(raw)} into pass and fail balances.`, ...positionLines(pos, tok, q.fmt), `Trade: \`${ctx.cmd("trade")} ${id} pass|fail buy|sell <amount>\``].join("\n"));
    },
  },

  merge: {
    usage: "<id> base|quote <amount>",
    description: "Turn pass+fail pairs back into tokens (or SOL), while trading lasts",
    models: ["decisionMarkets"],
    async run(ctx) {
      const usage = `${ctx.cmd("merge")} <id> base|quote <amount>`;
      const id = parseId(ctx.args[0], usage);
      const side = (ctx.args[1] ?? "").toLowerCase();
      if (!["base", "quote"].includes(side) || !ctx.args[2]) fail(`Usage: \`${usage}\``);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "decisionMarkets", "Merging");
      const q = await quoteToken(network, g);
      const raw = side === "base" ? tok.parse(ctx.args[2]) : q.parse(ctx.args[2]);
      const kp = await member(ctx, network, 165);
      await v.merge(network, kp, d, g, id, side === "base" ? raw : 0n, side === "quote" ? raw : 0n);
      return reply(`✅ Merged ${side === "base" ? `${tok.fmt(raw)} ${tok.symbol}` : q.fmt(raw)} of pass and fail back into your wallet.`);
    },
  },

  trade: {
    usage: "<id> pass|fail buy|sell <amount> [slippage%|minOut]",
    description: "Buy or sell the DAO's token in the pass or fail market",
    models: ["decisionMarkets"],
    async run(ctx) {
      const usage = `${ctx.cmd("trade")} <id> pass|fail buy|sell <amount> [slippage%|minOut]`;
      const id = parseId(ctx.args[0], usage);
      const market = (ctx.args[1] ?? "").toLowerCase();
      // The EVM side's words work too: spending quote buys, spending base sells.
      const dir = { base: "sell", quote: "buy" }[(ctx.args[2] ?? "").toLowerCase()] ?? (ctx.args[2] ?? "").toLowerCase();
      if (!["pass", "fail"].includes(market) || !["buy", "sell"].includes(dir) || !ctx.args[3]) {
        fail(`Usage: \`${usage}\`\nbuy spends that market's SOL balance on the DAO's token; sell sells that many tokens for SOL. The last word is a slippage limit like 2% (default 1%) or the least you'll accept back.`);
      }
      const limit = ctx.args[4] ?? "1%";
      const slip = String(limit).endsWith("%") ? Number(String(limit).slice(0, -1)) : null;
      if (slip !== null && !(slip >= 0 && slip <= 50)) fail("Slippage must be between 0% and 50%.");
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "decisionMarkets", "Trading");
      const q = await quoteToken(network, g);
      const raw = dir === "buy" ? q.parse(ctx.args[3]) : tok.parse(ctx.args[3]);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (p.finalized || (await v.clusterNow(network)) >= num(p.tradingDeadline)) fail(`Trading on #${id} is over.`);
      const kp = await member(ctx, network);
      const pos = await v.readPosition(network, model, d.position(d.proposal(id), kp.publicKey));
      const balance = BigInt((pos ? (market === "pass" ? (dir === "buy" ? pos.passQuote : pos.passBase) : dir === "buy" ? pos.failQuote : pos.failBase) : 0).toString());
      if (balance < raw) {
        const what = dir === "buy" ? `${market} quote balance is ${q.fmt(balance)}` : `${market} ${tok.symbol} balance is ${tok.fmt(balance)}`;
        fail(`Your ${what}. Split some first: \`${ctx.cmd("split")} ${id} ${dir === "buy" ? "quote" : "base"} <amount>\`.`);
      }
      const pool = market === "pass" ? p.passPool : p.failPool;
      const [reserveIn, reserveOut] = dir === "buy" ? [pool.quote, pool.base] : [pool.base, pool.quote];
      const expected = v.amountOut(raw, reserveIn, reserveOut);
      if (expected === 0n) fail("That trade is too small to get anything back.");
      const minOut = slip !== null ? (expected * BigInt(Math.round((100 - slip) * 100))) / 10_000n : /^0+(\.0+)?$/.test(limit) ? 1n : dir === "buy" ? tok.parse(limit) : q.parse(limit);
      if (minOut > expected) fail(`That would return about ${dir === "buy" ? `${tok.fmt(expected)} ${tok.symbol}` : q.fmt(expected)}, less than the ${dir === "buy" ? `${tok.fmt(minOut)} ${tok.symbol}` : q.fmt(minOut)} you asked for.`);
      await v.trade(network, kp, d, id, market, dir === "buy" ? "quote" : "base", raw, minOut > 0n ? minOut : 1n);
      const after = await v.readProposal(network, model, d.proposal(id));
      const got = dir === "buy" ? `${tok.fmt(expected)} ${tok.symbol}` : q.fmt(expected);
      const price = v.poolPrice(market === "pass" ? after.passPool : after.failPool, tok.decimals, q.decimals).toPrecision(6);
      return reply(`✅ ${dir === "buy" ? "Bought" : "Sold"} in the *${market}* market: ${dir === "buy" ? `${q.fmt(raw)} for about ${got}` : `${tok.fmt(raw)} ${tok.symbol} for about ${got}`}. Its price is now ${price} ${q.name} per ${tok.symbol}.`);
    },
  },

  finalizeproposal: {
    usage: "<id>",
    description: "Settle a proposal's markets once trading closes",
    models: ["decisionMarkets"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("finalizeproposal")} <id>`);
      const c = await loadDao(ctx);
      requireModel(c.model, "decisionMarkets", "Settling markets");
      return finalizeMarkets(ctx, c, id);
    },
  },

  redeem: {
    usage: "<id>",
    description: "Cash in your winning-side balances 1:1",
    models: ["decisionMarkets"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("redeem")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "decisionMarkets", "Redeeming");
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (!p.finalized) fail(`#${id} isn't settled yet: \`${ctx.cmd("finalizeproposal")} ${id}\` once trading closes.`);
      const kp = await member(ctx, network, 165);
      const pos = await v.readPosition(network, model, d.position(d.proposal(id), kp.publicKey));
      const [base, quote] = pos ? (p.passed ? [pos.passBase, pos.passQuote] : [pos.failBase, pos.failQuote]) : [0, 0];
      if (BigInt(base.toString()) === 0n && BigInt(quote.toString()) === 0n) fail(`You hold nothing on #${id}'s ${p.passed ? "pass" : "fail"} side, which is the one that pays.`);
      await v.redeem(network, kp, d, g, id);
      const q = await quoteToken(network, g);
      return reply(`✅ Redeemed ${tok.fmt(base)} ${tok.symbol} and ${q.fmt(quote)} from #${id}'s ${p.passed ? "pass" : "fail"} side.`);
    },
  },

  reclaimliquidity: {
    usage: "<id>",
    description: "Proposer: take back the winning pool once settled",
    models: ["decisionMarkets"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("reclaimliquidity")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "decisionMarkets", "Reclaiming liquidity");
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      const kp = await member(ctx, network, 165);
      if (!p.proposer.equals(kp.publicKey)) fail("Only the proposer can reclaim its liquidity.");
      if (!p.finalized) fail(`#${id} isn't settled yet.`);
      if (p.liquidityReclaimed) fail("Already reclaimed.");
      const pool = p.passed ? p.passPool : p.failPool;
      await v.reclaimLiquidity(network, kp, d, g, id);
      const q = await quoteToken(network, g);
      return reply(`✅ Took back the ${p.passed ? "pass" : "fail"} pool: ${tok.fmt(pool.base)} ${tok.symbol} and ${q.fmt(pool.quote)}.`);
    },
  },

  // ---- actions ----

  listactions: {
    usage: "",
    description: "Actions this DAO can propose (mint, signers, switch model, ...)",
    async run(ctx) {
      const { model, network } = await loadDao(ctx);
      return reply(listActionsText(model, ctx.cmd, network));
    },
  },

  actioninfo: {
    usage: "<action>",
    description: "What an action does and its arguments",
    async run(ctx) {
      const { model, network } = await loadDao(ctx);
      const text = actionInfoText(ctx.args[0], model, ctx.cmd, network);
      if (!text) fail(`Usage: \`${ctx.cmd("actioninfo")} <action>\` — see \`${ctx.cmd("listactions")}\`.`);
      return reply(text);
    },
  },

  proposeaction: {
    usage: "<action> <args...> <description>",
    description: "Propose an action from the list",
    async run(ctx) {
      const [actionId, ...rest] = ctx.args;
      const action = ACTIONS[actionId];
      if (!action) fail(`Usage: \`${ctx.cmd("proposeaction")} <action> <args...> <description>\` — see \`${ctx.cmd("listactions")}\`.`);
      const c = await loadDao(ctx);
      if (!actionApplies(action, c.model, c.network)) fail(`\`${actionId}\` doesn't apply to this ${MODEL_LABEL[c.model]} DAO on ${c.network.name}. See \`${ctx.cmd("listactions")}\`.`);
      // Discord passes the arguments and description as separate fields.
      // Sowellian and decision markets settings (name=value) can be anywhere.
      const named = ctx.named;
      const count = action.args.length;
      const withOptions = c.model === "sowellian" || c.model === "decisionMarkets";
      const strip = (words) => (withOptions ? takeModelOptions(c.model, words).rest : words);
      const allWords = named ? [...(named.args ?? "").split(/\s+/), ...(named.description ?? "").split(/\s+/)].filter(Boolean) : rest;
      const plainRest = strip(rest);
      const args = named ? strip((named.args ?? "").split(/\s+/).filter(Boolean)) : plainRest.slice(0, count);
      const description = named ? strip((named.description ?? "").trim().split(/\s+/).filter(Boolean)).join(" ") : plainRest.slice(count).join(" ");
      if (args.length !== count || !description) fail(`Usage: \`${ctx.cmd("proposeaction")} ${actionId}${count ? " " + action.args.map((a) => a.name).join(" ") : ""} <description>\`${optionsUsage(c.model)}`);
      return (await proposeAction(ctx, c, actionId, args, description, allWords)).reply;
    },
  },

  unregister: {
    usage: "",
    description: "Unlink this chat's Solana DAO (admins)",
    async run(ctx) {
      requireLink(ctx);
      unregisterSolanaChat(ctx.chatId, ctx.platform);
      return reply("Unlinked. The DAO itself is untouched on-chain; link it again with `register <dao address> solana`.");
    },
  },
};

/**
 * Builds action `actionId` with `args` and proposes it with `description`
 * from the caller's wallet (proposeaction, and the Phoenix desk's
 * proposals). `allWords` carries any model settings (name=value). Returns
 * { id, reply }.
 */
export async function proposeAction(ctx, c, actionId, args, description, allWords = []) {
  const action = ACTIONS[actionId];
  if (!actionApplies(action, c.model, c.network)) fail(`\`${actionId}\` doesn't apply to this ${MODEL_LABEL[c.model]} DAO on ${c.network.name}. See \`${ctx.cmd("listactions")}\`.`);
  if (Buffer.byteLength(description) > 200) fail("Keep the description to 200 characters.");
  const built = await action.build({ ...c, args, openTokenAccount: (mint, programId) => v.openTokenAccount(c.network, c.d.treasury, mint, programId) });
  const kp = await member(ctx, c.network, proposalBytes(built.instructions, description));
  if (COUNCIL.includes(c.model)) requireCouncil(c.governance, kp);
  if (c.model === "board") requireSigner(c.governance, kp);
  const { opts, notes } = await proposalOptions(ctx, c, allWords, kp);
  // Accounts the bot opens for the treasury before proposing (e.g. a Jupiter Lend position), paid by the operator: only once the proposer may propose.
  if (built.prepare) {
    const operator = getSolanaOperator();
    if (!operator) fail("This needs the bot's Solana operator wallet to set it up first - ask an admin to set SOLANA_OPERATOR_KEY.");
    await built.prepare({ operator: operator.publicKey, send: (ixs) => v.send(c.network, ixs, [operator]) });
  }
  const { id } = await v.propose(c.network, kp, c.d, c.model, built.instructions, description, { budget: built.budget ?? [], ...opts });
  const reply = await proposalMade(ctx, c, id, [`✅ Proposal *#${id}*: ${built.summary}`, `_${description}_`, ...notes, "", await nextStep(ctx, c, id)].join("\n"));
  return { id, reply };
}

/** What a Sowellian proposal is waiting for, and its pot, criteria and the member's position. */
async function sowellianLines(ctx, network, d, g, p, id, state, now, tok, me) {
  const c = g.config;
  const cr = p.criteria;
  const lines = [];
  const goal = BigInt(cr.targetValue.toString());
  if (v.variant(cr.method) === "oracle") {
    const feed = `0x${Buffer.from(cr.feedId).toString("hex")}`;
    const shown = Number(goal) / 1e18;
    lines.push(`Success if Pyth feed \`${feed.slice(0, 6)}…${feed.slice(-4)}\` is ${cr.targetIsMinimum ? "at least" : "at most"} ${shown}, ${duration(cr.measurementPeriod)} after it runs.`);
  } else {
    lines.push(`Resolved by people, ${duration(cr.measurementPeriod)} after it runs${goal !== 0n ? ` (goal recorded: ${goal} ${cr.targetIsMinimum ? "or more" : "or less"})` : ""}.`);
  }
  const yes = BigInt(p.yesPool.toString());
  const no = BigInt(p.noPool.toString());
  if (yes + no > 0n) lines.push(`Positions: YES ${tok.fmt(yes)} · NO ${tok.fmt(no)} ${tok.symbol}`);
  const vt = p.approval;
  switch (state) {
    case "Pending":
    case "Active":
      lines.push(`Approval: For ${tok.fmt(vt.forVotes)} · Against ${tok.fmt(vt.againstVotes)} · Abstain ${tok.fmt(vt.abstainVotes)} ${tok.symbol}`);
      lines.push(state === "Active" ? `Vote: \`${ctx.cmd("vote")} ${id} for|against|abstain\`, closes in ${duration(num(p.approvalEndsAt) - now)}` : `The approval vote opens in ${duration(num(p.approvalStartsAt) - now)}.`);
      break;
    case "ApprovalClosed":
      lines.push(`Approval: For ${tok.fmt(vt.forVotes)} · Against ${tok.fmt(vt.againstVotes)} · Abstain ${tok.fmt(vt.abstainVotes)} ${tok.symbol}`, `The approval vote is over - settle it: \`${ctx.cmd("finalizeapproval")} ${id}\``);
      break;
    case "PositionsOpen":
      lines.push(`Back an outcome with tokens from your wallet: \`${ctx.cmd("takeposition")} ${id} yes|no <amount>\` - closes in ${duration(num(p.positionsDeadline) - now)}. Winners split the whole pot.`);
      break;
    case "Expired":
      lines.push(`It wasn't run in time. \`${ctx.cmd("queue")} ${id}\` voids it, refunding every position.`);
      break;
    case "Measuring":
      lines.push(`It ran; the result is measured in ${duration(num(p.measurementDeadline) - now)}.`);
      break;
    case "AwaitingResolution":
      lines.push(
        v.variant(cr.method) === "oracle"
          ? `Measurement is over - settle it from Pyth: \`${ctx.cmd("resolveviaoracle")} ${id}\``
          : `Measurement is over - anyone can state the outcome, posting a ${tok.fmt(c.resolutionBond)} ${tok.symbol} bond: \`${ctx.cmd("proposeresolution")} ${id} success|failure\``
      );
      break;
    case "ResolutionProposed": {
      const left = num(p.challengeDeadline) - now;
      lines.push(`\`${short(p.resolver)}\` says *${v.variant(p.proposedOutcome)}*.`);
      lines.push(left > 0 ? `Disagree? \`${ctx.cmd("challengeresolution")} ${id}\` (bond ${tok.fmt(c.challengeBond)} ${tok.symbol}) within ${duration(left)}.` : `Nobody challenged it - lock it in: \`${ctx.cmd("finalizeunchallenged")} ${id}\``);
      break;
    }
    case "Adjudicating": {
      const left = num(p.adjudicationEndsAt) - now;
      lines.push(`\`${short(p.resolver)}\` said *${v.variant(p.proposedOutcome)}*; \`${short(p.challenger)}\` disputes it.`, `Adjudication: Success ${tok.fmt(p.successVotes)} · Failure ${tok.fmt(p.failureVotes)} ${tok.symbol}`);
      lines.push(left > 0 ? `Vote: \`${ctx.cmd("vote")} ${id} success|failure\`, closes in ${duration(left)}` : `The vote is over - settle it: \`${ctx.cmd("finalizeadjudication")} ${id}\``);
      break;
    }
    case "Resolved":
      lines.push(`Outcome: *${v.variant(p.finalOutcome)}*. Collect your winnings and bonds: \`${ctx.cmd("claimposition")} ${id}\``);
      break;
    case "Cancelled":
      if (yes + no > 0n) lines.push(`Positions are refunded: \`${ctx.cmd("claimposition")} ${id}\``);
      break;
  }
  if (me) {
    const pos = await v.readPosition(network, "sowellian", d.position(d.proposal(id), me));
    if (pos && (BigInt(pos.yes.toString()) > 0n || BigInt(pos.no.toString()) > 0n)) lines.push(`Your position: YES ${tok.fmt(pos.yes)} · NO ${tok.fmt(pos.no)}${pos.claimed ? " (collected)" : ""}`);
  }
  return lines;
}

/** A decision market proposal's two markets, its outcome and the member's balances. */
async function marketLines(ctx, network, d, g, p, id, state, now, tok, me) {
  const q = await quoteToken(network, g);
  const price = (pool) => v.poolPrice(pool, tok.decimals, q.decimals).toPrecision(6);
  const lines = p.finalized ? [] : [`Pass market: ${price(p.passPool)} ${q.name} per ${tok.symbol} · Fail market: ${price(p.failPool)}`];
  if (state === "Trading") {
    lines.push(`Trading closes in ${duration(num(p.tradingDeadline) - now)}. \`${ctx.cmd("split")} ${id} base|quote <amount>\`, then \`${ctx.cmd("trade")} ${id} pass|fail buy|sell <amount>\`.`);
  } else if (state === "TradingClosed") {
    lines.push(`Trading is over - settle it: \`${ctx.cmd("finalizeproposal")} ${id}\``);
  } else if (p.finalized) {
    const twap = (x) => v.twapPrice(x, tok.decimals, q.decimals).toPrecision(6);
    if (!p.cancelled) lines.push(`Settled: ${p.passed ? "passed" : "failed"} (average prices pass ${twap(p.passTwap)}, fail ${twap(p.failTwap)}).`);
    lines.push(`${p.passed ? "Pass" : "Fail"} balances redeem 1:1: \`${ctx.cmd("redeem")} ${id}\`.`);
    if (!p.liquidityReclaimed) lines.push(`The proposer can take back the winning pool: \`${ctx.cmd("reclaimliquidity")} ${id}\`.`);
  }
  if (me) lines.push(...positionLines(await v.readPosition(network, "decisionMarkets", d.position(d.proposal(id), me)), tok, q.fmt));
  return lines;
}

/** Moves a Sowellian proposal on: closes its approval vote, an unchallenged resolution or an adjudication. */
async function settleSowellian(ctx, c, id, only) {
  const { network, d, model, governance: g, tok } = c;
  const p = await v.readProposal(network, model, d.proposal(id));
  if (!p) fail(`There's no proposal #${id}.`);
  const now = await v.clusterNow(network);
  const phase = v.variant(p.phase);
  if (only && phase !== only) fail(`#${id} isn't waiting for that - it's ${v.sowellianState(p, g.config, now)}. \`${ctx.cmd("proposal")} ${id}\` shows what's next.`);
  if (phase === "approvalVoting" && now < num(p.approvalEndsAt)) fail(`The approval vote on #${id} closes in ${duration(num(p.approvalEndsAt) - now)}.`);
  if (phase === "resolutionProposed" && now < num(p.challengeDeadline)) fail(`The resolution of #${id} can be challenged for ${duration(num(p.challengeDeadline) - now)} more (\`${ctx.cmd("challengeresolution")} ${id}\`).`);
  if (phase === "adjudicating" && now < num(p.adjudicationEndsAt)) fail(`The adjudication vote on #${id} closes in ${duration(num(p.adjudicationEndsAt) - now)}.`);
  if (phase === "positionsOpen" && v.sowellianState(p, g.config, now) !== "Expired") {
    const at = v.sowellianExecutableAt(p, g.config);
    fail(at > now ? `#${id} can run in ${duration(at - now)}: \`${ctx.cmd("execute")} ${id}\`.` : `#${id} is ready to run: \`${ctx.cmd("execute")} ${id}\`.`);
  }
  const step = await v.sowellianSettle(network, d, id);
  const after = await v.readProposal(network, model, d.proposal(id));
  switch (step) {
    case "finalizeApproval":
      return v.variant(after.phase) === "positionsOpen"
        ? reply(`✅ #${id} is approved. Back YES or NO for ${duration(g.config.positionsWindow)}: \`${ctx.cmd("takeposition")} ${id} yes|no <amount>\`. It can run ${duration(g.config.executionTimelock)} after that.`)
        : reply(`#${id} wasn't approved; its ${tok.fmt(after.proposalBond)} ${tok.symbol} bond goes to the treasury.`);
    case "finalizeUnchallenged":
    case "finalizeAdjudication":
      return reply(`✅ #${id} is resolved: *${v.variant(after.finalOutcome)}*. Collect what you're owed with \`${ctx.cmd("claimposition")} ${id}\`.`);
    default:
      return reply(`#${id} was never run in time, so it's void: everyone's position comes back with \`${ctx.cmd("claimposition")} ${id}\`.`);
  }
}

/** Settles a decision market proposal by TWAP once trading closes. */
async function finalizeMarkets(ctx, c, id) {
  const { network, d, model, governance: g } = c;
  const p = await v.readProposal(network, model, d.proposal(id));
  if (!p) fail(`There's no proposal #${id}.`);
  if (p.finalized) fail(`#${id} is already settled: it ${p.passed ? "passed" : "failed"}.`);
  const now = await v.clusterNow(network);
  if (now < num(p.tradingDeadline)) fail(`Trading on #${id} closes in ${duration(num(p.tradingDeadline) - now)}.`);
  await v.queue(network, d, model, id);
  const after = await v.readProposal(network, model, d.proposal(id));
  const { decimals } = await v.mintInfo(network, g.mint);
  const q = await quoteToken(network, g);
  const twap = (x) => v.twapPrice(x, decimals, q.decimals).toPrecision(6);
  const prices = `Average prices: pass ${twap(after.passTwap)}, fail ${twap(after.failTwap)} ${q.name} per token (pass needed ${pct(g.config.thresholdBps)} more).`;
  return reply(
    after.passed
      ? `✅ #${id} passed. ${prices}\nIt can run in ${duration(g.config.timelock)}: \`${ctx.cmd("execute")} ${id}\`. Pass balances redeem 1:1: \`${ctx.cmd("redeem")} ${id}\`.`
      : `#${id} failed. ${prices}\nFail balances redeem 1:1: \`${ctx.cmd("redeem")} ${id}\`.`
  );
}

/** A Sowellian approval vote (for/against/abstain) or adjudication vote (success/failure), weighted by stake. */
async function castSowellian(ctx, c, kind, id, word) {
  const { network, d, model, tok } = c;
  const approval = kind === "approval";
  const usage = approval ? `${ctx.cmd("vote")} ${id} for|against|abstain` : `${ctx.cmd("vote")} ${id} success|failure`;
  if (!(approval ? CHOICES : OUTCOMES).includes(word)) fail(`Usage: \`${usage}\``);
  const p = await v.readProposal(network, model, d.proposal(id));
  if (!p) fail(`There's no proposal #${id}.`);
  const phase = v.variant(p.phase);
  if (approval && phase !== "approvalVoting") fail(phase === "adjudicating" ? `#${id} is in its adjudication vote: \`${ctx.cmd("vote")} ${id} success|failure\`.` : `#${id}'s approval vote is over.`);
  if (!approval && phase !== "adjudicating") fail(`#${id} has no adjudication vote open - one opens when someone challenges a proposed resolution.`);
  const kp = await member(ctx, network);
  const voter = await requireStake(ctx, network, d, model, kp);
  const record = approval ? d.approvalVote(d.proposal(id), kp.publicKey) : d.adjudicationVote(d.proposal(id), kp.publicKey);
  if (await network.connection.getAccountInfo(record)) fail(`You've already voted on #${id}${approval ? "" : "'s adjudication"}.`);
  if (approval) await v.approvalVote(network, kp, d, id, word);
  else await v.adjudicationVote(network, kp, d, id, word);
  return reply(`✅ Voted *${word}* on #${id}${approval ? "'s approval" : "'s true outcome"} with ${tok.fmt(voter.amount)} staked. Your stake stays locked until the vote closes.`);
}

/** A decision market's balances for one member, in words. */
function positionLines(pos, tok, quoteFmt) {
  if (!pos) return [];
  return [`Your balances: pass ${tok.fmt(pos.passBase)} ${tok.symbol} + ${quoteFmt(pos.passQuote)} · fail ${tok.fmt(pos.failBase)} ${tok.symbol} + ${quoteFmt(pos.failQuote)}`];
}

/** "1.5" of the decision market's quote token -> raw, and a formatter. */
async function quoteToken(network, g) {
  const { decimals } = await v.mintInfo(network, g.quoteMint);
  const name = v.quoteIsSol(g) ? "SOL" : `quote`;
  return { decimals, name, fmt: (raw) => `${v.formatUnits(raw, decimals)} ${name}`, parse: (text) => v.parseUnits(text, decimals) };
}

/** An election's phase, candidates and votes. */
function electionLines(ctx, e, now, tok) {
  const id = e.id.toString();
  const cand = num(e.candidacyEndsAt);
  const ends = num(e.votingEndsAt);
  const lines = [];
  if (e.finalized) lines.push(`Election #${id}: closed.`);
  else if (now < cand) lines.push(`Election #${id}: candidacy open for ${duration(cand - now)} (\`${ctx.cmd("declarecandidacy")} ${id}\`); voting then runs ${duration(ends - cand)}.`);
  else if (now < ends) lines.push(`Election #${id}: voting open for ${duration(ends - now)} (\`${ctx.cmd("voteinelection")} ${id} <candidate...>\`).`);
  else lines.push(`Election #${id}: voting is over - \`${ctx.cmd("finalizeelection")} ${id}\` seats the winners.`);
  if (e.candidates.length) lines.push(...e.candidates.map((c) => `• \`${c.key.toBase58()}\` — ${tok.fmt(c.votes)}`));
  else if (!e.finalized) lines.push("No candidates yet.");
  return lines;
}

/** Integer square root (quadratic vote weight). */
function sqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

// ---------------------------------------------------------------
// creating and linking (from any chat)
// ---------------------------------------------------------------

/** The Solana network named among `args`, and the args without it; null if none. */
function takeSolanaNetwork(args) {
  const index = args.findIndex((a) => resolveSolanaNetwork(a));
  if (index === -1) return null;
  return { networkId: resolveSolanaNetwork(args[index]), rest: [...args.slice(0, index), ...args.slice(index + 1)] };
}

const CREATE = {
  async createdao(ctx, networkId, args) {
    const usage = `${ctx.cmd("createdao")} <name> <symbol> <initialSupply> <maxSupply> [model] solana [council...]`;
    const [name, symbol, initial, , modelWord = "tokenWeighted", ...councilArgs] = args;
    if (!initial) fail(`Usage: \`${usage}\`\nModels: ${SOLANA_MODELS.filter((m) => m !== "board").join(", ")}. Delegate and sortition also take the first council's Solana addresses.`);
    const model = MODEL_WORDS[modelWord.toLowerCase()];
    if (model === "board") fail(`Board has no token - use \`${ctx.cmd("createboarddao")} <name> <signer...> solana\`.`);
    if (!model || !SOLANA_MODELS.includes(model)) fail(`On Solana the bot can create ${SOLANA_MODELS.filter((m) => m !== "board").join(", ")} DAOs (and board, with \`${ctx.cmd("createboarddao")}\`).`);
    if (!name || Buffer.byteLength(name) > 32) fail("The DAO's name must be 1-32 characters on Solana.");
    if (!/^\d+$/.test(initial) || Number(initial) <= 0) fail("The initial supply must be a whole number of tokens above zero.");
    let council;
    if (COUNCIL.includes(model)) {
      council = councilArgs.map((a) => parseKey(a, "a council member"));
      if (council.length === 0) fail(`A ${MODEL_LABEL[model]} DAO needs its first council: \`${usage}\` - council members are Solana addresses (each member's \`${ctx.cmd("wallet")}\` shows theirs).${model === "sortition" ? " Later councils, the same size, are drawn by lot from members who opt in." : ""}`);
      if (council.length > 15) fail("A council can have at most 15 members.");
      if (new Set(council.map((c) => c.toBase58())).size !== council.length) fail("The same council member is listed twice.");
    } else if (councilArgs.length) fail(`Only delegate and sortition DAOs take council members. Usage: \`${usage}\``);
    const network = getSolanaNetwork(networkId);
    const r = await v.createTokenDao(network, { name, initialSupply: initial, model, council });
    registerSolanaChat(ctx.chatId, { network: networkId, dao: r.dao.toBase58(), model, mint: r.mint.toBase58(), symbol, creatorPlatformUserId: String(ctx.userId) }, ctx.platform);
    const how = {
      tokenWeighted: "Members stake to vote.",
      quadratic: "Members stake to vote; each member's votes are the square root of their stake.",
      optimistic: "Proposals pass unless someone challenges them with a bond; only then is there a vote.",
      conviction: "Members stake and back proposals; support builds conviction over time, and spending more of the treasury needs more of it.",
      delegate: `The council (${council?.length} members) proposes and votes; members stake to elect it and to recall members.`,
      liquid: "Members stake to vote, or hand their vote to another member with `delegate`; voting yourself always overrides your delegate.",
      sortition: `The council (${council?.length} seats) proposes and votes. When its term ends, the next council is drawn by lot (ORAO VRF) from members who stake and opt in.`,
      sowellian: "Proposals name how success is measured. An approval vote opens them for YES/NO positions; after they run and are measured, Pyth or a challengeable human answer settles who was right.",
      decisionMarkets: "No votes: each proposal opens a pass and a fail market (DAO token vs SOL), and it passes if the pass market prices the token higher.",
    }[model];
    return reply(
      [
        `✅ *${name}* (${MODEL_LABEL[model]}) created on ${network.name} and linked here.`,
        "",
        `DAO: \`${r.dao.toBase58()}\``,
        `Treasury: \`${r.treasury.toBase58()}\``,
        `Token: \`${r.mint.toBase58()}\` (${symbol}, ${v.TOKEN_DECIMALS} decimals)`,
        "",
        how,
        `⚠️ All ${Number(initial).toLocaleString("en-US")} ${symbol} are held by the bot's operator wallet for now. Hand them out with \`${ctx.cmd("tip")} <amount> <address>\` (you only).`,
        `On Solana there's no fixed maximum supply: the treasury is the token's mint authority, so new ${symbol} can only be minted by a passed proposal.`,
        `Fund the treasury by sending SOL to its address. \`${ctx.cmd("help")}\` lists what you can do here.`,
      ].join("\n")
    );
  },

  async createboarddao(ctx, networkId, args) {
    const [name, ...signerArgs] = args;
    if (!name || signerArgs.length === 0) fail(`Usage: \`${ctx.cmd("createboarddao")} <name> <signer1> <signer2> ... solana\` - signers are Solana addresses (each member's \`${ctx.cmd("wallet")}\` shows theirs).`);
    if (Buffer.byteLength(name) > 32) fail("The DAO's name must be 1-32 characters on Solana.");
    const signers = signerArgs.map((s) => parseKey(s, "a signer"));
    if (signers.length > 20) fail("A board can have at most 20 signers.");
    if (new Set(signers.map((s) => s.toBase58())).size !== signers.length) fail("The same signer is listed twice.");
    const network = getSolanaNetwork(networkId);
    const r = await v.createBoardDao(network, { name, signers });
    registerSolanaChat(ctx.chatId, { network: networkId, dao: r.dao.toBase58(), model: "board", creatorPlatformUserId: String(ctx.userId) }, ctx.platform);
    const required = v.boardConfig(network, signers.length).requiredApprovals;
    return reply(`✅ *${name}* (board) created on ${network.name} and linked here.\n\nDAO: \`${r.dao.toBase58()}\`\nTreasury: \`${r.treasury.toBase58()}\`\n${required} of ${signers.length} signers must confirm.\n\nFund the treasury by sending SOL to its address.`);
  },

  async register(ctx, networkId, args) {
    if (!args[0]) fail(`Usage: \`${ctx.cmd("register")} <dao address> solana\``);
    const network = getSolanaNetwork(networkId);
    const daoKey = parseKey(args[0], "the DAO");
    let d;
    try {
      d = await v.readDao(network, daoKey);
    } catch {
      fail(`\`${args[0]}\` isn't a Vortexes DAO on ${network.name}.`);
    }
    if (!d.model) fail("That DAO runs on a governance model the bot doesn't know.");
    const extra = {};
    if (TOKEN.includes(d.model)) extra.mint = (await v.readGovernance(network, d.model, d.governance)).mint.toBase58();
    registerSolanaChat(ctx.chatId, { network: networkId, dao: d.dao.toBase58(), model: d.model, ...extra }, ctx.platform);
    return reply(`✅ Linked *${d.record.name}* (${MODEL_LABEL[d.model]}, ${network.name}) to this chat.`);
  },
};

// ---------------------------------------------------------------
// entry point
// ---------------------------------------------------------------

/**
 * Runs `name` if it's a Solana matter, returning a reply; returns null to
 * let the regular (EVM) handler take it. Never throws: errors become
 * replies, as in the shared registry's runCommand.
 */
/** Whether this chat's DAO is a Solana one (so a button's amount picker reads Solana balances). */
export function isSolanaChat(ctx) {
  return SOLANA_ENABLED && Boolean(getChatSolana(ctx.chatId, ctx.platform));
}

/**
 * What `name` would spend for the person pressing a button (buttonMenus.js
 * offers shares of it): `takeposition <id> yes|no` - DAO tokens in their
 * wallet; `split <id> base|quote` - DAO tokens, or SOL less a fee margin;
 * `trade <id> pass|fail buy|sell` - that market's quote (buy) or token
 * (sell) balance. { raw, decimals, unit, empty } - `empty` says how to get some.
 */
export async function solanaSpendable(ctx, name, args) {
  const { network, d, model, governance: g, tok } = await loadDao(ctx);
  const me = await getSolanaAddress(ctx.userId, ctx.platform);
  const id = parseId(args[0], "<id>");
  if (name === "takeposition") {
    return { raw: me ? await v.tokenBalance(network, g.mint, me) : 0n, decimals: tok.decimals, unit: tok.symbol, empty: `You have no ${tok.symbol} in your wallet (staked tokens don't count).` };
  }
  const q = await quoteToken(network, g);
  if (name === "split" && args[1] === "base") {
    return { raw: me ? await v.tokenBalance(network, g.mint, me) : 0n, decimals: tok.decimals, unit: tok.symbol, empty: `You have no ${tok.symbol} in your wallet to split.` };
  }
  if (name === "split") {
    let raw = 0n;
    if (me) raw = v.quoteIsSol(g) ? BigInt(await network.connection.getBalance(me)) - 10_000_000n : await v.tokenBalance(network, g.quoteMint, me);
    return { raw: raw > 0n ? raw : 0n, decimals: q.decimals, unit: q.name, empty: `You have no ${q.name} to split${v.quoteIsSol(g) && me ? `: send some to \`${me.toBase58()}\` first` : ""}.` };
  }
  if (name === "trade") {
    const [, market, dir] = args;
    const pos = me ? await v.readPosition(network, model, d.position(d.proposal(id), me)) : null;
    const field = { pass: { buy: "passQuote", sell: "passBase" }, fail: { buy: "failQuote", sell: "failBase" } }[market]?.[dir];
    const raw = pos && field ? BigInt(pos[field].toString()) : 0n;
    const [decimals, unit, side] = dir === "buy" ? [q.decimals, q.name, "quote"] : [tok.decimals, tok.symbol, "base"];
    return { raw, decimals, unit: `${market} ${unit}`, empty: `You have no ${market} ${unit} to ${dir === "buy" ? "spend" : "sell"}. Split some first: \`${ctx.cmd("split")} ${id} ${side} <amount>\`.` };
  }
  return null;
}

export async function runSolanaCommand(name, ctx) {
  if (!SOLANA_ENABLED) return null;
  try {
    // Creating or linking a Solana DAO, from any chat: the network word decides.
    if (CREATE[name]) {
      const taken = takeSolanaNetwork(ctx.args);
      if (taken) {
        if (!getSolanaOperator() && name !== "register") fail("This bot has no Solana operator wallet yet - ask an admin to set SOLANA_OPERATOR_KEY.");
        return await CREATE[name](ctx, taken.networkId, taken.rest);
      }
      // No Solana network named: an EVM DAO (which replaces any Solana link), as before.
      return null;
    }
    const link = getChatSolana(ctx.chatId, ctx.platform);
    if (!link) return null;
    if (COMMANDS[name]) return await COMMANDS[name].run(ctx);
    if (PASS_THROUGH.has(name)) return null;
    return reply(`\`${ctx.cmd(name)}\` isn't available for Solana DAOs. \`${ctx.cmd("help")}\` lists what is.`);
  } catch (err) {
    if (err instanceof SolanaUserError || err?.userFacing) return reply(err.message);
    console.error(`[solana] ${name} failed:`, err);
    return reply(`Couldn't complete \`${ctx.cmd(name)}\`: ${err.message ?? "unknown error"}`);
  }
}

/** A "Solana: <address>" line for /wallet in chats not linked to a Solana DAO, creating the wallet if needed. */
export async function solanaWalletLine(userId, platform) {
  if (!SOLANA_ENABLED) return null;
  try {
    const kp = await getOrCreateSolanaKeypair(userId, platform);
    return `Solana: \`${kp.publicKey.toBase58()}\``;
  } catch (err) {
    console.error("[solana] wallet line:", err);
    return null;
  }
}
