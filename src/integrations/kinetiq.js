import { erc20Abi, formatEther, getAddress, parseEther } from "viem";
import { NATIVE, IntegrationError, checksummed, parseAmount, formatAmount, parsePercentBps, deadlineFrom, requireCode } from "./common.js";
import { deployment as hyperswapDeployment, bestSwap, swapCalls } from "./hyperswap.js";

/**
 * Kinetiq kHYPE (HyperEVM) - the Treasury buys or sells kHYPE for HYPE at
 * close to Kinetiq's own exchange rate.
 *
 * Kinetiq's staking contract publishes no interface that could be
 * verified, so kHYPE is bought and sold on HyperSwap (hyperswap.js, the
 * same router), the way lido.js routes wstETH through Aerodrome. The
 * minimum out comes from Kinetiq's StakingAccountant rate
 * (kHYPEToHYPE), not the pool's quote, so a pool pushed off-price before
 * execution can't fill below the agreed rate - it reverts instead.
 */

const ACCOUNTANT_ABI = [
  { type: "function", name: "kHYPEToHYPE", stateMutability: "view", inputs: [{ name: "amount", type: "uint256" }], outputs: [{ type: "uint256" }] },
];

export const protocol = {
  id: "kinetiq",
  name: "Kinetiq kHYPE",
  category: "Liquid staking",
  deployments: {
    hyperevm: {
      khype: "0xfd739d4e423301ce9385c1fb8850539d657c296d",
      stakingAccountant: "0x9209648ec9d448ef57116b73a2f081835643dc7a",
      sources: [
        "DefiLlama/yield-server src/adaptors/kinetiq-khype (kHYPE, stakingAccountant, kHYPEToHYPE(uint256))",
        "kHYPE also in @hypurrquant/defi-cli@1.0.13 config/tokens/hyperevm.toml",
        "swaps: HyperSwap v3 (see hyperswap.js)",
      ],
      warning: "kHYPE and its rate contract come from DefiLlama and a community CLI, not a Kinetiq source - run verify:integrations before relying on them.",
    },
  },
};

export const verifyValues = [["khype", "symbol", "kHYPE"]];

/** verify-integrations: the accountant must answer a sane kHYPE -> HYPE rate (at least 1, well under 2). */
export async function verify(publicClient, d) {
  const rate = await publicClient.readContract({ address: getAddress(d.stakingAccountant), abi: ACCOUNTANT_ABI, functionName: "kHYPEToHYPE", args: [parseEther("1")] });
  return rate >= parseEther("1") && rate < parseEther("2") ? [] : [`kHYPEToHYPE(1) = ${formatEther(rate)}, expected between 1 and 2`];
}

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Kinetiq kHYPE actions are only set up on HyperEVM (not ${ctx.network.chain.name}).`);
  return checksummed(d);
}

/** HYPE per 1 kHYPE (18 decimals), refusing a nonsensical answer. */
async function kinetiqRate(ctx, d) {
  await requireCode(ctx, { kHYPE: d.khype, "Kinetiq StakingAccountant": d.stakingAccountant });
  const rate = await ctx.publicClient.readContract({ address: d.stakingAccountant, abi: ACCOUNTANT_ABI, functionName: "kHYPEToHYPE", args: [parseEther("1")] });
  if (rate < parseEther("1") || rate >= parseEther("2")) throw new IntegrationError(`Kinetiq's rate reads ${formatEther(rate)} HYPE per kHYPE, which looks wrong - refusing to price against it.`);
  return rate;
}

const rateText = (rate) => String(Number(Number(formatEther(rate)).toPrecision(6)));

function floorCheck(quoteOut, minOut, what) {
  if (quoteOut < minOut) {
    throw new IntegrationError(`HyperSwap's best quote (${what}) is already below Kinetiq's rate minus the allowed gap - it would fail now. Try a smaller amount or a larger maxgap.`);
  }
}

const OPTIONS = [
  { name: "maxgap", description: "how far below Kinetiq's rate the fill may be", default: "0.5%" },
  { name: "fee", description: "HyperSwap pool fee tier or auto", default: "auto" },
  { name: "deadline", description: "how long after proposing it may execute", default: "30d" },
];

export const actions = [
  {
    id: "kinetiq-buy-khype",
    label: "Buy kHYPE with HYPE at close to Kinetiq's rate",
    usage: ["amountHYPE"],
    options: OPTIONS,
    async build(ctx) {
      const d = deployment(ctx);
      const swap = hyperswapDeployment(ctx);
      const amountIn = await parseAmount(ctx, NATIVE, ctx.args[0]);
      const rate = await kinetiqRate(ctx, d);
      const fair = (amountIn * parseEther("1")) / rate;
      const minOut = (fair * BigInt(10_000 - parsePercentBps(ctx.options.maxgap, 50))) / 10_000n;
      const best = await bestSwap(ctx, swap, NATIVE, d.khype, amountIn, ctx.options.fee);
      floorCheck(best.out, minOut, await formatAmount(ctx, d.khype, best.out, { approx: true }));
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: swapCalls(ctx, swap, NATIVE, d.khype, amountIn, minOut, best, deadline),
        summary:
          `Buy kHYPE with ${await formatAmount(ctx, NATIVE, amountIn)} on HyperSwap, for at least ${await formatAmount(ctx, d.khype, minOut)} ` +
          `(Kinetiq rate ${rateText(rate)} HYPE per kHYPE; quoted ${await formatAmount(ctx, d.khype, best.out, { approx: true })} now).`,
      };
    },
  },
  {
    id: "kinetiq-sell-khype",
    label: "Sell the Treasury's kHYPE for HYPE at close to Kinetiq's rate",
    usage: ["amount|all"],
    options: OPTIONS,
    async build(ctx) {
      const d = deployment(ctx);
      const swap = hyperswapDeployment(ctx);
      const rate = await kinetiqRate(ctx, d);
      const held = await ctx.publicClient.readContract({ address: d.khype, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
      const amountIn = String(ctx.args[0]).toLowerCase() === "all" ? held : await parseAmount(ctx, d.khype, ctx.args[0]);
      if (amountIn === 0n) throw new IntegrationError("The Treasury holds no kHYPE.");
      if (amountIn > held) throw new IntegrationError(`The Treasury holds only ${await formatAmount(ctx, d.khype, held)}.`);
      const fair = (amountIn * rate) / parseEther("1");
      const minOut = (fair * BigInt(10_000 - parsePercentBps(ctx.options.maxgap, 50))) / 10_000n;
      const best = await bestSwap(ctx, swap, d.khype, NATIVE, amountIn, ctx.options.fee);
      floorCheck(best.out, minOut, await formatAmount(ctx, NATIVE, best.out, { approx: true }));
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: swapCalls(ctx, swap, d.khype, NATIVE, amountIn, minOut, best, deadline),
        summary:
          `Sell ${await formatAmount(ctx, d.khype, amountIn)} on HyperSwap for at least ${await formatAmount(ctx, NATIVE, minOut)} ` +
          `(Kinetiq rate ${rateText(rate)} HYPE per kHYPE; quoted ${await formatAmount(ctx, NATIVE, best.out, { approx: true })} now).`,
      };
    },
  },
];
