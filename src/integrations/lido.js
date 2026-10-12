import { erc20Abi, formatUnits, getAddress } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import { NATIVE, IntegrationError, checksummed, parseAmount, formatAmount, parsePercentBps, deadlineFrom, requireCode } from "./common.js";
import { deployment as aerodromeDeployment, bestSwap, swapCalls } from "./aerodrome.js";

/**
 * Lido wstETH on Base - the Treasury buys or sells wstETH for ETH at
 * close to Lido's own exchange rate.
 *
 * Base has no stETH and no Lido staking contract a Treasury can call
 * directly: wstETH there is the bridged token. Lido's Base "direct
 * staking" (Chainlink CCIP CustomSenderReferral) publishes no interface
 * that could be verified, so it isn't used. Instead the swap goes through
 * Aerodrome (aerodrome.js, the same verified Router), and the minimum out
 * is set from Lido's wstETH/stETH exchange-rate feed on Base rather than
 * from the pool's own quote - a pool pushed off-price before execution
 * can't fill below the agreed rate. Assumes 1 stETH = 1 ETH, the pricing
 * Lido's integration guide describes; `maxgap` is the tolerance on top.
 */

const ABI = loadIntegrationAbi("lido").rateFeed;
const MAX_FEED_AGE = 3n * 86400n; // the exchange-rate feed updates about daily

export const protocol = {
  id: "lido",
  name: "Lido wstETH",
  category: "Liquid staking",
  deployments: {
    base: {
      wsteth: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",
      rateFeed: "0xb88bac61a4ca37c43a3725912b1f472c9a5bc061",
      sources: [
        "lidofinance/docs deployed-contracts: WstETH ERC20Bridged (Base part); Chainlink wstETH/stETH exchange rate on Base",
        "wstETH also matches @bgd-labs/aave-address-book@4.44.22 AaveV3Base",
        "swaps: Aerodrome Router (see aerodrome.js)",
      ],
    },
  },
};

export const verifyValues = [["wsteth", "symbol", "wstETH"]];

/** verify-integrations: the rate feed must answer a sane wstETH/stETH rate (more than 1, well under 2). */
export async function verify(publicClient, d) {
  const feed = getAddress(d.rateFeed);
  const decimals = await publicClient.readContract({ address: feed, abi: ABI, functionName: "decimals" });
  const [, answer] = await publicClient.readContract({ address: feed, abi: ABI, functionName: "latestRoundData" });
  const rate = Number(formatUnits(answer, Number(decimals)));
  return rate > 1 && rate < 2 ? [] : [`rate feed answers ${rate}, expected a wstETH/stETH rate between 1 and 2`];
}

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Lido wstETH actions are only set up on Base (not ${ctx.network.chain.name}).`);
  return checksummed(d);
}

/** stETH per wstETH from Lido's feed, refusing a stale or nonsensical answer. */
async function lidoRate(ctx, d) {
  await requireCode(ctx, { "wstETH": d.wsteth, "Lido rate feed": d.rateFeed });
  const decimals = Number(await ctx.publicClient.readContract({ address: d.rateFeed, abi: ABI, functionName: "decimals" }));
  const [, answer, , updatedAt] = await ctx.publicClient.readContract({ address: d.rateFeed, abi: ABI, functionName: "latestRoundData" });
  const now = (await ctx.publicClient.getBlock()).timestamp;
  if (answer <= 0n) throw new IntegrationError("Lido's rate feed has no valid answer right now.");
  if (now - updatedAt > MAX_FEED_AGE) throw new IntegrationError("Lido's rate feed hasn't updated in over 3 days - refusing to price against it.");
  return { answer, decimals, scale: 10n ** BigInt(decimals) };
}

const rateText = (r) => String(Number(Number(formatUnits(r.answer, r.decimals)).toPrecision(6)));

function floorCheck(quoteOut, minOut, what) {
  if (quoteOut < minOut) {
    throw new IntegrationError(`Aerodrome's best quote (${what}) is already below Lido's rate minus the allowed gap - it would fail now. Try a smaller amount or a larger maxgap.`);
  }
}

export const actions = [
  {
    id: "lido-buy-wsteth",
    label: "Buy wstETH with ETH at close to Lido's rate",
    usage: ["amountETH"],
    options: [
      { name: "maxgap", description: "how far below Lido's rate the fill may be", default: "0.5%" },
      { name: "pool", description: "Aerodrome pool: stable, volatile or auto", default: "auto" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const aero = aerodromeDeployment(ctx);
      const amountIn = await parseAmount(ctx, NATIVE, ctx.args[0]);
      const rate = await lidoRate(ctx, d);
      await requireCode(ctx, { "Aerodrome Router": aero.router });
      const fair = (amountIn * rate.scale) / rate.answer; // ETH -> wstETH at 1 stETH = 1 ETH
      const minOut = (fair * BigInt(10_000 - parsePercentBps(ctx.options.maxgap, 50))) / 10_000n;
      const best = await bestSwap(ctx, aero, NATIVE, d.wsteth, amountIn, ctx.options.pool);
      floorCheck(best.out, minOut, await formatAmount(ctx, d.wsteth, best.out, { approx: true }));
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: swapCalls(ctx, aero, NATIVE, d.wsteth, amountIn, minOut, best.route, deadline),
        summary:
          `Buy wstETH with ${await formatAmount(ctx, NATIVE, amountIn)} on Aerodrome, for at least ${await formatAmount(ctx, d.wsteth, minOut)} ` +
          `(Lido rate ${rateText(rate)} stETH per wstETH; quoted ${await formatAmount(ctx, d.wsteth, best.out, { approx: true })} now).`,
      };
    },
  },
  {
    id: "lido-sell-wsteth",
    label: "Sell the Treasury's wstETH for ETH at close to Lido's rate",
    usage: ["amount|all"],
    options: [
      { name: "maxgap", description: "how far below Lido's rate the fill may be", default: "0.5%" },
      { name: "pool", description: "Aerodrome pool: stable, volatile or auto", default: "auto" },
      { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
    ],
    async build(ctx) {
      const d = deployment(ctx);
      const aero = aerodromeDeployment(ctx);
      const rate = await lidoRate(ctx, d);
      const held = await ctx.publicClient.readContract({ address: d.wsteth, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
      const amountIn = String(ctx.args[0]).toLowerCase() === "all" ? held : await parseAmount(ctx, d.wsteth, ctx.args[0]);
      if (amountIn === 0n) throw new IntegrationError("The Treasury holds no wstETH.");
      if (amountIn > held) throw new IntegrationError(`The Treasury holds only ${await formatAmount(ctx, d.wsteth, held)}.`);
      await requireCode(ctx, { "Aerodrome Router": aero.router });
      const fair = (amountIn * rate.answer) / rate.scale;
      const minOut = (fair * BigInt(10_000 - parsePercentBps(ctx.options.maxgap, 50))) / 10_000n;
      const best = await bestSwap(ctx, aero, d.wsteth, NATIVE, amountIn, ctx.options.pool);
      floorCheck(best.out, minOut, await formatAmount(ctx, NATIVE, best.out, { approx: true }));
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: swapCalls(ctx, aero, d.wsteth, NATIVE, amountIn, minOut, best.route, deadline),
        summary:
          `Sell ${await formatAmount(ctx, d.wsteth, amountIn)} on Aerodrome for at least ${await formatAmount(ctx, NATIVE, minOut)} ` +
          `(Lido rate ${rateText(rate)} stETH per wstETH; quoted ${await formatAmount(ctx, NATIVE, best.out, { approx: true })} now).`,
      };
    },
  },
];
