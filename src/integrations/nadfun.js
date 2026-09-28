import { encodeFunctionData, erc20Abi, formatEther, getAddress, maxUint256 } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import {
  NATIVE, IntegrationError, checksummed, call, approveCall, resolveToken, parseAmount, formatAmount, approxUnits,
  parsePercentBps, minusBps, deadlineFrom, requireCode,
} from "./common.js";

/**
 * Nad.fun - buying and selling launchpad tokens with MON, called by the
 * Treasury. Same flow as Nad.fun's own SDK: Lens.getAmountOut(token,
 * amount, isBuy) names the router that currently serves the token (the
 * bonding-curve router before graduation, the DEX router after) and
 * quotes it; buy() takes MON as value, sell() pulls the approved token.
 * The router Lens names must be one of the two verified routers below,
 * or the bot refuses. If a token graduates between the vote and
 * execution, the chosen router may revert - propose again.
 */

const ABIS = loadIntegrationAbi("nadfun");

export const protocol = {
  id: "nadfun",
  name: "Nad.fun",
  category: "Launchpad",
  deployments: {
    "monad-mainnet": {
      bondingCurveRouter: "0x6f6b8f1a20703309951a5127c45b49b1cd981a22",
      dexRouter: "0x0b79d71ae99528d1db24a4148b5f4f865cc2b137",
      lens: "0x7e78a8de94f21804f7a17f4e8bf9ec2c872187ea",
      curve: "0xa7283d07812a02afb7c09b60f8896bcea3f90ace",
      wmon: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a",
      sources: ["@nadfun/sdk@0.4.3 CONTRACTS.mainnet", "monad-crypto/protocols mainnet registry (Nad.fun)"],
    },
    "monad-testnet": {
      bondingCurveRouter: "0x865054f0f6a288adaac30261731361ea7e908003",
      dexRouter: "0x5d4a4f430ca3b1b2db86b9cfe48a5316800f5fb2",
      lens: "0xb056d79ca5257589692699a46623f901a3bb76f1",
      curve: "0x1228b0dc9481c11d3071e7a924b794cfb038994e",
      wmon: "0x5a4e0bfdef88c9032cb4d24338c5eb3d3870bfdd",
      // Nad.fun's own SDK; Monad's registry still lists its older testnet addresses.
      sources: ["@nadfun/sdk@0.4.3 CONTRACTS.testnet"],
    },
  },
};

export const verifyLinks = [
  ["bondingCurveRouter", "curve", "curve"],
  ["bondingCurveRouter", "wMon", "wmon"],
];

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Nad.fun isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

async function quote(ctx, d, token, amountIn, isBuy) {
  let router, amount;
  try {
    [router, amount] = await ctx.publicClient.readContract({ address: d.lens, abi: ABIS.lens, functionName: "getAmountOut", args: [token, amountIn, isBuy] });
  } catch (err) {
    throw new IntegrationError(`Nad.fun has no market for ${token} (${err.shortMessage || err.message}).`);
  }
  router = getAddress(router);
  if (router !== d.bondingCurveRouter && router !== d.dexRouter) {
    throw new IntegrationError(`Nad.fun's Lens named router ${router}, which isn't one of its verified routers - refusing.`);
  }
  const locked = await ctx.publicClient.readContract({ address: d.lens, abi: ABIS.lens, functionName: "isLocked", args: [token] }).catch(() => false);
  if (locked) throw new IntegrationError("This token is locked while it graduates to the DEX - try again shortly.");
  return { router, amount, stage: router === d.dexRouter ? "DEX (graduated)" : "bonding curve" };
}

function tokenArg(ctx, word) {
  const token = resolveToken(word, ctx);
  if (token === NATIVE) throw new IntegrationError("Name the Nad.fun token (its 0x address or registered ticker); the other side is always MON.");
  return token;
}

export const actions = [
  {
    id: "nadfun-buy",
    label: "Buy a Nad.fun token with MON",
    usage: ["token", "amountMON", "minTokens|slippage%"],
    options: [{ name: "deadline", description: "how long after proposing it may execute", default: "30d" }],
    async build(ctx) {
      const d = deployment(ctx);
      const token = tokenArg(ctx, ctx.args[0]);
      const amountIn = await parseAmount(ctx, NATIVE, ctx.args[1]);
      await requireCode(ctx, { Lens: d.lens, Token: token });
      const q = await quote(ctx, d, token, amountIn, true);
      const minText = String(ctx.args[2]);
      const minOut = minText.endsWith("%") ? minusBps(q.amount, parsePercentBps(minText)) : await parseAmount(ctx, token, minText);
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: [
          call(q.router, encodeFunctionData({ abi: ABIS.router, functionName: "buy", args: [{ amountOutMin: minOut, token, to: ctx.treasury, deadline }] }), {
            value: amountIn,
            note: "buy",
          }),
        ],
        summary:
          `Buy at least ${await formatAmount(ctx, token, minOut)} with ${formatEther(amountIn)} MON on Nad.fun's ${q.stage} ` +
          `(quoted ${approxUnits(q.amount, await tokenDecimalsOf(ctx, token))} today).`,
      };
    },
  },
  {
    id: "nadfun-sell",
    label: "Sell a Nad.fun token for MON",
    usage: ["token", "amount|all", "minMON|slippage%"],
    options: [{ name: "deadline", description: "how long after proposing it may execute", default: "30d" }],
    async build(ctx) {
      const d = deployment(ctx);
      const token = tokenArg(ctx, ctx.args[0]);
      await requireCode(ctx, { Lens: d.lens, Token: token });
      const held = await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
      const amountIn = String(ctx.args[1]).toLowerCase() === "all" ? held : await parseAmount(ctx, token, ctx.args[1]);
      if (amountIn === 0n) throw new IntegrationError("The Treasury holds none of this token.");
      if (amountIn > held) throw new IntegrationError(`The Treasury holds only ${await formatAmount(ctx, token, held)}.`);
      const q = await quote(ctx, d, token, amountIn, false);
      const minText = String(ctx.args[2]);
      const minOut = minText.endsWith("%") ? minusBps(q.amount, parsePercentBps(minText)) : await parseAmount(ctx, NATIVE, minText);
      const deadline = await deadlineFrom(ctx, ctx.options);
      return {
        calls: [
          approveCall(token, q.router, amountIn, "approve router"),
          call(q.router, encodeFunctionData({ abi: ABIS.router, functionName: "sell", args: [{ amountIn, amountOutMin: minOut, token, to: ctx.treasury, deadline }] }), {
            note: "sell",
          }),
        ],
        summary: `Sell ${await formatAmount(ctx, token, amountIn)} on Nad.fun's ${q.stage} for at least ${formatEther(minOut)} MON (quoted ${approxUnits(q.amount)} MON today).`,
      };
    },
  },
];

async function tokenDecimalsOf(ctx, token) {
  return Number(await ctx.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }));
}
