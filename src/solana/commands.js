import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { getChatSolana, registerSolanaChat, unregisterSolanaChat } from "../db.js";
import { SOLANA_ENABLED, SOLANA_MODELS, getSolanaNetwork, resolveSolanaNetwork, explorerUrl, getSolanaOperator } from "./config.js";
import { getOrCreateSolanaKeypair, getSolanaAddress, ensureSolFunded } from "./wallets.js";
import * as v from "./vortex.js";

/**
 * Commands for chats linked to a Solana (Vortexes) DAO, shared by every
 * platform: Telegram's middleware and the Discord/Slack/WhatsApp
 * registry both hand a command here first (runSolanaCommand), with the
 * same platform-neutral context the registry uses ({ platform, chatId,
 * userId, args, isAdmin, isDirect, cmd }). A reply is { text }.
 *
 * Stage 1: token-weighted and board DAOs - create or link one, stake,
 * propose SOL or token payments, vote or confirm, queue, execute.
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

const SLOW = new Set(["createdao", "createboarddao", "execute"]);

/** Whether a command may take a while (Telegram shows a "working" note first). */
export function isSlowSolanaCommand(name) {
  return SLOW.has(name);
}

const MODEL_LABEL = { tokenWeighted: "token-weighted", board: "board" };

// ---------------------------------------------------------------
// formatting
// ---------------------------------------------------------------

const short = (k) => {
  const s = k.toBase58 ? k.toBase58() : String(k);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};
const sol = (lamports) => `${v.formatUnits(BigInt(lamports), 9)} SOL`;

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

/** What one stored instruction does, in words, for the two kinds the bot proposes. */
function describeInstruction(ix) {
  const data = Buffer.from(ix.data);
  if (ix.programId.equals(new PublicKey("11111111111111111111111111111111")) && data.readUInt32LE(0) === 2) {
    return `pay ${sol(data.readBigUInt64LE(4))} to \`${ix.accounts[1].pubkey.toBase58()}\``;
  }
  // SPL Token / Token-2022 TransferChecked: tag 12, amount u64, decimals u8.
  if (data[0] === 12 && data.length >= 10) {
    const amount = data.readBigUInt64LE(1);
    return `pay ${v.formatUnits(amount, data[9])} of token \`${short(ix.accounts[1].pubkey)}\` to token account \`${short(ix.accounts[2].pubkey)}\``;
  }
  return null;
}

/** The proposal's payment(s) in words, skipping the account-creation step. */
function describePayment(p) {
  const words = p.core.instructions.map(describeInstruction).filter(Boolean);
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

async function loadDao(ctx) {
  const { link, network } = requireLink(ctx);
  const d = await v.readDao(network, new PublicKey(link.dao));
  if (!d.model) fail("This DAO now runs on a governance model the bot doesn't support on Solana yet.");
  const governance = await v.readGovernance(network, d.model, d.governance);
  return { link, network, d, model: d.model, governance };
}

function requireModel(model, expected, what) {
  if (model !== expected) fail(`${what} only applies to ${MODEL_LABEL[expected]} DAOs; this one is ${MODEL_LABEL[model]}.`);
}

/** The member's keypair, with enough SOL for fees and rent. */
async function member(ctx, network) {
  const kp = await getOrCreateSolanaKeypair(ctx.userId, ctx.platform);
  await ensureSolFunded(network, ctx.userId, ctx.platform, kp.publicKey);
  return kp;
}

function proposalState(model, p, config, now) {
  return model === "board" ? v.boardState(p, config, now) : v.tokenWeightedState(p, config, now);
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
        if (c.hidden) continue;
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
      const { network, d, model, governance, link } = await loadDao(ctx);
      const [treasurySol, now] = await Promise.all([network.connection.getBalance(d.treasury), v.clusterNow(network)]);
      const lines = [
        `*${d.record.name}* — ${MODEL_LABEL[model]} DAO on ${network.name}`,
        "",
        `DAO: \`${d.dao.toBase58()}\``,
        `Treasury: \`${d.treasury.toBase58()}\``,
        `Treasury holds: ${sol(treasurySol)}`,
      ];
      if (model === "tokenWeighted") {
        const held = await v.tokenBalance(network, governance.mint, d.treasury);
        const symbol = link.symbol ?? "tokens";
        lines.push(`  and ${v.formatTokens(held)} ${symbol}`);
        const c = governance.config;
        lines.push(
          "",
          `Token: \`${governance.mint.toBase58()}\` (${symbol})`,
          `Staked: ${v.formatTokens(governance.totalDeposited)} ${symbol}`,
          `Rules: ${c.quorumBps / 100}% quorum, ${c.approvalBps / 100}% approval, votes last ${duration(c.votingPeriod)}, ${duration(c.timelock)} timelock, ${duration(c.executionPeriod)} to run`
        );
      } else {
        const c = governance.config;
        lines.push("", `Signers (${c.requiredApprovals} of ${governance.signers.length} must confirm):`, ...governance.signers.map((s) => `• \`${s.toBase58()}\``), `Timelock ${duration(c.timelock)}, ${duration(c.executionPeriod)} to run`);
      }
      lines.push("", `Proposals so far: ${governance.proposalCount.toString()}`, `Governance setup #${d.record.epoch}`);
      if (d.record.pendingSwitch) {
        const ps = d.record.pendingSwitch;
        lines.push(`⚠️ Switching to governance program \`${short(ps.program)}\` in ${duration(Number(ps.readyAt.toString()) - now)}`);
      }
      lines.push("", explorerUrl(network, "address", d.treasury.toBase58()));
      return reply(lines.join("\n"));
    },
  },

  treasury: {
    usage: "",
    description: "The treasury's address and balance",
    async run(ctx) {
      const { network, d, model, governance, link } = await loadDao(ctx);
      const lines = [`Treasury: \`${d.treasury.toBase58()}\``, `Holds: ${sol(await network.connection.getBalance(d.treasury))}`];
      if (model === "tokenWeighted") lines.push(`  and ${v.formatTokens(await v.tokenBalance(network, governance.mint, d.treasury))} ${link.symbol ?? "tokens"}`);
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
      return reply(
        `Your Solana wallet:\n\`${kp.publicKey.toBase58()}\`\n\nBalance: ${sol(balance)}. The bot tops it up with a little SOL when you need fees or rent.`
      );
    },
  },

  balance: {
    usage: "",
    description: "Your SOL, tokens and stake in this DAO",
    async run(ctx) {
      const { network, d, model, governance, link } = await loadDao(ctx);
      const me = await getSolanaAddress(ctx.userId, ctx.platform);
      if (!me) return reply(`You don't have a Solana wallet yet - run \`${ctx.cmd("wallet")}\` to create one.`);
      const lines = [`\`${me.toBase58()}\``, `SOL: ${sol(await network.connection.getBalance(me))}`];
      if (model === "tokenWeighted") {
        const symbol = link.symbol ?? "tokens";
        const voter = await v.readVoter(network, model, d.voter(me));
        lines.push(`${symbol} in your wallet: ${v.formatTokens(await v.tokenBalance(network, governance.mint, me))}`);
        lines.push(`Staked here: ${v.formatTokens(voter?.amount ?? 0)}`);
        const lockedUntil = Number(voter?.lockedUntil?.toString() ?? 0);
        const now = await v.clusterNow(network);
        if (lockedUntil > now) lines.push(`Locked for ${duration(lockedUntil - now)} more (until the votes you cast close)`);
      } else {
        lines.push(governance.signers.some((s) => s.equals(me)) ? "You're a signer of this board." : "You're not a signer of this board.");
      }
      return reply(lines.join("\n"));
    },
  },

  stake: {
    usage: "<amount>",
    description: "Stake tokens to vote with them",
    models: ["tokenWeighted"],
    async run(ctx) {
      const { network, d, model, governance, link } = await loadDao(ctx);
      requireModel(model, "tokenWeighted", "Staking");
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("stake")} <amount>\``);
      const raw = v.parseTokens(ctx.args[0]);
      const kp = await member(ctx, network);
      const sig = await v.deposit(network, kp, d, governance, raw);
      return reply(`✅ Staked ${v.formatTokens(raw)} ${link.symbol ?? "tokens"}.\n${explorerUrl(network, "tx", sig)}`);
    },
  },

  unstake: {
    usage: "<amount>",
    description: "Withdraw staked tokens",
    models: ["tokenWeighted"],
    async run(ctx) {
      const { network, d, model, governance, link } = await loadDao(ctx);
      requireModel(model, "tokenWeighted", "Unstaking");
      if (!ctx.args[0]) fail(`Usage: \`${ctx.cmd("unstake")} <amount>\``);
      const raw = v.parseTokens(ctx.args[0]);
      const kp = await member(ctx, network);
      const sig = await v.withdraw(network, kp, d, governance, raw);
      return reply(`✅ Unstaked ${v.formatTokens(raw)} ${link.symbol ?? "tokens"}.\n${explorerUrl(network, "tx", sig)}`);
    },
  },

  tip: {
    usage: "<amount> <address|treasury>",
    description: "Send the DAO's starting tokens (creator only)",
    models: ["tokenWeighted"],
    async run(ctx) {
      const { network, d, model, governance, link } = await loadDao(ctx);
      requireModel(model, "tokenWeighted", "Tipping");
      if (!link.creatorPlatformUserId || link.creatorPlatformUserId !== String(ctx.userId)) fail("Only the person who created this DAO through the bot can tip its starting tokens.");
      const [amount, to] = ctx.args;
      if (!amount || !to) fail(`Usage: \`${ctx.cmd("tip")} <amount> <address|treasury>\``);
      const recipient = to.toLowerCase() === "treasury" ? d.treasury : parseKey(to, "the recipient");
      const raw = v.parseTokens(amount);
      const sig = await v.tipTokens(network, governance.mint, recipient, raw);
      return reply(`✅ Sent ${v.formatTokens(raw)} ${link.symbol ?? "tokens"} to \`${short(recipient)}\`.\n${explorerUrl(network, "tx", sig)}`);
    },
  },

  propose: {
    usage: "<recipient> <amount> <SOL|token> <description>",
    description: "Propose a payment from the treasury",
    async run(ctx) {
      const usage = `${ctx.cmd("propose")} <recipient> <amount> <SOL|token> <description>`;
      const [to, amount, asset, ...words] = ctx.args;
      if (!to || !amount || !asset || words.length === 0) fail(`Usage: \`${usage}\`\nExample: \`${ctx.cmd("propose")} 7Xf…k2 0.5 SOL Pay the designer\`\n\`token\` means this DAO's token; any token's mint address works too.`);
      const { network, d, model, governance, link } = await loadDao(ctx);
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
        const own = model === "tokenWeighted" && (asset.toLowerCase() === "token" || asset.toUpperCase() === (link.symbol ?? "").toUpperCase());
        if (own) mint = governance.mint;
        else if (asset.toLowerCase() === "token") fail("A board DAO has no token of its own - give the token's mint address instead.");
        else mint = parseKey(asset, "the token's mint");
        const { decimals } = await getMint(network.connection, mint).catch(() => fail(`\`${asset}\` isn't a token mint on ${network.name}.`));
        raw = v.parseUnits(amount, decimals);
        label = `${v.formatUnits(raw, decimals)} ${own ? link.symbol ?? "tokens" : `of token ${short(mint)}`}`;
      }
      const instructions = await v.paymentInstructions(network, d, { recipient, raw, mint });
      const kp = await member(ctx, network);
      const { id } = await v.propose(network, kp, d, model, instructions, description);
      const next =
        model === "board"
          ? `Your confirmation counts already. Other signers: \`${ctx.cmd("confirm")} ${id}\`.`
          : `Vote with \`${ctx.cmd("vote")} ${id} for|against|abstain\` (votes last ${duration(governance.config.votingPeriod)}).`;
      return reply(`✅ Proposal *#${id}*: pay ${label} to \`${short(recipient)}\`\n_${description}_\n\n${next}`);
    },
  },

  proposals: {
    usage: "",
    description: "Recent proposals",
    async run(ctx) {
      const { network, d, model, governance } = await loadDao(ctx);
      const count = Number(governance.proposalCount.toString());
      if (count === 0) return reply(`No proposals yet. Make one with \`${ctx.cmd("propose")}\`.`);
      const now = await v.clusterNow(network);
      const ids = [];
      for (let id = count; id >= 1 && ids.length < 10; id--) ids.push(id);
      const lines = ["*Recent proposals*"];
      for (const id of ids) {
        const p = await v.readProposal(network, model, d.proposal(id));
        if (!p) continue;
        lines.push(`*#${id}* — ${proposalState(model, p, governance.config, now)} — ${p.metadataUri}`);
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
      const { network, d, model, governance, link } = await loadDao(ctx);
      const p = await v.readProposal(network, model, d.proposal(id));
      if (!p) fail(`There's no proposal #${id}.`);
      const now = await v.clusterNow(network);
      const state = proposalState(model, p, governance.config, now);
      const lines = [`*Proposal #${id}* — ${state}`, `_${p.metadataUri}_`, "", `Does: ${describePayment(p)}`, `Proposed by \`${short(p.proposer)}\``];
      if (p.core.epoch !== d.record.epoch) lines.push("⚠️ Made under an earlier governance setup - it can no longer run.");
      if (model === "tokenWeighted") {
        const t = p.tally;
        const symbol = link.symbol ?? "tokens";
        lines.push(`For ${v.formatTokens(t.forVotes)} · Against ${v.formatTokens(t.againstVotes)} · Abstain ${v.formatTokens(t.abstainVotes)} ${symbol}`);
        const ends = Number(p.votingEndsAt.toString());
        if (state === "Active") lines.push(`Voting closes in ${duration(ends - now)}`);
        if (state === "Succeeded") lines.push(`Passed - queue it: \`${ctx.cmd("queue")} ${id}\``);
      } else {
        lines.push(`Confirmed by ${p.confirmations.length} of ${governance.signers.length} (needs ${governance.config.requiredApprovals})`);
        if (state === "Active") lines.push(`Signers confirm with \`${ctx.cmd("confirm")} ${id}\``);
      }
      if (state === "Queued") {
        const at = Number(p.queuedAt.toString()) + governance.config.timelock;
        lines.push(at > now ? `Can run in ${duration(at - now)}: \`${ctx.cmd("execute")} ${id}\`` : `Ready to run: \`${ctx.cmd("execute")} ${id}\``);
      }
      return reply(lines.join("\n"));
    },
  },

  vote: {
    usage: "<id> for|against|abstain",
    description: "Vote with your staked tokens",
    models: ["tokenWeighted"],
    async run(ctx) {
      const usage = `${ctx.cmd("vote")} <id> for|against|abstain`;
      const id = parseId(ctx.args[0], usage);
      const choice = (ctx.args[1] ?? "").toLowerCase();
      if (!["for", "against", "abstain"].includes(choice)) fail(`Usage: \`${usage}\``);
      const { network, d, model } = await loadDao(ctx);
      if (model === "board") fail(`Board DAOs don't vote - signers confirm: \`${ctx.cmd("confirm")} ${id}\`.`);
      const kp = await member(ctx, network);
      const voter = await v.readVoter(network, model, d.voter(kp.publicKey));
      if (!voter || BigInt(voter.amount.toString()) === 0n) fail(`You have nothing staked here - stake first with \`${ctx.cmd("stake")} <amount>\`.`);
      if (await network.connection.getAccountInfo(d.vote(d.proposal(id), kp.publicKey))) fail(`You've already voted on #${id}.`);
      await v.vote(network, kp, d, id, choice);
      return reply(`✅ Voted *${choice}* on #${id} with ${v.formatTokens(voter.amount)} staked. Your stake stays locked until voting closes.`);
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
      if (!governance.signers.some((s) => s.equals(kp.publicKey))) fail(`You're not a signer of this board. Your Solana address is \`${kp.publicKey.toBase58()}\`.`);
      await v.confirm(network, kp, d, id);
      const p = await v.readProposal(network, model, d.proposal(id));
      const queued = Number(p.queuedAt.toString()) !== 0;
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
    description: "Queue a passed proposal",
    models: ["tokenWeighted"],
    async run(ctx) {
      const id = parseId(ctx.args[0], `${ctx.cmd("queue")} <id>`);
      const { network, d, model, governance } = await loadDao(ctx);
      if (model === "board") fail("Board proposals queue themselves once enough signers confirm.");
      await v.queue(network, d, id);
      return reply(`✅ Queued #${id}. It can run in ${duration(governance.config.timelock)}: \`${ctx.cmd("execute")} ${id}\``);
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
      const { network, d, model } = await loadDao(ctx);
      const kp = await member(ctx, network);
      await v.cancel(network, kp, d, model, id);
      return reply(`✅ Cancelled #${id}.`);
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
    const usage = `${ctx.cmd("createdao")} <name> <symbol> <initialSupply> <maxSupply> [model] solana`;
    const [name, symbol, initial, , model = "tokenWeighted"] = args;
    if (!initial) fail(`Usage: \`${usage}\``);
    if (model === "board") fail(`Board has no token - use \`${ctx.cmd("createboarddao")} <name> <signer...> solana\`.`);
    if (!SOLANA_MODELS.includes(model)) fail(`On Solana the bot can create ${SOLANA_MODELS.map((m) => MODEL_LABEL[m]).join(" and ")} DAOs so far.`);
    if (!name || Buffer.byteLength(name) > 32) fail("The DAO's name must be 1-32 characters on Solana.");
    if (!/^\d+$/.test(initial) || Number(initial) <= 0) fail("The initial supply must be a whole number of tokens above zero.");
    const network = getSolanaNetwork(networkId);
    const r = await v.createTokenDao(network, { name, initialSupply: initial });
    registerSolanaChat(ctx.chatId, { network: networkId, dao: r.dao.toBase58(), model: "tokenWeighted", mint: r.mint.toBase58(), symbol, creatorPlatformUserId: String(ctx.userId) }, ctx.platform);
    return reply(
      [
        `✅ *${name}* (token-weighted) created on ${network.name} and linked here.`,
        "",
        `DAO: \`${r.dao.toBase58()}\``,
        `Treasury: \`${r.treasury.toBase58()}\``,
        `Token: \`${r.mint.toBase58()}\` (${symbol}, ${v.TOKEN_DECIMALS} decimals)`,
        "",
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
    const network = getSolanaNetwork(networkId);
    const r = await v.createBoardDao(network, { name, signers });
    registerSolanaChat(ctx.chatId, { network: networkId, dao: r.dao.toBase58(), model: "board", creatorPlatformUserId: String(ctx.userId) }, ctx.platform);
    const required = Math.ceil((signers.length + 1) / 2);
    return reply(
      `✅ *${name}* (board) created on ${network.name} and linked here.\n\nDAO: \`${r.dao.toBase58()}\`\nTreasury: \`${r.treasury.toBase58()}\`\n${required} of ${signers.length} signers must confirm.\n\nFund the treasury by sending SOL to its address.`
    );
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
    if (!d.model) fail("That DAO runs on a governance model the bot doesn't support on Solana yet.");
    const extra = {};
    if (d.model === "tokenWeighted") extra.mint = (await v.readGovernance(network, d.model, d.governance)).mint.toBase58();
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
    return reply(`\`${ctx.cmd(name)}\` isn't available for Solana DAOs yet. \`${ctx.cmd("help")}\` lists what is.`);
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

