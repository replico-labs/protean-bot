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

/**
 * Trading desk: the group appoints a trader by proposal, and the trader then
 * trades from the chat without a vote per trade.
 *
 * On-chain (Perpl, Monad): the desk is a Perpl DelegatedAccount owned by the
 * Treasury, with the trader's bot wallet as its operator. The operator can
 * only call the exchange's trading functions through it; withdrawing is the
 * owner's alone and always pays the owner, so the most a trader can do with
 * the desk's money is trade it - never take it. Funding, withdrawing and
 * removing the trader are proposals (perpl-desk-* actions).
 *
 * The mandate - markets, the largest position, the most leverage, how many
 * days - is written into the appointment proposal, so voters see what they
 * agree to, and the bot refuses any trade outside it. Those limits are
 * enforced by the bot (Perpl's contract has no such limits), and they hold
 * because the trader's key lives in the bot's KMS wallet store and is never
 * handed out. What's on-chain regardless: the trader can't withdraw, and the
 * DAO risks only what it funded the desk with.
 *
 * Record per chat (db.js getChatDesk): { address, trader, pending }, where
 * `pending` holds appointments by proposal id until their proposal executes.
 */

export class DeskError extends Error {}

const VENUE_NETWORKS = new Set(["monad-testnet", "monad-mainnet"]);
const SIGNATURE_DAYS = 60; // the trader's consent must still be valid when the proposal executes, however long the vote takes
const MAX_DAYS = 365;
const CLOSED = new Set(["Defeated", "Cancelled", "Expired", "Rejected", "Failed"]);

export function deskUsage(cmd) {
  const d = cmd("desk");
  return [
    `\`${d}\` - the DAO's trading desk: trader, limits, collateral, positions`,
    `\`${d} apply <markets|all> max=<size> [lev=2] [days=30]\` - propose yourself as the trader (e.g. \`${d} apply BTC,ETH max=500 lev=3 days=30\`; max is the largest position, in the collateral token)`,
    `\`${d} fund <amount>\` / \`${d} withdraw <amount>\` - propose moving collateral between the Treasury and the desk`,
    `\`${d} remove\` - propose removing the trader · \`${d} resign\` - the trader steps down`,
    `\`${d} long|short <market> <size> at <limitPrice> [3x]\` / \`${d} close <market> <size|all> at <limitPrice>\` - the trader trades, no vote`,
    "The trader can trade the desk's collateral but never withdraw it - only the Treasury can, by proposal.",
  ].join("\n");
}

function requireVenue() {
  const network = currentNetwork();
  if (!VENUE_NETWORKS.has(network.id)) throw new DeskError(`Trading desks run on Perpl (Monad) for now - not on ${network.chain.name} yet.`);
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

/*//////////////////////////////////////////////////////////////
                         MANDATE
//////////////////////////////////////////////////////////////*/

/** `apply` words -> mandate: { markets: [..] | "all", max, lev, days }. */
export function parseMandate(words) {
  const w = words.filter(Boolean);
  const opts = Object.fromEntries(w.filter((x) => x.includes("=")).map((x) => [x.split("=")[0].toLowerCase(), x.slice(x.indexOf("=") + 1)]));
  const marketsWord = opts.markets ?? w.find((x) => !x.includes("="));
  if (!marketsWord) throw new DeskError("Name the markets the trader may trade (e.g. `BTC,ETH`, or `all`).");
  const markets = marketsWord.toLowerCase() === "all" ? "all" : [...new Set(marketsWord.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean))];
  const num = (v, what) => {
    if (!/^\d+(\.\d+)?$/.test(String(v ?? "").replace(/,/g, ""))) throw new DeskError(`${what} must be a number.`);
    return String(v).replace(/,/g, "");
  };
  if (opts.max === undefined) throw new DeskError("Set the largest position the trader may hold: `max=<size>` in the collateral token (e.g. `max=500`).");
  const max = num(opts.max, "max");
  const lev = num((opts.lev ?? opts.leverage ?? "2").replace(/x$/i, ""), "lev");
  const days = Number(num(opts.days ?? "30", "days"));
  if (Number(max) <= 0) throw new DeskError("max must be more than 0.");
  if (Number(lev) < 1) throw new DeskError("lev must be at least 1.");
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new DeskError(`days must be a whole number from 1 to ${MAX_DAYS}.`);
  return { markets, max, lev, days };
}

export function mandateText(m, symbol = "") {
  const markets = m.markets === "all" ? "any market" : m.markets.join(", ");
  return `${markets}; positions up to ${m.max}${symbol ? ` ${symbol}` : ""}; up to ${m.lev}x leverage; for ${m.days} day${m.days === 1 ? "" : "s"}`;
}

/*//////////////////////////////////////////////////////////////
                     APPOINTMENT LIFECYCLE
//////////////////////////////////////////////////////////////*/

const stateLabelOf = (p) => p.stateLabel ?? p.statusLabel ?? p.phaseLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";

/**
 * Settles pending appointments whose proposal has finished: executed and the
 * trader really is the desk's operator -> active, with the mandate's clock
 * starting now; defeated/cancelled/expired -> dropped. Returns lines worth
 * telling the chat.
 */
export async function refreshDesk(chat) {
  const desk = getChatDesk(chat.chatId, chat.platform);
  if (!desk?.pending || !Object.keys(desk.pending).length) return [];
  const governance = getChatDAO(chat.chatId, chat.platform);
  const adapter = getAdapter(getChatModel(chat.chatId, chat.platform));
  const news = [];
  const updates = {};
  for (const [id, a] of Object.entries(desk.pending)) {
    const label = stateLabelOf(await adapter.getProposal(governance, id));
    if (CLOSED.has(label)) {
      updates[id] = { drop: true };
      continue;
    }
    if (label !== "Executed") continue;
    const address = desk.address ?? a.desk;
    if (!address) continue; // a new desk: its address comes from the execution receipt (deskExecuted) or /desk link
    const active = await publicClient.readContract({ address, abi: DESK_ABI, functionName: "isOperator", args: [a.address] });
    if (!active) {
      updates[id] = { drop: true };
      news.push(`⚠️ Proposal #${id} executed, but ${a.address} isn't the desk's trader on-chain - nothing changed.`);
      continue;
    }
    updates[id] = { activate: { ...a, since: Date.now(), expiresAt: Date.now() + a.mandate.days * 86_400_000 }, address };
    news.push(`📈 The trading desk has a trader: \`${a.address}\` (${mandateText(a.mandate)}).`);
  }
  if (!Object.keys(updates).length) return news;
  updateChatDesk(
    chat.chatId,
    (cur) => {
      const next = cur ?? { pending: {} };
      for (const [id, u] of Object.entries(updates)) {
        delete next.pending?.[id];
        if (u.activate) {
          next.address ??= u.address;
          const { desk: _, kind: __, ...trader } = u.activate;
          next.trader = trader;
        }
      }
      return next;
    },
    chat.platform
  );
  return news;
}

/**
 * Called by the event listener when one of the chat's proposals executes:
 * a desk-creating appointment learns its desk's address from the receipt
 * (Perpl's factory event, owner = this Treasury), then activates.
 */
export async function deskExecuted(chat, proposalId, txHash) {
  const desk = getChatDesk(chat.chatId, chat.platform);
  const a = desk?.pending?.[String(proposalId)];
  if (!a) return [];
  if (!desk.address && a.kind === "create" && txHash) {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const ctx = await venueCtx(chat);
    const created = parseEventLogs({ abi: deskVenue.DESK_FACTORY_ABI, logs: receipt.logs, eventName: "DelegatedAccountCreated" }).find(
      (l) => getAddress(l.address) === deskVenue.deployment(ctx).deskFactory && getAddress(l.args.owner) === getAddress(ctx.treasury)
    );
    if (created) {
      await verifyDesk(ctx, created.args.proxy);
      updateChatDesk(chat.chatId, (cur) => ({ ...cur, address: getAddress(created.args.proxy) }), chat.platform);
    }
  }
  return refreshDesk(chat);
}

/** Links a desk by address (when its creation wasn't seen): must be a Perpl desk owned by this Treasury. */
export async function linkDesk(chat, word) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const { desk } = await verifyDesk(ctx, word);
    updateChatDesk(chat.chatId, (cur) => ({ pending: {}, ...cur, address: desk }), chat.platform);
    const news = await refreshDesk(chat);
    return [`✅ Linked the trading desk \`${desk}\`.`, ...news].join("\n");
  });
}

/**
 * /desk apply: the caller volunteers. Their wallet signs Perpl's
 * AssignOperator consent, and the returned action words become the
 * appointment proposal (create the desk, or add them as its operator).
 * `record(proposalId)` stores the appointment once the proposal exists.
 */
export async function applyForDesk(chat, account, words) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const mandate = parseMandate(words);
    const desk = getChatDesk(chat.chatId, chat.platform);
    const d = deskVenue.deployment(ctx);
    if (mandate.markets !== "all") {
      const unknown = mandate.markets.filter((m) => d.markets[m] === undefined);
      if (unknown.length) throw new DeskError(`Unknown Perpl market${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Markets: ${Object.keys(d.markets).join(", ")}.`);
    }
    if (desk?.address) await verifyDesk(ctx, desk.address);
    // The contract checks the deadline against block time, so count from the chain's clock.
    const { timestamp } = await publicClient.getBlock();
    const deadline = timestamp + BigInt(SIGNATURE_DAYS * 86_400);
    const typed = await deskConsentRequest(ctx, { desk: desk?.address, operator: account.address, deadline });
    const signature = await account.signTypedData(typed);
    const state = await deskVenue.exchangeState(ctx, d, desk?.address ?? ctx.treasury).catch(() => ({ symbol: d.collateralSymbol ?? "" }));
    const description = `Appoint ${account.address} as the DAO's trader on Perpl: ${mandateText(mandate, state.symbol)}. The trader can trade the desk's collateral but never withdraw it.`;
    const current = desk?.trader?.address;
    const kind = desk?.address ? "appoint" : "create";
    const actionWords =
      kind === "create"
        ? ["perpl-desk-create", account.address, deadline.toString(), signature, ...description.split(" ")]
        : ["perpl-desk-appoint", desk.address, account.address, deadline.toString(), signature, ...(current && getAddress(current) !== getAddress(account.address) ? [`replace=${current}`] : []), ...description.split(" ")];
    return {
      actionId: actionWords[0],
      words: actionWords.slice(1),
      note: kind === "create" ? "Once it passes and executes, the desk exists; then fund it with a `desk fund` proposal." : "",
      record: (proposalId) =>
        updateChatDesk(
          chat.chatId,
          (cur) => ({ pending: {}, ...cur, pending: { ...(cur?.pending ?? {}), [String(proposalId)]: { kind, desk: desk?.address ?? null, platform: chat.platform, userId: String(chat.userId), address: account.address, mandate } } }),
          chat.platform
        ),
    };
  });
}

/** The action words for fund / withdraw / remove proposals. */
export function deskProposalWords(chat, sub, args) {
  requireVenue();
  const desk = getChatDesk(chat.chatId, chat.platform);
  if (!desk?.address) throw new DeskError("This DAO has no trading desk yet - someone has to `desk apply` and the proposal pass first.");
  if (sub === "fund" || sub === "withdraw") {
    const amount = String(args[0] ?? "").replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(amount)) throw new DeskError(`Give an amount: \`desk ${sub} <amount>\`.`);
    const rest = args.slice(1);
    const description = rest.length ? rest : `${sub === "fund" ? "Fund the trading desk with" : "Withdraw from the trading desk:"} ${amount}.`.split(" ");
    return { actionId: `perpl-desk-${sub}`, words: [desk.address, amount, ...description] };
  }
  if (sub === "remove") {
    if (!desk.trader) throw new DeskError("The desk has no trader to remove.");
    const rest = args.length ? args : `Remove ${desk.trader.address} as the DAO's trader.`.split(" ");
    return { actionId: "perpl-desk-remove", words: [desk.address, desk.trader.address, ...rest] };
  }
  throw new DeskError(`Unknown \`desk ${sub}\`.`);
}

/** /desk resign: the trader steps down, signed by their own wallet. */
export async function resignFromDesk(chat, client) {
  return wrap(async () => {
    requireVenue();
    const desk = getChatDesk(chat.chatId, chat.platform);
    if (!desk?.address || !desk.trader) throw new DeskError("The desk has no trader.");
    if (getAddress(desk.trader.address) !== getAddress(client.account.address)) throw new DeskError("Only the desk's trader can resign.");
    const hash = await writeWithGasBuffer(client, { address: desk.address, abi: DESK_ABI, functionName: "resignOperator" });
    await publicClient.waitForTransactionReceipt({ hash });
    updateChatDesk(chat.chatId, (cur) => ({ ...cur, trader: null }), chat.platform);
    return "✅ You've stepped down as the desk's trader. Open positions stay open until the DAO appoints a new trader or withdraws.";
  });
}

/*//////////////////////////////////////////////////////////////
                           STATUS
//////////////////////////////////////////////////////////////*/

const fmt = (n, digits = 4) => (Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "?");

export async function deskStatus(chat, cmd) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    const news = await refreshDesk(chat);
    const desk = getChatDesk(chat.chatId, chat.platform);
    const lines = [...news, ...(news.length ? [""] : []), "*Trading desk* (Perpl)"];
    if (!desk?.address) {
      lines.push(desk?.pending && Object.keys(desk.pending).length ? `No desk yet - waiting on proposal${Object.keys(desk.pending).length > 1 ? "s" : ""} #${Object.keys(desk.pending).join(", #")}.` : `No desk yet. A would-be trader starts with \`${cmd("desk")} apply <markets> max=<size>\`.`);
      return lines.join("\n");
    }
    const d = deskVenue.deployment(ctx);
    const state = await deskVenue.exchangeState(ctx, d, desk.address);
    lines.push(`Desk: \`${desk.address}\``);
    if (desk.trader) {
      const expired = Date.now() > desk.trader.expiresAt;
      lines.push(`Trader: \`${desk.trader.address}\` - ${mandateText(desk.trader.mandate, state.symbol)}${expired ? " - ⏰ mandate ended" : `, until ${new Date(desk.trader.expiresAt).toISOString().slice(0, 10)}`}`);
    } else lines.push("Trader: none");
    for (const [id, a] of Object.entries(desk.pending ?? {})) lines.push(`Proposed: \`${a.address}\` (proposal #${id}) - ${mandateText(a.mandate, state.symbol)}`);
    if (state.accountId === 0n) {
      lines.push(`Collateral: none yet - \`${cmd("desk")} fund <amount>\` proposes moving some from the Treasury.`);
      return lines.join("\n");
    }
    lines.push(`Collateral: ${formatUnits(state.balance, state.decimals)} ${state.symbol}${state.locked ? ` (${formatUnits(state.locked, state.decimals)} in positions)` : ""}`);
    const positions = await deskVenue.openPositions(ctx, d, state.accountId);
    if (!positions.length) lines.push("No open positions.");
    for (const p of positions) lines.push(`• ${p.symbol} ${p.side} ${fmt(p.size)} @ ${fmt(p.entry, 2)} · mark ${fmt(p.mark, 2)} · PnL ${p.pnl >= 0 ? "+" : ""}${fmt(p.pnl, 2)} ${state.symbol}`);
    return lines.join("\n");
  });
}

/*//////////////////////////////////////////////////////////////
                           TRADING
//////////////////////////////////////////////////////////////*/

/**
 * /desk long|short|close: the appointed trader opens or closes a position, signed by their
 * own wallet through the desk - after the mandate checks. Returns the reply.
 */
export async function trade(chat, client, words) {
  return wrap(async () => {
    const ctx = await venueCtx(chat);
    await refreshDesk(chat);
    const desk = getChatDesk(chat.chatId, chat.platform);
    if (!desk?.address) throw new DeskError("This DAO has no trading desk.");
    const t = desk.trader;
    const me = getAddress(client.account.address);
    if (!t || t.platform !== chat.platform || String(t.userId) !== String(chat.userId) || getAddress(t.address) !== me) throw new DeskError("Only the desk's appointed trader can trade.");
    if (!(await publicClient.readContract({ address: desk.address, abi: DESK_ABI, functionName: "isOperator", args: [me] }))) {
      throw new DeskError("You're no longer the desk's trader on-chain.");
    }
    const request = parsePerps(words);
    if (request.kind !== "open" && request.kind !== "close") throw new DeskError("Use `desk long|short <market> <size> at <price> [3x]` or `desk close <market> <size|all> at <price>`.");

    const d = deskVenue.deployment(ctx);
    const state = await deskVenue.exchangeState(ctx, d, desk.address);
    if (state.accountId === 0n) throw new DeskError("The desk has no collateral yet - it needs a `desk fund` proposal first.");
    const m = await deskVenue.market(ctx, d, request.market);
    const [position] = await deskVenue.read(ctx, d, "getPosition", [m.perpId, state.accountId]);
    const held = position.lotLNS;
    const heldLong = Number(position.positionType) === 0;
    const pricePNS = deskVenue.scaled(request.price, m.priceDecimals, "Limit price");

    let desc;
    let what;
    if (request.kind === "open") {
      if (Date.now() > t.expiresAt) throw new DeskError("Your mandate has ended - the DAO needs to appoint you again to open positions. You can still close them.");
      const { mandate } = t;
      if (mandate.markets !== "all" && !mandate.markets.includes(request.market)) throw new DeskError(`Your mandate covers ${mandate.markets.join(", ")}, not ${request.market}.`);
      const lev = request.leverage ?? "1";
      if (Number(lev) > Number(mandate.lev)) throw new DeskError(`Your mandate allows up to ${mandate.lev}x, not ${lev}x.`);
      const leverageHdths = deskVenue.scaled(lev, deskVenue.LEVERAGE_DECIMALS, "Leverage");
      if (leverageHdths > m.maxLeverageHdths) throw new DeskError(`${m.symbol} allows at most ${formatUnits(m.maxLeverageHdths, deskVenue.LEVERAGE_DECIMALS)}x.`);
      if (held > 0n && heldLong !== (request.side === "long")) throw new DeskError(`The desk holds a ${m.symbol} ${heldLong ? "long" : "short"} - close it before opening a ${request.side}.`);
      const lotLNS = deskVenue.scaled(request.size, m.lotDecimals, "Size");
      // Position size in collateral at the limit price, including what's already held.
      const notional = Number(formatUnits(held + lotLNS, m.lotDecimals)) * Number(request.price);
      if (notional > Number(mandate.max)) {
        throw new DeskError(`That makes the ${m.symbol} position ${fmt(notional, 2)} ${state.symbol} at your limit price; your mandate allows up to ${mandate.max}.`);
      }
      desc = deskVenue.orderDesc({ perpId: m.perpId, orderType: request.side === "long" ? deskVenue.ORDER.OpenLong : deskVenue.ORDER.OpenShort, pricePNS, lotLNS, leverageHdths });
      what = `${request.side} ${request.size} ${m.symbol} at ${request.price} or better, ${lev}x`;
    } else {
      if (held === 0n) throw new DeskError(`The desk has no ${m.symbol} position.`);
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
    const result = filled === 0n ? "Nothing filled at that price (immediate-or-cancel) - no change." : `Filled ${size(filled)} ${m.symbol}; the desk's ${m.symbol} position is now ${after.lotLNS === 0n ? "closed" : `${size(after.lotLNS)} ${Number(after.positionType) === 0 ? "long" : "short"}`}.`;
    return `📈 Trader \`${me}\`: ${what}.\n${result}`;
  });
}
