import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, parseUnits, recoverTypedDataAddress } from "viem";
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
 *
 * Trading desk (perpl-desk-*, used by /desk and /trade - src/desk.js): a
 * Perpl DelegatedAccount (PerplFoundation/delegated-account) owned by the
 * Treasury, with a trader appointed by proposal as its operator. The
 * operator can only call the exchange's trading functions through it; only
 * the owner can withdraw, and withdrawals always go to the owner. Created by
 * Perpl's DelegatedAccountFactory, so every desk runs Perpl's audited code.
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
      deskFactory: "0xc535276e3e446e4f28d95ed27ccd5c32e4c8907a",
      collateral: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
      collateralSymbol: "AUSD",
      markets: { BTC: 1, MON: 10, ETH: 20, SOL: 31, HYPE: 40, ZEC: 50 },
      sources: [
        "PerplFoundation/api-docs README (Network Configuration, Markets)",
        "monad-crypto/protocols mainnet registry (Perpl Exchange)",
        "deskFactory: PerplFoundation/delegated-account README (Deployed Contracts, Monad Mainnet)",
      ],
    },
    "monad-testnet": {
      exchange: "0x1964c32f0be608e7d29302aff5e61268e72080cc",
      deskFactory: "0xf42548ccb3300bc76c35dc2d347416db2e8d7209",
      // The api-docs README lists an older testnet collateral token; this is the one the exchange itself reports.
      collateral: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
      markets: { BTC: 16, ETH: 32, SOL: 48, MON: 64, ZEC: 256, LIT: 272, VVV: 288, TAO: 304, PUMP: 320, NEAR: 336, UNI: 352, ARB: 368, AAVE: 384, MORPHO: 400, ENA: 416 },
      sources: [
        "PerplFoundation/api-docs README (Network Configuration, Markets)",
        "markets: every id 0-1020 read from the exchange (perpetualExists + getPerpetualInfo) by scripts/perpl-markets.mjs, 2026-10-13",
        "collateral: the exchange's own getExchangeInfo().collateralToken on Monad testnet (verify:integrations, 2026-09-28)",
        "deskFactory: PerplFoundation/delegated-account README (Deployed Contracts, Monad Testnet)",
      ],
    },
  },
};

/** verify-integrations: the exchange must report our collateral token. */
export async function verify(publicClient, d) {
  const info = await publicClient.readContract({ address: getAddress(d.exchange), abi: ABI, functionName: "getExchangeInfo" });
  const token = getAddress(info.collateralToken ?? info[4]);
  if (token !== getAddress(d.collateral)) return [`exchange collateralToken() is ${token}, expected ${getAddress(d.collateral)}`];
  // The desk factory must be bound to this same exchange.
  const bound = await publicClient.readContract({ address: getAddress(d.deskFactory), abi: DESK_FACTORY_ABI, functionName: "EXCHANGE" });
  if (getAddress(bound) !== getAddress(d.exchange)) return [`desk factory EXCHANGE() is ${bound}, expected ${getAddress(d.exchange)}`];
  return [];
}

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Perpl isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

// PerplFoundation/delegated-account: src/DelegatedAccountFactory.sol, src/DelegatedAccount.sol.
const DESK_FACTORY_ABI = parseAbi([
  "function create(address _operator, uint256 _opDeadline, bytes _opSig) returns (address proxy)",
  "function operatorNonces(address) view returns (uint256)",
  "function beacon() view returns (address)",
  "function EXCHANGE() view returns (address)",
  "event DelegatedAccountCreated(address indexed proxy, address indexed owner, address indexed operator)",
]);
export const DESK_ABI = parseAbi([
  "function owner() view returns (address)",
  "function exchange() view returns (address)",
  "function accountId() view returns (uint256)",
  "function isOperator(address) view returns (bool)",
  "function operatorNonces(address) view returns (uint256)",
  "function addOperator(address _operator, uint256 _deadline, bytes _sig)",
  "function removeOperator(address _operator)",
  "function resignOperator()",
  "function createAccount(uint256 amount)",
  "function withdrawCollateral(uint256 amount)",
]);
// ERC-1967 beacon slot: where a BeaconProxy keeps its beacon.
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ASSIGN_OPERATOR_TYPES = { AssignOperator: [{ name: "owner", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };

const read = (ctx, d, functionName, args = []) => ctx.publicClient.readContract({ address: d.exchange, abi: ABI, functionName, args });

async function exchangeState(ctx, d, owner = ctx.treasury) {
  await requireCode(ctx, { "Perpl Exchange": d.exchange });
  if (await read(ctx, d, "isHalted")) throw new IntegrationError("Perpl's exchange is halted right now.");
  const info = await read(ctx, d, "getExchangeInfo");
  const decimals = Number(info.collateralDecimals ?? info[3]);
  // Never approve a token the exchange doesn't actually take as collateral.
  const collateral = getAddress(info.collateralToken ?? info[4]);
  if (collateral !== d.collateral) throw new IntegrationError(`Perpl's exchange now takes ${collateral} as collateral, not the ${d.collateral} the bot has pinned - refusing until that's re-verified.`);
  const symbol = await ctx.publicClient.readContract({ address: collateral, abi: erc20Abi, functionName: "symbol" }).catch(() => d.collateralSymbol ?? "collateral");
  // An address with no Perpl account makes getAccountByAddr revert (testnet:
  // error 0x03a0e277 carrying the address) rather than return id 0.
  const account = await read(ctx, d, "getAccountByAddr", [owner]).catch((err) => {
    if (/revert/i.test(`${err.shortMessage ?? ""} ${err.message ?? ""}`)) return { accountId: 0n, balanceCNS: 0n };
    throw err;
  });
  const whitelisting = await read(ctx, d, "whitelistingEnabled");
  const whitelisted = whitelisting ? await read(ctx, d, "whitelisted", [owner]) : true;
  return { decimals, symbol, accountId: account.accountId, balance: account.balanceCNS, locked: account.lockedBalanceCNS ?? 0n, whitelisted };
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
  ...deskActions(),
];

/*//////////////////////////////////////////////////////////////
                    TRADING DESK (src/desk.js)
//////////////////////////////////////////////////////////////*/

/** EIP-712 consent a trader signs to become a desk's operator: (owner, nonce, deadline). */
export function assignOperatorTypedData({ chainId, verifyingContract, factory, owner, nonce, deadline }) {
  return {
    domain: factory
      ? { name: "DelegatedAccountFactory", version: "1", chainId, verifyingContract: getAddress(verifyingContract) }
      : { name: "DelegatedAccount", version: "1", chainId, verifyingContract: getAddress(verifyingContract) },
    types: ASSIGN_OPERATOR_TYPES,
    primaryType: "AssignOperator",
    message: { owner: getAddress(owner), nonce: BigInt(nonce), deadline: BigInt(deadline) },
  };
}

/**
 * What the trader signs to be appointed: to the factory when the Treasury has
 * no desk yet, to the desk itself otherwise. The nonce is the one the
 * contract will check when the proposal executes.
 */
export async function deskConsentRequest(ctx, { desk, operator, deadline }) {
  const d = deployment(ctx);
  const target = desk ? getAddress(desk) : d.deskFactory;
  const nonce = await ctx.publicClient.readContract({ address: target, abi: desk ? DESK_ABI : DESK_FACTORY_ABI, functionName: "operatorNonces", args: [getAddress(operator)] });
  return assignOperatorTypedData({ chainId: ctx.network.chain.id, verifyingContract: target, factory: !desk, owner: ctx.treasury, nonce, deadline });
}

/**
 * A desk the bot will act on: a Perpl DelegatedAccount from Perpl's factory
 * (its beacon), on this exchange, owned by this Treasury. Anything else -
 * a look-alike contract, someone else's desk - is refused.
 */
export async function verifyDesk(ctx, deskWord, owner = ctx.treasury) {
  const d = deployment(ctx);
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(deskWord ?? ""))) throw new IntegrationError(`"${deskWord}" isn't a desk address.`);
  const desk = getAddress(deskWord);
  const readDesk = (functionName, args = []) => ctx.publicClient.readContract({ address: desk, abi: DESK_ABI, functionName, args });
  const [slot, beacon] = await Promise.all([ctx.publicClient.getStorageAt({ address: desk, slot: BEACON_SLOT }), ctx.publicClient.readContract({ address: d.deskFactory, abi: DESK_FACTORY_ABI, functionName: "beacon" })]);
  if (!slot || BigInt(slot) === 0n || getAddress(`0x${slot.slice(-40)}`) !== getAddress(beacon)) throw new IntegrationError(`${desk} isn't a desk made by Perpl's DelegatedAccount factory.`);
  const [deskOwner, exchange, accountId] = await Promise.all([readDesk("owner"), readDesk("exchange"), readDesk("accountId")]);
  if (getAddress(exchange) !== d.exchange) throw new IntegrationError(`Desk ${desk} trades on another exchange (${exchange}).`);
  if (getAddress(deskOwner) !== getAddress(owner)) throw new IntegrationError(`Desk ${desk} belongs to ${deskOwner}, not this DAO's Treasury.`);
  return { desk, accountId, d };
}

/** Checks a trader's consent signature before it goes into a proposal (a bad one would only fail at execution). */
async function checkConsent(ctx, { desk, operator, deadline, signature }) {
  const { timestamp } = await ctx.publicClient.getBlock();
  if (BigInt(deadline) <= timestamp) throw new IntegrationError("The trader's signature has expired - they need to apply again.");
  const typed = await deskConsentRequest(ctx, { desk, operator, deadline });
  const signer = await recoverTypedDataAddress({ ...typed, signature }).catch(() => null);
  if (!signer || getAddress(signer) !== getAddress(operator)) throw new IntegrationError("The trader's signature doesn't match - it must be their AssignOperator consent for this Treasury.");
}

const addressArg = (word, what) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(word ?? ""))) throw new IntegrationError(`${what} must be an 0x address.`);
  return getAddress(word);
};

function deskActions() {
  return [
    {
      id: "perpl-desk-create",
      label: "Create the Treasury's Perpl trading desk with a trader (operator) who can trade but never withdraw",
      usage: ["trader", "deadline", "signature"],
      options: [],
      help: "Used by /desk apply: the trader's wallet signs Perpl's AssignOperator consent. The desk is a Perpl DelegatedAccount owned by the Treasury; fund it with perpl-desk-fund once it exists.",
      async build(ctx) {
        const d = deployment(ctx);
        const operator = addressArg(ctx.args[0], "Trader");
        await checkConsent(ctx, { operator, deadline: ctx.args[1], signature: ctx.args[2] });
        return {
          calls: [call(d.deskFactory, encodeFunctionData({ abi: DESK_FACTORY_ABI, functionName: "create", args: [operator, BigInt(ctx.args[1]), ctx.args[2]] }), { note: "create desk" })],
          summary: `Create a Perpl trading desk owned by the Treasury, with ${operator} as its trader. The trader can open and close positions with the desk's collateral but can never withdraw it: only the Treasury can, by proposal.`,
        };
      },
    },
    {
      id: "perpl-desk-appoint",
      label: "Appoint a trader (operator) on the Treasury's Perpl desk, optionally replacing one",
      usage: ["desk", "trader", "deadline", "signature"],
      options: [{ name: "replace", description: "the current trader to remove", default: "" }],
      async build(ctx) {
        const { desk } = await verifyDesk(ctx, ctx.args[0]);
        const operator = addressArg(ctx.args[1], "Trader");
        await checkConsent(ctx, { desk, operator, deadline: ctx.args[2], signature: ctx.args[3] });
        const calls = [];
        const old = ctx.options.replace ? addressArg(ctx.options.replace, "replace") : null;
        if (old && old !== operator) calls.push(call(desk, encodeFunctionData({ abi: DESK_ABI, functionName: "removeOperator", args: [old] }), { note: "remove trader" }));
        calls.push(call(desk, encodeFunctionData({ abi: DESK_ABI, functionName: "addOperator", args: [operator, BigInt(ctx.args[2]), ctx.args[3]] }), { note: "add trader" }));
        return { calls, summary: `Make ${operator} the trader of the Treasury's Perpl desk ${desk}${old && old !== operator ? `, replacing ${old}` : ""}. Traders can trade but never withdraw.` };
      },
    },
    {
      id: "perpl-desk-fund",
      label: "Move collateral from the Treasury into its Perpl desk (opens the desk's exchange account the first time)",
      usage: ["desk", "amount"],
      options: [],
      async build(ctx) {
        const { desk, accountId, d } = await verifyDesk(ctx, ctx.args[0]);
        const state = await exchangeState(ctx, d, desk);
        const amount = scaled(ctx.args[1], state.decimals, "Amount");
        const opening = accountId === 0n;
        if (opening) {
          const min = await read(ctx, d, "getMinAccountOpenCNS");
          if (amount < min) throw new IntegrationError(`Opening the desk's Perpl account needs at least ${formatUnits(min, state.decimals)} ${state.symbol}.`);
        }
        const note = state.whitelisted ? "" : " ⚠️ Perpl currently only accepts whitelisted accounts and the desk isn't one - this will revert unless it's whitelisted first.";
        return {
          calls: [
            call(d.collateral, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [desk, amount] }), { note: "send to desk" }),
            // The desk approved the exchange when it was created; depositCollateral goes through its fallback.
            call(desk, opening ? encodeFunctionData({ abi: DESK_ABI, functionName: "createAccount", args: [amount] }) : encodeFunctionData({ abi: ABI, functionName: "depositCollateral", args: [amount] }), { note: opening ? "open account" : "deposit" }),
          ],
          summary: `Move ${formatUnits(amount, state.decimals)} ${state.symbol} from the Treasury into its Perpl desk ${desk} as trading collateral${opening ? " (opening its exchange account)" : ""}. This is the most the trader can lose.${note}`,
        };
      },
    },
    {
      id: "perpl-desk-withdraw",
      label: "Withdraw collateral from the Perpl desk back to the Treasury",
      usage: ["desk", "amount"],
      options: [],
      async build(ctx) {
        const { desk, accountId, d } = await verifyDesk(ctx, ctx.args[0]);
        if (accountId === 0n) throw new IntegrationError("The desk has no Perpl account yet.");
        const state = await exchangeState(ctx, d, desk);
        const amount = scaled(ctx.args[1], state.decimals, "Amount");
        if (amount > state.balance) throw new IntegrationError(`The desk has ${formatUnits(state.balance, state.decimals)} ${state.symbol} free.`);
        return {
          calls: [call(desk, encodeFunctionData({ abi: DESK_ABI, functionName: "withdrawCollateral", args: [amount] }), { note: "withdraw" })],
          summary: `Withdraw ${formatUnits(amount, state.decimals)} ${state.symbol} from the Perpl desk ${desk} to the Treasury.`,
        };
      },
    },
    {
      id: "perpl-desk-remove",
      label: "Remove a trader from the Perpl desk",
      usage: ["desk", "trader"],
      options: [],
      async build(ctx) {
        const { desk } = await verifyDesk(ctx, ctx.args[0]);
        const operator = addressArg(ctx.args[1], "Trader");
        return {
          calls: [call(desk, encodeFunctionData({ abi: DESK_ABI, functionName: "removeOperator", args: [operator] }), { note: "remove trader" })],
          summary: `Remove ${operator} as trader of the Perpl desk ${desk}. Open positions stay open; the Treasury can appoint another trader or withdraw.`,
        };
      },
    },
  ];
}

/** For src/desk.js: Perpl's pieces a desk trade is built from. */
export const deskVenue = {
  deployment,
  exchangeState,
  market,
  orderDesc,
  scaled,
  openPositions,
  read,
  ORDER,
  ABI,
  DESK_FACTORY_ABI,
  LEVERAGE_DECIMALS,
};

/*//////////////////////////////////////////////////////////////
                    /perps (src/perps.js)
//////////////////////////////////////////////////////////////*/

const num = (value, decimals) => Number(formatUnits(value, decimals));

/** The Treasury's open positions: one getPosition per listed market, details only for the open ones. */
async function openPositions(ctx, d, accountId) {
  const entries = Object.entries(d.markets);
  const found = await Promise.all(entries.map(([, id]) => read(ctx, d, "getPosition", [BigInt(id), accountId])));
  const open = entries.map(([symbol, id], i) => ({ symbol, id, position: found[i][0], mark: found[i][1] })).filter((p) => p.position.lotLNS > 0n);
  return Promise.all(
    open.map(async (p) => {
      const info = await read(ctx, d, "getPerpetualInfo", [BigInt(p.id)]);
      const pd = Number(info.priceDecimals), ld = Number(info.lotDecimals);
      const long = Number(p.position.positionType) === 0;
      const size = num(p.position.lotLNS, ld), entry = num(p.position.pricePNS, pd), mark = num(p.mark || info.markPNS, pd);
      return { symbol: p.symbol, side: long ? "long" : "short", size, entry, mark, pnl: (mark - entry) * size * (long ? 1 : -1), margin: p.position.depositCNS };
    })
  );
}

export const perps = {
  venue: "Perpl",

  async overview(ctx) {
    const d = deployment(ctx);
    const state = await exchangeState(ctx, d);
    if (state.accountId === 0n) return { empty: "The Treasury has no Perpl account yet - `deposit <amount>` opens one.", note: whitelistNote(state).trim() };
    const positions = await openPositions(ctx, d, state.accountId);
    return {
      collateral: `${formatUnits(state.balance, state.decimals)} ${state.symbol}${state.locked ? ` (${formatUnits(state.locked, state.decimals)} locked)` : ""}`,
      positions: positions.map((p) => ({ ...p, margin: `${formatUnits(p.margin, state.decimals)} ${state.symbol}` })),
      note: whitelistNote(state).trim(),
    };
  },

  async markets(ctx) {
    const d = deployment(ctx);
    const rows = await Promise.all(
      Object.entries(d.markets).map(async ([symbol, id]) => {
        const info = await read(ctx, d, "getPerpetualInfo", [BigInt(id)]);
        const pd = Number(info.priceDecimals), ld = Number(info.lotDecimals);
        return { symbol, mark: num(info.markPNS, pd), openInterest: num(info.longOpenInterestLNS, ld) + num(info.shortOpenInterestLNS, ld) };
      })
    );
    return { rows };
  },

  /** /perps words -> perpl-* action words. */
  async translate(ctx, t) {
    if (t.kind === "deposit") return ["perpl-deposit", t.amount];
    if (t.kind === "withdraw") return ["perpl-withdraw", t.amount];
    if (t.kind === "open") return ["perpl-open", t.market, t.side, t.size, t.price, `leverage=${t.leverage ?? "1"}`];
    // close: Perpl wants the side of the position being closed.
    const d = deployment(ctx);
    const state = await exchangeState(ctx, d);
    if (state.accountId === 0n) throw new IntegrationError("The Treasury has no Perpl account.");
    const id = d.markets[t.market.toUpperCase()];
    if (id === undefined) throw new IntegrationError(`Unknown Perpl market "${t.market}". Markets: ${Object.keys(d.markets).join(", ")}.`);
    const [position] = await read(ctx, d, "getPosition", [BigInt(id), state.accountId]);
    if (position.lotLNS === 0n) throw new IntegrationError(`The Treasury has no ${t.market.toUpperCase()} position on Perpl.`);
    return ["perpl-close", t.market, Number(position.positionType) === 0 ? "long" : "short", t.size, t.price];
  },
};
