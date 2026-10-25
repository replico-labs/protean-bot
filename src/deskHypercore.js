import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { publicClient } from "./config.js";
import { currentNetwork } from "./networks.js";
import { daoTreasury } from "./proposalBuilder.js";
import { IntegrationError } from "./integrations/common.js";
import { deskVenue } from "./integrations/hypercore.js";
import { getChatDesk, updateChatDesk, getChatDAO, getChatModel } from "./db.js";
import { getAdapter } from "./governance/index.js";
import { PROPOSAL_STATE_LABELS } from "./governance/common.js";
import { parsePerps, PerpsError } from "./perps.js";
import { createAgentKey, getAgentAccount, deleteAgentKey } from "./walletStore.js";
import { DeskError, parseMandate, mandateText, checkOpen, covers, isTrader, pickTrader, takeFor, mineLines, fmt } from "./deskMandate.js";

/**
 * Trading desk on HyperCore (HyperEVM): the same /desk as on Perpl
 * (src/desk.js), built the other way round because Hyperliquid has no
 * trade-only account a contract can own.
 *
 * - The desk is the Treasury's own HyperCore account. Money reaches it
 *   only by proposal (desk fund) and leaves it only by proposal.
 * - The trader never holds a key that can touch it. Appointing a trader
 *   makes a fresh API wallet ("agent") key that the bot keeps encrypted
 *   (walletStore createAgentKey), and the appointment proposal has the
 *   Treasury approve that agent through CoreWriter (hypercore-approve-agent),
 *   with the mandate written into its description.
 * - The trader trades from the chat. The bot checks each order against the
 *   mandate (src/deskMandate.js) and only then signs it with the agent key.
 * - Removing the trader is a proposal that approves a throwaway address
 *   under the same agent name, which replaces (revokes) the agent on
 *   HyperCore. A trader resigning destroys the key at once.
 * - Several traders: each has their own agent (named protean-desk-<n>) and
 *   mandate, but they all trade the one account, where a market holds a
 *   single position. So each market belongs to one trader at most: an
 *   appointment whose markets overlap another trader's is refused, and a
 *   trader can only open or close in their own markets. `total` counts the
 *   whole desk's positions, since they share one cross margin.
 *
 * What a breach could cost: Hyperliquid agents may be able to move their
 * principal's funds (scripts/hl-agent-check.mjs checks), so if the bot's
 * keys leaked, what's at risk is what the Treasury holds on HyperCore - not
 * the Treasury on HyperEVM, which HyperCore can't reach. Keep only what the
 * desk needs on HyperCore.
 *
 * Record per chat (db.js getChatDesk): { venue: "hypercore", traders:
 * { [agentKey]: trader }, pending: { [proposalId]: appointment or removal },
 * nextAgent, paused }. A record from before several traders had one
 * `trader`, under the agent name protean-desk; it's read as a list of one.
 */

export const VENUE_NETWORKS = new Set(["hyperevm", "hyperevm-testnet"]);
export const AGENT_NAME = "protean-desk";
const CLOSED = new Set(["Defeated", "Cancelled", "Expired", "Rejected", "Failed"]);
const COLLATERAL = "USDC";

export const isHypercoreNetwork = (network = currentNetwork()) => VENUE_NETWORKS.has(network.id);

async function venueCtx(chat) {
  const network = currentNetwork();
  if (!VENUE_NETWORKS.has(network.id)) throw new DeskError(`HyperCore desks run on HyperEVM, not ${network.chain.name}.`);
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

/** A desk record in the current shape (a Perpl record from another network doesn't count). */
function normalize(desk) {
  if (desk?.venue !== "hypercore") return { venue: "hypercore", traders: {}, pending: {}, nextAgent: 1 };
  const { trader, ...rest } = desk;
  const next = { traders: {}, pending: {}, nextAgent: 1, ...rest };
  if (trader) next.traders = { ...next.traders, [trader.agentKey]: { agentName: AGENT_NAME, ...trader } };
  return next;
}

const deskOf = (chat) => normalize(getChatDesk(chat.chatId, chat.platform));

function updateDesk(chat, change) {
  updateChatDesk(chat.chatId, (cur) => change(normalize(cur)), chat.platform);
}

/** The desk's traders in the order /desk numbers them (longest-serving first). */
const tradersOf = (desk) => Object.values(desk.traders ?? {}).sort((a, b) => (a.since ?? 0) - (b.since ?? 0));

/** The agents the Treasury's HyperCore account has approved: [{ address, name, validUntil }]. */
const agentsOf = (ctx) => deskVenue.info(ctx, { type: "extraAgents", user: ctx.treasury });

const listed = (agents, agent, name) => agents.some((a) => a.name === name && getAddress(a.address) === getAddress(agent));
const isApproved = async (ctx, agent, name) => listed(await agentsOf(ctx), agent, name);

/** Another trader's mandate that shares a market with `mandate`, or null: on one account a market has one position. */
function overlap(mandate, others) {
  for (const o of others) {
    if (o.mandate.markets === "all" || mandate.markets === "all") return { who: o.address, markets: o.mandate.markets === "all" ? "every market" : o.mandate.markets.join(", ") };
    const shared = mandate.markets.filter((m) => o.mandate.markets.includes(m));
    if (shared.length) return { who: o.address, markets: shared.join(", ") };
  }
  return null;
}

/** Hyperliquid's API for orders, signed by the agent (HYPERLIQUID_INFO_URL points both at a stand-in, for tests). */
function exchangeFor(ctx, wallet) {
  const apiUrl = process.env.HYPERLIQUID_INFO_URL?.replace(/\/info$/, "");
  const transport = new HttpTransport({ isTestnet: ctx.network.id === "hyperevm-testnet", ...(apiUrl ? { apiUrl } : {}) });
  return new ExchangeClient({ transport, wallet });
}

const stateLabelOf = (p) => p.stateLabel ?? p.statusLabel ?? p.phaseLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";
const forget = (agentKey) => deleteAgentKey(agentKey).catch((err) => console.error(`HyperCore desk: couldn't delete agent key ${agentKey}:`, err.message));

/*//////////////////////////////////////////////////////////////
                     APPOINTMENT LIFECYCLE
//////////////////////////////////////////////////////////////*/

/**
 * Settles pending proposals that have finished. An executed appointment
 * makes its trader active once HyperCore lists the agent (Core applies the
 * action just after the EVM block), replacing whoever had that agent name;
 * an executed removal drops its trader; a failed proposal is dropped and an
 * unused key destroyed. Keys that can no longer trade are destroyed.
 * Returns lines for the chat.
 */
export async function refreshDesk(chat) {
  const desk = deskOf(chat);
  if (!Object.keys(desk.pending).length) return [];
  const ctx = await venueCtx(chat);
  const adapter = getAdapter(ctx.model);
  const agents = await agentsOf(ctx);
  const news = [];
  const updates = {};
  for (const [id, a] of Object.entries(desk.pending)) {
    const label = stateLabelOf(await adapter.getProposal(ctx.governance, id));
    if (CLOSED.has(label)) {
      updates[id] = { drop: true };
      if (a.kind === "appoint") await forget(a.agentKey);
      continue;
    }
    if (label !== "Executed") continue;
    if (a.kind === "remove") {
      updates[id] = { drop: true, remove: a.agentKey };
      const t = desk.traders[a.agentKey];
      if (t) news.push(`📉 \`${t.address}\` is no longer one of the desk's traders (proposal #${id}).`);
      continue;
    }
    if (!listed(agents, a.agent, a.agentName)) continue; // HyperCore hasn't applied it yet, or rejected it: /desk shows it as waiting
    updates[id] = { drop: true, activate: { ...a, since: Date.now(), expiresAt: Date.now() + a.mandate.days * 86_400_000 } };
    news.push(`📈 \`${a.address}\` now trades the desk: ${mandateText(a.mandate, COLLATERAL)}.`);
  }
  if (!Object.keys(updates).length) return news;
  // A replaced or removed trader's agent is gone on HyperCore, so their key can never trade again: destroy it.
  const gone = new Set();
  for (const u of Object.values(updates)) {
    if (u.remove && desk.traders[u.remove]) gone.add(u.remove);
    if (u.activate) for (const t of tradersOf(desk)) if (t.agentName === u.activate.agentName) gone.add(t.agentKey);
  }
  for (const key of gone) await forget(key);
  updateDesk(chat, (next) => {
    for (const [id, u] of Object.entries(updates)) {
      delete next.pending[id];
      if (u.activate) {
        for (const [key, t] of Object.entries(next.traders)) if (t.agentName === u.activate.agentName) delete next.traders[key];
        const { kind: _, ...trader } = u.activate;
        next.traders[trader.agentKey] = trader;
      }
      if (u.remove) delete next.traders[u.remove];
    }
    return next;
  });
  return news;
}

/**
 * /desk apply: the caller volunteers. A fresh agent key is made for them
 * (held by the bot), and the returned words become the appointment
 * proposal: the Treasury approves that agent on HyperCore. A trader
 * applying again (to change their mandate) keeps their agent name, so the
 * new agent replaces their old one. Markets another trader has, or has
 * applied for, are refused. `record` stores the appointment once the
 * proposal exists.
 */
export async function applyForDesk(chat, account, words) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const mandate = parseMandate(words);
    if (mandate.markets !== "all") {
      for (const m of mandate.markets) await deskVenue.perpIndex(ctx, m);
    }
    const desk = deskOf(chat);
    const mine = tradersOf(desk).find((t) => isTrader(t, chat));
    const others = [...tradersOf(desk), ...Object.values(desk.pending).filter((a) => a.kind === "appoint")].filter((t) => !isTrader(t, chat));
    const clash = overlap(mandate, others);
    if (clash) {
      throw new DeskError(`\`${clash.who}\` already trades (or has applied for) ${clash.markets} on this desk. Traders share the Treasury's one HyperCore account, where each market holds one position, so each market can have only one trader. Apply for other markets.`);
    }
    const agentName = mine?.agentName ?? `${AGENT_NAME}-${desk.nextAgent}`;
    const agentKey = `${ctx.network.id}:${ctx.treasury.toLowerCase()}:${Date.now()}`;
    const agent = await createAgentKey(agentKey);
    const description =
      `Appoint ${account.address} as a trader of the DAO's HyperCore desk: ${mandateText(mandate, COLLATERAL)}. ` +
      `They trade the Treasury's HyperCore account through agent ${agent} ("${agentName}"), whose key the bot holds and signs with only within this mandate. ` +
      `Moving money onto or off HyperCore stays a proposal.`;
    return {
      actionId: "hypercore-approve-agent",
      words: [agent, agentName, ...description.split(" ")],
      note: mine
        ? "Once it executes, this mandate replaces your current one (and its agent)."
        : tradersOf(desk).length
          ? `Once it executes, they trade alongside the desk's ${tradersOf(desk).length} other trader${tradersOf(desk).length === 1 ? "" : "s"}.`
          : "Once it executes, fund the desk with a `desk fund` proposal if the Treasury has no USDC on HyperCore yet.",
      record: (proposalId) =>
        updateDesk(chat, (cur) => ({
          ...cur,
          nextAgent: mine ? cur.nextAgent : cur.nextAgent + 1,
          pending: { ...cur.pending, [String(proposalId)]: { kind: "appoint", platform: chat.platform, userId: String(chat.userId), address: account.address, agent, agentKey, agentName, mandate } },
        })),
    };
  });
}

/** The action words for fund / withdraw / remove proposals (and, for remove, the record to keep). */
export async function deskProposalWords(chat, sub, args) {
  await venueCtx(chat);
  const desk = deskOf(chat);
  if (sub === "fund" || sub === "withdraw") {
    // Every trader shares the one HyperCore account, so a `for=` (meaningful on Perpl) changes nothing here.
    const [, words] = takeFor(args);
    const amount = String(words[0] ?? "").replace(/,/g, "");
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new DeskError(`Give a USDC amount: \`desk ${sub} <amount>\`.`);
    const rest = words.slice(1);
    if (sub === "fund") {
      const description = rest.length ? rest : `Fund the trading desk: move ${amount} USDC from the Treasury to its HyperCore perps balance.`.split(" ");
      return { actionId: "hypercore-deposit-usdc", words: [amount, "to=perp", ...description] };
    }
    const description = rest.length ? rest : `Take ${amount} USDC out of the trading desk: from the Treasury's HyperCore perps balance to its spot balance.`.split(" ");
    return { actionId: "hypercore-usd-transfer", words: [amount, "to-spot", ...description] };
  }
  if (sub === "remove") {
    // `desk remove [trader] [description]`: a trader is their number in /desk or their address.
    const named = /^#?\d+$/.test(args[0] ?? "") || /^0x[0-9a-fA-F]{40}$/.test(args[0] ?? "");
    const t = pickTrader(tradersOf(desk), named ? args[0] : undefined);
    // Approving another address under the agent's name replaces it on HyperCore; nobody holds this one's key.
    const nobody = privateKeyToAccount(generatePrivateKey()).address;
    const rest = named ? args.slice(1) : args;
    const description = rest.length ? rest : `Remove ${t.address} as a trader of the DAO's desk: revoke HyperCore agent ${t.agent} (replaced by ${nobody}, whose key nobody holds).`.split(" ");
    return {
      actionId: "hypercore-approve-agent",
      words: [nobody, t.agentName, ...description],
      record: (proposalId) => updateDesk(chat, (cur) => ({ ...cur, pending: { ...cur.pending, [String(proposalId)]: { kind: "remove", agentKey: t.agentKey } } })),
    };
  }
  throw new DeskError(`Unknown \`desk ${sub}\`.`);
}

/** /desk resign: the trader steps down; their agent key is destroyed, so nothing can trade through it. */
export async function resignFromDesk(chat, client) {
  return wrap(async () => {
    await venueCtx(chat);
    const t = tradersOf(deskOf(chat)).find((x) => isTrader(x, chat, client.account.address));
    if (!t) throw new DeskError("Only the desk's traders can resign, and you aren't one.");
    await deleteAgentKey(t.agentKey);
    updateDesk(chat, (cur) => {
      delete cur.traders[t.agentKey];
      return cur;
    });
    return `✅ You've stepped down as a trader of the desk, and the bot has destroyed your agent key, so nothing can trade through it. Your open positions stay open until the DAO appoints a trader for those markets or closes them by proposal (\`perps close\`).`;
  });
}

/*//////////////////////////////////////////////////////////////
                           STATUS
//////////////////////////////////////////////////////////////*/

const positionsOf = (state) => state.assetPositions.map((a) => a.position).filter((p) => Number(p.szi) !== 0);

export async function deskStatus(chat, cmd) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const news = await refreshDesk(chat);
    const desk = deskOf(chat);
    const lines = [...news, ...(news.length ? [""] : []), "*Trading desk* (HyperCore)", `Account: the Treasury's HyperCore account \`${ctx.treasury}\``];
    if (desk.paused) lines.push(`⏸️ Paused${desk.paused.by ? ` by ${desk.paused.by}` : ""}: no new positions until \`${cmd("desk")} resume\`.`);
    const agents = await agentsOf(ctx).catch(() => null);
    const traders = tradersOf(desk);
    if (!traders.length) lines.push(`Traders: none. A would-be trader starts with \`${cmd("desk")} apply <markets> max=<size>\`.`);
    traders.forEach((t, i) => {
      const expired = Date.now() > t.expiresAt;
      const lost = agents && !listed(agents, t.agent, t.agentName) ? " - ⚠️ its agent is no longer approved on HyperCore" : "";
      lines.push(`${i + 1}. \`${t.address}\` - ${mandateText(t.mandate, COLLATERAL)}${expired ? " - ⏰ mandate ended" : `, until ${new Date(t.expiresAt).toISOString().slice(0, 10)}`}${lost}`);
    });
    for (const [id, a] of Object.entries(desk.pending)) {
      const t = a.kind === "remove" ? desk.traders[a.agentKey] : null;
      lines.push(a.kind === "remove" ? `Proposed: remove \`${t?.address ?? "a trader"}\` (proposal #${id})` : `Proposed: \`${a.address}\` (proposal #${id}) - ${mandateText(a.mandate, COLLATERAL)}`);
    }
    const state = await deskVenue.info(ctx, { type: "clearinghouseState", user: ctx.treasury });
    lines.push(`Collateral: ${fmt(Number(state.marginSummary.accountValue), 2)} USDC on HyperCore perps (withdrawable ${fmt(Number(state.withdrawable), 2)})`);
    const open = positionsOf(state);
    if (!open.length) lines.push(Number(state.marginSummary.accountValue) === 0 ? `No collateral yet - \`${cmd("desk")} fund <amount>\` proposes moving USDC to HyperCore.` : "No open positions.");
    for (const p of open) {
      const size = Math.abs(Number(p.szi));
      // Each market belongs to one trader, so the position in it is theirs.
      const owner = traders.findIndex((t) => covers(t.mandate, p.coin));
      const whose = owner >= 0 ? `trader ${owner + 1}` : "no trader";
      lines.push(`• ${p.coin} ${Number(p.szi) > 0 ? "long" : "short"} ${fmt(size)} @ ${fmt(Number(p.entryPx), 2)} · mark ${fmt(Number(p.positionValue) / size, 2)} · PnL ${Number(p.unrealizedPnl) >= 0 ? "+" : ""}${fmt(Number(p.unrealizedPnl), 2)} USDC · ${p.leverage.value}x · ${whose}`);
    }
    return lines.join("\n");
  });
}

/** /desk mine: the caller's own positions (those in their markets) and how much of their mandate they use. */
export async function deskMine(chat, client, cmd) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    await refreshDesk(chat);
    const desk = deskOf(chat);
    const traders = tradersOf(desk);
    const n = traders.findIndex((x) => isTrader(x, chat, client.account.address));
    if (n < 0) throw new DeskError(`You aren't one of the desk's traders - \`${cmd("desk")}\` shows who is.`);
    const t = traders[n];
    const state = await deskVenue.info(ctx, { type: "clearinghouseState", user: ctx.treasury });
    const open = positionsOf(state);
    const positions = open
      .filter((p) => covers(t.mandate, p.coin))
      .map((p) => {
        const size = Math.abs(Number(p.szi));
        return { symbol: p.coin, side: Number(p.szi) > 0 ? "long" : "short", size, entry: Number(p.entryPx), mark: Number(p.positionValue) / size, pnl: Number(p.unrealizedPnl), extra: `${p.leverage.value}x` };
      });
    const deskNotional = open.reduce((sum, p) => sum + Math.abs(Number(p.positionValue)), 0);
    const lines = mineLines(desk, t, { venue: "HyperCore", n: traders.length > 1 ? n + 1 : null, positions, deskNotional, symbol: COLLATERAL, cmd });
    if (!(await isApproved(ctx, t.agent, t.agentName))) lines.push("⚠️ Your agent is no longer approved on HyperCore, so you can't trade.");
    return lines.join("\n");
  });
}

/*//////////////////////////////////////////////////////////////
                           TRADING
//////////////////////////////////////////////////////////////*/

/** "1.500" -> "1.5": Hyperliquid wants numbers without trailing zeros. */
const wire = (text) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);

/**
 * /desk long|short|close on HyperCore: an appointed trader's order, in one
 * of their markets, after the mandate checks, signed with their agent key.
 * Returns the reply.
 */
export async function trade(chat, client, words) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    await refreshDesk(chat);
    const desk = deskOf(chat);
    const me = getAddress(client.account.address);
    const t = tradersOf(desk).find((x) => isTrader(x, chat, me));
    if (!t) throw new DeskError("Only the desk's appointed traders can trade.");
    if (!(await isApproved(ctx, t.agent, t.agentName))) throw new DeskError("The Treasury's HyperCore account no longer approves your agent - you've been removed or replaced.");
    const request = parsePerps(words);
    if (request.kind !== "open" && request.kind !== "close") throw new DeskError("Use `desk long|short <market> <size> at <price> [3x]` or `desk close <market> <size|all> at <price>`.");

    const m = await deskVenue.perpIndex(ctx, request.market);
    // Each market belongs to one trader: the position in it is theirs alone to open or close.
    if (!covers(t.mandate, m.coin)) throw new DeskError(`${m.coin} isn't one of your markets (${t.mandate.markets.join(", ")}).`);
    const state = await deskVenue.info(ctx, { type: "clearinghouseState", user: ctx.treasury });
    const open = positionsOf(state);
    const held = Number(open.find((p) => p.coin === m.coin)?.szi ?? 0);
    const price = wire(request.price);
    let order;
    let leverage;
    let what;
    if (request.kind === "open") {
      const lev = request.leverage ?? "1";
      if (!/^\d+$/.test(lev) || Number(lev) < 1) throw new DeskError("HyperCore leverage is a whole number, e.g. `3x`.");
      if (Number(lev) > m.maxLeverage) throw new DeskError(`${m.coin} allows at most ${m.maxLeverage}x.`);
      const isBuy = request.side === "long";
      if (held !== 0 && held > 0 !== isBuy) throw new DeskError(`The desk holds a ${m.coin} ${held > 0 ? "long" : "short"} - close it before opening a ${request.side}.`);
      const size = wire(request.size);
      deskVenue.checkTick(m, size, price);
      // This market's position after the order at the limit price; other markets (every trader's: one cross margin) at their current value.
      const notional = (Math.abs(held) + Number(size)) * Number(price);
      const others = open.filter((p) => p.coin !== m.coin).reduce((sum, p) => sum + Math.abs(Number(p.positionValue)), 0);
      checkOpen(desk, t, { market: m.coin.toUpperCase(), leverage: lev, notional, othersNotional: others, symbol: COLLATERAL });
      leverage = Number(lev);
      order = { a: m.index, b: isBuy, p: price, s: size, r: false, t: { limit: { tif: "Ioc" } } };
      what = `${request.side} ${size} ${m.coin} at ${price} or better, ${lev}x`;
    } else {
      if (held === 0) throw new DeskError(`The desk has no ${m.coin} position.`);
      const all = request.size.toLowerCase() === "all";
      const size = all ? wire(Math.abs(held).toFixed(m.szDecimals)) : wire(request.size);
      deskVenue.checkTick(m, size, price);
      if (Number(size) > Math.abs(held)) throw new DeskError(`The position is only ${Math.abs(held)} ${m.coin}.`);
      order = { a: m.index, b: held < 0, p: price, s: size, r: true, t: { limit: { tif: "Ioc" } } };
      what = `close ${all ? "all" : size} of the ${m.coin} ${held > 0 ? "long" : "short"} at ${price} or better`;
    }

    const exchange = exchangeFor(ctx, await getAgentAccount(t.agentKey));
    let result;
    try {
      if (leverage) await exchange.updateLeverage({ asset: m.index, isCross: true, leverage });
      const response = await exchange.order({ orders: [order], grouping: "na" });
      const filled = response.response?.data?.statuses?.[0]?.filled;
      result = filled ? `Filled ${filled.totalSz} ${m.coin} at an average ${filled.avgPx}.` : "Nothing filled at that price (immediate-or-cancel) - no change.";
    } catch (err) {
      if (err?.name !== "ApiRequestError") throw err;
      result = `Hyperliquid didn't take it: ${err.message}`;
    }
    return `📈 Trader \`${me}\`: ${what}.\n${result}`;
  });
}
