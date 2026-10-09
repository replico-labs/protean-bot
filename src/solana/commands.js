import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getChatSolana, registerSolanaChat, unregisterSolanaChat, updateChatSolana } from "../db.js";
import { SOLANA_ENABLED, SOLANA_MODELS, getSolanaNetwork, resolveSolanaNetwork, explorerUrl, getSolanaOperator } from "./config.js";
import { getOrCreateSolanaKeypair, getSolanaAddress, ensureSolFunded } from "./wallets.js";
import { ACTIONS, MODEL_WORDS, actionApplies, listActionsText, actionInfoText } from "./actions.js";
import * as v from "./vortex.js";

/**
 * Commands for chats linked to a Solana (Vortexes) DAO, shared by every
 * platform: Telegram's middleware and the Discord/Slack/WhatsApp
 * registry both hand a command here first (runSolanaCommand), with the
 * same platform-neutral context the registry uses ({ platform, chatId,
 * userId, args, named?, isAdmin, isDirect, cmd }). A reply is { text }.
 *
 * All six Vortexes models: token-weighted, quadratic, optimistic,
 * conviction and delegate DAOs (each with a new token), and board DAOs.
 * Command names match the EVM side's, so members use the same words.
 */

class SolanaUserError extends Error {}
const fail = (msg) => {
  throw new SolanaUserError(msg);
};
const reply = (text) => ({ text });

/** Commands that have nothing to do with the chat's DAO, so they keep working in a Solana chat (the Opportunity Market runs on Sepolia). */
const PASS_THROUGH = new Set([
  "start", "migratewallet",
  "registermarket", "unregistermarket", "createmarket", "listopportunity", "deposit", "back", "mybalance", "mybet", "allbets",
  "analytics", "fundrewardpool", "cancelmarket", "resolve", "revealwinningtotal", "reclaimstake", "computereward", "withdraw", "withdrawreward",
]);

const SLOW = new Set(["createdao", "createboarddao", "execute", "proposeaction"]);

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
};
const TOKEN = v.TOKEN_MODELS;
const CHOICES = ["for", "against", "abstain"];

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
function describeInstruction(network, ix) {
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
  if (!governance.council.some((m) => m.equals(kp.publicKey))) fail(`Only council members can do that in a delegate DAO. Your Solana address is \`${kp.publicKey.toBase58()}\`.`);
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
      return `Council members vote: \`${ctx.cmd("vote")} ${id} for|against|abstain\` (votes last ${duration(g.config.votingPeriod)}).`;
    default:
      return `Vote with \`${ctx.cmd("vote")} ${id} for|against|abstain\` (votes last ${duration(g.config.votingPeriod)}).`;
  }
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

const COMMANDS = {
  help: {
    usage: "",
    description: "The commands for this chat's Solana DAO",
    async run(ctx) {
      const link = getChatSolana(ctx.chatId, ctx.platform);
      const lines = [`*Protean DAO on Solana* — ${MODEL_LABEL[link.model] ?? link.model} DAO on ${getSolanaNetwork(link.network).name}`, ""];
      for (const [name, c] of Object.entries(COMMANDS)) {
        if (c.models && !c.models.includes(link.model)) continue;
        lines.push(`\`${ctx.cmd(name)}${c.usage ? " " + c.usage : ""}\` — ${c.description}`);
      }
      lines.push("", "Opportunity Market commands work here as usual.");
      return reply(lines.join("\n"));
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
      const lines = [`*${d.record.name}* — ${MODEL_LABEL[model]} DAO on ${network.name}`, "", `DAO: \`${d.dao.toBase58()}\``, `Treasury: \`${d.treasury.toBase58()}\``, `Treasury holds: ${sol(treasurySol)}`];
      if (tok) {
        lines.push(`  and ${tok.fmt(await v.tokenBalance(network, governance.mint, d.treasury))} ${tok.symbol}`);
        lines.push("", `Token: \`${governance.mint.toBase58()}\` (${tok.symbol})`, `Staked: ${tok.fmt(governance.totalDeposited)} ${tok.symbol}`);
      } else lines.push("");
      lines.push(...(await rulesLines(ctx, c, now)));
      lines.push("", `Proposals so far: ${governance.proposalCount.toString()}`, `Governance setup #${d.record.epoch}`);
      if (d.record.pendingSwitch) {
        const ps = d.record.pendingSwitch;
        const to = MODEL_LABEL[v.modelOf(network, ps.program)] ?? `program \`${short(ps.program)}\``;
        lines.push(`⚠️ Switching to ${to} in ${duration(num(ps.readyAt) - now)} (same treasury). A proposal running \`cancelswitch\` can still stop it.`);
      }
      lines.push("", explorerUrl(network, "address", d.treasury.toBase58()));
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
      lines.push("", "Anyone can send SOL to this address to fund the DAO.", explorerUrl(network, "address", d.treasury.toBase58()));
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
      if (tok) {
        const voter = await v.readVoter(network, model, d.voter(me));
        lines.push(`${tok.symbol} in your wallet: ${tok.fmt(await v.tokenBalance(network, governance.mint, me))}`, `Staked here: ${tok.fmt(voter?.amount ?? 0)}`);
        const now = await v.clusterNow(network);
        const lockedUntil = num(voter?.lockedUntil ?? 0);
        if (lockedUntil > now) lines.push(`Locked for ${duration(lockedUntil - now)} more (until the votes you cast close)`);
        if (model === "conviction" && voter && !voter.supporting.equals(PublicKey.default)) {
          const p = await v.readProposal(network, model, voter.supporting);
          lines.push(`Backing proposal #${p?.id.toString() ?? "?"} with ${tok.fmt(voter.supportWeight)} (locked until you withdraw that support)`);
        }
        if (model === "delegate") lines.push(governance.council.some((m) => m.equals(me)) ? "You're on the council." : "You're not on the council.");
      } else {
        lines.push(governance.signers.some((s) => s.equals(me)) ? "You're a signer of this board." : "You're not a signer of this board.");
      }
      return reply(lines.join("\n"));
    },
  },

  stake: {
    usage: "<amount>",
    description: "Stake tokens to vote with them",
    models: TOKEN,
    async run(ctx) {
      const { network, d, model, governance, tok } = await loadDao(ctx);
      requireModel(model, TOKEN, "Staking");
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("stake")} <amount>\``);
      const raw = tok.parse(ctx.args[0]);
      const kp = await member(ctx, network);
      const sig = await v.deposit(network, model, kp, d, governance, raw);
      const extra = model === "conviction" ? `\nTo back a proposal with it, \`${ctx.cmd("support")} <id>\` (again, if you already back one).` : "";
      return reply(`✅ Staked ${tok.fmt(raw)} ${tok.symbol}.${extra}\n${explorerUrl(network, "tx", sig)}`);
    },
  },

  unstake: {
    usage: "<amount>",
    description: "Withdraw staked tokens",
    models: TOKEN,
    async run(ctx) {
      const { network, d, model, governance, tok } = await loadDao(ctx);
      requireModel(model, TOKEN, "Unstaking");
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("unstake")} <amount>\``);
      const raw = tok.parse(ctx.args[0]);
      const kp = await member(ctx, network);
      const sig = await v.withdraw(network, model, kp, d, governance, raw);
      return reply(`✅ Unstaked ${tok.fmt(raw)} ${tok.symbol}.\n${explorerUrl(network, "tx", sig)}`);
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
      const sig = await v.tipTokens(network, governance.mint, recipient, raw);
      return reply(`✅ Sent ${tok.fmt(raw)} ${tok.symbol} to \`${short(recipient)}\`.\n${explorerUrl(network, "tx", sig)}`);
    },
  },

  propose: {
    usage: "<recipient> <amount> <SOL|token> <description>",
    description: "Propose a payment from the treasury",
    async run(ctx) {
      const usage = `${ctx.cmd("propose")} <recipient> <amount> <SOL|token> <description>`;
      const [to, amount, asset, ...words] = ctx.args;
      if (!to || !amount || !asset || words.length === 0) fail(`Usage: \`${usage}\`\nExample: \`${ctx.cmd("propose")} 7Xf…k2 0.5 SOL Pay the designer\`\n\`token\` means this DAO's token; any token's mint address works too.`);
      const c = await loadDao(ctx);
      const { network, d, model, governance, tok } = c;
      const recipient = parseKey(to, "the recipient");
      const description = words.join(" ");
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
      if (model === "delegate") requireCouncil(governance, kp);
      if (model === "board") requireSigner(governance, kp);
      const { id } = await v.propose(network, kp, d, model, instructions, description, { budget });
      return reply(`✅ Proposal *#${id}*: pay ${label} to \`${short(recipient)}\`\n_${description}_\n\n${await nextStep(ctx, c, id)}`);
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
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      const now = await v.clusterNow(network);
      const state = v.proposalState(model, p, g, now);
      const lines = [`*Proposal #${id}* — ${state}`, `_${p.metadataUri}_`, "", `Does: ${describeProposal(network, p)}`, `Proposed by \`${short(p.proposer)}\``];
      if (p.core.epoch !== d.record.epoch) lines.push("⚠️ Made under an earlier governance setup - it can no longer run.");
      const q = ctx.cmd("queue");
      switch (model) {
        case "tokenWeighted":
        case "quadratic":
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
      }
      if (state === "Queued") {
        const at = num(p.queuedAt) + g.config.timelock;
        lines.push(at > now ? `Can run in ${duration(at - now)}: \`${ctx.cmd("execute")} ${id}\`` : `Ready to run: \`${ctx.cmd("execute")} ${id}\``);
      }
      return reply(lines.join("\n"));
    },
  },

  vote: {
    usage: "<id> for|against|abstain",
    description: "Vote on a proposal",
    models: ["tokenWeighted", "quadratic", "optimistic", "delegate"],
    async run(ctx) {
      const usage = `${ctx.cmd("vote")} <id> for|against|abstain`;
      const id = parseId(ctx.args[0], usage);
      const choice = parseChoice(ctx.args[1], usage);
      const { network, d, model, governance, tok } = await loadDao(ctx);
      if (model === "board") fail(`Board DAOs don't vote - signers confirm: \`${ctx.cmd("confirm")} ${id}\`.`);
      if (model === "conviction") fail(`Conviction DAOs don't vote - back a proposal with \`${ctx.cmd("support")} ${id}\`.`);
      const kp = await member(ctx, network);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      if (model === "delegate") {
        requireCouncil(governance, kp);
        if (p.votes.some((x) => x.member.equals(kp.publicKey))) fail(`You've already voted on #${id}.`);
        await v.vote(network, kp, d, model, id, choice);
        return reply(`✅ Voted *${choice}* on #${id} (one vote per council seat).`);
      }
      if (model === "optimistic" && !p.challenged) fail(`Optimistic proposals only take votes once challenged. To dispute #${id}: \`${ctx.cmd("challenge")} ${id}\`.`);
      const voter = await requireStake(ctx, network, d, model, kp);
      if (await network.connection.getAccountInfo(d.vote(d.proposal(id), kp.publicKey))) fail(`You've already voted on #${id}.`);
      await v.vote(network, kp, d, model, id, choice);
      const weight =
        model === "quadratic" ? `${votesText(BigInt(voter.amount.toString()) === 0n ? 0n : sqrt(BigInt(voter.amount.toString())), tok)} votes (√ of your ${tok.fmt(voter.amount)} staked)` : `${tok.fmt(voter.amount)} staked`;
      return reply(`✅ Voted *${choice}* on #${id} with ${weight}. Your stake stays locked until voting closes.`);
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
    models: ["tokenWeighted", "quadratic", "optimistic", "conviction", "delegate"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("queue")} <id>`);
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      if (model === "board") fail("Board proposals queue themselves once enough signers confirm.");
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
      const sig = await v.execute(network, d, model, id);
      return reply(`✅ Proposal #${id} executed - the treasury has done what it said.\n${explorerUrl(network, "tx", sig)}`);
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
      return reply(`✅ Cancelled #${id}.${model === "conviction" ? " Its supporters can now withdraw their support." : ""}`);
    },
  },

  // ---- delegate: council, elections, recalls ----

  council: {
    usage: "",
    description: "The council, its term, and any election",
    models: ["delegate"],
    async run(ctx) {
      const { network, d, model, governance: g, tok } = await loadDao(ctx);
      requireModel(model, "delegate", "The council");
      const now = await v.clusterNow(network);
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

  // ---- actions ----

  listactions: {
    usage: "",
    description: "Actions this DAO can propose (mint, signers, switch model, ...)",
    async run(ctx) {
      const { model } = await loadDao(ctx);
      return reply(listActionsText(model, ctx.cmd));
    },
  },

  actioninfo: {
    usage: "<action>",
    description: "What an action does and its arguments",
    async run(ctx) {
      const { model } = await loadDao(ctx);
      const text = actionInfoText(ctx.args[0], model, ctx.cmd);
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
      if (!actionApplies(action, c.model)) fail(`\`${actionId}\` doesn't apply to this ${MODEL_LABEL[c.model]} DAO. See \`${ctx.cmd("listactions")}\`.`);
      // Discord passes the arguments and description as separate fields.
      const named = ctx.named;
      const count = action.args.length;
      const args = named ? (named.args ?? "").split(/\s+/).filter(Boolean) : rest.slice(0, count);
      const description = named ? (named.description ?? "").trim() : rest.slice(count).join(" ");
      if (args.length !== count || !description) fail(`Usage: \`${ctx.cmd("proposeaction")} ${actionId}${count ? " " + action.args.map((a) => a.name).join(" ") : ""} <description>\``);
      if (Buffer.byteLength(description) > 200) fail("Keep the description to 200 characters.");
      const built = await action.build({ ...c, args });
      const kp = await member(ctx, c.network, proposalBytes(built.instructions, description));
      if (c.model === "delegate") requireCouncil(c.governance, kp);
      if (c.model === "board") requireSigner(c.governance, kp);
      const { id } = await v.propose(c.network, kp, c.d, c.model, built.instructions, description, { budget: built.budget ?? [] });
      return reply(`✅ Proposal *#${id}*: ${built.summary}\n_${description}_\n\n${await nextStep(ctx, c, id)}`);
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
    if (!initial) fail(`Usage: \`${usage}\`\nModels: ${SOLANA_MODELS.filter((m) => m !== "board").join(", ")}. Delegate also takes the first council's Solana addresses.`);
    const model = MODEL_WORDS[modelWord.toLowerCase()];
    if (model === "board") fail(`Board has no token - use \`${ctx.cmd("createboarddao")} <name> <signer...> solana\`.`);
    if (!model || !SOLANA_MODELS.includes(model)) fail(`On Solana the bot can create ${SOLANA_MODELS.filter((m) => m !== "board").join(", ")} DAOs (and board, with \`${ctx.cmd("createboarddao")}\`).`);
    if (!name || Buffer.byteLength(name) > 32) fail("The DAO's name must be 1-32 characters on Solana.");
    if (!/^\d+$/.test(initial) || Number(initial) <= 0) fail("The initial supply must be a whole number of tokens above zero.");
    let council;
    if (model === "delegate") {
      council = councilArgs.map((a) => parseKey(a, "a council member"));
      if (council.length === 0) fail(`A delegate DAO needs its first council: \`${usage}\` - council members are Solana addresses (each member's \`${ctx.cmd("wallet")}\` shows theirs).`);
      if (council.length > 15) fail("A council can have at most 15 members.");
      if (new Set(council.map((c) => c.toBase58())).size !== council.length) fail("The same council member is listed twice.");
    } else if (councilArgs.length) fail(`Only delegate DAOs take council members. Usage: \`${usage}\``);
    const network = getSolanaNetwork(networkId);
    const r = await v.createTokenDao(network, { name, initialSupply: initial, model, council });
    registerSolanaChat(ctx.chatId, { network: networkId, dao: r.dao.toBase58(), model, mint: r.mint.toBase58(), symbol, creatorPlatformUserId: String(ctx.userId) }, ctx.platform);
    const how = {
      tokenWeighted: "Members stake to vote.",
      quadratic: "Members stake to vote; each member's votes are the square root of their stake.",
      optimistic: "Proposals pass unless someone challenges them with a bond; only then is there a vote.",
      conviction: "Members stake and back proposals; support builds conviction over time, and spending more of the treasury needs more of it.",
      delegate: `The council (${council?.length} members) proposes and votes; members stake to elect it and to recall members.`,
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
