import * as rise from "@ellipsis-labs/rise";
import { getChatDesk, updateChatDesk } from "../db.js";
import { parsePerps, PerpsError } from "../perps.js";
import { deskCardImage } from "../charts.js";
import { deletePhoenixAgentKey } from "../walletStore.js";
import { DeskError, parseMandate, mandateText, checkOpen, isTrader, pickTrader, takeFor, mineLines, dayOf, addRealized, fmt } from "../deskMandate.js";
import { getSolanaOperator } from "./config.js";
import { createPhoenixAgentKey, getPhoenixAgentKey, getSolanaAddress } from "./wallets.js";
import * as v from "./vortex.js";
import * as phx from "./phoenix.js";

/**
 * The trading desk on Solana: Phoenix perps, run like the HyperCore desk
 * (src/deskHypercore.js) - the bot holds each trader's key and signs their
 * orders only after the mandate checks (src/deskMandate.js) - but with
 * Phoenix keeping every trader apart on-chain:
 *
 * - The Treasury is registered on Phoenix once (`desk register`, through
 *   Phoenix's no-referral onboarding API; the operator pays). Its cross
 *   account (subaccount 0) receives deposits.
 * - Each trader gets their own isolated subaccount (1, 2, ...), delegated by
 *   proposal to a key the bot makes for that appointment (Phoenix's
 *   position authority). On-chain, that key can trade the subaccount and
 *   never withdraw from it; a trader's losses stop at what their subaccount
 *   holds. An isolated subaccount holds one position at a time.
 * - Money moves only by proposal: fund, withdraw (src/solana/integrations/
 *   phoenix.js). Removing a trader delegates the subaccount back to the
 *   Treasury and destroys the key; a trader resigning destroys it at once.
 *
 * Record per chat (db.js getChatDesk): { venue: "phoenix", traders:
 * { [sub]: trader }, pending: { [proposalId]: appointment or removal },
 * paused }. A trader: { sub, agentId, agent, platform, userId, address,
 * mandate, since, expiresAt, day }.
 */

const CLOSED = new Set(["Defeated", "Cancelled", "Expired", "Rejected", "Failed", "ChallengeFailed"]);
const UNIT = "USDC";

const usage = (cmd) => {
  const d = cmd("desk");
  return [
    `\`${d}\` - the DAO's Phoenix desk: traders, limits, collateral, positions`,
    `\`${d} register\` - register the Treasury on Phoenix (once; the bot pays)`,
    `\`${d} apply <markets|all> max=<size> [total=<size>] [loss=<size>] [lev=2] [days=30]\` - propose yourself as a trader, on your own isolated subaccount (sizes in USDC)`,
    `\`${d} fund <amount> [for=<n>]\` / \`${d} withdraw <amount|all> [for=<n>]\` - propose moving USDC between the Treasury and a trader's subaccount`,
    `\`${d} remove [n]\` - propose taking a trader's subaccount back · \`${d} resign\` - a trader steps down`,
    `\`${d} pause\` / \`${d} resume\` - chat admins or the DAO's creator stop new positions at once (closing stays allowed)`,
    `\`${d} long|short <market> <size> at <limitPrice>\` / \`${d} close <market> <size|all> at <limitPrice>\` - a trader trades, no vote`,
    `\`${d} mine\` - a trader's own position and how much of their limits they use`,
    "Each trader's key can trade their subaccount but never withdraw: Phoenix allows that only to the Treasury, by proposal.",
  ].join("\n");
};

const reply = (text, extra = {}) => ({ text, ...extra });

function normalize(rec) {
  if (rec?.venue !== "phoenix") return { venue: "phoenix", traders: {}, pending: {} };
  return { traders: {}, pending: {}, ...rec };
}
const recordOf = (chat) => normalize(getChatDesk(chat.chatId, chat.platform));
const update = (chat, change) => updateChatDesk(chat.chatId, (cur) => change(normalize(cur)), chat.platform);

/** Traders in subaccount order: [{ sub, ...trader }]. */
const tradersOf = (rec) => Object.values(rec.traders).sort((a, b) => a.sub - b.sub);

const forget = (agentId) => deletePhoenixAgentKey(agentId).catch((err) => console.error(`Phoenix desk: couldn't delete key ${agentId}:`, err.message));

/** The first subaccount with no trader and no appointment waiting for it. */
function freeSub(rec) {
  const used = new Set([...Object.keys(rec.traders).map(Number), ...Object.values(rec.pending).map((p) => p.sub)]);
  for (let sub = 1; sub <= phx.MAX_SUBACCOUNT; sub++) if (!used.has(sub)) return sub;
  throw new DeskError("Every Phoenix subaccount is taken.");
}

/*//////////////////////////////////////////////////////////////
                     APPOINTMENT LIFECYCLE
//////////////////////////////////////////////////////////////*/

/**
 * Settles what has changed on-chain: an appointment is active once its
 * subaccount is delegated to its key; a removal is done once it's
 * delegated back to the Treasury; a proposal that failed is dropped (and
 * an unused key destroyed); a trader whose subaccount was delegated away
 * is cleared. Returns lines for the chat.
 */
async function refresh(chat, c) {
  const rec = recordOf(chat);
  if (!Object.keys(rec.pending).length && !Object.keys(rec.traders).length) return [];
  const now = await v.clusterNow(c.network);
  const authorityOf = new Map();
  const delegate = async (sub) => {
    if (!authorityOf.has(sub)) authorityOf.set(sub, (await phx.readTrader(c.network, c.d.treasury, sub))?.positionAuthority ?? null);
    return authorityOf.get(sub);
  };
  const news = [];
  const changes = [];
  for (const [id, p] of Object.entries(rec.pending)) {
    const proposal = await v.readProposal(c.network, c.model, c.d.proposal(Number(id))).catch(() => null);
    const state = proposal ? v.proposalState(c.model, proposal, c.governance, now) : "Unknown";
    const target = p.kind === "appoint" ? p.agent : c.d.treasury.toBase58();
    if ((await delegate(p.sub)) === target) {
      changes.push({ id, p, done: true });
      news.push(p.kind === "appoint" ? `📈 \`${p.address}\` now trades Phoenix subaccount ${p.sub} (${mandateText(p.mandate, UNIT)}).` : `📉 Subaccount ${p.sub} is back with the Treasury; its trader's key is destroyed.`);
    } else if (CLOSED.has(state) || (state === "Executed" && proposal)) {
      // Executed but not delegated as planned (a newer proposal moved it), or never passed.
      changes.push({ id, p, done: false });
      if (state === "Executed") news.push(`⚠️ Proposal #${id} executed, but subaccount ${p.sub} isn't delegated as it said - nothing changed.`);
    }
  }
  const cleared = [];
  for (const t of tradersOf(rec)) {
    if (changes.some((ch) => ch.done && ch.p.sub === t.sub)) continue;
    if ((await delegate(t.sub)) !== t.agent) {
      cleared.push(t);
      news.push(`📉 \`${t.address}\` no longer trades subaccount ${t.sub}.`);
    }
  }
  if (!changes.length && !cleared.length) return news;
  const destroy = [];
  update(chat, (cur) => {
    for (const t of cleared) {
      if (cur.traders[t.sub]?.agentId === t.agentId) delete cur.traders[t.sub];
      destroy.push(t.agentId);
    }
    for (const { id, p, done } of changes) {
      delete cur.pending[id];
      if (p.kind === "appoint" && done) {
        const previous = cur.traders[p.sub];
        if (previous && previous.agentId !== p.agentId) destroy.push(previous.agentId);
        const { kind: _, ...trader } = p;
        cur.traders[p.sub] = { ...trader, since: Date.now(), expiresAt: Date.now() + p.mandate.days * 86_400_000 };
      } else if (p.kind === "appoint") destroy.push(p.agentId);
      if (p.kind === "remove" && done && cur.traders[p.sub]) {
        destroy.push(cur.traders[p.sub].agentId);
        delete cur.traders[p.sub];
      }
    }
    return cur;
  });
  for (const id of new Set(destroy)) await forget(id);
  return news;
}

/*//////////////////////////////////////////////////////////////
                           COMMANDS
//////////////////////////////////////////////////////////////*/

/**
 * /desk in a chat linked to a Solana DAO. `c` is the loaded DAO
 * (commands.js loadDao); `propose(actionId, args, description)` makes a
 * proposal from the caller's wallet and returns { id, reply };
 * `isCreator` says whether the caller created the DAO.
 */
export async function runPhoenixDesk(ctx, c, { propose, isCreator }) {
  const chat = { chatId: ctx.chatId, platform: ctx.platform, userId: ctx.userId };
  const [sub = "", ...args] = ctx.args;
  try {
    if (c.network.id !== "solana-mainnet") throw new DeskError(`The trading desk on Solana runs on Phoenix, which is on mainnet only - not ${c.network.name}.`);
    switch (sub.toLowerCase()) {
      case "":
      case "status":
        return await status(chat, c, ctx.cmd);
      case "help":
        return reply(usage(ctx.cmd));
      case "register":
        return reply(await register(c));
      case "apply":
        return await apply(chat, c, args, propose);
      case "fund":
      case "withdraw":
        return await move(chat, c, sub.toLowerCase(), args, propose);
      case "remove":
        return await remove(chat, c, args, propose);
      case "resign":
        return reply(await resign(chat, c));
      case "pause":
      case "resume": {
        if (ctx.isAdmin !== true && !(await isCreator())) throw new DeskError("Only this chat's admins or the DAO's creator can pause or resume the desk. Anyone can propose removing a trader: `desk remove`.");
        return reply(setPaused(chat, sub.toLowerCase() === "pause", ctx.isAdmin === true ? "a chat admin" : "the DAO's creator"));
      }
      case "mine":
      case "me":
        return await mine(chat, c, ctx.cmd);
      case "long":
      case "short":
      case "buy":
      case "sell":
      case "close":
        return reply(await trade(chat, c, ctx.args));
      default:
        throw new DeskError(`Unknown \`desk ${sub}\`.`);
    }
  } catch (err) {
    if (err instanceof DeskError || err instanceof PerpsError) return reply(`${err.message}\n\n${usage(ctx.cmd)}`);
    throw err;
  }
}

async function register(c) {
  const operator = getSolanaOperator();
  if (!operator) throw new DeskError("This bot has no Solana operator wallet to pay for registering.");
  if (await phx.readTrader(c.network, c.d.treasury, phx.CROSS)) return "✅ The Treasury is already registered on Phoenix.";
  const sig = await phx.registerWithPhoenix(c.network, operator, c.d.treasury);
  return `✅ The Treasury is registered on Phoenix (its cross account receives deposits).\nTx: \`${sig}\`\nNext: someone \`desk apply\`s as a trader.`;
}

async function apply(chat, c, words, propose) {
  if (!(await phx.readTrader(c.network, c.d.treasury, phx.CROSS))) throw new DeskError("The Treasury isn't on Phoenix yet: run `desk register` first.");
  const mandate = parseMandate(words);
  if (mandate.markets !== "all") {
    const listed = await phx.marketSymbols(c.network);
    const unknown = mandate.markets.filter((m) => !listed.includes(m));
    if (unknown.length) throw new DeskError(`Unknown Phoenix market${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Markets: ${listed.join(", ")}.`);
  }
  await refresh(chat, c);
  const rec = recordOf(chat);
  const address = (await getSolanaAddress(chat.userId, chat.platform))?.toBase58() ?? `user ${chat.userId}`;
  // A trader applying again keeps their subaccount (a new mandate and key); anyone else gets a free one.
  const sub = tradersOf(rec).find((t) => isTrader(t, chat))?.sub ?? freeSub(rec);
  const agentId = `${chat.platform}:${chat.chatId}:${sub}:${Date.now()}`;
  const agent = (await createPhoenixAgentKey(agentId)).publicKey.toBase58();
  const description = `Appoint ${address} as trader of Phoenix subaccount ${sub}: ${mandateText(mandate, UNIT)}. Can trade it, never withdraw.`.slice(0, 200);
  let made;
  try {
    made = await propose("phoenix-appoint", [String(sub), agent], description);
  } catch (err) {
    await forget(agentId);
    throw err;
  }
  update(chat, (cur) => {
    cur.pending[String(made.id)] = { kind: "appoint", sub, agentId, agent, platform: chat.platform, userId: String(chat.userId), address, mandate };
    return cur;
  });
  const fresh = !(await phx.readTrader(c.network, c.d.treasury, sub));
  return { ...made.reply, text: `${made.reply.text}\n\n${fresh ? "Once it runs, fund the subaccount with a `desk fund` proposal." : ""}`.trim() };
}

async function move(chat, c, kind, words, propose) {
  const rec = recordOf(chat);
  const [which, rest] = takeFor(words);
  const list = tradersOf(rec);
  if (!list.length) throw new DeskError("The desk has no trader yet - someone has to `desk apply` and the proposal pass first.");
  const t = pickTrader(list, which, "trader");
  const amount = String(rest[0] ?? "").replace(/,/g, "");
  if (!(/^\d+(\.\d+)?$/.test(amount) || (kind === "withdraw" && amount.toLowerCase() === "all"))) throw new DeskError(`Give an amount: \`desk ${kind} <amount${kind === "withdraw" ? "|all" : ""}> [for=<n>]\`.`);
  const description = (rest.slice(1).join(" ") || `${kind === "fund" ? "Fund" : "Withdraw from"} ${t.address}'s Phoenix subaccount ${t.sub}: ${amount} USDC.`).slice(0, 200);
  return (await propose(`phoenix-${kind}`, [String(t.sub), amount], description)).reply;
}

async function remove(chat, c, words, propose) {
  await refresh(chat, c);
  const rec = recordOf(chat);
  const list = tradersOf(rec);
  if (!list.length) throw new DeskError("The desk has no trader to remove.");
  const named = /^#?\d+$/.test(words[0] ?? "") || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(words[0] ?? "");
  const t = pickTrader(list, named ? words[0] : undefined, "trader");
  const description = ((named ? words.slice(1) : words).join(" ") || `Remove ${t.address} as the trader of Phoenix subaccount ${t.sub}.`).slice(0, 200);
  const made = await propose("phoenix-remove", [String(t.sub)], description);
  update(chat, (cur) => {
    cur.pending[String(made.id)] = { kind: "remove", sub: t.sub, agentId: t.agentId, agent: t.agent, platform: t.platform, userId: t.userId, address: t.address, mandate: t.mandate };
    return cur;
  });
  return made.reply;
}

async function resign(chat, c) {
  await refresh(chat, c);
  const t = tradersOf(recordOf(chat)).find((x) => isTrader(x, chat));
  if (!t) throw new DeskError("Only the desk's traders can resign, and you aren't one.");
  update(chat, (cur) => {
    delete cur.traders[t.sub];
    return cur;
  });
  await forget(t.agentId);
  return `✅ You've stepped down; your trading key for subaccount ${t.sub} is destroyed, so nobody can trade it. Its open position stays open until the DAO appoints someone (\`desk apply\`) or takes it back (\`desk remove\`), and its collateral stays put until a \`desk withdraw\`.`;
}

function setPaused(chat, paused, by) {
  const rec = recordOf(chat);
  if (!Object.keys(rec.traders).length && !Object.keys(rec.pending).length) throw new DeskError("This DAO has no trading desk yet.");
  if (Boolean(rec.paused) === paused) throw new DeskError(paused ? "The desk is already paused." : "The desk isn't paused.");
  update(chat, (cur) => ({ ...cur, paused: paused ? { by, at: Date.now() } : null }));
  return paused ? "⏸️ Trading desk paused: no trader can open or add to positions until it's resumed. Closing stays allowed." : "▶️ Trading desk resumed: traders can trade within their mandates again.";
}

/*//////////////////////////////////////////////////////////////
                           STATUS
//////////////////////////////////////////////////////////////*/

async function status(chat, c, cmd) {
  const news = await refresh(chat, c);
  const rec = recordOf(chat);
  const lines = [...news, ...(news.length ? [""] : []), "*Trading desk* (Phoenix)"];
  if (!(await phx.readTrader(c.network, c.d.treasury, phx.CROSS))) {
    lines.push(`The Treasury isn't registered on Phoenix yet: \`${cmd("desk")} register\`.`);
    return reply(lines.join("\n"));
  }
  if (rec.paused) lines.push(`⏸️ Paused${rec.paused.by ? ` by ${rec.paused.by}` : ""}: no new positions until \`${cmd("desk")} resume\`.`);
  const [subs, marks] = await Promise.all([phx.subaccounts(c.network, c.d.treasury), phx.markPrices(c.network)]);
  lines.push(`Cross account (deposits waiting to be assigned): ${fmt(subs[phx.CROSS]?.collateral ?? 0, 2)} ${UNIT}`);
  const traders = tradersOf(rec);
  if (!traders.length) lines.push(`No trader yet. A would-be trader starts with \`${cmd("desk")} apply <markets> max=<size>\`.`);
  const card = [];
  let collateral = 0;
  for (const [i, t] of traders.entries()) {
    const s = subs[t.sub] ?? { collateral: 0, positions: [] };
    const positions = phx.withMarks(s.positions, marks);
    collateral += s.collateral;
    const ended = Date.now() > t.expiresAt;
    lines.push("", `*${i + 1}.* \`${t.address}\` - subaccount ${t.sub}`, `${mandateText(t.mandate, UNIT)}${ended ? " - ⏰ mandate ended" : `, until ${new Date(t.expiresAt).toISOString().slice(0, 10)}`}`);
    lines.push(`Collateral: ${fmt(s.collateral, 2)} ${UNIT}${s.collateral ? "" : ` - \`${cmd("desk")} fund <amount>${traders.length > 1 ? ` for=${i + 1}` : ""}\``}`);
    if (!positions.length) lines.push("No open position.");
    for (const p of positions) lines.push(`• ${p.symbol} ${p.side} ${fmt(p.size)} @ ${fmt(p.entry, 2)} · mark ${fmt(p.mark, 2)} · PnL ${p.pnl >= 0 ? "+" : ""}${fmt(p.pnl, 2)} ${UNIT}`);
    card.push(...positions.map((p) => ({ ...p, owner: traders.length > 1 ? `trader ${i + 1}` : null })));
  }
  const pending = Object.entries(rec.pending);
  if (pending.length) lines.push("");
  for (const [id, p] of pending) lines.push(p.kind === "appoint" ? `Proposed: \`${p.address}\` on subaccount ${p.sub} (proposal #${id}) - ${mandateText(p.mandate, UNIT)}` : `Proposed: taking subaccount ${p.sub} back (proposal #${id})`);
  const image = deskCardImage({ title: "Trading desk", subtitle: `Phoenix · ${traders.length} trader${traders.length === 1 ? "" : "s"}`, positions: card, symbol: UNIT, collateral: collateral ? `${fmt(collateral, 2)} ${UNIT}${traders.length > 1 ? " across the traders" : ""}` : null });
  return reply(lines.join("\n"), { image });
}

async function mine(chat, c, cmd) {
  await refresh(chat, c);
  const rec = recordOf(chat);
  const list = tradersOf(rec);
  const n = list.findIndex((t) => isTrader(t, chat));
  if (n < 0) throw new DeskError(`You aren't one of the desk's traders - \`${cmd("desk")}\` shows who is.`);
  const t = list[n];
  const [subs, marks] = await Promise.all([phx.subaccounts(c.network, c.d.treasury), phx.markPrices(c.network)]);
  const s = subs[t.sub] ?? { collateral: 0, positions: [] };
  const positions = phx.withMarks(s.positions, marks);
  const notional = positions.reduce((sum, p) => sum + p.size * p.mark, 0);
  const { day, pnl } = dayOf(t, positions.reduce((sum, p) => sum + p.pnl, 0));
  if (day !== t.day) saveDay(chat, t.sub, day);
  const lines = mineLines(rec, t, { venue: "Phoenix", n: list.length > 1 ? n + 1 : null, positions, deskNotional: notional, symbol: UNIT, cmd, dayPnl: pnl });
  lines.splice(1, 0, `Subaccount ${t.sub} · collateral ${fmt(s.collateral, 2)} ${UNIT}${s.collateral ? ` · leverage ${fmt(notional / s.collateral, 2)}x` : ""}`);
  const image = deskCardImage({ title: "Your trading", subtitle: `Phoenix · subaccount ${t.sub}`, positions, symbol: UNIT, mandate: t.mandate, deskNotional: notional, collateral: `${fmt(s.collateral, 2)} ${UNIT}` });
  return reply(lines.join("\n"), { image });
}

function saveDay(chat, sub, day) {
  update(chat, (cur) => {
    if (cur.traders[sub]) cur.traders[sub].day = day;
    return cur;
  });
}

/*//////////////////////////////////////////////////////////////
                           TRADING
//////////////////////////////////////////////////////////////*/

/**
 * /desk long|short|close: an immediate-or-cancel order on the trader's own
 * subaccount at their limit price or better, signed with their key after
 * the mandate checks. The operator pays the fee. Leverage is what the
 * position would be against the subaccount's collateral.
 */
async function trade(chat, c, words) {
  await refresh(chat, c);
  const rec = recordOf(chat);
  const t = tradersOf(rec).find((x) => isTrader(x, chat));
  if (!t) throw new DeskError("Only the desk's appointed traders can trade.");
  const request = parsePerps(words);
  if (request.kind !== "open" && request.kind !== "close") throw new DeskError("Use `desk long|short <market> <size> at <price>` or `desk close <market> <size|all> at <price>`.");
  const operator = getSolanaOperator();
  if (!operator) throw new DeskError("This bot has no Solana operator wallet to pay the fee.");
  const agent = await getPhoenixAgentKey(t.agentId);
  if (!agent) throw new DeskError("Your trading key is gone - the DAO has to appoint you again.");
  const onChain = await phx.readTrader(c.network, c.d.treasury, t.sub);
  if (onChain?.positionAuthority !== t.agent) throw new DeskError(`Subaccount ${t.sub} isn't delegated to your key any more.`);

  const m = await phx.market(c.network, request.market);
  const [subs, marks] = await Promise.all([phx.subaccounts(c.network, c.d.treasury), phx.markPrices(c.network)]);
  const s = subs[t.sub] ?? { collateral: 0, positions: [] };
  if (!s.collateral && request.kind === "open") throw new DeskError("Your subaccount has no collateral yet - it needs a `desk fund` proposal first.");
  const positions = phx.withMarks(s.positions, marks);
  const held = positions.find((p) => p.symbol.toUpperCase() === m.symbol.toUpperCase());
  const today = dayOf(t, positions.reduce((sum, p) => sum + p.pnl, 0));
  let day = today.day;
  if (day !== t.day) saveDay(chat, t.sub, day);

  let side;
  let size;
  let what;
  if (request.kind === "open") {
    const other = positions.find((p) => p.symbol.toUpperCase() !== m.symbol.toUpperCase());
    if (other) throw new DeskError(`Your subaccount holds a ${other.symbol} position, and an isolated subaccount holds one market at a time - close it first.`);
    if (held && held.side !== request.side) throw new DeskError(`You hold a ${m.symbol} ${held.side} - close it before opening a ${request.side}.`);
    const notional = ((held?.size ?? 0) + Number(request.size)) * Number(request.price);
    const leverage = (notional / s.collateral).toFixed(2);
    checkOpen(rec, t, { market: m.symbol.toUpperCase(), leverage, notional, symbol: UNIT, dayPnl: today.pnl });
    side = request.side === "long" ? rise.Side.Bid : rise.Side.Ask;
    size = request.size;
    what = `${request.side} ${request.size} ${m.symbol} at ${request.price} or better (${leverage}x on the subaccount)`;
  } else {
    if (!held) throw new DeskError(`You have no ${m.symbol} position.`);
    const all = request.size.toLowerCase() === "all";
    if (!all && Number(request.size) > held.size) throw new DeskError(`The position is only ${fmt(held.size)} ${m.symbol}.`);
    side = held.side === "long" ? rise.Side.Ask : rise.Side.Bid;
    size = all ? String(held.size) : request.size;
    what = `close ${all ? "all" : request.size} of the ${m.symbol} ${held.side} at ${request.price} or better`;
  }

  const exchange = await phx.exchangeAccounts(c.network);
  const ix = rise.buildPlaceMarketOrderIxResolved({
    exchange,
    market: { marketAddress: m.marketAddress, splineCollection: m.splineCollection },
    trader: { authority: c.d.treasury.toBase58(), positionAuthority: t.agent, traderAccount: await phx.traderAccount(c.d.treasury, t.sub) },
    orderPacket: rise.buildMarketOrderPacketFromMarketParams({ side, priceLimitUsd: String(request.price), baseUnits: String(size) }, { tickSize: m.tickSize, baseLotsDecimals: m.baseLotsDecimals }),
  });
  if (agent.publicKey.toBase58() !== t.agent) throw new Error("The stored trading key doesn't match its record");
  const sig = await v.send(c.network, [phx.web3Instruction(ix)], [operator, agent]);

  const after = ((await phx.subaccounts(c.network, c.d.treasury))[t.sub]?.positions ?? []).find((p) => p.symbol.toUpperCase() === m.symbol.toUpperCase());
  const signed = (p) => (p ? (p.side === "long" ? p.size : -p.size) : 0);
  const filled = Math.abs(signed(after) - signed(held));
  // A close realizes PnL; the bot counts it at the limit price, the worst the close could fill at.
  if (request.kind === "close" && held && filled > 0) {
    day = addRealized(day, (Number(request.price) - held.entry) * Math.min(filled, held.size) * (held.side === "long" ? 1 : -1));
    saveDay(chat, t.sub, day);
  }
  const result = filled === 0 ? "Nothing filled at that price (immediate-or-cancel) - no change." : `The ${m.symbol} position is now ${after ? `${fmt(after.size)} ${after.side}` : "closed"}.`;
  return `📈 Trader \`${t.address}\`: ${what}.\n${result}\nTx: \`${sig}\``;
}

export { usage as phoenixDeskUsage };
