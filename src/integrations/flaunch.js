import { erc20Abi, getAddress, zeroAddress } from "viem";
import { createFlaunch, PoolSwapExactInputVersionAbi } from "@flaunch/sdk";
import { NATIVE, IntegrationError, checksummed, call, approveCall, resolveToken, parseAmount, formatAmount, parsePercentBps, deadlineFrom, requireCode, tokenSymbol } from "./common.js";

/**
 * Flaunch (Base) - buying and selling Flaunch coins from the Treasury.
 *
 * Flaunch runs several hook generations at once, and each coin's pool key
 * depends on the hook it launched on, so the swap is planned by Flaunch's
 * own SDK (@flaunch/sdk, pinned) rather than re-derived here:
 * planPairedTokenSwap() finds the coin's pool, quotes it, and returns
 * plain calls ({approve?, swap: {to, data, value}}) with the Treasury as
 * sender. Its router (PoolSwap) enforces the minimum out, full input
 * consumption and the deadline on-chain, and pays the output to the
 * caller - the Treasury.
 *
 * A buy spends the pool's paired token (native ETH, or on current Base
 * launches Flaunch's default paired token) - the Treasury must hold it.
 * Coins from the legacy flETH generation need a signer-driven SDK path
 * and are refused with an explanation, as are spend-gated pools (they need
 * a signed authorisation a Treasury can't produce).
 */

export const protocol = {
  id: "flaunch",
  name: "Flaunch",
  category: "Launchpad",
  deployments: {
    base: {
      poolSwap: "0x1b8065a099adcd7aa7c5e241e3596b56ec98ba5a",
      pairedPositionManager: "0x588c683ecc450f8b2aadb13d7f63792b840425dc",
      quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
      stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
      sources: ["@flaunch/sdk@0.17.1 (PoolSwapV1_3Address, PairedTokenPositionManagerV1_3Address, QuoterAddress, StateViewAddress for Base)"],
    },
    "base-sepolia": {
      poolSwap: "0xb32a99502f433f78454a4d20304e654cdda75c5c",
      pairedPositionManager: "0x8d346f24278c5cd786309161aac0fc2bbe4c25dc",
      quoter: "0x4a6513c898fe1b2d0e78d3b0e0a4a151589b1cba",
      stateView: "0x571291b572ed32ce6751a2cb2486ebee8defb9b4",
      sources: ["@flaunch/sdk@0.17.1 (same maps, Base Sepolia)"],
    },
  },
};

/** verify-integrations: the router must be the protected generation the SDK plans for. */
export async function verify(publicClient, d) {
  const version = await publicClient.readContract({ address: getAddress(d.poolSwap), abi: PoolSwapExactInputVersionAbi, functionName: "exactInputVersion" });
  return version === 1n ? [] : [`PoolSwap exactInputVersion() is ${version}, expected 1`];
}

/** The SDK factory - replaceable in tests. */
export const sdk = { create: (publicClient) => createFlaunch({ publicClient }) };

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`Flaunch isn't available on ${ctx.network.chain.name} (it's on Base and Base Sepolia).`);
  return checksummed(d);
}

function coinArg(ctx, word) {
  const coin = resolveToken(word, ctx);
  if (coin === NATIVE) throw new IntegrationError("Name the Flaunch coin (its 0x address or registered ticker).");
  return coin;
}

async function plan(ctx, d, direction, coin, amountIn, slippageBps, deadline) {
  let p;
  try {
    p = await sdk.create(ctx.publicClient).planPairedTokenSwap({ coinAddress: coin, direction, amountIn, slippageBps, deadline, sender: ctx.treasury });
  } catch (err) {
    const why = err.shortMessage || err.message;
    if (/not launched on a paired-token PositionManager/.test(why)) {
      throw new IntegrationError("This coin isn't on Flaunch's current (paired-token) generation - older flETH-pool coins aren't supported from a Treasury.");
    }
    throw new IntegrationError(`Flaunch couldn't plan this swap: ${why}`);
  }
  // The SDK picks the router per hook; only ever send the Treasury's funds to the verified one.
  if (getAddress(p.swap.to) !== d.poolSwap) throw new IntegrationError(`Flaunch's SDK chose router ${p.swap.to}, not the verified PoolSwap ${d.poolSwap} - refusing.`);
  return p;
}

function swapCalls(p) {
  const calls = [];
  if (!p.isNativeInput) calls.push(approveCall(p.tokenIn, p.swap.to, p.amountIn, "approve PoolSwap"));
  calls.push(call(p.swap.to, p.swap.data, { value: p.swap.value, note: p.direction }));
  return calls;
}

const sideToken = (t) => (getAddress(t) === zeroAddress ? NATIVE : getAddress(t));

export const actions = [
  {
    id: "flaunch-buy",
    label: "Buy a Flaunch coin with its pool's paired token",
    usage: ["coin", "amountIn", "slippage%"],
    options: [{ name: "deadline", description: "how long after proposing it may execute", default: "30d" }],
    async build(ctx) {
      const d = deployment(ctx);
      const coin = coinArg(ctx, ctx.args[0]);
      await requireCode(ctx, { "Flaunch PoolSwap": d.poolSwap, Coin: coin });
      const slippageBps = parsePercentBps(ctx.args[2] ?? "5%");
      const deadline = await deadlineFrom(ctx, ctx.options);
      // The amount is in the paired token's units, so learn which token that is first.
      const pool = await sdk.create(ctx.publicClient).resolvePairedPool(coin).catch(() => null);
      const paid = pool ? sideToken(pool.pairedToken) : NATIVE;
      const amountIn = await parseAmount(ctx, paid, ctx.args[1]);
      if (paid !== NATIVE) {
        const held = await ctx.publicClient.readContract({ address: paid, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
        if (held < amountIn) throw new IntegrationError(`This pool is paid in ${await tokenSymbol(ctx, paid)}; the Treasury holds only ${await formatAmount(ctx, paid, held)}.`);
      }
      const p = await plan(ctx, d, "buy", coin, amountIn, slippageBps, deadline);
      return {
        calls: swapCalls(p),
        summary:
          `Buy at least ${await formatAmount(ctx, coin, p.amountOutMin)} on Flaunch with ${await formatAmount(ctx, paid, amountIn)} ` +
          `(quoted ${await formatAmount(ctx, coin, p.expectedAmountOut, { approx: true })} now).`,
      };
    },
  },
  {
    id: "flaunch-sell",
    label: "Sell a Flaunch coin for its pool's paired token",
    usage: ["coin", "amount|all", "slippage%"],
    options: [{ name: "deadline", description: "how long after proposing it may execute", default: "30d" }],
    async build(ctx) {
      const d = deployment(ctx);
      const coin = coinArg(ctx, ctx.args[0]);
      await requireCode(ctx, { "Flaunch PoolSwap": d.poolSwap, Coin: coin });
      const held = await ctx.publicClient.readContract({ address: coin, abi: erc20Abi, functionName: "balanceOf", args: [ctx.treasury] });
      const amountIn = String(ctx.args[1]).toLowerCase() === "all" ? held : await parseAmount(ctx, coin, ctx.args[1]);
      if (amountIn === 0n) throw new IntegrationError("The Treasury holds none of this coin.");
      if (amountIn > held) throw new IntegrationError(`The Treasury holds only ${await formatAmount(ctx, coin, held)}.`);
      const slippageBps = parsePercentBps(ctx.args[2] ?? "5%");
      const deadline = await deadlineFrom(ctx, ctx.options);
      const p = await plan(ctx, d, "sell", coin, amountIn, slippageBps, deadline);
      const out = sideToken(p.tokenOut);
      return {
        calls: swapCalls(p),
        summary:
          `Sell ${await formatAmount(ctx, coin, amountIn)} on Flaunch for at least ${await formatAmount(ctx, out, p.amountOutMin)} ` +
          `(quoted ${await formatAmount(ctx, out, p.expectedAmountOut, { approx: true })} now).`,
      };
    },
  },
];
