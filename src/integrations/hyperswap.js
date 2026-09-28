import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import {
  NATIVE, IntegrationError, checksummed, call, approveCall, resolveToken, parseAmount, formatAmount,
  parsePercentBps, minusBps, deadlineFrom, requireCode,
} from "./common.js";

/**
 * HyperSwap (HyperEVM) - one-pool swaps on HyperSwap v3, called by the
 * Treasury on its SwapRouter (plain ERC20 approvals, no callbacks - no
 * wrapper needed).
 *
 * HyperSwap v3 is a Uniswap v3 fork: its own SDK (@hyperswap-labs/v3-sdk)
 * encodes swaps with Uniswap's original SwapRouter ABI, which is what's
 * used here. HyperSwap v2 isn't covered - its router adds a `referral`
 * argument whose ABI HyperSwap doesn't publish.
 *
 * Native HYPE: the router wraps HYPE sent with a WHYPE-in swap, and for
 * HYPE out the swap pays WHYPE to the router, then unwrapWETH9 sends HYPE
 * to the Treasury - both in the same proposal step.
 */

const ABI = loadIntegrationAbi("hyperswap");
const FEE_TIERS = [100, 500, 3000, 10000];

export const protocol = {
  id: "hyperswap",
  name: "HyperSwap",
  category: "DEX",
  deployments: {
    hyperevm: {
      router: "0x4e2960a8cd19b467b82d26d83facb0fae26b094d",
      quoter: "0x03a918028f22d9e1473b7959c927ad7425a45c7c",
      factory: "0xb1c0fa0b789320044a6f623cfe5ebda9562602e3",
      whype: "0x5555555555555555555555555555555555555555",
      tokens: { WHYPE: "0x5555555555555555555555555555555555555555" },
      sources: [
        "@hyperswap-labs/addresses@1.0.17 V3_ADDRESSES[999] (SWAP_ROUTER, QUOTERV2, FACTORY) and WETH9_ADDRESSES[999]",
        "router/factory also match @hypurrquant/defi-cli@1.0.13 config/protocols/dex/hyperswap.toml",
      ],
    },
  },
};

export const verifyLinks = [
  ["router", "factory", "factory"],
  ["router", "WETH9", "whype"],
  ["quoter", "factory", "factory"],
  ["quoter", "WETH9", "whype"],
];

export function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`HyperSwap isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

/** The router works in WHYPE; native is only a flag for how the swap is wrapped. */
const onRouter = (d, token) => (token === NATIVE ? d.whype : token);

async function quote(ctx, d, tokenIn, tokenOut, fee, amountIn) {
  try {
    const { result } = await ctx.publicClient.simulateContract({
      address: d.quoter,
      abi: ABI.quoter,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    return result[0];
  } catch {
    return 0n;
  }
}

/**
 * The best-quoting HyperSwap v3 pool for a one-hop swap, across the fee
 * tiers the factory has enabled (or just `feeText`). Shared with kinetiq.js.
 */
export async function bestSwap(ctx, d, tokenIn, tokenOut, amountIn, feeText) {
  const a = onRouter(d, tokenIn), b = onRouter(d, tokenOut);
  if (a === b) throw new IntegrationError("Both sides are the same token.");
  await requireCode(ctx, { "HyperSwap router": d.router, "HyperSwap quoter": d.quoter });
  let fees = FEE_TIERS;
  if (feeText !== undefined && String(feeText).toLowerCase() !== "auto") {
    if (!/^\d+$/.test(String(feeText))) throw new IntegrationError(`fee=${feeText} - use auto or a fee tier in hundredths of a bip (e.g. 3000 = 0.3%).`);
    fees = [Number(feeText)];
  }
  let best = null;
  for (const fee of fees) {
    const pool = await ctx.publicClient.readContract({ address: d.factory, abi: ABI.factory, functionName: "getPool", args: [a, b, fee] });
    if (getAddress(pool) === zeroAddress) continue;
    const out = await quote(ctx, d, a, b, fee, amountIn);
    if (out > 0n && (!best || out > best.out)) best = { fee, out, pool: getAddress(pool) };
  }
  if (!best) throw new IntegrationError("No HyperSwap v3 pool with liquidity for this pair" + (fees.length === 1 ? ` at fee ${fees[0]}.` : "."));
  return best;
}

/** The Treasury calls for a one-hop exact-input swap through the pool `best` picked. */
export function swapCalls(ctx, d, tokenIn, tokenOut, amountIn, minOut, best, deadline) {
  const params = (recipient) => ({
    tokenIn: onRouter(d, tokenIn),
    tokenOut: onRouter(d, tokenOut),
    fee: best.fee,
    recipient,
    deadline,
    amountIn,
    amountOutMinimum: minOut,
    sqrtPriceLimitX96: 0n,
  });
  if (tokenIn === NATIVE) {
    return [call(d.router, encodeFunctionData({ abi: ABI.router, functionName: "exactInputSingle", args: [params(ctx.treasury)] }), { value: amountIn, note: "swap" })];
  }
  const approve = approveCall(tokenIn, d.router, amountIn, "approve router");
  if (tokenOut === NATIVE) {
    const steps = [
      encodeFunctionData({ abi: ABI.router, functionName: "exactInputSingle", args: [params(d.router)] }),
      encodeFunctionData({ abi: ABI.router, functionName: "unwrapWETH9", args: [minOut, ctx.treasury] }),
    ];
    return [approve, call(d.router, encodeFunctionData({ abi: ABI.router, functionName: "multicall", args: [steps] }), { note: "swap + unwrap" })];
  }
  return [approve, call(d.router, encodeFunctionData({ abi: ABI.router, functionName: "exactInputSingle", args: [params(ctx.treasury)] }), { note: "swap" })];
}

const feeLabel = (fee) => `${fee / 10000}%`;

export const actions = [
  {
    id: "hyperswap-swap",
    label: "Swap tokens on HyperSwap v3 (one pool)",
    usage: ["tokenIn", "tokenOut", "amountIn", "minOut|slippage%"],
    options: [
      { name: "fee", description: "pool fee tier (100, 500, 3000, 10000) or auto - the best quote now", default: "auto" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const tokenIn = resolveToken(ctx.args[0], ctx, d.tokens);
      const tokenOut = resolveToken(ctx.args[1], ctx, d.tokens);
      const amountIn = await parseAmount(ctx, tokenIn, ctx.args[2]);
      const best = await bestSwap(ctx, d, tokenIn, tokenOut, amountIn, ctx.options.fee);
      const minText = String(ctx.args[3]);
      const minOut = minText.endsWith("%") ? minusBps(best.out, parsePercentBps(minText)) : await parseAmount(ctx, tokenOut, minText);
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: swapCalls(ctx, d, tokenIn, tokenOut, amountIn, minOut, best, deadline),
        summary:
          `Swap ${await formatAmount(ctx, tokenIn, amountIn)} for at least ${await formatAmount(ctx, tokenOut, minOut)} on HyperSwap's ` +
          `${feeLabel(best.fee)} pool (quoted ${await formatAmount(ctx, tokenOut, best.out, { approx: true })} now).`,
      };
    },
  },
];
