import { PublicKey } from "@solana/web3.js";
import { getChatSolana, updateChatSolana, registerSolanaChat } from "../db.js";
import { getSolanaNetwork } from "./config.js";
import { getOrCreateSolanaKeypair } from "./wallets.js";
import { accountId, mentionedUserId } from "../accountId.js";
import * as v from "./vortex.js";
import * as sf from "./funds.js";

/**
 * A Solana DAO's money and council seats - the same commands as EVM
 * (src/platforms/commands/funds.js), built by src/solana/funds.js:
 * /allowance, /distributor, /claim, /welcome, /raise, /contribute,
 * /refund, /vault, /seats, and the Delegate election commands with seats.
 * Proposals go through the actions in src/solana/fundsActions.js.
 *
 * `h` is commands.js's helpers (loadDao, member, proposeAction, fail,
 * reply, parseId, parseKey, requireModel, requireStake, num, duration).
 */
export function fundsCommands(h) {
  const { loadDao, member, proposeAction, fail, reply, parseId, parseKey, requireModel, requireStake, num, duration, MODEL_WORDS } = h;
  const big = (x) => BigInt(x?.toString?.() ?? x ?? 0);
  const when = (secs) => new Date(Number(secs) * 1000).toUTCString().replace(":00 GMT", " UTC");
  const opts = (words) => {
    const named = {};
    const rest = [];
    for (const w of words) {
      const m = String(w).match(/^([a-z]+)=(.+)$/i);
      if (m) named[m[1].toLowerCase()] = m[2];
      else rest.push(w);
    }
    return { named, rest, raw: words.filter((w) => /^[a-z]+=/i.test(w)) };
  };
  const account = (ctx) => sf.accountBytes(accountId(ctx.platform, ctx.userId));
  const symbolOf = (c) => c.link.symbol ?? "tokens";

  async function daoMint(c) {
    const mint = (await v.readDaoToken(c.network, c.d.dao)) ?? c.governance.mint;
    if (!mint) fail("This DAO has no token.");
    return mint;
  }

  /** The member a command names (a mention, a user id, or the replied-to author): { userId, wallet, account }. */
  async function namedMember(ctx, word) {
    const userId = mentionedUserId(word, ctx.replyToUserId);
    if (!userId) return null;
    const kp = await getOrCreateSolanaKeypair(userId, ctx.platform);
    return { userId, wallet: kp.publicKey, account: sf.accountBytes(accountId(ctx.platform, userId)) };
  }

  const chatRaise = (ctx) => {
    const r = getChatSolana(ctx.chatId, ctx.platform)?.raise;
    if (!r) fail(`There's no raise here. \`${ctx.cmd("raise")} open\` opens one.`);
    return new PublicKey(r);
  };

  function raiseText(ctx, r) {
    const f = (x) => v.formatUnits(big(x), r.decimals);
    const t = r.terms;
    const lines = [
      `*Raise* \`${r.address.toBase58()}\` - ${r.phase}`,
      `Raised ${f(r.total)} · soft cap ${f(t.softCap)}, target ${f(t.hardCap)} (contributions go past it)`,
      `Open ${when(t.start)} to ${when(t.end)}; the DAO decides by ${when(Number(t.end) + Number(t.decisionWindow))}.`,
    ];
    if (r.phase === "open") lines.push(`Contribute with \`${ctx.cmd("contribute")} <amount>\`.`);
    if (r.phase === "deciding") lines.push(`The DAO accepts an amount by proposal: \`${ctx.cmd("raise")} accept <amount>\`.`);
    if (r.phase === "accepted") lines.push(`Accepted ${f(r.accepted)}: \`${ctx.cmd("raise")} settle\`, then \`${ctx.cmd("claim")}\` and \`${ctx.cmd("refund")}\`.`);
    if (r.phase === "failed") lines.push(`It didn't go ahead: \`${ctx.cmd("refund")}\` returns everything.`);
    return lines.join("\n");
  }

  /**
   * `/launch ... solana` in a chat with no DAO yet: the DAO, its Distributor
   * and a raise the caller (the founder) decides, made now and linked here.
   */
  async function launchCreate(ctx, networkId, args) {
    const usage = `${ctx.cmd("launch")} <model> <name> <symbol> <supply> <tokensForSale|propfirm> <currency mint> <softCap> <hardCap> <days|30m|12h> solana [council...]`;
    const { named, rest } = opts(args);
    const [modelWord, name, symbol, supply, sale, currencyWord, soft, hard, span, ...councilArgs] = rest;
    if (!span) fail(`Usage: \`${usage}\`\nOne command makes the DAO, its Distributor and the raise; you accept an amount when it ends (\`${ctx.cmd("launch")} finish <amount>\`) and the money goes only to the DAO's treasury. \`propfirm\` instead of the tokens for sale makes a prop firm: its token is its vault's shares, minted from the money.`);
    const model = MODEL_WORDS[String(modelWord).toLowerCase()];
    if (!model || model === "board") fail("A launch makes a token DAO: tokenweighted, quadratic, optimistic, conviction, delegate, liquid, sortition, sowellian or decisionmarkets.");
    if (Buffer.byteLength(name) > 32) fail("The DAO's name must be 1-32 characters on Solana.");
    const network = getSolanaNetwork(networkId);
    const founder = await member(ctx, network);
    const council = ["delegate", "sortition"].includes(model) ? (councilArgs.length ? councilArgs.map((a) => parseKey(a, "a council member")) : [founder.publicKey]) : undefined;
    const propFirm = String(sale).toLowerCase() === "propfirm";
    const currency = parseKey(currencyWord, "the currency's mint");
    const cur = await v.mintInfo(network, currency);
    if (!propFirm && (!/^\d+$/.test(supply) || Number(supply) <= 0)) fail("The supply is a whole number of tokens above zero.");
    const made = await sf.launch(network, founder.publicKey, {
      name,
      model,
      council,
      supply: propFirm ? 0 : Number(supply),
      saleSupply: propFirm ? 0n : v.parseUnits(sale, v.TOKEN_DECIMALS),
      currency,
      softCap: v.parseUnits(soft, cur.decimals),
      hardCap: v.parseUnits(hard, cur.decimals),
      seconds: sf.parseSpan(span, "The raise's length"),
      decideSeconds: sf.parseSpan(named.decide ?? "7", "decide="),
      propFirm: propFirm ? sf.vaultConfig({ fast: network.fastTimings, performanceBps: Number(named.perf ?? 2000), managementBps: Number(named.mgmt ?? 200), maxDrawdownBps: Number(named.drawdown ?? 2000) }) : null,
    });
    registerSolanaChat(ctx.chatId, { network: networkId, dao: made.dao.toBase58(), model, mint: made.mint.toBase58(), symbol, creatorPlatformUserId: String(ctx.userId), raise: made.raise.toBase58(), launch: { founder: founder.publicKey.toBase58() } }, ctx.platform);
    return reply(
      [
        `✅ *${name}* launched on ${network.name}: raising ${soft} to ${hard} (more is welcome) over ${/^\d+$/.test(span) ? `${span} days` : span}.`,
        "",
        `DAO: \`${made.dao.toBase58()}\` · Treasury: \`${made.treasury.toBase58()}\``,
        `Token: \`${made.mint.toBase58()}\` (${symbol})${propFirm ? ` - the shares of its vault \`${made.vault.toBase58()}\`, minted from the money raised` : `: ${sale} for sale in its Distributor, the rest in its treasury`}`,
        `Raise: \`${made.raise.toBase58()}\` - \`${ctx.cmd("contribute")} <amount>\`.`,
        "",
        `When it ends you accept an amount: \`${ctx.cmd("launch")} finish <amount>\`. The money goes only to ${propFirm ? "the vault" : "the treasury"}; everyone gets tokens pro rata and the rest of their money back.`,
      ].join("\n")
    );
  }

  const commands = {
    allowance: {
      usage: "[grant <address> <amount> <sol|token|mint> <months> | change <id> <amount> <months> | revoke <id> | claim <id>]",
      description: "Monthly allowances the treasury pays: list, propose one, or claim yours",
      async run(ctx) {
        const c = await loadDao(ctx);
        const [sub, ...rest] = ctx.args;
        const usage = [
          `\`${ctx.cmd("allowance")} grant <address> <amount> <sol|token|mint> <months> [description]\` - propose paying someone monthly (up to 12 months)`,
          `\`${ctx.cmd("allowance")} change <id> <amount> <months>\` / \`revoke <id>\` - propose changing or ending one`,
          `\`${ctx.cmd("allowance")} claim <id>\` - the recipient takes this month's payment (a month not claimed lapses)`,
        ].join("\n");
        if (!sub) {
          const list = await sf.listAllowances(c.network, c.d);
          if (!list.length) return reply(`No allowances yet.\n\n${usage}`);
          const now = await v.clusterNow(c.network);
          const lines = await Promise.all(
            list.map(async (a) => {
              const decimals = a.mint ? (await v.mintInfo(c.network, a.mint)).decimals : 9;
              const unit = a.mint ? (a.mint.equals(c.governance.mint ?? PublicKey.default) ? symbolOf(c) : `of \`${a.mint.toBase58()}\``) : "SOL";
              const period = Math.floor((now - num(a.start)) / sf.MONTH) + 1;
              const state = a.revoked ? "revoked" : now >= num(a.endsAt) ? "ended" : period > num(a.paidThrough) ? "claimable now" : `next ${when(num(a.start) + period * sf.MONTH)}`;
              return `#${a.id} \`${a.recipient.toBase58()}\` ${v.formatUnits(big(a.amount), decimals)} ${unit}/month until ${when(a.endsAt)} - ${state}`;
            })
          );
          return reply(["*Allowances*", ...lines, "", usage].join("\n"));
        }
        const { raw, rest: words } = opts(rest);
        switch (sub.toLowerCase()) {
          case "grant": {
            const [to, amount, which, months, ...desc] = words;
            if (!to || !amount || !which || !months) fail(`Usage: \`${ctx.cmd("allowance")} grant <address> <amount> <sol|token|mint> <months> [description]\``);
            return (await proposeAction(ctx, c, "allowancegrant", [to, amount, which, months], desc.join(" ") || `Monthly allowance for ${to.slice(0, 8)}`, desc, raw)).reply;
          }
          case "change": {
            const [id, amount, months, ...desc] = words;
            if (!id || !amount || !months) fail(`Usage: \`${ctx.cmd("allowance")} change <id> <amount> <months>\``);
            return (await proposeAction(ctx, c, "allowancechange", [id, amount, months], desc.join(" ") || `Change allowance #${id}`, desc, raw)).reply;
          }
          case "revoke": {
            const [id, ...desc] = words;
            parseId(id, `${ctx.cmd("allowance")} revoke <id>`);
            return (await proposeAction(ctx, c, "allowancerevoke", [id], desc.join(" ") || `End allowance #${id}`, desc, raw)).reply;
          }
          case "claim": {
            const id = parseId(rest[0], `${ctx.cmd("allowance")} claim <id>`);
            const kp = await member(ctx, c.network);
            const r = await sf.claimAllowance(c.network, kp, c.d, id);
            const decimals = r.mint ? (await v.mintInfo(c.network, r.mint)).decimals : 9;
            return reply(`✅ Paid ${v.formatUnits(r.amount, decimals)} ${r.mint ? "tokens" : "SOL"} from the treasury for this month.`);
          }
          default:
            fail(usage);
        }
      },
    },

    distributor: {
      usage: "[open | fund <amount> | grant <address|@member> <amount> [cliff=<days>] [vest=<days>] | welcome <amount> <cap>]",
      description: "The DAO's Distributor: tokens promised to members, raises' buyers and welcome grants",
      async run(ctx) {
        const c = await loadDao(ctx);
        const mint = await daoMint(c);
        const [sub, ...rest] = ctx.args;
        const usage = [
          `\`${ctx.cmd("distributor")} open\` - make the DAO's Distributor (the bot pays; it holds nothing until the DAO funds it)`,
          `\`${ctx.cmd("distributor")} fund <amount>\` - propose moving tokens there from the treasury`,
          `\`${ctx.cmd("distributor")} grant <address|@member> <amount> [cliff=<days>] [vest=<days>]\` - propose a grant`,
          `\`${ctx.cmd("distributor")} welcome <amount> <cap>\` - propose welcome grants, approved by a council member with \`${ctx.cmd("welcome")}\``,
          `Members take what's theirs with \`${ctx.cmd("claim")}\`.`,
        ].join("\n");
        const { decimals } = await v.mintInfo(c.network, mint);
        const f = (x) => v.formatUnits(big(x), decimals);
        if (!sub) {
          await sf.requireProgram(c.network, "distribution");
          const { address, account: x } = await sf.distributorOf(c.network, c.d, mint);
          if (!x) return reply(`No Distributor yet.\n\n${usage}`);
          const held = big((await c.network.connection.getTokenAccountBalance(x.vault)).value.amount);
          return reply(
            [
              `*Distributor* \`${address.toBase58()}\``,
              `Promised, not yet claimed: ${f(x.outstanding)} ${symbolOf(c)} · free: ${f(held - big(x.outstanding))}`,
              `Grants so far: ${num(x.allocationCount)}${big(x.welcomeAmount) > 0n ? ` · welcome grants ${f(x.welcomeAmount)} each (${f(x.welcomeGranted)} of ${f(x.welcomeCap)} given)` : ""}`,
              `Claims close ${when(x.claimDeadline)}.`,
              "",
              usage,
            ].join("\n")
          );
        }
        const { raw, rest: words } = opts(rest);
        switch (sub.toLowerCase()) {
          case "open": {
            await sf.requireProgram(c.network, "distribution");
            if ((await sf.distributorOf(c.network, c.d, mint)).account) fail("This DAO already has a Distributor.");
            const address = await sf.createDistributor(c.network, c.d, mint, Number(opts(rest).named.days ?? 365));
            return reply(`✅ Distributor made: \`${address.toBase58()}\`. Fund it with \`${ctx.cmd("distributor")} fund <amount>\`.`);
          }
          case "fund": {
            const [amount, ...desc] = words;
            if (!amount) fail(`Usage: \`${ctx.cmd("distributor")} fund <amount>\``);
            return (await proposeAction(ctx, c, "distributorfund", [amount], desc.join(" ") || `Fund the Distributor with ${amount}`, desc, raw)).reply;
          }
          case "grant": {
            const [who, amount, ...desc] = words;
            const m = await namedMember(ctx, who).catch(() => null);
            if (!amount || (!m && !who)) fail(`Usage: \`${ctx.cmd("distributor")} grant <address|@member> <amount> [cliff=<days>] [vest=<days>]\``);
            const to = m ? `account:${Buffer.from(m.account).toString("hex")}` : parseKey(who, "the recipient").toBase58();
            return (await proposeAction(ctx, c, "distributorgrant", [to, amount], desc.join(" ") || `Grant ${amount} ${symbolOf(c)}`, desc, raw)).reply;
          }
          case "welcome": {
            const [amount, cap, ...desc] = words;
            if (!amount || !cap) fail(`Usage: \`${ctx.cmd("distributor")} welcome <amount> <cap>\``);
            return (await proposeAction(ctx, c, "distributorwelcome", [amount, cap], desc.join(" ") || `Welcome grants of ${amount}`, desc, raw)).reply;
          }
          default:
            fail(usage);
        }
      },
    },

    claim: {
      description: "Claim the tokens the DAO's Distributor holds for you",
      async run(ctx) {
        const c = await loadDao(ctx);
        const mint = await daoMint(c);
        const { address } = await sf.requireDistributor(c.network, c.d, mint);
        const kp = await member(ctx, c.network);
        const r = await sf.claimAll(c.network, kp, address, account(ctx));
        const { decimals } = await v.mintInfo(c.network, mint);
        if (r.claimed === 0n) {
          if (!r.rows.length) fail("The Distributor holds nothing for you.");
          fail(`Nothing has vested yet: ${v.formatUnits(r.rows.reduce((n, x) => n + x.total - x.claimed, 0n), decimals)} still vesting for you.`);
        }
        return reply(`✅ Claimed ${v.formatUnits(r.claimed, decimals)} ${symbolOf(c)} into \`${kp.publicKey.toBase58()}\`.`);
      },
    },

    welcome: {
      usage: "<@member>",
      description: "A council member approves a member's welcome grant",
      async run(ctx) {
        const c = await loadDao(ctx);
        requireModel(c.model, "delegate", "Welcome grants (approved by the council)");
        const mint = await daoMint(c);
        const { address } = await sf.requireDistributor(c.network, c.d, mint);
        const m = await namedMember(ctx, ctx.args[0]);
        if (!m) fail(`Usage: \`${ctx.cmd("welcome")} @member\` (on Telegram, reply to one of their messages).`);
        if (String(m.userId) === String(ctx.userId)) fail("A welcome grant is approved by someone else.");
        const kp = await member(ctx, c.network);
        if (!c.governance.council.some((x) => x.equals(kp.publicKey))) fail("Only a member of the DAO's council can approve welcome grants.");
        const r = await sf.grantWelcome(c.network, kp, c.d, address, m.wallet, m.account);
        const { decimals } = await v.mintInfo(c.network, mint);
        return reply(`✅ Welcome grant of ${v.formatUnits(r.amount, decimals)} ${symbolOf(c)} approved. They take it with \`${ctx.cmd("claim")}\`.`);
      },
    },

    raise: {
      usage: "[open <currency mint> <softCap> <hardCap> <days|30m|12h> <tokensForSale|propfirm> [min=] [max=] [cliff=<days>] [vest=<days>] [decide=<days>] | accept <amount> | settle]",
      description: "The DAO's raise: status, open one, accept an amount by proposal, settle",
      async run(ctx) {
        const [sub, ...rest] = ctx.args;
        const c = await loadDao(ctx);
        if (!sub) return reply(raiseText(ctx, await sf.readRaise(c.network, chatRaise(ctx))));
        const { named, raw, rest: words } = opts(rest);
        switch (sub.toLowerCase()) {
          case "open": {
            const [currencyWord, soft, hard, nDays, sale] = words;
            if (!currencyWord || !soft || !hard || !nDays || !sale) fail(`Usage: \`${ctx.cmd("raise")} open <currency mint> <softCap> <hardCap> <days> <tokensForSale|propfirm> [min=] [max=] [cliff=<days>] [vest=<days>] [decide=<days>]\` - the money only ever goes to the treasury (or a prop firm's vault), and the DAO accepts an amount by proposal when it ends.`);
            const currency = parseKey(currencyWord, "the currency's mint");
            const cur = await v.mintInfo(c.network, currency);
            const mint = await daoMint(c);
            const tok = await v.mintInfo(c.network, mint);
            let { address: distributor, account: dx } = await sf.distributorOf(c.network, c.d, mint);
            if (!dx) distributor = await sf.createDistributor(c.network, c.d, mint, 400);
            const propFirm = sale.toLowerCase() === "propfirm";
            const link = getChatSolana(ctx.chatId, ctx.platform);
            const nonce = propFirm ? (link.propFirmRaiseNonce ?? fail(`First make the DAO a prop firm: \`${ctx.cmd("vault")} create <asset mint> raise=1\` (a proposal), then open its raise.`)) : `${Date.now()}`;
            const vault = propFirm ? await sf.requireVault(c.network, c.d) : null;
            if (propFirm && !vault.assetMint.equals(currency)) fail(`The vault takes \`${vault.assetMint.toBase58()}\`: raise in that.`);
            const raise = await sf.createRaise(c.network, c.d, distributor, {
              currency,
              softCap: v.parseUnits(soft, cur.decimals),
              hardCap: v.parseUnits(hard, cur.decimals),
              seconds: sf.parseSpan(nDays, "The raise's length"),
              saleSupply: propFirm ? 0n : v.parseUnits(sale, tok.decimals),
              min: named.min ? v.parseUnits(named.min, cur.decimals) : 0n,
              max: named.max ? v.parseUnits(named.max, cur.decimals) : 0n,
              cliffDays: Number(named.cliff ?? 0),
              vestDays: Number(named.vest ?? 0),
              decideSeconds: sf.parseSpan(named.decide ?? "7", "decide="),
              propFirmVault: vault?.address ?? null,
              nonce,
            });
            updateChatSolana(ctx.chatId, { raise: raise.toBase58() }, ctx.platform);
            return reply(
              `✅ Raise open: \`${raise.toBase58()}\`, ${soft} to ${hard} over ${/^\d+$/.test(nDays) ? `${nDays} days` : nDays} (more is welcome)${propFirm ? ", into the vault: contributors share the shares it mints" : `, selling ${sale} ${symbolOf(c)} pro rata`}. Contribute with \`${ctx.cmd("contribute")} <amount>\`. When it ends the DAO accepts an amount by proposal (\`${ctx.cmd("raise")} accept <amount>\`); the money only ever goes to ${propFirm ? "its vault" : "its treasury"}.`
            );
          }
          case "accept": {
            const [amount, ...desc] = words;
            if (!amount) fail(`Usage: \`${ctx.cmd("raise")} accept <amount>\``);
            return (await proposeAction(ctx, c, "raiseaccept", [chatRaise(ctx).toBase58(), amount], desc.join(" ") || `Accept ${amount} of the raise`, desc, raw)).reply;
          }
          case "settle": {
            const n = await sf.settleAll(c.network, c.d, chatRaise(ctx));
            return reply(n ? `✅ Settled ${n} contributors: tokens are in the Distributor (\`${ctx.cmd("claim")}\`), refunds ready (\`${ctx.cmd("refund")}\`).` : "Everyone is already settled.");
          }
          default:
            fail(`Usage: \`${ctx.cmd("raise")} [open ... | accept <amount> | settle]\``);
        }
      },
    },

    contribute: {
      usage: "[amount]",
      description: "Put money into the open raise (tied to your chat account); without an amount, the treasury's address",
      async run(ctx) {
        const c = await loadDao(ctx);
        if (!ctx.args[0]) return reply(`💰 Send SOL or tokens to the treasury: \`${c.d.treasury.toBase58()}\`\nWhat's sent there is the DAO's: only a passed proposal moves it.`, { ephemeral: true });
        const raise = chatRaise(ctx);
        const r = await sf.readRaise(c.network, raise);
        const amount = v.parseUnits(ctx.args[0] ?? fail(`Usage: \`${ctx.cmd("contribute")} <amount>\``), r.decimals);
        const kp = await member(ctx, c.network, 120);
        await sf.contribute(c.network, kp, c.d, raise, amount, account(ctx));
        return reply(`✅ Contributed ${v.formatUnits(amount, r.decimals)}. If the raise goes ahead you get tokens pro rata and back whatever isn't accepted; if not, everything.`);
      },
    },

    refund: {
      description: "Take back what the raise didn't accept (or everything, if it didn't go ahead)",
      async run(ctx) {
        const c = await loadDao(ctx);
        const kp = await member(ctx, c.network);
        const r = await sf.withdrawRefund(c.network, kp, c.d, chatRaise(ctx));
        return reply(`✅ Refunded ${v.formatUnits(r.amount, r.decimals)}.`);
      },
    },

    launch: {
      usage: "finish <amount> | status",
      description: "The founder accepts the launch's raise (a new DAO starts with `launch ... solana`)",
      async run(ctx) {
        const [sub, amount] = ctx.args;
        const c = await loadDao(ctx);
        const link = getChatSolana(ctx.chatId, ctx.platform);
        if (!link.launch) fail(`This DAO wasn't launched here. A new one starts with \`${ctx.cmd("launch")} <model> <name> <symbol> <supply> <forSale|propfirm> <currency> <softCap> <hardCap> <days> solana\`.`);
        const raise = chatRaise(ctx);
        if (String(sub).toLowerCase() !== "finish") return reply(raiseText(ctx, await sf.readRaise(c.network, raise)));
        const r = await sf.readRaise(c.network, raise);
        const kp = await member(ctx, c.network);
        if (!r.decider.equals(kp.publicKey)) fail("Only the launch's founder accepts its raise.");
        if (r.phase !== "deciding") fail(r.phase === "open" ? "The raise hasn't ended yet." : `The raise is ${r.phase}.`);
        const raw = v.parseUnits(amount ?? fail(`Usage: \`${ctx.cmd("launch")} finish <amount>\``), r.decimals);
        await sf.founderAccept(c.network, kp, c.d, raise, raw);
        const propFirm = !r.propFirmVault.equals(PublicKey.default);
        return reply(`✅ Accepted ${v.formatUnits(raw, r.decimals)}: it's in the DAO's ${propFirm ? "vault, whose first shares are in the Distributor" : "treasury"}. Contributors: \`${ctx.cmd("raise")} settle\`, then \`${ctx.cmd("claim")}\` and \`${ctx.cmd("refund")}\`.`);
      },
    },

    vault: {
      usage: "[create <asset mint> [fees=<addr>:<bps>,...] [raise=1] | deposit <amount> | redeem <shares> | cancel | claim | window | pause | resume | allow <address> | venues <perpAssetMap> <trader,...>]",
      description: "The prop firm's vault: its value, deposits and redemptions at windows, and the DAO's settings",
      async run(ctx) {
        const c = await loadDao(ctx);
        const [sub, ...rest] = ctx.args;
        const { raw, named, rest: words } = opts(rest);
        if (sub?.toLowerCase() === "create") {
          const [assetMint, ...desc] = words;
          if (!assetMint) fail(`Usage: \`${ctx.cmd("vault")} create <asset mint> [fees=<address>:<bps>,...] [mgmt=<bps>] [perf=<bps>] [drawdown=<bps>] [interval=<days>] [raise=1]\``);
          await sf.requireProgram(c.network, "vault");
          const made = await proposeAction(ctx, c, "vaultcreate", [assetMint], desc.join(" ") || "Make this DAO a prop firm", desc, raw);
          if (named.raise) updateChatSolana(ctx.chatId, { propFirmRaiseNonce: named.raise }, ctx.platform);
          return made.reply;
        }
        const x = await sf.requireVault(c.network, c.d);
        const ad = x.assetDecimals;
        const sd = (await v.mintInfo(c.network, x.shareMint)).decimals;
        if (!sub) {
          const supply = big((await c.network.connection.getTokenSupply(x.shareMint)).value.amount);
          const idle = big((await c.network.connection.getTokenAccountBalance(x.assets)).value.amount);
          return reply(
            [
              `*Vault* \`${x.address.toBase58()}\`${x.paused ? " - ⏸ trading paused (drawdown or by proposal)" : ""}`,
              `Idle ${v.formatUnits(idle, ad)} · ${v.formatUnits(supply, sd)} shares · ${x.phoenixTraders.length} Phoenix account(s) counted in its value at each window`,
              `Window ${num(x.epoch)} closes ${when(x.nextWindowAt)} · waiting to deposit ${v.formatUnits(big(x.pendingDepositAssets), ad)} · owed to redeemers ${v.formatUnits(big(x.owedAssets), ad)}`,
              `Fees: ${x.config.managementBps / 100}% a year + ${x.config.performanceBps / 100}% of gains · trading pauses ${x.config.maxDrawdownBps / 100}% below the high.`,
              "",
              `\`${ctx.cmd("vault")} deposit <amount>\` / \`redeem <shares>\` - priced at the next window; \`cancel\` before it; \`claim\` after it.`,
            ].join("\n")
          );
        }
        const kp = () => member(ctx, c.network, 200);
        switch (sub.toLowerCase()) {
          case "deposit": {
            const amount = v.parseUnits(words[0] ?? fail("How much?"), ad);
            await sf.vaultDeposit(c.network, await kp(), c.d, amount);
            return reply(`✅ ${v.formatUnits(amount, ad)} waiting for the window on ${when(x.nextWindowAt)}; then \`${ctx.cmd("vault")} claim\` your shares.`);
          }
          case "redeem": {
            const shares = v.parseUnits(words[0] ?? fail("How many shares?"), sd);
            await sf.vaultRedeem(c.network, await kp(), c.d, shares);
            return reply(`✅ ${v.formatUnits(shares, sd)} shares to redeem at the window on ${when(x.nextWindowAt)}; then \`${ctx.cmd("vault")} claim\` the money.`);
          }
          case "cancel": {
            const r = await sf.vaultCancel(c.network, await kp(), c.d);
            return reply(`✅ Cancelled${r.deposit ? ` your ${v.formatUnits(r.deposit, ad)} deposit` : ""}${r.deposit && r.redeem ? " and" : ""}${r.redeem ? ` your ${v.formatUnits(r.redeem, sd)}-share redemption` : ""}.`);
          }
          case "claim": {
            const r = await sf.vaultClaim(c.network, await kp(), c.d);
            return reply(`✅ Claimed${r.shares ? ` ${v.formatUnits(r.shares, sd)} shares` : ""}${r.shares && r.assets ? " and" : ""}${r.assets ? ` ${v.formatUnits(r.assets, ad)}` : ""}.`);
          }
          case "window": {
            const r = await sf.vaultProcessWindow(c.network, c.d);
            return reply(`✅ Window ${r.epoch} processed: requests are priced; \`${ctx.cmd("vault")} claim\`.`);
          }
          case "pause":
          case "resume":
            return (await proposeAction(ctx, c, `vault${sub.toLowerCase()}`, [], words.join(" ") || `${sub} the vault's trading`, words, raw)).reply;
          case "allow": {
            const [who, ...desc] = words;
            return (await proposeAction(ctx, c, "vaultallow", [who ?? fail(`Usage: \`${ctx.cmd("vault")} allow <address>\``)], desc.join(" ") || "Let an address deposit in the vault", desc, raw)).reply;
          }
          case "venues": {
            const [map, traders, ...desc] = words;
            if (!map || !traders) fail(`Usage: \`${ctx.cmd("vault")} venues <perpAssetMap> <trader,...>\``);
            return (await proposeAction(ctx, c, "vaultvenues", [map, traders], desc.join(" ") || "Value the vault from its Phoenix accounts", desc, raw)).reply;
          }
          default:
            fail(`Usage: \`${ctx.cmd("vault")} ${this.usage}\``);
        }
      },
    },

    seats: {
      usage: "[electionId]",
      description: "The council by seat; with an election, each seat's candidates and votes",
      models: ["delegate"],
      async run(ctx) {
        const c = await loadDao(ctx);
        requireModel(c.model, "delegate", "Council seats");
        const g = c.governance;
        const labels = g.seatLabels ?? [];
        const id = ctx.args[0] ? parseId(ctx.args[0], `${ctx.cmd("seats")} [electionId]`) : null;
        const e = id ? await v.readElection(c.network, c.d.election(id)) : null;
        if (id && !e) fail(`There's no election #${id}.`);
        const lines = [];
        for (let s = 0; s < g.config.councilSize; s++) {
          const holder = g.council[s];
          const vacant = !holder || holder.equals(PublicKey.default);
          lines.push(`*Seat ${s + 1}*${labels[s] ? ` (${labels[s]})` : ""}: ${vacant ? "vacant" : `\`${holder.toBase58()}\``}`);
          if (e) {
            const running = e.candidates.filter((x) => x.seat === s);
            lines.push(running.length ? running.map((x) => `  \`${x.key.toBase58()}\` ${v.formatUnits(big(x.votes), c.tok?.decimals ?? 0)} votes`).join("\n") : "  nobody running: the holder stays");
          }
        }
        return reply([e ? `*Election #${id}, by seat*` : "*Council seats*", ...lines].join("\n"));
      },
    },

    declarecandidacy: {
      usage: "[electionId] [seat]",
      description: "Run for a council seat in the open election (seat 1 if not given)",
      models: ["delegate"],
      async run(ctx) {
        const { network, d, model, governance: g } = await loadDao(ctx);
        requireModel(model, "delegate", "Elections");
        const id = ctx.args[0] ? parseId(ctx.args[0], `${ctx.cmd("declarecandidacy")} [electionId] [seat]`) : num(g.electionCount);
        if (id === 0) fail(`No election has been started. \`${ctx.cmd("startelection")}\` opens one once the term is over.`);
        const seat = ctx.args[1] === undefined ? 1 : Number(ctx.args[1]);
        if (!Number.isInteger(seat) || seat < 1 || seat > g.config.councilSize) fail(`Seats are numbered 1 to ${g.config.councilSize}; \`${ctx.cmd("seats")}\` lists them.`);
        const kp = await member(ctx, network);
        if (!(await v.readMember(network, model, d, kp.publicKey))) fail(`Stake some tokens first: \`${ctx.cmd("stake")} <amount>\`.`);
        await sf.declareCandidacy(network, kp, d, id, seat - 1);
        return reply(`✅ You're running for seat ${seat} in election #${id} as \`${kp.publicKey.toBase58()}\`. Your stake stays locked until voting ends.`);
      },
    },

    voteinelection: {
      usage: "<electionId> <candidate...>",
      description: "Vote for council candidates, one per seat",
      models: ["delegate"],
      async run(ctx) {
        const usage = `${ctx.cmd("voteinelection")} <electionId> <candidate...>`;
        const id = parseId(ctx.args[0], usage);
        const candidates = ctx.args.slice(1).map((a) => parseKey(a, "a candidate"));
        if (candidates.length === 0) fail(`Usage: \`${usage}\``);
        const { network, d, model, governance: g } = await loadDao(ctx);
        requireModel(model, "delegate", "Elections");
        if (new Set(candidates.map((x) => x.toBase58())).size !== candidates.length) fail("You named the same candidate twice.");
        const e = await v.readElection(network, d.election(id));
        if (!e) fail(`There's no election #${id}.`);
        const seats = new Map();
        for (const cand of candidates) {
          const found = e.candidates.find((x) => x.key.equals(cand));
          if (!found) fail(`\`${cand.toBase58()}\` isn't running in election #${id}. \`${ctx.cmd("seats")} ${id}\` lists the candidates.`);
          if (seats.has(found.seat)) fail(`Two of them run for seat ${found.seat + 1}: vote for one candidate per seat.`);
          seats.set(found.seat, cand);
        }
        if (candidates.length > g.config.councilSize) fail(`You can vote for at most ${g.config.councilSize} candidates (one per seat).`);
        const kp = await member(ctx, network);
        await requireStake(ctx, network, d, model, kp);
        if (await network.connection.getAccountInfo(d.ballot(d.election(id), kp.publicKey))) fail(`You've already voted in election #${id}.`);
        await v.voteInElection(network, kp, d, id, candidates);
        return reply(`✅ Voted for ${candidates.length} candidate(s) in election #${id}, one per seat; each gets your whole stake. It stays locked until voting ends.`);
      },
    },

    finalizeelection: {
      usage: "[electionId]",
      description: "Close the election and seat the winners (a tied seat is drawn by lot)",
      models: ["delegate"],
      async run(ctx) {
        const { network, d, model, governance: g } = await loadDao(ctx);
        requireModel(model, "delegate", "Elections");
        const id = ctx.args[0] ? parseId(ctx.args[0], `${ctx.cmd("finalizeelection")} [electionId]`) : num(g.electionCount);
        if (id === 0) fail("No election has been started.");
        const r = await sf.finalizeElection(network, d, id);
        if (r.drawRequested) return reply(`🎲 A seat in election #${id} is tied, so it's drawn by lot (ORAO). Run \`${ctx.cmd("finalizeelection")} ${id}\` again in a minute to seat the council.`);
        const after = await v.readGovernance(network, model, d.governance);
        if (after.councilTerm === g.councilTerm) return reply(`Election #${id} closed with no votes, so the council stays. A new election can start right away.`);
        return reply([`✅ Election #${id} closed. \`${ctx.cmd("seats")}\` shows the new council:`, ...after.council.map((m, i) => `• Seat ${i + 1}: ${m.equals(PublicKey.default) ? "vacant" : `\`${m.toBase58()}\``}`), "", "Proposals from the previous council can no longer run."].join("\n"));
      },
    },
  };
  return { commands, create: { launch: launchCreate } };
}
