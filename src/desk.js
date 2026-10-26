import { formatUnits, getAddress, parseEventLogs } from "viem";
import { publicClient, writeWithGasBuffer } from "./config.js";
import { currentNetwork } from "./networks.js";
import { daoTreasury } from "./proposalBuilder.js";
import { IntegrationError } from "./integrations/common.js";
import { deskVenue, verifyDesk, deskConsentRequest, DESK_ABI } from "./integrations/perpl.js";
import { getChatDesk, updateChatDesk, getChatDAO, getChatModel } from "./db.js";
import { getAdapter } from "./governance/index.js";
import { PROPOSAL_STATE_LABELS } from "./governance/common.js";
import { parsePerps, PerpsError } from "./perps.js";
import { DeskError, parseMandate, mandateText, checkOpen, isTrader, pickTrader, takeFor, mineLines, dayOf, addRealized, fmt } from "./deskMandate.js";
import * as hypercoreDesk from "./deskHypercore.js";
import { deskCardImage } from "./charts.js";

export { DeskError, parseMandate, mandateText };

/**
 * Trading desk: the group appoints traders by proposal, and each trader then
 * trades from the chat without a vote per trade. This file is the Perpl
 * desk, and every export hands HyperEVM chats to src/deskHypercore.js; the
 * mandate both share is src/deskMandate.js.
 *
 * On-chain (Perpl, Monad): each trader has their own desk, a Perpl
 * DelegatedAccount owned by the Treasury, with the trader's bot wallet as
 * its operator. The operator can only call the exchange's trading functions
 * through it; withdrawing is the owner's alone and always pays the owner, so
 * the most a trader can do with their desk's money is trade it - never take
 * it. Desks are separate exchange accounts, so one trader's losses never
 * touch another's collateral. Funding, withdrawing and removing a trader
 * are proposals (perpl-desk-* actions).
 *
 * The mandate - markets, the largest position, the most leverage, how many
 * days - is written into the appointment proposal, so voters see what they
 * agree to, and the bot refuses any trade outside it. Those limits are
 * enforced by the bot (Perpl's contract has no such limits), and they hold
 * because the trader's key lives in the bot's KMS wallet store and is never
 * handed out. What's on-chain regardless: no trader can withdraw, and the
 * DAO risks only what it funded each desk with.
 *
 * Record per chat (db.js getChatDesk): { desks: { [address]: { trader } },
 * pending: { [proposalId]: appointment }, paused }. A record from before
 * several desks had one `address` and `trader`; it's read as one desk.
 */

const VENUE_NETWORKS = new Set(["monad-testnet", "monad-mainnet"]);
const onHypercore = () => hypercoreDesk.isHypercoreNetwork();
const SIGNATURE_DAYS = 60; // the trader's consent must still be valid when the proposal executes, however long the vote takes
const CLOSED = new Set(["Defeated", "Cancelled", "Expired", "Rejected", "Failed"]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function deskUsage(cmd) {
  const d = cmd("desk");
  return [
    `\`${d}\` - the DAO's trading desk: its traders, their limits, collateral, positions`,
    `\`${d} apply <markets|all> max=<size> [total=<size>] [loss=<size>] [lev=2] [days=30]\` - propose yourself as a trader (e.g. \`${d} apply BTC,ETH max=500 total=800 loss=50 lev=3 days=30\`; max is the largest position in one market, total all of them together, loss the most to lose in a day, in the collateral token)`,
    `\`${d} fund <amount> [for=<n>]\` / \`${d} withdraw <amount> [for=<n>]\` - propose moving collateral between the Treasury and a trader's desk (n: its number in \`${d}\`, or the trader's address)`,
    `\`${d} remove [n]\` - propose removing a trader · \`${d} resign\` - a trader steps down`,
    `\`${d} pause\` / \`${d} resume\` - chat admins or the DAO's creator stop new positions for every trader at once (closing stays allowed)`,
    `\`${d} long|short <market> <size> at <limitPrice> [3x]\` / \`${d} close <market> <size|all> at <limitPrice>\` - a trader trades, no vote`,
    `\`${d} mine\` - a trader's own positions, and how much of their limits they use`,
    "Traders can trade the desk's collateral but never withdraw it - only the Treasury can, by proposal.",
  ].join("\n");
}

function requireVenue() {
  const network = currentNetwork();
  if (!VENUE_NETWORKS.has(network.id)) throw new DeskError(`Trading desks run on Perpl (Monad) and HyperCore (HyperEVM) - not on ${network.chain.name} yet.`);
  return network;
}

async function venueCtx(chat) {
  const network = requireVenue();
  const governance = getChatDAO(chat.chatId, chat.platform);
  const model = getChatModel(chat.chatId, chat.platform);
  return { network, publicClient, treasury: await daoTreasury(model, governance), governance, model };
}

const wrap = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IntegrationError || err instanceof PerpsError) throw new DeskError(err.message);
    throw err;
  }
};

/** A Perpl desk record in the current shape. */
function normalize(rec) {
  if (rec?.venue === "hypercore") return { desks: {}, pending: {} };
  const { address, trader, ...rest } = rec ?? {};
  const next = { desks: {}, pending: {}, ...rest };
  if (address) next.desks = { [getAddress(address)]: { trader: trader ?? null }, ...next.desks };
  return next;
}

const recordOf = (chat) => normalize(getChatDesk(chat.chatId, chat.platform));
const updateRecord = (chat, change) => updateChatDesk(chat.chatId, (cur) => change(normalize(cur)), chat.platform);

/** The desks in the order /desk numbers them: [{ address, trader }]. */
const desksOf = (rec) => Object.entries(rec.desks).map(([address, d]) => ({ address, trader: d.trader ?? null }));

/** A desk by its number in /desk, its address or its trader's address; with no word, the only one. */
function pickDesk(rec, word) {
  const list = desksOf(rec);
  if (word && ADDRESS.test(word)) {
    const hit = list.find((d) => d.address.toLowerCase() === word.toLowerCase() || d.trader?.address.toLowerCase() === word.toLowerCase());
    if (!hit) throw new DeskError(`\`${word}\` isn't one of the DAO's desks or traders.`);
    return hit;
  }
  return pickTrader(list, word, "desk");
}

/** Saves `day` (deskMandate.dayOf) on desk `address`'s trader. */
function saveDay(chat, address, day) {
  updateRecord(chat, (cur) => {
    if (cur.desks[address]?.trader) cur.desks[address].trader.day = day;
    return cur;
  });
}

const stateLabelOf = (p) => p.stateLabel ?? p.statusLabel ?? p.phaseLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";
const isOperator = (desk, who) => publicClient.readContract({ address: desk, abi: DESK_ABI, functionName: "isOperator", args: [who] });

/*//////////////////////////////////////////////////////////////
                     APPOINTMENT LIFECYCLE
//////////////////////////////////////////////////////////////*/

/**
 * Settles pending appointments whose proposal has finished: executed and the
 * trader really is their desk's operator -> active, with the mandate's clock
 * starting now; defeated/cancelled/expired -> dropped. Also clears any
 * trader who is no longer their desk's operator on-chain (removed by a
 * proposal). Returns lines worth telling the chat.
 */
export async function refreshDesk(chat) {
  if (onHypercore()) return hypercoreDesk.refreshDesk(chat);
  const rec = recordOf(chat);
  const desks = desksOf(rec).filter((d) => d.trader);
  if (!Object.keys(rec.pending).length && !desks.length) return [];
  const governance = getChatDAO(chat.chatId, chat.platform);
  const adapter = getAdapter(getChatModel(chat.chatId, chat.platform));
  const news = [];
  const updates = {};
  const cleared = [];
  for (const d of desks) {
    if (await isOperator(d.address, d.trader.address)) continue;
    cleared.push(d.address);
    news.push(`📉 \`${d.trader.address}\` is no longer the trader of desk \`${d.address}\`.`);
  }
  for (const [id, a] of Object.entries(rec.pending)) {
    const label = stateLabelOf(await adapter.getProposal(governance, id));
    if (CLOSED.has(label)) {
      updates[id] = { drop: true };
      continue;
    }
    if (label !== "Executed") continue;
    if (!a.desk) continue; // a new desk: its address comes from the execution receipt (deskExecuted) or /desk link
    if (!(await isOperator(a.desk, a.address))) {
      updates[id] = { drop: true };
      news.push(`⚠️ Proposal #${id} executed, but ${a.address} isn't desk ${a.desk}'s trader on-chain - nothing changed.`);
      continue;
    }
    updates[id] = { activate: { ...a, since: Date.now(), expiresAt: Date.now() + a.mandate.days * 86_400_000 } };
    news.push(`📈 \`${a.address}\` now trades desk \`${a.desk}\` (${mandateText(a.mandate)}).`);
  }
  if (!Object.keys(updates).length && !cleared.length) return news;
  updateRecord(chat, (next) => {
    for (const address of cleared) if (next.desks[address]) next.desks[address].trader = null;
    for (const [id, u] of Object.entries(updates)) {
      delete next.pending[id];
      if (u.activate) {
        const { desk, kind: _, ...trader } = u.activate;
        next.desks[desk] = { ...next.desks[desk], trader };
      }
    }
    return next;
  });
  return news;
}

/**
 * Called by the event listener when one of the chat's proposals executes:
 * an appointment that created a desk learns its address from the receipt
 * (Perpl's factory event: owner = this Treasury, operator = the trader),
 * then activates.
 */
export async function deskExecuted(chat, proposalId, txHash) {
  if (onHypercore()) return hypercoreDesk.refreshDesk(chat);
  const rec = recordOf(chat);
  const a = rec.pending[String(proposalId)];
  if (!a) return [];
  if (!a.desk && a.kind === "create" && txHash) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const ctx = await venueCtx(chat);
    const created = parseEventLogs({ abi: deskVenue.DESK_FACTORY_ABI, logs: receipt.logs, eventName: "DelegatedAccountCreated" }).find(
      (l) => getAddress(l.address) === deskVenue.deployment(ctx).deskFactory && getAddress(l.args.owner) === getAddress(ctx.treasury) && getAddress(l.args.operator) === getAddress(a.address)
    );
    if (created) {
      await verifyDesk(ctx, created.args.proxy);
      const desk = getAddress(created.args.proxy);
      updateRecord(chat, (cur) => {
        cur.desks[desk] ??= { trader: null };
        if (cur.pending[String(proposalId)]) cur.pending[String(proposalId)].desk = desk;
        return cur;
      });
    }
  }
  return refreshDesk(chat);
}

/** Links a desk by address (when its creation wasn't seen): must be a Perpl desk owned by this Treasury. */
export async function linkDesk(chat, word) {
  if (onHypercore()) throw new DeskError("A HyperCore desk needs no linking: it's the Treasury's own HyperCore account.");
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const { desk } = await verifyDesk(ctx, word);
    // An appointment that created this desk, if it's the one waiting for its address.
    const waiting = [];
    for (const [id, a] of Object.entries(recordOf(chat).pending)) if (a.kind === "create" && !a.desk && (await isOperator(desk, a.address))) waiting.push(id);
    updateRecord(chat, (cur) => {
      cur.desks[desk] ??= { trader: null };
      for (const id of waiting) if (cur.pending[id]) cur.pending[id].desk = desk;
      return cur;
    });
    const news = await refreshDesk(chat);
    return [`✅ Linked the trading desk \`${desk}\`.`, ...news].join("\n");
  });
}

/**
 * /desk apply: the caller volunteers. Their wallet signs Perpl's
 * AssignOperator consent, and the returned action words become the
 * appointment proposal: on their own desk if they already have one (a new
 * mandate), else on a desk with no trader, else a new desk of their own.
 * `record(proposalId)` stores the appointment once the proposal exists.
 */
export async function applyForDesk(chat, account, words) {
  if (onHypercore()) return hypercoreDesk.applyForDesk(chat, account, words);
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const mandate = parseMandate(words);
    const rec = recordOf(chat);
    const d = deskVenue.deployment(ctx);
    if (mandate.markets !== "all") {
      const unknown = mandate.markets.filter((m) => d.markets[m] === undefined);
      if (unknown.length) throw new DeskError(`Unknown Perpl market${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Markets: ${Object.keys(d.markets).join(", ")}.`);
    }
    const desks = desksOf(rec);
    const target = desks.find((x) => isTrader(x.trader, chat, account.address)) ?? desks.find((x) => !x.trader) ?? null;
    if (target) await verifyDesk(ctx, target.address);
    // The contract checks the deadline against block time, so count from the chain's clock.
    const { timestamp } = await publicClient.getBlock();
    const deadline = timestamp + BigInt(SIGNATURE_DAYS * 86_400);
    const typed = await deskConsentRequest(ctx, { desk: target?.address, operator: account.address, deadline });
    const signature = await account.signTypedData(typed);
    const state = await deskVenue.exchangeState(ctx, d, target?.address ?? ctx.treasury).catch(() => ({ symbol: d.collateralSymbol ?? "" }));
    const where = target ? `the DAO's Perpl desk ${target.address}` : "a new Perpl desk of their own";
    const description = `Appoint ${account.address} as a trader on ${where}: ${mandateText(mandate, state.symbol)}. The trader can trade the desk's collateral but never withdraw it.`;
    const kind = target ? "appoint" : "create";
    const actionWords =
      kind === "create"
        ? ["perpl-desk-create", account.address, deadline.toString(), signature, ...description.split(" ")]
        : ["perpl-desk-appoint", target.address, account.address, deadline.toString(), signature, ...description.split(" ")];
    return {
      actionId: actionWords[0],
      words: actionWords.slice(1),
      note: kind === "create" ? "Once it passes and executes, the desk exists; then fund it with a `desk fund` proposal." : "",
      record: (proposalId) =>
        updateRecord(chat, (cur) => ({ ...cur, pending: { ...cur.pending, [String(proposalId)]: { kind, desk: target?.address ?? null, platform: chat.platform, userId: String(chat.userId), address: account.address, mandate } } })),
    };
  });
}

/** The action words for fund / withdraw / remove proposals. */
export async function deskProposalWords(chat, sub, args) {
  if (onHypercore()) return hypercoreDesk.deskProposalWords(chat, sub, args);
  requireVenue();
  const rec = recordOf(chat);
  if (!desksOf(rec).length) throw new DeskError("This DAO has no trading desk yet - someone has to `desk apply` and the proposal pass first.");
  if (sub === "fund" || sub === "withdraw") {
    const [which, words] = takeFor(args);
    const desk = pickDesk(rec, which);
    const amount = String(words[0] ?? "").replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(amount)) throw new DeskError(`Give an amount: \`desk ${sub} <amount> [for=<n>]\`.`);
    const rest = words.slice(1);
    const whose = desk.trader ? ` (${desk.trader.address}'s)` : "";
    const description = rest.length ? rest : `${sub === "fund" ? "Fund the trading desk" : "Withdraw from the trading desk"} ${desk.address}${whose}: ${amount}.`.split(" ");
    return { actionId: `perpl-desk-${sub}`, words: [desk.address, amount, ...description] };
  }
  if (sub === "remove") {
    const named = /^#?\d+$/.test(args[0] ?? "") || ADDRESS.test(args[0] ?? "");
    const withTraders = { ...rec, desks: Object.fromEntries(Object.entries(rec.desks).filter(([, d]) => d.trader)) };
    if (!desksOf(withTraders).length) throw new DeskError("The desk has no trader to remove.");
    const desk = named ? pickDesk(rec, args[0]) : pickDesk(withTraders);
    if (!desk.trader) throw new DeskError(`Desk \`${desk.address}\` has no trader.`);
    const rest = named ? args.slice(1) : args;
    const description = rest.length ? rest : `Remove ${desk.trader.address} as the trader of desk ${desk.address}.`.split(" ");
    return { actionId: "perpl-desk-remove", words: [desk.address, desk.trader.address, ...description] };
  }
  throw new DeskError(`Unknown \`desk ${sub}\`.`);
}

/** /desk resign: a trader steps down from their desk, signed by their own wallet. */
export async function resignFromDesk(chat, client) {
  if (onHypercore()) return hypercoreDesk.resignFromDesk(chat, client);
  return wrap(async () => {
    requireVenue();
    const desk = desksOf(recordOf(chat)).find((d) => isTrader(d.trader, chat, client.account.address));
    if (!desk) throw new DeskError("Only the desk's traders can resign, and you aren't one.");
    const hash = await writeWithGasBuffer(client, { address: desk.address, abi: DESK_ABI, functionName: "resignOperator" });
    await publicClient.waitForTransactionReceipt({ hash });
    updateRecord(chat, (cur) => {
      cur.desks[desk.address].trader = null;
      return cur;
    });
    return "✅ You've stepped down as your desk's trader. Its open positions stay open until the DAO appoints a new trader there or withdraws.";
  });
}

/*//////////////////////////////////////////////////////////////
                           STATUS
//////////////////////////////////////////////////////////////*/

export async function deskStatus(chat, cmd) {
  if (onHypercore()) return hypercoreDesk.deskStatus(chat, cmd);
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const news = await refreshDesk(chat);
    const rec = recordOf(chat);
    const lines = [...news, ...(news.length ? [""] : []), "*Trading desk* (Perpl)"];
    if (rec.paused) lines.push(`⏸️ Paused${rec.paused.by ? ` by ${rec.paused.by}` : ""}: no new positions until \`${cmd("desk")} resume\`.`);
    const d = deskVenue.deployment(ctx);
    const desks = desksOf(rec);
    const card = [];
    let symbol = "";
    let collateral = 0;
    if (!desks.length) {
      lines.push(`No desk yet. A would-be trader starts with \`${cmd("desk")} apply <markets> max=<size>\`.`);
    }
    for (const [i, desk] of desks.entries()) {
      const state = await deskVenue.exchangeState(ctx, d, desk.address);
      lines.push("", `*${i + 1}.* Desk \`${desk.address}\``);
      if (desk.trader) {
        const expired = Date.now() > desk.trader.expiresAt;
        lines.push(`Trader: \`${desk.trader.address}\` - ${mandateText(desk.trader.mandate, state.symbol)}${expired ? " - ⏰ mandate ended" : `, until ${new Date(desk.trader.expiresAt).toISOString().slice(0, 10)}`}`);
      } else lines.push("Trader: none");
      if (state.accountId === 0n) {
        lines.push(`Collateral: none yet - \`${cmd("desk")} fund <amount>${desks.length > 1 ? ` for=${i + 1}` : ""}\` proposes moving some from the Treasury.`);
        continue;
      }
      lines.push(`Collateral: ${formatUnits(state.balance, state.decimals)} ${state.symbol}${state.locked ? ` (${formatUnits(state.locked, state.decimals)} in positions)` : ""}`);
      symbol = state.symbol;
      collateral += Number(formatUnits(state.balance, state.decimals));
      const positions = await deskVenue.openPositions(ctx, d, state.accountId);
      card.push(...positions.map((p) => ({ ...p, owner: desks.length > 1 ? `desk ${i + 1}` : null })));
      if (!positions.length) lines.push("No open positions.");
      for (const p of positions) lines.push(`• ${p.symbol} ${p.side} ${fmt(p.size)} @ ${fmt(p.entry, 2)} · mark ${fmt(p.mark, 2)} · PnL ${p.pnl >= 0 ? "+" : ""}${fmt(p.pnl, 2)} ${state.symbol}`);
    }
    const pending = Object.entries(rec.pending);
    if (pending.length) lines.push("");
    for (const [id, a] of pending) lines.push(`Proposed: \`${a.address}\` (proposal #${id}) - ${mandateText(a.mandate)}${a.desk ? ` on desk \`${a.desk}\`` : ", on a new desk"}`);
    const image = deskCardImage({ title: "Trading desk", subtitle: `Perpl · ${desks.length} desk${desks.length === 1 ? "" : "s"}`, positions: card, symbol, collateral: collateral ? `${fmt(collateral, 2)} ${symbol}${desks.length > 1 ? " across the desks" : ""}` : null });
    return { text: lines.join("\n"), image };
  });
}

/** /desk mine, either venue: the caller's own desk (Perpl) or markets (HyperCore), and how much of their mandate they use. */
export async function deskMine(chat, client, cmd) {
  if (onHypercore()) return hypercoreDesk.deskMine(chat, client, cmd);
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    await refreshDesk(chat);
    const rec = recordOf(chat);
    const desks = desksOf(rec);
    const n = desks.findIndex((x) => isTrader(x.trader, chat, client.account.address));
    if (n < 0) throw new DeskError(`You aren't one of the desk's traders - \`${cmd("desk")}\` shows who is.`);
    const desk = desks[n];
    const d = deskVenue.deployment(ctx);
    const state = await deskVenue.exchangeState(ctx, d, desk.address);
    const positions = state.accountId === 0n ? [] : await deskVenue.openPositions(ctx, d, state.accountId);
    // A Perpl desk is the trader's own account, so every position on it is theirs.
    const deskNotional = positions.reduce((sum, p) => sum + p.size * p.mark, 0);
    const { day, pnl } = dayOf(desk.trader, positions.reduce((sum, p) => sum + p.pnl, 0));
    if (day !== desk.trader.day) saveDay(chat, desk.address, day);
    const lines = mineLines(rec, desk.trader, { venue: "Perpl", n: desks.length > 1 ? n + 1 : null, positions, deskNotional, symbol: state.symbol, cmd, dayPnl: pnl });
    const collateral = state.accountId === 0n ? "none yet" : `${formatUnits(state.balance, state.decimals)} ${state.symbol}${state.locked ? ` (${formatUnits(state.locked, state.decimals)} in positions)` : ""}`;
    lines.splice(1, 0, `Desk: \`${desk.address}\` · collateral ${collateral}`);
    const image = deskCardImage({ title: "Your trading", subtitle: `Perpl · desk ${desk.address.slice(0, 6)}…${desk.address.slice(-4)}`, positions, symbol: state.symbol, mandate: desk.trader.mandate, deskNotional, collateral: state.accountId === 0n ? null : collateral });
    return { text: lines.join("\n"), image };
  });
}

/*//////////////////////////////////////////////////////////////
                           TRADING
//////////////////////////////////////////////////////////////*/

/**
 * /desk long|short|close: a trader opens or closes a position on their own
 * desk, signed by their own wallet - after the mandate checks. Returns the reply.
 */
export async function trade(chat, client, words) {
  if (onHypercore()) return hypercoreDesk.trade(chat, client, words);
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    await refreshDesk(chat);
    const rec = recordOf(chat);
    const me = getAddress(client.account.address);
    const desk = desksOf(rec).find((x) => isTrader(x.trader, chat, me));
    if (!desk) throw new DeskError("Only the desk's appointed traders can trade.");
    const t = desk.trader;
    if (!(await isOperator(desk.address, me))) throw new DeskError("You're no longer your desk's trader on-chain.");
    const request = parsePerps(words);
    if (request.kind !== "open" && request.kind !== "close") throw new DeskError("Use `desk long|short <market> <size> at <price> [3x]` or `desk close <market> <size|all> at <price>`.");

    const d = deskVenue.deployment(ctx);
    const state = await deskVenue.exchangeState(ctx, d, desk.address);
    if (state.accountId === 0n) throw new DeskError("Your desk has no collateral yet - it needs a `desk fund` proposal first.");
    const m = await deskVenue.market(ctx, d, request.market);
    const [position] = await deskVenue.read(ctx, d, "getPosition", [m.perpId, state.accountId]);
    const held = position.lotLNS;
    const heldLong = Number(position.positionType) === 0;
    const pricePNS = deskVenue.scaled(request.price, m.priceDecimals, "Limit price");
    // The daily loss limit counts from the first look each day (deskMandate.dayOf).
    const openNow = await deskVenue.openPositions(ctx, d, state.accountId);
    const today = dayOf(t, openNow.reduce((sum, p) => sum + p.pnl, 0));
    let day = today.day;
    if (day !== t.day) saveDay(chat, desk.address, day);

    let desc;
    let what;
    if (request.kind === "open") {
      const lev = request.leverage ?? "1";
      const leverageHdths = deskVenue.scaled(lev, deskVenue.LEVERAGE_DECIMALS, "Leverage");
      if (leverageHdths > m.maxLeverageHdths) throw new DeskError(`${m.symbol} allows at most ${formatUnits(m.maxLeverageHdths, deskVenue.LEVERAGE_DECIMALS)}x.`);
      if (held > 0n && heldLong !== (request.side === "long")) throw new DeskError(`Your desk holds a ${m.symbol} ${heldLong ? "long" : "short"} - close it before opening a ${request.side}.`);
      const lotLNS = deskVenue.scaled(request.size, m.lotDecimals, "Size");
      // Position size in collateral at the limit price, including what's already held; the desk's other markets at their mark.
      const notional = Number(formatUnits(held + lotLNS, m.lotDecimals)) * Number(request.price);
      const others = openNow.filter((p) => BigInt(p.id) !== m.perpId).reduce((sum, p) => sum + p.size * p.mark, 0);
      checkOpen(rec, t, { market: request.market, leverage: lev, notional, othersNotional: others, symbol: state.symbol, dayPnl: today.pnl });
      desc = deskVenue.orderDesc({ perpId: m.perpId, orderType: request.side === "long" ? deskVenue.ORDER.OpenLong : deskVenue.ORDER.OpenShort, pricePNS, lotLNS, leverageHdths });
      what = `${request.side} ${request.size} ${m.symbol} at ${request.price} or better, ${lev}x`;
    } else {
      if (held === 0n) throw new DeskError(`Your desk has no ${m.symbol} position.`);
      const all = request.size.toLowerCase() === "all";
      const lotLNS = all ? held : deskVenue.scaled(request.size, m.lotDecimals, "Size");
      if (lotLNS > held) throw new DeskError(`The position is only ${formatUnits(held, m.lotDecimals)} ${m.symbol}.`);
      desc = deskVenue.orderDesc({ perpId: m.perpId, orderType: heldLong ? deskVenue.ORDER.CloseLong : deskVenue.ORDER.CloseShort, pricePNS, lotLNS, leverageHdths: m.maxLeverageHdths });
      what = `close ${all ? "all" : request.size} of the ${m.symbol} ${heldLong ? "long" : "short"} at ${request.price} or better`;
    }

    // The trader's own transaction, through the desk's fallback to the exchange (operators may call execOrders).
    const hash = await writeWithGasBuffer(client, { address: desk.address, abi: deskVenue.ABI, functionName: "execOrders", args: [[desc], true] });
    await publicClient.waitForTransactionReceipt({ hash });
    const [after] = await deskVenue.read(ctx, d, "getPosition", [m.perpId, state.accountId]);
    const filled = after.lotLNS > held ? after.lotLNS - held : held - after.lotLNS;
    const size = (v) => formatUnits(v, m.lotDecimals);
    // A close realizes PnL; the bot can't see Perpl's fill price, so it counts the limit price, the worst the close could fill at.
    if (filled > 0n && request.kind === "close") {
      const entry = Number(formatUnits(position.pricePNS, m.priceDecimals));
      day = addRealized(day, (Number(request.price) - entry) * Number(formatUnits(filled, m.lotDecimals)) * (heldLong ? 1 : -1));
      saveDay(chat, desk.address, day);
    }
    const result = filled === 0n ? "Nothing filled at that price (immediate-or-cancel) - no change." : `Filled ${size(filled)} ${m.symbol}; the desk's ${m.symbol} position is now ${after.lotLNS === 0n ? "closed" : `${size(after.lotLNS)} ${Number(after.positionType) === 0 ? "long" : "short"}`}.`;
    return `📈 Trader \`${me}\`: ${what}.\n${result}`;
  });
}

/*//////////////////////////////////////////////////////////////
                         PAUSE / RESUME
//////////////////////////////////////////////////////////////*/

/**
 * /desk pause|resume, either venue: stops (or allows again) new positions
 * for every trader straight away, without the vote removing one takes.
 * Closing is never paused. The caller checks who may (core.js: chat admins
 * and the DAO's creator); `by` is shown in /desk.
 */
export function setDeskPaused(chat, paused, by) {
  if (!onHypercore()) requireVenue();
  const rec = getChatDesk(chat.chatId, chat.platform);
  const has = onHypercore()
    ? rec?.venue === "hypercore" && (rec.trader || Object.keys(rec.traders ?? {}).length || Object.keys(rec.pending ?? {}).length)
    : rec?.venue !== "hypercore" && desksOf(normalize(rec)).length;
  if (!has) throw new DeskError("This DAO has no trading desk yet.");
  if (Boolean(rec.paused) === paused) throw new DeskError(paused ? "The desk is already paused." : "The desk isn't paused.");
  updateChatDesk(chat.chatId, (cur) => ({ ...cur, paused: paused ? { by, at: Date.now() } : null }), chat.platform);
  return paused
    ? "⏸️ Trading desk paused: no trader can open or add to positions until it's resumed. Closing stays allowed."
    : "▶️ Trading desk resumed: traders can trade within their mandates again.";
}
