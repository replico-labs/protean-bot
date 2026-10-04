import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, getAddress, maxUint128, maxUint160 } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import {
  NATIVE, IntegrationError, checksummed, call, approveCall, resolveToken, parseAmount, formatAmount, tokenDecimals,
  parsePercentBps, minusBps, deadlineFrom, requireCode,
} from "./common.js";
import {
  getSqrtPriceAtTick, fullRangeTicks, getLiquidityForAmounts, getAmountsForLiquidity, sqrtPriceX96FromRatio,
  MIN_SQRT_PRICE, MAX_SQRT_PRICE,
} from "./uniswapMath.js";

/**
 * Uniswap v4 - swaps and liquidity positions, called by the Treasury.
 *
 * The Treasury can't talk to the PoolManager directly (it requires an
 * unlockCallback the Treasury doesn't implement), so every action goes
 * through Uniswap's own periphery, which implements that callback:
 *   swaps     -> UniversalRouter.execute(V4_SWAP)
 *   liquidity -> PositionManager.modifyLiquidities
 * Both pull ERC20s through Permit2, so an ERC20 leg is: token.approve
 * (Permit2), Permit2.approve(router, amount, expiry), then the call.
 * Position NFTs are minted with a plain _mint (no receiver hook), so the
 * Treasury holds them directly; removing liquidity checks it owns one.
 *
 * Action and command codes are from the official sources:
 * universal-router contracts/libraries/Commands.sol (V4_SWAP = 0x10) and
 * v4-periphery src/libraries/Actions.sol; parameter layouts from
 * V4Router._handleAction / PositionManager._handleAction.
 */

export const protocol = {
  id: "uniswap-v4",
  name: "Uniswap v4",
  category: "DEX",
  deployments: {
    "monad-mainnet": {
      poolManager: "0x188d586ddcf52439676ca21a244753fa19f9ea8e",
      positionManager: "0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016",
      stateView: "0x77395f3b2e73ae90843717371294fa97cc419d64",
      v4Quoter: "0xa222dd357a9076d1091ed6aa2e16c9742dd26891",
      universalRouter: "0x0d97dc33264bfc1c226207428a79b26757fb9dc3",
      permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      sources: [
        "@uniswap/sdk-core@7.19.4 CHAIN_TO_ADDRESSES_MAP[143]",
        "@uniswap/universal-router-sdk@5.14.0 CHAIN_CONFIGS[143] (UniversalRouter v2.0)",
        "monad-crypto/protocols mainnet registry (Uniswap, Canonical Contracts/Permit2)",
      ],
    },
    "monad-testnet": {
      poolManager: "0x451d64ab3b650040d2ae1886602b97ed6edc643d",
      positionManager: "0x3bb14e3d0cd50abe3edaca06d06c29c78676c31a",
      stateView: "0xb639209539c61baf67ac04876315786f8d0b153c",
      v4Quoter: "0x869834d127b230283fe63e0d0a9beb67216a94c7",
      universalRouter: "0x1b7bfcd2870329b987191910d85c22c7287f3c22",
      permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      // Monad maintains the testnet deployment; Uniswap's own SDK covers Monad mainnet.
      sources: ["monad-crypto/protocols testnet registry (\"Uniswap v4\", Monad-maintained)"],
    },
    base: {
      poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
      positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc",
      stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
      v4Quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
      universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
      permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      sources: [
        "@uniswap/sdk-core@7.19.4 CHAIN_TO_ADDRESSES_MAP[8453]",
        "@uniswap/universal-router-sdk@5.14.0 CHAIN_CONFIGS[8453] (UniversalRouter v2.0)",
        "Permit2: canonical address, Uniswap permit2 repo (same on every chain)",
      ],
    },
    "base-sepolia": {
      poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408",
      positionManager: "0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80",
      stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
      v4Quoter: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",
      universalRouter: "0x492e6456d9528771018deb9e87ef7750ef184104",
      permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
      sources: [
        "@uniswap/sdk-core@7.19.4 CHAIN_TO_ADDRESSES_MAP[84532]",
        "@uniswap/universal-router-sdk@5.14.0 CHAIN_CONFIGS[84532] (UniversalRouter v2.0)",
        "Permit2: canonical address, Uniswap permit2 repo (same on every chain)",
      ],
    },
  },
};

const ABIS = loadIntegrationAbi("uniswapV4");
/**
 * On-chain cross-checks for scripts/verify-integrations.js: each contract
 * must point back at the others it's deployed with (getters taken from
 * the official ABIs). A wrong or look-alike address fails these even
 * if it has code.
 */
export const verifyLinks = [
  ["positionManager", "poolManager", "poolManager"],
  ["positionManager", "permit2", "permit2"],
  ["stateView", "poolManager", "poolManager"],
  ["v4Quoter", "poolManager", "poolManager"],
  ["universalRouter", "poolManager", "poolManager"],
  ["universalRouter", "V4_POSITION_MANAGER", "positionManager"],
];

const V4_SWAP = "0x10";
const ACTION = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  SETTLE_PAIR: 0x0d,
  TAKE_ALL: 0x0f,
  TAKE_PAIR: 0x11,
  SWEEP: 0x14,
};

/** Conventional fee -> tick spacing pairs; any other pool takes tickSpacing= explicitly. */
const DEFAULT_TICK_SPACING = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

const POOL_KEY = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
};

const POOL_OPTIONS = [
  { name: "fee", description: "pool fee in hundredths of a bip (3000 = 0.30%)", default: "3000" },
  { name: "tickSpacing", description: "pool tick spacing (defaults from the fee)" },
  { name: "hooks", description: "pool hook contract", default: "none" },
  { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
];

// A swap picks its pool: by default every standard fee tier is tried
// and the one quoting the most out wins.
const SWAP_OPTIONS = [
  { name: "fee", description: "pool fee tier (100, 500, 3000, 10000) or auto - every standard tier, best quote now", default: "auto" },
  ...POOL_OPTIONS.slice(1),
];

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Uniswap v4 isn't set up for ${ctx.network.chain.name}.`);
  return checksummed(d);
}

function lower(a) {
  return a.toLowerCase();
}

export function poolKeyFor(tokenA, tokenB, options = {}) {
  const fee = Number(options.fee ?? 3000);
  if (!Number.isInteger(fee) || fee < 0 || fee > 1_000_000) throw new IntegrationError(`fee=${options.fee} isn't a valid pool fee.`);
  const tickSpacing = Number(options.tickSpacing ?? DEFAULT_TICK_SPACING[fee]);
  if (!Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 32767) {
    throw new IntegrationError(`No default tick spacing for fee ${fee} - add tickSpacing=<n>.`);
  }
  const hooks = !options.hooks || options.hooks === "none" ? NATIVE : getAddress(options.hooks);
  if (lower(tokenA) === lower(tokenB)) throw new IntegrationError("Both tokens are the same.");
  const [currency0, currency1] = BigInt(tokenA) < BigInt(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

export function poolIdOf(key) {
  return keccak256(encodeAbiParameters(POOL_KEY.components, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

async function readSqrtPrice(ctx, d, key) {
  const [sqrtPriceX96] = await ctx.publicClient.readContract({ address: d.stateView, abi: ABIS.stateView, functionName: "getSlot0", args: [poolIdOf(key)] });
  return sqrtPriceX96;
}

function describePool(key) {
  return `fee ${key.fee / 10_000}%, tick spacing ${key.tickSpacing}${key.hooks === NATIVE ? "" : `, hooks ${key.hooks}`}`;
}

function encodeActions(codes, params) {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [encodePacked(codes.map(() => "uint8"), codes), params]
  );
}

const currencyAndAmount = (currency, amount) => encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [currency, amount]);
const currencyPair = (c0, c1) => encodeAbiParameters([{ type: "address" }, { type: "address" }], [c0, c1]);

/** Token -> Permit2 -> spender approvals for one ERC20 leg (none for native). */
function permit2Approvals(d, token, spender, amount, deadline) {
  if (token === NATIVE) return [];
  if (amount > maxUint160) throw new IntegrationError("Amount too large for Permit2.");
  return [
    approveCall(token, d.permit2, amount, "approve Permit2"),
    call(d.permit2, encodeFunctionData({ abi: ABIS.permit2, functionName: "approve", args: [token, spender, amount, Number(deadline)] }), {
      note: "Permit2 allowance",
    }),
  ];
}

/** Decodes PositionInfo's packed ticks (v4-periphery PositionInfoLibrary: lower at bit 8, upper at bit 32, 24 bits each, signed). */
export function positionTicks(info) {
  const signed24 = (v) => Number(BigInt.asIntN(24, v & 0xffffffn));
  const n = BigInt(info);
  return [signed24(n >> 8n), signed24(n >> 32n)];
}

async function quoteExactIn(ctx, d, key, zeroForOne, amountIn) {
  try {
    const { result } = await ctx.publicClient.simulateContract({
      address: d.v4Quoter,
      abi: ABIS.v4Quoter,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
    });
    return result[0];
  } catch (err) {
    throw new IntegrationError(`Couldn't get a quote from Uniswap (${err.shortMessage || err.message}) - give an explicit minimum instead of a %.`);
  }
}

/**
 * The pool a swap goes through. With fee=auto (the default) every
 * standard tier is checked and the one quoting the most out is used, so
 * nobody has to guess which tier a pair's liquidity sits in.
 */
async function pickSwapPool(ctx, d, tokenIn, tokenOut, amountIn, needQuote) {
  const feeText = ctx.options.fee;
  if (feeText !== undefined && String(feeText).toLowerCase() !== "auto") {
    const key = poolKeyFor(tokenIn, tokenOut, ctx.options);
    if ((await readSqrtPrice(ctx, d, key)) === 0n) {
      throw new IntegrationError(`No Uniswap v4 pool for this pair with ${describePool(key)} - leave out fee= to try every standard tier, or check tickSpacing=/hooks=.`);
    }
    return { key, quote: undefined };
  }
  if (ctx.options.tickSpacing !== undefined) throw new IntegrationError("tickSpacing= needs a fee= too.");

  let best = null;
  const found = [];
  for (const fee of Object.keys(DEFAULT_TICK_SPACING)) {
    const key = poolKeyFor(tokenIn, tokenOut, { ...ctx.options, fee, tickSpacing: undefined });
    if ((await readSqrtPrice(ctx, d, key)) === 0n) continue;
    found.push(key);
    const quote = await quoteExactIn(ctx, d, key, lower(tokenIn) === lower(key.currency0), amountIn).catch(() => null);
    if (quote !== null && quote > 0n && (!best || quote > best.quote)) best = { key, quote };
  }
  if (best) return best;
  // An explicit minimum needs no quote: with one pool, use it.
  if (!needQuote && found.length === 1) return { key: found[0], quote: undefined };
  if (found.length) {
    throw new IntegrationError(`Uniswap v4 has this pair at ${found.map(describePool).join("; ")}, but none of them can quote this amount now (no liquidity in range)${needQuote ? "" : " - add fee= to pick one"}.`);
  }
  const hooks = ctx.options.hooks && ctx.options.hooks !== "none" ? ` with hooks ${ctx.options.hooks}` : " without hooks";
  const native = tokenIn === NATIVE || tokenOut === NATIVE;
  const otherSide = native ? "the wrapped token (WMON/WETH/WHYPE) instead of the native coin" : "the native coin (MON/ETH/HYPE, or native) instead of its wrapped token";
  throw new IntegrationError(
    `No Uniswap v4 pool for this pair at any standard fee tier (0.01%, 0.05%, 0.3%, 1%)${hooks}. Try ${otherSide}, a pool's hooks=<address>, or another DEX.`
  );
}

export const actions = [
  {
    id: "uniswap-swap",
    label: "Swap tokens on Uniswap v4 (exact input, one pool)",
    usage: ["tokenIn", "tokenOut", "amountIn", "minOut|slippage%"],
    options: SWAP_OPTIONS,
    async build(ctx) {
      const d = deployment(ctx);
      const [inWord, outWord, amountText, minText] = ctx.args;
      const tokenIn = resolveToken(inWord, ctx);
      const tokenOut = resolveToken(outWord, ctx);
      const amountIn = await parseAmount(ctx, tokenIn, amountText);
      if (amountIn > maxUint128) throw new IntegrationError("Amount too large.");

      await requireCode(ctx, { UniversalRouter: d.universalRouter, StateView: d.stateView, Permit2: d.permit2 });
      const { key, quote: autoQuote } = await pickSwapPool(ctx, d, tokenIn, tokenOut, amountIn, String(minText).endsWith("%"));
      const zeroForOne = lower(tokenIn) === lower(key.currency0);

      let minOut;
      let quoteNote = "";
      if (String(minText).endsWith("%")) {
        const quote = autoQuote ?? (await quoteExactIn(ctx, d, key, zeroForOne, amountIn));
        minOut = minusBps(quote, parsePercentBps(minText));
        quoteNote = ` (quoted ${await formatAmount(ctx, tokenOut, quote, { approx: true })} now, less ${minText})`;
      } else {
        minOut = await parseAmount(ctx, tokenOut, minText);
      }
      if (minOut > maxUint128) throw new IntegrationError("Minimum too large.");

      const deadline = await deadlineFrom(ctx, ctx.options);
      const swapParams = encodeAbiParameters(
        [{
          type: "tuple",
          components: [{ ...POOL_KEY, name: "poolKey" }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }],
        }],
        [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }]
      );
      const v4Input = encodeActions(
        [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL],
        [swapParams, currencyAndAmount(tokenIn, amountIn), currencyAndAmount(tokenOut, minOut)]
      );
      const routerData = encodeFunctionData({ abi: ABIS.universalRouter, functionName: "execute", args: [V4_SWAP, [v4Input], deadline] });

      return {
        calls: [
          ...permit2Approvals(d, tokenIn, d.universalRouter, amountIn, deadline),
          call(d.universalRouter, routerData, { value: tokenIn === NATIVE ? amountIn : 0n, note: "swap" }),
        ],
        summary: `Swap ${await formatAmount(ctx, tokenIn, amountIn)} for at least ${await formatAmount(ctx, tokenOut, minOut)}${quoteNote} on Uniswap v4 (${describePool(key)}).`,
      };
    },
  },

  {
    id: "uniswap-add-liquidity",
    label: "Add liquidity on Uniswap v4 (new position owned by the Treasury)",
    usage: ["tokenA", "tokenB", "amountA", "amountB"],
    options: [
      ...POOL_OPTIONS,
      { name: "range", description: "full, or tickLower:tickUpper", default: "full" },
      { name: "slippage", description: "extra the price may move before execution", default: "1%" },
      { name: "initPrice", description: "tokenB per tokenA - only to create a pool that doesn't exist yet" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const [aWord, bWord, aText, bText] = ctx.args;
      const tokenA = resolveToken(aWord, ctx);
      const tokenB = resolveToken(bWord, ctx);
      const amountA = await parseAmount(ctx, tokenA, aText);
      const amountB = await parseAmount(ctx, tokenB, bText);
      const key = poolKeyFor(tokenA, tokenB, ctx.options);
      const aIsZero = lower(tokenA) === lower(key.currency0);
      const [amount0, amount1] = aIsZero ? [amountA, amountB] : [amountB, amountA];

      await requireCode(ctx, { PositionManager: d.positionManager, StateView: d.stateView, Permit2: d.permit2 });

      const calls = [];
      let sqrtPrice = await readSqrtPrice(ctx, d, key);
      let createNote = "";
      if (sqrtPrice === 0n) {
        if (!ctx.options.initPrice) {
          throw new IntegrationError(`No pool for this pair with ${describePool(key)}. To create it, add initPrice=<${bWord} per ${aWord}>.`);
        }
        sqrtPrice = await initialSqrtPrice(ctx, key, tokenA, tokenB, ctx.options.initPrice);
        calls.push(call(d.positionManager, encodeFunctionData({ abi: ABIS.positionManager, functionName: "initializePool", args: [key, sqrtPrice] }), { note: "create pool" }));
        createNote = ` Creates the pool at ${ctx.options.initPrice} ${bWord} per ${aWord}.`;
      }

      const [tickLower, tickUpper] = parseRange(ctx.options.range, key.tickSpacing);
      const sqrtLower = getSqrtPriceAtTick(tickLower);
      const sqrtUpper = getSqrtPriceAtTick(tickUpper);
      const liquidity = getLiquidityForAmounts(sqrtPrice, sqrtLower, sqrtUpper, amount0, amount1);
      if (liquidity === 0n) throw new IntegrationError("Those amounts give zero liquidity at the current price - add more of the other token.");

      const slippageBps = parsePercentBps(ctx.options.slippage, 100);
      const [need0, need1] = getAmountsForLiquidity(sqrtPrice, sqrtLower, sqrtUpper, liquidity);
      const max0 = ((need0 + 1n) * BigInt(10_000 + slippageBps)) / 10_000n;
      const max1 = ((need1 + 1n) * BigInt(10_000 + slippageBps)) / 10_000n;
      if (max0 > maxUint128 || max1 > maxUint128) throw new IntegrationError("Amount too large.");

      const deadline = await deadlineFrom(ctx, ctx.options);
      const mintParams = encodeAbiParameters(
        [POOL_KEY, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
        [key, tickLower, tickUpper, liquidity, max0, max1, ctx.treasury, "0x"]
      );
      const codes = [ACTION.MINT_POSITION, ACTION.SETTLE_PAIR];
      const params = [mintParams, currencyPair(key.currency0, key.currency1)];
      const nativeValue = key.currency0 === NATIVE ? max0 : 0n;
      if (nativeValue > 0n) {
        // Native is sent up front; SWEEP returns whatever the mint didn't use.
        codes.push(ACTION.SWEEP);
        params.push(encodeAbiParameters([{ type: "address" }, { type: "address" }], [NATIVE, ctx.treasury]));
      }

      calls.push(
        ...permit2Approvals(d, key.currency0, d.positionManager, max0, deadline),
        ...permit2Approvals(d, key.currency1, d.positionManager, max1, deadline),
        call(
          d.positionManager,
          encodeFunctionData({ abi: ABIS.positionManager, functionName: "modifyLiquidities", args: [encodeActions(codes, params), deadline] }),
          { value: nativeValue, note: "mint position" }
        )
      );

      const rangeText = ctx.options.range && ctx.options.range !== "full" ? `ticks ${tickLower} to ${tickUpper}` : "full range";
      return {
        calls,
        summary:
          `Add liquidity to Uniswap v4 (${describePool(key)}, ${rangeText}): about ${await formatAmount(ctx, key.currency0, need0, { approx: true })} and ` +
          `${await formatAmount(ctx, key.currency1, need1, { approx: true })} at today's price, at most ${slippageBps / 100}% more of either if the price moves before execution. ` +
          `The position NFT goes to the Treasury.${createNote}`,
      };
    },
  },

  {
    id: "uniswap-remove-liquidity",
    label: "Remove liquidity from a Treasury-owned Uniswap v4 position",
    usage: ["positionId", "percent"],
    options: [
      { name: "slippage", description: "how far below today's value the payout may be", default: "1%" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const [idText, pctText] = ctx.args;
      const tokenId = parsePositionId(idText);
      const pctBps = parsePercentBps(pctText);
      if (pctBps === 0) throw new IntegrationError("Percent must be more than 0%.");
      const { key, tickLower, tickUpper, liquidity } = await readTreasuryPosition(ctx, d, tokenId);

      const remove = pctBps === 10_000 ? liquidity : (liquidity * BigInt(pctBps)) / 10_000n;
      const sqrtPrice = await readSqrtPrice(ctx, d, key);
      const [out0, out1] = getAmountsForLiquidity(sqrtPrice, getSqrtPriceAtTick(tickLower), getSqrtPriceAtTick(tickUpper), remove);
      const slippageBps = parsePercentBps(ctx.options.slippage, 100);
      const [min0, min1] = [minusBps(out0, slippageBps), minusBps(out1, slippageBps)];

      const deadline = await deadlineFrom(ctx, ctx.options);
      const first =
        pctBps === 10_000
          ? [ACTION.BURN_POSITION, encodeAbiParameters([{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [tokenId, min0, min1, "0x"])]
          : [ACTION.DECREASE_LIQUIDITY, encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [tokenId, remove, min0, min1, "0x"])];
      const unlockData = encodeActions(
        [first[0], ACTION.TAKE_PAIR],
        [first[1], encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [key.currency0, key.currency1, ctx.treasury])]
      );

      return {
        calls: [call(d.positionManager, encodeFunctionData({ abi: ABIS.positionManager, functionName: "modifyLiquidities", args: [unlockData, deadline] }), { note: "remove liquidity" })],
        summary:
          `Remove ${pctText.replace(/%?$/, "%")} of Uniswap v4 position #${tokenId}${pctBps === 10_000 ? " and burn it" : ""}, plus its fees, ` +
          `for at least ${await formatAmount(ctx, key.currency0, min0)} and ${await formatAmount(ctx, key.currency1, min1)}, paid to the Treasury.`,
      };
    },
  },

  {
    id: "uniswap-collect-fees",
    label: "Collect trading fees from a Treasury-owned Uniswap v4 position",
    usage: ["positionId"],
    options: [{ name: "deadline", description: "how long after proposing it may execute", default: "30d" }],
    async build(ctx) {
      const d = deployment(ctx);
      const tokenId = parsePositionId(ctx.args[0]);
      const { key } = await readTreasuryPosition(ctx, d, tokenId);
      const deadline = await deadlineFrom(ctx, ctx.options);
      // Decreasing by zero liquidity settles the fees owed, which TAKE_PAIR then sends on.
      const unlockData = encodeActions(
        [ACTION.DECREASE_LIQUIDITY, ACTION.TAKE_PAIR],
        [
          encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [tokenId, 0n, 0n, 0n, "0x"]),
          encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [key.currency0, key.currency1, ctx.treasury]),
        ]
      );
      return {
        calls: [call(d.positionManager, encodeFunctionData({ abi: ABIS.positionManager, functionName: "modifyLiquidities", args: [unlockData, deadline] }), { note: "collect fees" })],
        summary: `Collect the trading fees earned by Uniswap v4 position #${tokenId} into the Treasury.`,
      };
    },
  },
];

function parsePositionId(text) {
  if (!/^\d+$/.test(String(text ?? ""))) throw new IntegrationError(`"${text}" isn't a position id.`);
  return BigInt(text);
}

async function readTreasuryPosition(ctx, d, tokenId) {
  await requireCode(ctx, { PositionManager: d.positionManager, StateView: d.stateView });
  let owner;
  try {
    owner = await ctx.publicClient.readContract({ address: d.positionManager, abi: ABIS.positionManager, functionName: "ownerOf", args: [tokenId] });
  } catch {
    throw new IntegrationError(`Uniswap v4 position #${tokenId} doesn't exist.`);
  }
  if (lower(owner) !== lower(ctx.treasury)) throw new IntegrationError(`Position #${tokenId} belongs to ${owner}, not this DAO's Treasury.`);
  const [key, info] = await ctx.publicClient.readContract({ address: d.positionManager, abi: ABIS.positionManager, functionName: "getPoolAndPositionInfo", args: [tokenId] });
  const liquidity = await ctx.publicClient.readContract({ address: d.positionManager, abi: ABIS.positionManager, functionName: "getPositionLiquidity", args: [tokenId] });
  const [tickLower, tickUpper] = positionTicks(info);
  return { key, tickLower, tickUpper, liquidity };
}

function parseRange(text, tickSpacing) {
  if (!text || text === "full") return fullRangeTicks(tickSpacing);
  const m = /^(-?\d+):(-?\d+)$/.exec(text);
  if (!m) throw new IntegrationError(`range=${text} - use full, or tickLower:tickUpper like -600:600.`);
  const [lowerTick, upperTick] = [Number(m[1]), Number(m[2])];
  if (lowerTick >= upperTick) throw new IntegrationError("range: the lower tick must be below the upper tick.");
  if (lowerTick % tickSpacing || upperTick % tickSpacing) throw new IntegrationError(`range: both ticks must be multiples of the tick spacing (${tickSpacing}).`);
  const [minT, maxT] = fullRangeTicks(tickSpacing);
  if (lowerTick < minT || upperTick > maxT) throw new IntegrationError(`range: ticks must be within ${minT}:${maxT}.`);
  return [lowerTick, upperTick];
}

/** "2.5" (tokenB per tokenA, human units) -> sqrtPriceX96 of currency1 per currency0 in base units. */
async function initialSqrtPrice(ctx, key, tokenA, tokenB, priceText) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(priceText));
  if (!m) throw new IntegrationError(`initPrice=${priceText} isn't a number.`);
  const frac = m[2] ?? "";
  const priceNum = BigInt(m[1] + frac);
  const priceDen = 10n ** BigInt(frac.length);
  if (priceNum === 0n) throw new IntegrationError("initPrice must be more than 0.");
  const decA = BigInt(await tokenDecimals(ctx, tokenA));
  const decB = BigInt(await tokenDecimals(ctx, tokenB));
  // raw tokenB per raw tokenA = price * 10^decB / 10^decA
  let num = priceNum * 10n ** decB;
  let den = priceDen * 10n ** decA;
  if (lower(tokenA) !== lower(key.currency0)) [num, den] = [den, num];
  const sqrtPrice = sqrtPriceX96FromRatio(num, den);
  if (sqrtPrice <= MIN_SQRT_PRICE || sqrtPrice >= MAX_SQRT_PRICE) throw new IntegrationError("initPrice is outside what Uniswap supports.");
  return sqrtPrice;
}
