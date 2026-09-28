import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import { IntegrationError, checksummed, call, approveCall, requireCode } from "./common.js";

/**
 * Perpl - perpetual futures on Monad, traded by the Treasury directly
 * on-chain (not through Perpl's API, which needs an off-chain key the
 * Treasury can't hold).
 *
 * The Treasury is the Perpl account owner:
 *   deposit   first time: createAccount(amount); after: depositCollateral
 *   withdraw  withdrawCollateral(amount)
 *   open/close  execOrders([orderDesc], revertOnFail = true) - the same
 *               entrypoint and field mapping as Perpl's SDK
 *               (OrderRequest::to_order_desc), as an immediate-or-cancel
 *               order with a limit price. A proposal executes days after
 *               it's written, so the limit price is the protection: the
 *               order fills at that price or better, or not at all.
 * Units follow the SDK's converters: price in the market's priceDecimals,
 * size in its lotDecimals, leverage in hundredths, collateral in the
 * collateral token's decimals (getExchangeInfo().collateralDecimals).
 */

const ABI = loadIntegrationAbi("perpl").exchange;

// PerplFoundation/dex-sdk types/request.rs RequestType (0..3) and constants.
const ORDER = { OpenLong: 0, OpenShort: 1, CloseLong: 2, CloseShort: 3 };
const MAX_MATCHES = 1000n;
const DEFAULT_MAX_NEG_PNL_COLLAT_BPS = 1000n;
const LEVERAGE_DECIMALS = 2;

export const protocol = {
  id: "perpl",
  name: "Perpl",
  category: "Perpetuals",
  deployments: {
    "monad-mainnet": {
      exchange: "0x34b6552d57a35a1d042ccae1951bd1c370112a6f",
      collateral: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      collateralSymbol: "AUSD",
      markets: { BTC: 1, MON: 10, ETH: 20, SOL: 31, HYPE: 40, ZEC: 50 },
      sources: ["PerplFoundation/api-docs README (Network Configuration, Markets)", "monad-crypto/protocols mainnet registry (Perpl Exchange)"],
    },
    "monad-testnet": {
      exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc",
      // The api-docs README lists an older testnet collateral token; this is the one the exchange itself reports.
      collateral: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
      markets: { BTC: 16, ETH: 32, SOL: 48, MON: 64, ZEC: 256 },
      sources: [
        "PerplFoundation/api-docs README (Network Configuration, Markets)",
        "collateral: the exchange's own getExchangeInfo().collateralToken on Monad testnet (verify:integrations, 2026-09-28)",
      ],
    },
  },
};

/** verify-integrations: the exchange must report our collateral token. */
export async function verify(publicClient, d) {
  const info = await publicClient.readContract({ address: getAddress(d.exchange), abi: ABI, functionName: "getExchangeInfo" });
  const token = getAddress(info.collateralToken ?? info[4]);
  if (token !== getAddress(d.collateral)) return [`exchange collateralToken() is ${token}, expected ${getAddress(d.collateral)}`];
  return [];
}

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Perpl isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

const read = (ctx, d, functionName, args = []) => ctx.publicClient.readContract({ address: d.exchange, abi: ABI, functionName, args });

async function exchangeState(ctx, d) {
  await requireCode(ctx, { "Perpl Exchange": d.exchange });
  if (await read(ctx, d, "isHalted")) throw new IntegrationError("Perpl's exchange is halted right now.");
  const info = await read(ctx, d, "getExchangeInfo");
  const decimals = Number(info.collateralDecimals ?? info[3]);
  // Never approve a token the exchange doesn't actually take as collateral.
  const collateral = getAddress(info.collateralToken ?? info[4]);
  if (collateral !== d.collateral) throw new IntegrationError(`Perpl's exchange now takes ${collateral} as collateral, not the ${d.collateral} the bot has pinned - refusing until that's re-verified.`);
  const symbol = await ctx.publicClient.readContract({ address: collateral, abi: erc20Abi, functionName: "symbol" }).catch(() => d.collateralSymbol ?? "collateral");
  const account = await read(ctx, d, "getAccountByAddr", [ctx.treasury]);
  const whitelisting = await read(ctx, d, "whitelistingEnabled");
  const whitelisted = whitelisting ? await read(ctx, d, "whitelisted", [ctx.treasury]) : true;
  return { decimals, symbol, accountId: account.accountId, balance: account.balanceCNS, whitelisted };
}

/** Parse a human decimal into `decimals` places, refusing extra precision (the contract would silently truncate it). */
function scaled(text, decimals, what) {
  if (!/^\d+(\.\d+)?$/.test(String(text ?? ""))) throw new IntegrationError(`${what} "${text}" isn't a number.`);
  const frac = String(text).split(".")[1] ?? "";
  if (frac.length > decimals) throw new IntegrationError(`${what} ${text} has more than ${decimals} decimal places, which this market can't represent.`);
  const value = parseUnits(String(text), decimals);
  if (value === 0n) throw new IntegrationError(`${what} must be more than 0.`);
  return value;
}

async function market(ctx, d, word) {
  const perpId = /^\d+$/.test(String(word)) ? Number(word) : d.markets[String(word).toUpperCase()];
  if (perpId === undefined) throw new IntegrationError(`Unknown Perpl market "${word}". Markets: ${Object.keys(d.markets).join(", ")} (or a market id).`);
  if (!(await read(ctx, d, "perpetualExists", [BigInt(perpId)]))) throw new IntegrationError(`Perpl market ${perpId} doesn't exist.`);
  const info = await read(ctx, d, "getPerpetualInfo", [BigInt(perpId)]);
  // The SDK reads getMarginFractions(perpId, 0) and treats the first value as
  // the market's maximum leverage in hundredths (state/mod.rs, request.rs);
  // it's also the leverage the SDK sends when none is named, closes included.
  const [maxLeverageHdths] = await read(ctx, d, "getMarginFractions", [BigInt(perpId), 0n]);
  return {
    perpId: BigInt(perpId),
    symbol: info.symbol,
    priceDecimals: Number(info.priceDecimals),
    lotDecimals: Number(info.lotDecimals),
    maxLeverageHdths,
  };
}

function orderDesc({ perpId, orderType, pricePNS, lotLNS, leverageHdths }) {
  return {
    // Client order id: any u64; unique per request so events can be matched.
    orderDescId: BigInt(Date.now()),
    perpId,
    orderType,
    orderId: 0n,
    pricePNS,
    lotLNS,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: MAX_MATCHES,
    leverageHdths,
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: DEFAULT_MAX_NEG_PNL_COLLAT_BPS,
  };
}

const orderCall = (d, desc, note) => call(d.exchange, encodeFunctionData({ abi: ABI, functionName: "execOrders", args: [[desc], true] }), { note });

function whitelistNote(state) {
  return state.whitelisted ? "" : " ⚠️ Perpl currently only accepts whitelisted accounts and the Treasury isn't one - this will revert unless it's whitelisted first.";
}

export const actions = [
  {
    id: "perpl-deposit",
    label: "Deposit collateral into the Treasury's Perpl account (opens it the first time)",
    usage: ["amount"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const state = await exchangeState(ctx, d);
      const amount = scaled(ctx.args[0], state.decimals, "Amount");
      const opening = state.accountId === 0n;
      if (opening) {
        const min = await read(ctx, d, "getMinAccountOpenCNS");
        if (amount < min) throw new IntegrationError(`Opening a Perpl account needs at least ${formatUnits(min, state.decimals)} ${state.symbol}.`);
      }
      return {
        calls: [
          approveCall(d.collateral, d.exchange, amount, "approve Perpl"),
          call(d.exchange, encodeFunctionData({ abi: ABI, functionName: opening ? "createAccount" : "depositCollateral", args: [amount] }), { note: opening ? "open account" : "deposit" }),
        ],
        summary:
          `${opening ? "Open a Perpl account for the Treasury with" : "Deposit"} ${formatUnits(amount, state.decimals)} ${state.symbol} ${opening ? "" : "into the Treasury's Perpl account "}as trading collateral.`.replace(/  +/g, " ") +
          whitelistNote(state),
      };
    },
  },
  {
    id: "perpl-withdraw",
    label: "Withdraw collateral from the Treasury's Perpl account",
    usage: ["amount"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const state = await exchangeState(ctx, d);
      if (state.accountId === 0n) throw new IntegrationError("The Treasury has no Perpl account yet.");
      const amount = scaled(ctx.args[0], state.decimals, "Amount");
      if (amount > state.balance) throw new IntegrationError(`The Treasury's Perpl account has ${formatUnits(state.balance, state.decimals)} ${state.symbol} free.`);
      return {
        calls: [call(d.exchange, encodeFunctionData({ abi: ABI, functionName: "withdrawCollateral", args: [amount] }), { note: "withdraw" })],
        summary: `Withdraw ${formatUnits(amount, state.decimals)} ${state.symbol} from the Treasury's Perpl account to the Treasury.`,
      };
    },
  },
  {
    id: "perpl-open",
    label: "Open (or add to) a Perpl long or short, at a limit price or better",
    usage: ["market", "long|short", "size", "limitPrice"],
    options: [{ name: "leverage", description: "position leverage, e.g. 2 or 2.5", default: "1" }],
    help: "Immediate-or-cancel: at execution it fills what it can at the limit price or better and cancels the rest - nothing is left resting on the book. Longs: the most you'll pay. Shorts: the least you'll sell at.",
    async build(ctx) {
      const d = deployment(ctx);
      const state = await exchangeState(ctx, d);
      if (state.accountId === 0n) throw new IntegrationError("The Treasury has no Perpl account yet - propose perpl-deposit first.");
      const m = await market(ctx, d, ctx.args[0]);
      const side = String(ctx.args[1]).toLowerCase();
      if (side !== "long" && side !== "short") throw new IntegrationError('Second argument must be "long" or "short".');
      const lotLNS = scaled(ctx.args[2], m.lotDecimals, "Size");
      const pricePNS = scaled(ctx.args[3], m.priceDecimals, "Limit price");
      const leverageHdths = scaled(ctx.options.leverage ?? "1", LEVERAGE_DECIMALS, "Leverage");
      if (leverageHdths > m.maxLeverageHdths) {
        throw new IntegrationError(`${m.symbol} allows at most ${formatUnits(m.maxLeverageHdths, LEVERAGE_DECIMALS)}x leverage.`);
      }
      const desc = orderDesc({ perpId: m.perpId, orderType: side === "long" ? ORDER.OpenLong : ORDER.OpenShort, pricePNS, lotLNS, leverageHdths });
      return {
        calls: [orderCall(d, desc, "open")],
        summary:
          `Open a ${ctx.options.leverage ?? "1"}x ${side} of ${ctx.args[2]} ${m.symbol} on Perpl at ${ctx.args[3]} or better ` +
          `(immediate-or-cancel; unfilled size is cancelled). Margin comes from the Treasury's Perpl balance, ` +
          `now ${formatUnits(state.balance, state.decimals)} ${state.symbol}.` + whitelistNote(state),
      };
    },
  },
  {
    id: "perpl-close",
    label: "Close (or reduce) a Perpl position, at a limit price or better",
    usage: ["market", "long|short", "size|all", "limitPrice"],
    options: [],
    help: "long|short names the position being closed. Longs close by selling (limit = the least you'll accept); shorts by buying (limit = the most you'll pay).",
    async build(ctx) {
      const d = deployment(ctx);
      const state = await exchangeState(ctx, d);
      if (state.accountId === 0n) throw new IntegrationError("The Treasury has no Perpl account.");
      const m = await market(ctx, d, ctx.args[0]);
      const side = String(ctx.args[1]).toLowerCase();
      if (side !== "long" && side !== "short") throw new IntegrationError('Second argument must be "long" or "short".');
      const [position] = await read(ctx, d, "getPosition", [m.perpId, state.accountId]);
      if (position.lotLNS === 0n) throw new IntegrationError(`The Treasury has no ${m.symbol} position on Perpl.`);
      const isLong = Number(position.positionType) === 0;
      if ((side === "long") !== isLong) throw new IntegrationError(`The Treasury's ${m.symbol} position is a ${isLong ? "long" : "short"}, not a ${side}.`);
      const all = String(ctx.args[2]).toLowerCase() === "all";
      const lotLNS = all ? position.lotLNS : scaled(ctx.args[2], m.lotDecimals, "Size");
      if (lotLNS > position.lotLNS) throw new IntegrationError(`The position is only ${formatUnits(position.lotLNS, m.lotDecimals)} ${m.symbol}.`);
      const pricePNS = scaled(ctx.args[3], m.priceDecimals, "Limit price");
      const desc = orderDesc({ perpId: m.perpId, orderType: side === "long" ? ORDER.CloseLong : ORDER.CloseShort, pricePNS, lotLNS, leverageHdths: m.maxLeverageHdths });
      return {
        calls: [orderCall(d, desc, "close")],
        summary: `Close ${all ? "all" : formatUnits(lotLNS, m.lotDecimals)} of the Treasury's ${m.symbol} ${side} on Perpl at ${ctx.args[3]} or better (immediate-or-cancel).`,
      };
    },
  },
];
