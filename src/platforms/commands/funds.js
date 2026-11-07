import { getAddress, isAddress, parseUnits, formatUnits, zeroAddress } from "viem";
import { getChatModel, getChatDistributor, registerDistributor, getChatFunds, setChatFunds, registerChat, recordChatLinker } from "../../db.js";
import { currentNetwork } from "../../networks.js";
import { getAdapter } from "../../governance/index.js";
import { hasToken } from "../../governance/common.js";
import { takeModelOptions, checkModelOptions, proposeForModel } from "../../modelProposal.js";
import { daoState } from "../../governanceChanges.js";
import { getOrCreateUserAccount } from "../../walletResolver.js";
import { accountId, mentionedUserId } from "../../accountId.js";
import { short } from "../../format.js";
import * as f from "../../funds.js";
import { UserError, reply, requireDao, userClient, proposalReply, parseId } from "../helpers.js";
import { TOKEN_COMMANDS } from "./tokens.js";

/**
 * A DAO's money, for EVM DAOs (src/funds.js builds it; Solana DAOs answer
 * the same commands in src/solana/commands.js, which runs first):
 *   /allowance  monthly allowances paid by the Treasury
 *   /distributor, /claim, /welcome  the Distributor: everything the DAO
 *               has promised someone, claimable from a chat account
 *   /raise, /contribute, /refund  raises, paying only into the Treasury
 *   /launch     a new DAO made from a raise (the founder decides the amount)
 *   /vault      a prop firm's vault, whose shares are the DAO's token
 */

const fmt = (raw, decimals, symbol = "") => `${Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })}${symbol ? ` ${symbol}` : ""}`;
const when = (secs) => new Date(Number(secs) * 1000).toUTCString().replace(":00 GMT", " UTC");
const opts = (words) => {
  const named = {};
  const rest = [];
  for (const w of words) {
    const m = String(w).match(/^([a-z]+)=(.+)$/i);
    if (m) named[m[1].toLowerCase()] = m[2];
    else rest.push(w);
  }
  return { named, rest };
};
const days = (v, name, def) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UserError(`${name}= is a whole number of days.`);
  return n;
};
const units = (raw, decimals, what) => {
  try {
    const v = parseUnits(String(raw), decimals);
    if (v <= 0n) throw new Error();
    return v;
  } catch {
    throw new UserError(`${what} must be a positive number (got \`${raw}\`).`);
  }
};
const rethrow = (err) => {
  if (err instanceof f.FundsError) throw new UserError(err.message);
  throw err;
};

/** Proposes `actions` on the chat's DAO; name=value words are the DAO's own proposal settings. */
async function propose(ctx, governance, model, actions, words, fallback) {
  const { options, rest } = takeModelOptions(model, words);
  checkModelOptions(model, options);
  const description = rest.join(" ") || fallback;
  const { client } = await userClient(ctx, { forceFullTopup: true });
  const { proposalId } = await proposeForModel({ model, client, governanceAddress: governance, actions, description, options });
  return proposalId;
}

async function proposed(ctx, governance, model, plan, words, fallback, text) {
  const id = await propose(ctx, governance, model, plan.actions, words, fallback);
  return proposalReply(ctx, governance, model, id, `✅ Proposal #${id}: ${text}${plan.viaCouncil ? `\n${f.COUNCIL_NOTE}` : ""}`);
}

const dao = (ctx) => {
  const governance = requireDao(ctx);
  return { governance, model: getChatModel(ctx.chatId, ctx.platform) };
};

/** The chat's Distributor, or a UserError saying how to open one. */
async function requireDistributor(ctx) {
  const d = getChatDistributor(ctx.chatId, ctx.platform);
  if (!d || !(await f.isDistributor(d))) throw new UserError(`This DAO has no Distributor yet: \`${ctx.cmd("distributor")} open\` makes one.`);
  return d;
}

/** The person a command names: a mention, a user id, or (Telegram) the replied-to message's author. */
async function namedMember(ctx, word) {
  const userId = mentionedUserId(word, ctx.replyToUserId);
  if (!userId) return null;
  const account = await getOrCreateUserAccount(userId, ctx.platform);
  return { userId, wallet: account.address, account: accountId(ctx.platform, userId) };
}

/*//////////////////////////////////////////////////////////////
                             /allowance
//////////////////////////////////////////////////////////////*/

const allowance = {
  section: "Money",
  usage: "[grant <address> <amount> <token|native> <months> | change <id> <amount> <months> | revoke <id> | claim <id>]",
  description: "Monthly allowances the Treasury pays: list, propose one, or claim yours",
  options: [{ name: "args", description: "grant | change | revoke | claim, then its values", required: false, rest: true }],
  async run(ctx) {
    const { governance, model } = dao(ctx);
    const [sub, ...rest] = ctx.args;
    const usage = [
      `\`${ctx.cmd("allowance")}\` - the DAO's allowances`,
      `\`${ctx.cmd("allowance")} grant <address> <amount> <token|native> <months> [description]\` - propose paying someone monthly (up to 12 months)`,
      `\`${ctx.cmd("allowance")} change <id> <amount> <months>\` / \`revoke <id>\` - propose changing or ending one`,
      `\`${ctx.cmd("allowance")} claim <id>\` - the recipient takes this month's payment (a month not claimed lapses)`,
    ].join("\n");
    const s = await daoState(model, governance).catch(rethrow);
    if (!sub) {
      const list = await f.listAllowances(s.treasury);
      if (!list.length) return reply(`No allowances yet.\n\n${usage}`);
      const lines = await Promise.all(
        list.map(async (a) => {
          const t = await f.tokenInfo(a.token === zeroAddress ? "native" : a.token);
          const state = a.revoked ? "revoked" : Date.now() / 1000 >= Number(a.endsAt) ? "ended" : a.claimable > 0n ? "claimable now" : `next ${when(a.nextAt)}`;
          return `#${a.id} \`${short(a.recipient)}\` ${fmt(a.amount, t.decimals, t.symbol)}/month until ${when(a.endsAt)} - ${state}`;
        })
      );
      return reply(["*Allowances*", ...lines, "", usage].join("\n"));
    }
    switch (sub.toLowerCase()) {
      case "grant": {
        const [to, amount, token, months, ...words] = rest;
        if (!to || !isAddress(to) || !amount || !token || !months) throw new UserError(`Usage: \`${ctx.cmd("allowance")} grant <address> <amount> <token|native> <months> [description]\``);
        const t = await f.tokenInfo(token).catch(rethrow);
        const raw = units(amount, t.decimals, "The amount");
        const plan = await f.buildAllowanceGrant({ model, governance, recipient: to, token: t.address, amountRaw: raw, months: Number(months) }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `Pay ${short(to)} ${amount} ${t.symbol} a month for ${months} months`, `pay \`${short(to)}\` ${fmt(raw, t.decimals, t.symbol)} a month until ${when(plan.endsAt)}. The recipient claims each month with \`${ctx.cmd("allowance")} claim <id>\`.`);
      }
      case "change": {
        const [id, amount, months, ...words] = rest;
        parseId(id, `${ctx.cmd("allowance")} change <id> <amount> <months>`);
        if (!amount || !months) throw new UserError(`Usage: \`${ctx.cmd("allowance")} change <id> <amount> <months>\``);
        const a = (await f.listAllowances(s.treasury)).find((x) => x.id === Number(id));
        if (!a) throw new UserError(`There's no allowance #${id}.`);
        const t = await f.tokenInfo(a.token === zeroAddress ? "native" : a.token);
        const raw = units(amount, t.decimals, "The amount");
        const plan = await f.buildAllowanceChange({ model, governance, id: Number(id), amountRaw: raw, months: Number(months) }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `Change allowance #${id}`, `allowance #${id} becomes ${fmt(raw, t.decimals, t.symbol)} a month for ${months} months from now.`);
      }
      case "revoke": {
        const [id, ...words] = rest;
        parseId(id, `${ctx.cmd("allowance")} revoke <id>`);
        const plan = await f.buildAllowanceRevoke({ model, governance, id: Number(id) }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `End allowance #${id}`, `end allowance #${id}.`);
      }
      case "claim": {
        const id = parseId(rest[0], `${ctx.cmd("allowance")} claim <id>`);
        const { client } = await userClient(ctx);
        const r = await f.claimAllowance(client, s.treasury, Number(id)).catch(rethrow);
        const t = await f.tokenInfo(r.token === zeroAddress ? "native" : r.token);
        return reply(`✅ Paid ${fmt(r.amount, t.decimals, t.symbol)} from the Treasury for this month.`);
      }
      default:
        throw new UserError(usage);
    }
  },
};

/*//////////////////////////////////////////////////////////////
                    /distributor, /claim, /welcome
//////////////////////////////////////////////////////////////*/

const distributor = {
  section: "Money",
  usage: "[open | fund <amount> | grant <address> <amount> [cliff=<days>] [vest=<days>] | welcome <amount> <cap>]",
  description: "The DAO's Distributor: tokens promised to members, raises' buyers and welcome grants",
  options: [{ name: "args", description: "open | fund | grant | welcome, then its values", required: false, rest: true }],
  async run(ctx) {
    const { governance, model } = dao(ctx);
    if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token to distribute.`);
    const [sub, ...rest] = ctx.args;
    const usage = [
      `\`${ctx.cmd("distributor")} open\` - make the DAO's Distributor (anyone; it holds nothing until the DAO funds it)`,
      `\`${ctx.cmd("distributor")} fund <amount>\` - propose moving tokens there from the Treasury`,
      `\`${ctx.cmd("distributor")} grant <address|@member> <amount> [cliff=<days>] [vest=<days>]\` - propose a grant, vesting if you like`,
      `\`${ctx.cmd("distributor")} welcome <amount> <cap>\` - propose welcome grants for new members, approved by a council member with \`${ctx.cmd("welcome")}\``,
      `Members take what's theirs with \`${ctx.cmd("claim")}\`.`,
    ].join("\n");
    if (!sub) {
      const d = getChatDistributor(ctx.chatId, ctx.platform);
      if (!d || !(await f.isDistributor(d))) return reply(`No Distributor yet.\n\n${usage}`);
      const i = await f.distributorInfo(d);
      const t = i.token;
      return reply(
        [
          `*Distributor* \`${short(d)}\``,
          `Promised, not yet claimed: ${fmt(i.outstanding, t.decimals, t.symbol)} · free: ${fmt(i.unpromised, t.decimals, t.symbol)}`,
          `Grants so far: ${i.count}${i.welcomeAmount > 0n ? ` · welcome grants ${fmt(i.welcomeAmount, t.decimals, t.symbol)} each (${fmt(i.welcomeGranted, t.decimals)} of ${fmt(i.welcomeCap, t.decimals)} given)` : ""}`,
          `Claims close ${when(i.claimDeadline)}.`,
          "",
          usage,
        ].join("\n")
      );
    }
    const s = await daoState(model, governance).catch(rethrow);
    const t = await f.tokenInfo(s.token);
    switch (sub.toLowerCase()) {
      case "open": {
        const existing = getChatDistributor(ctx.chatId, ctx.platform);
        if (existing && (await f.isDistributor(existing))) throw new UserError(`This DAO already has a Distributor: \`${existing}\`.`);
        const { named } = opts(rest);
        const { client } = await userClient(ctx);
        const r = await f.createDistributor(client, { token: s.token, treasury: s.treasury, claimDays: days(named.days, "days", 365) }).catch(rethrow);
        registerDistributor(ctx.chatId, r.distributor, ctx.platform);
        return reply(`✅ Distributor made: \`${r.distributor}\`. Fund it with \`${ctx.cmd("distributor")} fund <amount>\`.`);
      }
      case "fund": {
        const d = await requireDistributor(ctx);
        const [amount, ...words] = rest;
        const raw = units(amount, t.decimals, "The amount");
        const plan = await f.buildDistributorFund({ model, governance, distributor: d, amountRaw: raw }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `Fund the Distributor with ${amount} ${t.symbol}`, `move ${fmt(raw, t.decimals, t.symbol)} from the Treasury to the Distributor.`);
      }
      case "grant": {
        const d = await requireDistributor(ctx);
        const { named, rest: words } = opts(rest);
        const [who, amount, ...desc] = words;
        const member = isAddress(who ?? "") ? null : await namedMember(ctx, who);
        if (!amount || (!member && !isAddress(who ?? ""))) throw new UserError(`Usage: \`${ctx.cmd("distributor")} grant <address|@member> <amount> [cliff=<days>] [vest=<days>]\``);
        const raw = units(amount, t.decimals, "The amount");
        const cliff = days(named.cliff, "cliff", 0);
        const vest = days(named.vest, "vest", 0);
        const plan = await f
          .buildDistributorGrant({ model, governance, distributor: d, owner: member ? null : who, account: member?.account, amountRaw: raw, cliffDays: cliff, vestDays: vest })
          .catch(rethrow);
        const to = member ? "that member's chat account (they claim it with /claim)" : `\`${short(who)}\``;
        return proposed(ctx, governance, model, plan, desc, `Grant ${amount} ${t.symbol}`, `grant ${fmt(raw, t.decimals, t.symbol)} to ${to}${vest ? `, vesting over ${vest} days${cliff ? ` after a ${cliff}-day cliff` : ""}` : ""}.`);
      }
      case "welcome": {
        const d = await requireDistributor(ctx);
        const [amount, cap, ...words] = rest;
        const raw = units(amount, t.decimals, "The amount");
        const capRaw = units(cap, t.decimals, "The cap");
        const plan = await f.buildWelcomeTerms({ model, governance, distributor: d, amountRaw: raw, capRaw }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `Welcome grants of ${amount} ${t.symbol}`, `welcome grants of ${fmt(raw, t.decimals, t.symbol)} each, up to ${fmt(capRaw, t.decimals, t.symbol)} in all. A council member approves each with \`${ctx.cmd("welcome")}\`.`);
      }
      default:
        throw new UserError(usage);
    }
  },
};

const claim = {
  section: "Money",
  usage: "",
  description: "Claim the tokens the DAO's Distributor holds for you (grants, raises, welcome grants)",
  options: [],
  async run(ctx) {
    requireDao(ctx);
    const d = await requireDistributor(ctx);
    const { client } = await userClient(ctx);
    const r = await f.claimAll(client, d, accountId(ctx.platform, ctx.userId)).catch(rethrow);
    const t = (await f.distributorInfo(d)).token;
    if (r.claimed === 0n) {
      if (!r.rows.length) throw new UserError("The Distributor holds nothing for you.");
      const locked = r.rows.reduce((n, x) => n + x.total - x.claimed, 0n);
      throw new UserError(`Nothing has vested yet: ${fmt(locked, t.decimals, t.symbol)} still vesting for you.`);
    }
    return reply(`✅ Claimed ${fmt(r.claimed, t.decimals, t.symbol)} into \`${short(client.account.address)}\`.`);
  },
};

const welcome = {
  section: "Council",
  usage: "<@member>",
  description: "A council member approves a member's welcome grant (Telegram: reply to their message)",
  options: [{ name: "member", description: "The member (a mention)", required: false }],
  async run(ctx) {
    requireDao(ctx);
    const d = await requireDistributor(ctx);
    const member = await namedMember(ctx, ctx.args[0]);
    if (!member) throw new UserError(`Usage: \`${ctx.cmd("welcome")} @member\` (on Telegram, reply to one of their messages).`);
    if (String(member.userId) === String(ctx.userId)) throw new UserError("A welcome grant is approved by someone else.");
    const { client } = await userClient(ctx);
    const r = await f.grantWelcome(client, d, member.wallet, member.account).catch((err) => {
      if (/NotCouncilMember/.test(err?.shortMessage ?? err?.message ?? "")) throw new UserError("Only a member of the DAO's council can approve welcome grants.");
      return rethrow(err);
    });
    const t = (await f.distributorInfo(d)).token;
    return reply(`✅ Welcome grant of ${fmt(r.amount, t.decimals, t.symbol)} approved. They take it with \`${ctx.cmd("claim")}\`.`);
  },
};

/*//////////////////////////////////////////////////////////////
                    /raise, /contribute, /refund
//////////////////////////////////////////////////////////////*/

async function requireRaise(ctx) {
  const { raise } = getChatFunds(ctx.chatId, ctx.platform);
  if (!raise) throw new UserError(`There's no raise here. \`${ctx.cmd("raise")} open\` proposes one; a new DAO starts with \`${ctx.cmd("launch")}\`.`);
  return raise;
}

function raiseText(ctx, i) {
  const c = i.currency;
  const lines = [
    `*Raise* \`${short(i.address)}\` - ${i.phase}`,
    `Raised ${fmt(i.total, c.decimals, c.symbol)} from ${i.count} contributors · soft cap ${fmt(i.terms.softCap, c.decimals)}, target ${fmt(i.terms.hardCap, c.decimals)} (contributions go past it)`,
    `Open ${when(i.terms.start)} to ${when(i.terms.end)}; the decision is due by ${when(Number(i.terms.end) + Number(i.terms.decisionWindow))}.`,
  ];
  if (i.phase === "accepted") lines.push(`Accepted ${fmt(i.accepted, c.decimals, c.symbol)}: everyone gets tokens pro rata and the rest of their money back (\`${ctx.cmd("raise")} settle\`, then \`${ctx.cmd("claim")}\` and \`${ctx.cmd("refund")}\`).`);
  if (i.phase === "failed") lines.push(`It didn't go ahead: \`${ctx.cmd("refund")}\` returns everything.`);
  if (i.phase === "open") lines.push(`Contribute with \`${ctx.cmd("contribute")} <amount>\`.`);
  return lines.join("\n");
}

const raise = {
  section: "Money",
  usage: "[open <softCap> <hardCap> <days> <tokensForSale> [currency=<token>] [min=] [max=] [cliff=<days>] [vest=<days>] [decide=<days>] | accept <amount> | settle]",
  description: "The DAO's raise: status, propose one, accept an amount by proposal, settle",
  options: [{ name: "args", description: "open | accept | settle, then its values", required: false, rest: true }],
  async run(ctx) {
    const [sub, ...rest] = ctx.args;
    if (!sub) return reply(raiseText(ctx, await f.raiseInfo(await requireRaise(ctx))));
    switch (sub.toLowerCase()) {
      case "open": {
        const { governance, model } = dao(ctx);
        const { named, rest: words } = opts(rest);
        const [soft, hard, nDays, sale, ...desc] = words;
        if (!soft || !hard || !nDays || !sale) throw new UserError(`Usage: \`${ctx.cmd("raise")} open <softCap> <hardCap> <days> <tokensForSale> [currency=<token|native>] [min=] [max=] [cliff=<days>] [vest=<days>] [decide=<days>]\``);
        const cur = await f.tokenInfo(named.currency ?? "native").catch(rethrow);
        const s = await daoState(model, governance).catch(rethrow);
        const tok = await f.tokenInfo(s.token);
        const d = getChatDistributor(ctx.chatId, ctx.platform);
        const plan = await f
          .buildRaiseOpen({
            model,
            governance,
            distributor: d && (await f.isDistributor(d)) ? d : null,
            currency: cur.address,
            softCapRaw: units(soft, cur.decimals, "The soft cap"),
            hardCapRaw: units(hard, cur.decimals, "The hard cap"),
            days: Number(nDays),
            saleSupplyRaw: units(sale, tok.decimals, "The tokens for sale"),
            minRaw: named.min ? units(named.min, cur.decimals, "min=") : 0n,
            maxRaw: named.max ? units(named.max, cur.decimals, "max=") : 0n,
            cliffDays: days(named.cliff, "cliff", 0),
            vestDays: days(named.vest, "vest", 0),
            decideDays: days(named.decide, "decide", 7),
          })
          .catch(rethrow);
        const id = await propose(ctx, governance, model, plan.actions, desc, `Raise ${soft}-${hard} ${cur.symbol} for ${sale} ${tok.symbol}`);
        setChatFunds(ctx.chatId, { raise: plan.raise, pendingRaiseProposal: String(id) }, ctx.platform);
        if (plan.newDistributor) registerDistributor(ctx.chatId, plan.distributor, ctx.platform);
        return proposalReply(
          ctx,
          governance,
          model,
          id,
          `✅ Proposal #${id}: raise ${soft} to ${hard} ${cur.symbol} (more is welcome) over ${nDays} days, selling ${sale} ${tok.symbol} pro rata. The money goes only to the Treasury; the DAO accepts an amount by proposal when it ends.\nRaise: \`${plan.raise}\` (open once the proposal runs).${plan.viaCouncil ? `\n${f.COUNCIL_NOTE}` : ""}`
        );
      }
      case "accept": {
        const { governance, model } = dao(ctx);
        const r = await requireRaise(ctx);
        const info = await f.raiseInfo(r);
        const [amount, ...words] = rest;
        const raw = units(amount, info.currency.decimals, "The amount");
        const plan = await f.buildRaiseAccept({ model, governance, raise: r, distributor: getChatDistributor(ctx.chatId, ctx.platform), amountRaw: raw }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `Accept ${amount} ${info.currency.symbol} of the raise`, `accept ${fmt(raw, info.currency.decimals, info.currency.symbol)} of the ${fmt(info.total, info.currency.decimals)} raised; the rest goes back pro rata.`);
      }
      case "settle": {
        const r = await requireRaise(ctx);
        const { client } = await userClient(ctx);
        const { settled } = await f.settleAll(client, r).catch(rethrow);
        return reply(settled ? `✅ Settled ${settled} contributors: tokens are in the Distributor (\`${ctx.cmd("claim")}\`), refunds ready (\`${ctx.cmd("refund")}\`).` : "Everyone is already settled.");
      }
      default:
        throw new UserError(`Usage: \`${ctx.cmd("raise")} [open ... | accept <amount> | settle]\``);
    }
  },
};

const contribute = {
  section: "Money",
  usage: "[amount]",
  description: "Put money into the open raise (tied to your chat account); without an amount, the treasury's address to donate to (sent privately)",
  options: [{ name: "amount", description: "How much, into the raise", required: false }],
  async run(ctx) {
    if (!ctx.args[0]) return TOKEN_COMMANDS.contribute.run(ctx);
    const r = await requireRaise(ctx);
    const info = await f.raiseInfo(r);
    const raw = units(ctx.args[0], info.currency.decimals, "The amount");
    const { client } = await userClient(ctx);
    await f.contribute(client, r, raw, accountId(ctx.platform, ctx.userId)).catch(rethrow);
    return reply(`✅ Contributed ${fmt(raw, info.currency.decimals, info.currency.symbol)}. If the raise goes ahead you get tokens pro rata and back whatever isn't accepted; if not, everything.`);
  },
};

const refund = {
  section: "Money",
  usage: "",
  description: "Take back what the raise didn't accept (or everything, if it didn't go ahead)",
  options: [],
  async run(ctx) {
    const r = await requireRaise(ctx);
    const { client } = await userClient(ctx);
    const x = await f.withdrawRefund(client, r).catch(rethrow);
    return reply(`✅ Refunded ${fmt(x.amount, x.currency.decimals, x.currency.symbol)}.`);
  },
};

/*//////////////////////////////////////////////////////////////
                              /launch
//////////////////////////////////////////////////////////////*/

const launch = {
  section: "Money",
  usage: "<model> <name> <symbol> <supply> <tokensForSale> <softCap> <hardCap> <days> [currency=<token>] [team=<amount>] [cliff=<days>] [vest=<days>] [propfirm] | finish <amount> | status",
  description: "Start a new DAO from a raise: the money only ever goes to its Treasury",
  options: [{ name: "args", description: "The launch's terms, or finish <amount>", required: true, rest: true }],
  async run(ctx) {
    const [first, ...rest] = ctx.args;
    const usage = [
      `\`${ctx.cmd("launch")} <model> <name> <symbol> <supply> <tokensForSale> <softCap> <hardCap> <days> [currency=<token|native>] [team=<amount>] [cliff=<days>] [vest=<days>]\``,
      "Opens a raise for a DAO that doesn't exist yet. When it ends, you (the founder) accept an amount and one transaction makes the DAO, puts the money in its Treasury, the sale and team tokens in its Distributor, and the rest of the supply in its Treasury.",
      `A prop firm: \`${ctx.cmd("launch")} <model> <name> <symbol> propfirm <softCap> <hardCap> <days> currency=<usdc>\` - its token is its vault's shares, minted from the money.`,
      `Then: \`${ctx.cmd("contribute")} <amount>\`, and \`${ctx.cmd("launch")} finish <amount>\`.`,
    ].join("\n");
    if (!first) throw new UserError(usage);
    const funds = getChatFunds(ctx.chatId, ctx.platform);
    if (first.toLowerCase() === "status") {
      if (!funds.launch) throw new UserError("No launch here.");
      return reply(raiseText(ctx, await f.raiseInfo(funds.launch.raise)));
    }
    if (first.toLowerCase() === "finish") {
      if (!funds.launch) throw new UserError("No launch here.");
      const info = await f.raiseInfo(funds.launch.raise);
      const raw = units(rest[0], info.currency.decimals, "The amount");
      const { client } = await userClient(ctx);
      const { launch: l } = await f.finishLaunch(client, funds.launch.id, raw).catch(rethrow);
      registerChat(ctx.chatId, getAddress(l.governance), funds.launch.model, ctx.platform, String(ctx.userId), currentNetwork().id);
      recordChatLinker(ctx.chatId, String(ctx.userId), ctx.platform, { keepCreator: true });
      registerDistributor(ctx.chatId, getAddress(l.distributor), ctx.platform);
      setChatFunds(ctx.chatId, { raise: funds.launch.raise, launch: { ...funds.launch, finished: true }, ...(l.vault && l.vault !== zeroAddress ? { vault: getAddress(l.vault) } : {}) }, ctx.platform);
      return reply(
        `✅ Launched. Governance \`${l.governance}\`, Treasury \`${l.treasury}\` (holding the ${fmt(raw, info.currency.decimals, info.currency.symbol)} accepted). This channel now runs the new DAO.\nContributors: \`${ctx.cmd("raise")} settle\`, then \`${ctx.cmd("claim")}\` and \`${ctx.cmd("refund")}\`.`
      );
    }
    if (funds.launch && !funds.launch.finished) throw new UserError(`This channel already has a launch (raise \`${funds.launch.raise}\`).`);
    const { named, rest: words } = opts(rest);
    const model = first;
    const propFirm = words.includes("propfirm");
    const [name, symbol, supply, sale, soft, hard, nDays] = propFirm ? [words[0], words[1], "0", "0", words[3], words[4], words[5]] : words;
    if (!name || !symbol || !soft || !hard || !nDays) throw new UserError(usage);
    if (!f.LAUNCH_MODELS.includes(model)) throw new UserError(`A launch can create: ${f.LAUNCH_MODELS.join(", ")}.`);
    const cur = await f.tokenInfo(named.currency ?? (propFirm ? "" : "native")).catch(rethrow);
    const { client } = await userClient(ctx, { forceFullTopup: true });
    const adapter = getAdapter(model);
    const config = model === "delegate" ? adapter.newDaoConfig([client.account.address]) : model === "tokenWeighted" ? (await import("../../contracts.js")).newTokenWeightedConfig() : adapter.newDaoConfig();
    const t = Math.floor(Date.now() / 1000);
    const terms = {
      currency: cur.address,
      softCap: units(soft, cur.decimals, "The soft cap"),
      hardCap: units(hard, cur.decimals, "The hard cap"),
      start: BigInt(t),
      end: BigInt(t + Number(nDays) * f.DAY),
      minContribution: 0n,
      maxContribution: 0n,
      saleSupply: propFirm ? 0n : units(sale, 18, "The tokens for sale"),
      vestCliff: BigInt(days(named.cliff, "cliff", 0) * f.DAY),
      vestDuration: BigInt(days(named.vest, "vest", 0) * f.DAY),
      decisionWindow: BigInt(7 * f.DAY),
      fundsTo: zeroAddress,
    };
    const shares = named.team ? [{ owner: client.account.address, account: accountId(ctx.platform, ctx.userId), amount: units(named.team, 18, "team="), cliff: BigInt(90 * f.DAY), duration: BigInt(365 * f.DAY) }] : [];
    const r = await f
      .createLaunch(client, {
        model,
        name,
        symbol,
        supplyRaw: propFirm ? 0n : units(supply, 18, "The supply"),
        maxSupplyRaw: propFirm ? 2n ** 128n - 1n : units(supply, 18, "The supply") * 10n,
        config,
        council: [client.account.address],
        terms,
        shares,
        propFirm: propFirm ? { interval: BigInt(30 * f.DAY), freezeBefore: BigInt(f.DAY), settleDelay: BigInt(60 * 60), managementBps: 200, performanceBps: 2000, maxDrawdownBps: 2000, openToAll: true } : null,
      })
      .catch(rethrow);
    setChatFunds(ctx.chatId, { launch: { id: r.id, raise: r.raise, model, network: currentNetwork().id, founder: String(ctx.userId) }, raise: r.raise }, ctx.platform);
    return reply(
      `✅ Launch #${r.id} open: raising ${soft} to ${hard} ${cur.symbol} over ${nDays} days for *${name}* (${symbol}, ${model}).\nRaise: \`${r.raise}\`. Contribute with \`${ctx.cmd("contribute")} <amount>\`. When it ends, the founder accepts an amount with \`${ctx.cmd("launch")} finish <amount>\` and the DAO is made.`
    );
  },
};

/*//////////////////////////////////////////////////////////////
                               /vault
//////////////////////////////////////////////////////////////*/

async function requireVault(ctx) {
  const { vault } = getChatFunds(ctx.chatId, ctx.platform);
  if (!vault) throw new UserError("This DAO has no vault: only DAOs launched as prop firms do.");
  return vault;
}

const vault = {
  section: "Money",
  usage: "[deposit <amount> | redeem <shares> | cancel | claim | window | pause | resume | allow <address> | valuer hypercore | valuer perpl <desk> <marketIds>]",
  description: "The prop firm's vault: its value, deposits and redemptions at windows, and the DAO's settings",
  options: [{ name: "args", description: "deposit | redeem | cancel | claim | window | pause | resume | allow | valuer", required: false, rest: true }],
  async run(ctx) {
    const v = await requireVault(ctx);
    const [sub, ...rest] = ctx.args;
    const i = await f.vaultInfo(v);
    const a = i.asset;
    if (!sub) {
      return reply(
        [
          `*Vault* \`${short(v)}\`${i.paused ? " - ⏸ trading paused (drawdown or by proposal)" : ""}`,
          `Value ${i.value === null ? "unknown right now (a venue's price is stale)" : fmt(i.value, a.decimals, a.symbol)} · ${fmt(i.supply, 18)} shares${i.price !== null ? ` · ${fmt(i.price, a.decimals, a.symbol)} a share` : ""}`,
          `Window ${i.epoch} closes ${when(i.nextWindowAt)} · waiting: ${fmt(i.pendingDepositAssets, a.decimals, a.symbol)} to deposit · owed to redeemers: ${fmt(i.owedAssets, a.decimals, a.symbol)}`,
          `Fees: ${i.config.managementBps / 100}% a year + ${i.config.performanceBps / 100}% of gains · trading pauses ${i.config.maxDrawdownBps / 100}% below the high.`,
          "",
          `\`${ctx.cmd("vault")} deposit <amount>\` / \`redeem <shares>\` - priced at the next window; \`cancel\` before it; \`claim\` after it.`,
        ].join("\n")
      );
    }
    const { governance, model } = dao(ctx);
    switch (sub.toLowerCase()) {
      case "deposit": {
        const raw = units(rest[0], a.decimals, "The amount");
        const { client } = await userClient(ctx);
        await f.vaultDeposit(client, v, raw).catch(rethrow);
        return reply(`✅ ${fmt(raw, a.decimals, a.symbol)} waiting for the window on ${when(i.nextWindowAt)}; then \`${ctx.cmd("vault")} claim\` your shares.`);
      }
      case "redeem": {
        const raw = units(rest[0], 18, "The shares");
        const { client } = await userClient(ctx);
        await f.vaultRedeem(client, v, raw).catch(rethrow);
        return reply(`✅ ${fmt(raw, 18)} shares to redeem at the window on ${when(i.nextWindowAt)}; then \`${ctx.cmd("vault")} claim\` the money.`);
      }
      case "cancel": {
        const { client } = await userClient(ctx);
        const r = await f.vaultCancel(client, v).catch(rethrow);
        return reply(`✅ Cancelled${r.deposit ? ` your ${fmt(r.deposit, a.decimals, a.symbol)} deposit` : ""}${r.deposit && r.redeem ? " and" : ""}${r.redeem ? ` your ${fmt(r.redeem, 18)}-share redemption` : ""}.`);
      }
      case "claim": {
        const { client } = await userClient(ctx);
        const r = await f.vaultClaim(client, v).catch(rethrow);
        return reply(`✅ Claimed${r.shares ? ` ${fmt(r.shares, 18)} shares` : ""}${r.shares && r.assets ? " and" : ""}${r.assets ? ` ${fmt(r.assets, a.decimals, a.symbol)}` : ""}.`);
      }
      case "window": {
        const { client } = await userClient(ctx);
        await f.vaultProcessWindow(client, v).catch(rethrow);
        return reply(`✅ Window ${i.epoch} processed: requests are priced; \`${ctx.cmd("vault")} claim\`.`);
      }
      case "pause":
      case "resume": {
        const plan = await f.buildVaultAdmin({ model, governance, vault: v, functionName: sub.toLowerCase() }).catch(rethrow);
        return proposed(ctx, governance, model, plan, rest, `${sub} vault trading`, `${sub.toLowerCase()} the vault's trading.`);
      }
      case "allow": {
        const [who, ...words] = rest;
        if (!who || !isAddress(who)) throw new UserError(`Usage: \`${ctx.cmd("vault")} allow <address>\``);
        const plan = await f.buildVaultAdmin({ model, governance, vault: v, functionName: "setAllowed", args: [getAddress(who), true] }).catch(rethrow);
        return proposed(ctx, governance, model, plan, words, `Let ${short(who)} deposit in the vault`, `let \`${short(who)}\` deposit in the vault.`);
      }
      case "valuer": {
        const [venue, ...more] = rest;
        const { client } = await userClient(ctx);
        let made;
        if (venue === "perpl") {
          // Each Perpl desk is its own exchange account: value each one the vault owns.
          const [desk, ids] = more;
          if (!desk || !isAddress(desk) || !ids) throw new UserError(`Usage: \`${ctx.cmd("vault")} valuer perpl <desk> <marketId,...>\` (\`${ctx.cmd("desk")}\` lists the desks).`);
          const { deskVenue } = await import("../../integrations/perpl.js");
          const exchange = deskVenue.deployment({ network: currentNetwork() }).exchange;
          made = await f.createValuer(client, { vault: v, venue, exchange, account: desk, markets: String(ids).split(",").filter(Boolean) }).catch(rethrow);
        } else made = await f.createValuer(client, { vault: v, venue: "hypercore" }).catch(rethrow);
        const plan = await f.buildVaultAdmin({ model, governance, vault: v, functionName: "setValuer", args: [made.valuer, true] }).catch(rethrow);
        return proposed(ctx, governance, model, plan, [], `Value the vault's ${venue} account`, `count the vault's ${venue ?? "hypercore"} account in its value (valuer \`${made.valuer}\`).`);
      }
      default:
        throw new UserError(`Usage: \`${ctx.cmd("vault")} ${vault.usage}\``);
    }
  },
};

/**
 * Someone joined a chat whose Distributor gives welcome grants: the text
 * asking a council member to approve theirs (null when there's nothing to
 * say). `mention` is how the platform names them.
 */
export async function welcomeOnJoin(ctx, mention, display = mention) {
  const d = getChatDistributor(ctx.chatId, ctx.platform);
  if (!d || !(await f.isDistributor(d).catch(() => false))) return null;
  const i = await f.distributorInfo(d).catch(() => null);
  if (!i || i.welcomeAmount === 0n || i.welcomeGranted + i.welcomeAmount > i.welcomeCap) return null;
  return `👋 Welcome, ${display}! There's a welcome grant of ${fmt(i.welcomeAmount, i.token.decimals, i.token.symbol)} for new members: a council member approves it with \`${ctx.cmd("welcome")} ${mention}\`, then you take it with \`${ctx.cmd("claim")}\`.`;
}

export const FUNDS_COMMANDS = { allowance, distributor, claim, welcome, raise, contribute, refund, launch, vault };

/** The commands an older bot had for the WelcomeDistributor, now the Distributor's. */
export const RETIRED = { deploywelcomedistributor: "distributor", setdistributor: "distributor" };
