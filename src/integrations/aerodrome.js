import { encodeFunctionData, erc20Abi, getAddress, zeroAddress } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import {
  NATIVE, IntegrationError, checksummed, call, approveCall, resolveToken, parseAmount, formatAmount,
  parsePercentBps, minusBps, deadlineFrom, requireCode,
} from "./common.js";

/**
 * Aerodrome (Base) - swaps and liquidity on its classic stable/volatile
 * pools, called by the Treasury on Aerodrome's Router (plain ERC20
 * approvals, no callbacks - no wrapper needed). LP tokens are ordinary
 * ERC20s held by the Treasury. Slipstream (concentrated-liquidity) pools
 * are a separate contract set and aren't covered.
 *
 * Native ETH: the Router's ETH variants (swapExactETHForTokens,
 * addLiquidityETH, ...) wrap/unwrap through WETH and refund unused ETH to
 * the Treasury. Interface compiled from Aerodrome's own IRouter.sol.
 */

const ABI = loadIntegrationAbi("aerodrome").router;

export const protocol = {
  id: "aerodrome",
  name: "Aerodrome",
  category: "DEX",
  deployments: {
    base: {
      router: "0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43",
      poolFactory: "0x420dd381b31aef6683db6b902084cb0ffece40da",
      weth: "0x4200000000000000000000000000000000000006",
      tokens: {
        AERO: "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
        WETH: "0x4200000000000000000000000000000000000006",
        USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        WSTETH: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",
      },
      sources: [
        "aerodrome-finance/contracts README (Base deployment table: Router, PoolFactory, AERO)",
        "WETH/USDC/wstETH: @bgd-labs/aave-address-book@4.44.22 AaveV3Base (wstETH also in lidofinance/docs deployed-contracts, Base part)",
      ],
    },
  },
};

export const verifyLinks = [
  ["router", "defaultFactory", "poolFactory"],
  ["router", "weth", "weth"],
];

export function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Aerodrome isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

const read = (ctx, d, functionName, args) => ctx.publicClient.readContract({ address: d.router, abi: ABI, functionName, args });
/** The Router works in WETH; native is only a flag for which entry point to use. */
const onRouter = (d, token) => (token === NATIVE ? d.weth : token);

function poolKind(text, fallback) {
  const v = String(text ?? fallback).toLowerCase();
  if (v === "stable") return [true];
  if (v === "volatile") return [false];
  if (v === "auto") return [false, true];
  throw new IntegrationError(`pool=${text} - use stable, volatile${fallback === "auto" ? " or auto" : ""}.`);
}

async function poolAddress(ctx, d, a, b, stable) {
  const pool = await read(ctx, d, "poolFor", [onRouter(d, a), onRouter(d, b), stable, zeroAddress]);
  const code = await ctx.publicClient.getCode({ address: pool });
  return code && code !== "0x" ? getAddress(pool) : null;
}

/**
 * The better of Aerodrome's stable and volatile pools for a one-hop swap
 * (or just the one `poolText` names), quoted now. Shared with lido.js.
 */
export async function bestSwap(ctx, d, tokenIn, tokenOut, amountIn, poolText) {
  let best = null;
  for (const stable of poolKind(poolText, "auto")) {
    if (!(await poolAddress(ctx, d, tokenIn, tokenOut, stable))) continue;
    const route = { from: onRouter(d, tokenIn), to: onRouter(d, tokenOut), stable, factory: d.poolFactory };
    const amounts = await read(ctx, d, "getAmountsOut", [amountIn, [route]]).catch(() => null);
    const out = amounts?.[amounts.length - 1] ?? 0n;
    if (out > 0n && (!best || out > best.out)) best = { route, out };
  }
  if (!best) throw new IntegrationError(`No Aerodrome ${poolText ?? ""} pool with liquidity for this pair.`.replace("  ", " "));
  return best;
}

/** The Treasury calls for a one-hop swap on `route`; native in or out uses the Router's ETH entry points. */
export function swapCalls(ctx, d, tokenIn, tokenOut, amountIn, minOut, route, deadline) {
  const routes = [route];
  if (tokenIn === NATIVE) {
    return [call(d.router, encodeFunctionData({ abi: ABI, functionName: "swapExactETHForTokens", args: [minOut, routes, ctx.treasury, deadline] }), { value: amountIn, note: "swap" })];
  }
  const fn = tokenOut === NATIVE ? "swapExactTokensForETH" : "swapExactTokensForTokens";
  return [approveCall(tokenIn, d.router, amountIn, "approve Router"), call(d.router, encodeFunctionData({ abi: ABI, functionName: fn, args: [amountIn, minOut, routes, ctx.treasury, deadline] }), { note: "swap" })];
}

export const actions = [
  {
    id: "aerodrome-swap",
    label: "Swap tokens on Aerodrome (one pool)",
    usage: ["tokenIn", "tokenOut", "amountIn", "minOut|slippage%"],
    options: [
      { name: "pool", description: "stable, volatile, or auto (whichever quotes better now)", default: "auto" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const tokenIn = resolveToken(ctx.args[0], ctx, d.tokens);
      const tokenOut = resolveToken(ctx.args[1], ctx, d.tokens);
      if (onRouter(d, tokenIn) === onRouter(d, tokenOut)) throw new IntegrationError("Both sides are the same token.");
      const amountIn = await parseAmount(ctx, tokenIn, ctx.args[2]);
      await requireCode(ctx, { Router: d.router });

      const best = await bestSwap(ctx, d, tokenIn, tokenOut, amountIn, ctx.options.pool);

      const minText = String(ctx.args[3]);
      const minOut = minText.endsWith("%") ? minusBps(best.out, parsePercentBps(minText)) : await parseAmount(ctx, tokenOut, minText);
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: swapCalls(ctx, d, tokenIn, tokenOut, amountIn, minOut, best.route, deadline),
        summary:
          `Swap ${await formatAmount(ctx, tokenIn, amountIn)} for at least ${await formatAmount(ctx, tokenOut, minOut)} on Aerodrome's ` +
          `${best.route.stable ? "stable" : "volatile"} pool (quoted ${await formatAmount(ctx, tokenOut, best.out, { approx: true })} now).`,
      };
    },
  },
  {
    id: "aerodrome-add-liquidity",
    label: "Add liquidity to an Aerodrome pool (LP tokens to the Treasury)",
    usage: ["tokenA", "tokenB", "amountA", "amountB"],
    options: [
      { name: "pool", description: "stable or volatile", default: "volatile" },
      { name: "slippage", description: "how far below today's quote each side may go", default: "1%" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const [stable] = poolKind(ctx.options.pool, "volatile");
      let tokenA = resolveToken(ctx.args[0], ctx, d.tokens);
      let tokenB = resolveToken(ctx.args[1], ctx, d.tokens);
      let amountA = await parseAmount(ctx, tokenA, ctx.args[2]);
      let amountB = await parseAmount(ctx, tokenB, ctx.args[3]);
      if (tokenA === NATIVE && tokenB === NATIVE) throw new IntegrationError("Both sides are native.");
      if (tokenA === NATIVE) [tokenA, tokenB, amountA, amountB] = [tokenB, tokenA, amountB, amountA]; // native always second
      await requireCode(ctx, { Router: d.router });

      const [quoteA, quoteB] = await read(ctx, d, "quoteAddLiquidity", [tokenA, onRouter(d, tokenB), stable, d.poolFactory, amountA, amountB]);
      const bps = parsePercentBps(ctx.options.slippage, 100);
      const [minA, minB] = [minusBps(quoteA, bps), minusBps(quoteB, bps)];
      const deadline = await deadlineFrom(ctx, ctx.options);
      const exists = await poolAddress(ctx, d, tokenA, tokenB, stable);
      let calls;
      if (tokenB === NATIVE) {
        calls = [
          approveCall(tokenA, d.router, amountA, "approve Router"),
          call(d.router, encodeFunctionData({ abi: ABI, functionName: "addLiquidityETH", args: [tokenA, stable, amountA, minA, minB, ctx.treasury, deadline] }), { value: amountB, note: "add liquidity" }),
        ];
      } else {
        calls = [
          approveCall(tokenA, d.router, amountA, "approve Router"),
          approveCall(tokenB, d.router, amountB, "approve Router"),
          call(d.router, encodeFunctionData({ abi: ABI, functionName: "addLiquidity", args: [tokenA, tokenB, stable, amountA, amountB, minA, minB, ctx.treasury, deadline] }), { note: "add liquidity" }),
        ];
      }
      return {
        calls,
        summary:
          `Add about ${await formatAmount(ctx, tokenA, quoteA, { approx: true })} and ${await formatAmount(ctx, tokenB, quoteB, { approx: true })} ` +
          `to Aerodrome's ${stable ? "stable" : "volatile"} pool${exists ? "" : " (creating it)"}; LP tokens go to the Treasury.`,
      };
    },
  },
  {
    id: "aerodrome-remove-liquidity",
    label: "Remove liquidity from an Aerodrome pool",
    usage: ["tokenA", "tokenB", "lpAmount|all"],
    options: [
      { name: "pool", description: "stable or volatile", default: "volatile" },
      { name: "slippage", description: "how far below today's value each side may go", default: "1%" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const [stable] = poolKind(ctx.options.pool, "volatile");
      let tokenA = resolveToken(ctx.args[0], ctx, d.tokens);
      let tokenB = resolveToken(ctx.args[1], ctx, d.tokens);
      if (tokenA === NATIVE) [tokenA, tokenB] = [tokenB, tokenA];
      await requireCode(ctx, { Router: d.router });
      const pool = await poolAddress(ctx, d, tokenA, tokenB, stable);
      if (!pool) throw new IntegrationError(`There's no Aerodrome ${stable ? "stable" : "volatile"} pool for this pair.`);
      const held = await ctx.publicClient.readContract({ address: pool, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
      const liquidity = String(ctx.args[2]).toLowerCase() === "all" ? held : await parseAmount(ctx, pool, ctx.args[2]);
      if (liquidity === 0n) throw new IntegrationError("The Treasury holds no LP tokens for this pool.");
      if (liquidity > held) throw new IntegrationError(`The Treasury holds only ${await formatAmount(ctx, pool, held)} LP.`);

      const [outA, outB] = await read(ctx, d, "quoteRemoveLiquidity", [tokenA, onRouter(d, tokenB), stable, d.poolFactory, liquidity]);
      const bps = parsePercentBps(ctx.options.slippage, 100);
      const [minA, minB] = [minusBps(outA, bps), minusBps(outB, bps)];
      const deadline = await deadlineFrom(ctx, ctx.options);
      const fn = tokenB === NATIVE ? "removeLiquidityETH" : "removeLiquidity";
      const args = tokenB === NATIVE ? [tokenA, stable, liquidity, minA, minB, ctx.treasury, deadline] : [tokenA, tokenB, stable, liquidity, minA, minB, ctx.treasury, deadline];
      return {
        calls: [approveCall(pool, d.router, liquidity, "approve LP"), call(d.router, encodeFunctionData({ abi: ABI, functionName: fn, args }), { note: "remove liquidity" })],
        summary: `Remove ${await formatAmount(ctx, pool, liquidity)} LP from Aerodrome for at least ${await formatAmount(ctx, tokenA, minA)} and ${await formatAmount(ctx, tokenB, minB)}, to the Treasury.`,
      };
    },
  },
];
