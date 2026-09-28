import { encodeFunctionData, formatEther, maxUint256 } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import { IntegrationError, checksummed, call, parseAmount, parsePercentBps, minusBps, requireCode, approxUnits, NATIVE } from "./common.js";

/**
 * shMON - FastLane's liquid-staking MON (ShMonad), called by the Treasury.
 *
 * stake:            deposit{value}(MON, Treasury)            -> shMON
 * unstake (instant) redeemWithSlippageProtection from the atomic pool:
 *                   MON now, minus the pool's fee, with a minimum out
 * unstake (queued)  requestUnstake(shares) burns shMON now; after the
 *                   completion epoch, completeUnstake() pays the MON with
 *                   no fee. Two proposals, days apart.
 * Interface compiled from FastLane's own IShMonad.sol.
 */

const ABI = loadIntegrationAbi("shmonad").shmonad;

export const protocol = {
  id: "shmonad",
  name: "shMON (FastLane)",
  category: "Liquid staking",
  deployments: {
    "monad-mainnet": {
      shmonad: "0x1b68626dca36c7fe922fd2d55e4f631d962de19c",
      sources: [
        "monad-crypto/protocols mainnet registry (Fastlane ShMonad)",
        "FastLane's address page docs.shmonad.xyz/addresses (via search index; the site is blocked from the build environment)",
      ],
    },
  },
};

/** verify-integrations: the contract must answer as shMON. */
export const verifyValues = [["shmonad", "symbol", "shMON"]];

function deployment(ctx) {
  const d = protocol.deployments[ctx.network.id];
  if (!d) throw new IntegrationError(`shMON isn't available on ${ctx.network.chain.name}.`);
  return checksummed(d);
}

const read = (ctx, d, functionName, args = []) => ctx.publicClient.readContract({ address: d.shmonad, abi: ABI, functionName, args });

async function sharesArg(ctx, d, text) {
  const balance = await read(ctx, d, "balanceOf", [ctx.treasury]);
  if (String(text).toLowerCase() === "all") {
    if (balance === 0n) throw new IntegrationError("The Treasury holds no shMON.");
    return { shares: balance, note: " (all the Treasury holds today)" };
  }
  const shares = await parseAmount(ctx, NATIVE, text); // shMON has 18 decimals, like MON
  if (shares > balance) throw new IntegrationError(`The Treasury holds only ${formatEther(balance)} shMON.`);
  return { shares, note: "" };
}

export const actions = [
  {
    id: "shmon-stake",
    label: "Stake MON for shMON",
    usage: ["amountMON"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      const amount = await parseAmount(ctx, NATIVE, ctx.args[0]);
      await requireCode(ctx, { ShMonad: d.shmonad });
      let expect = "";
      try {
        expect = ` (about ${approxUnits(await read(ctx, d, "previewDeposit", [amount]))} shMON at today's rate)`;
      } catch {}
      return {
        calls: [call(d.shmonad, encodeFunctionData({ abi: ABI, functionName: "deposit", args: [amount, ctx.treasury] }), { value: amount, note: "stake" })],
        summary: `Stake ${formatEther(amount)} MON from the Treasury for shMON${expect}.`,
      };
    },
  },
  {
    id: "shmon-unstake-instant",
    label: "Unstake shMON to MON now (pays the instant-unstake fee)",
    usage: ["shares|all", "minMON|slippage%"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      await requireCode(ctx, { ShMonad: d.shmonad });
      const { shares, note } = await sharesArg(ctx, d, ctx.args[0]);
      const quote = await read(ctx, d, "previewRedeem", [shares]);
      const minText = String(ctx.args[1]);
      const minOut = minText.endsWith("%") ? minusBps(quote, parsePercentBps(minText)) : await parseAmount(ctx, NATIVE, minText);
      return {
        calls: [call(d.shmonad, encodeFunctionData({ abi: ABI, functionName: "redeemWithSlippageProtection", args: [shares, ctx.treasury, ctx.treasury, minOut] }), { note: "instant unstake" })],
        summary:
          `Unstake ${formatEther(shares)} shMON${note} instantly for at least ${formatEther(minOut)} MON ` +
          `(${approxUnits(quote)} MON after the fee today). For no fee, use shmon-request-unstake instead.`,
      };
    },
  },
  {
    id: "shmon-request-unstake",
    label: "Queue a fee-free shMON unstake (complete it later)",
    usage: ["shares|all"],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      await requireCode(ctx, { ShMonad: d.shmonad });
      const { shares, note } = await sharesArg(ctx, d, ctx.args[0]);
      const mon = await read(ctx, d, "previewUnstake", [shares]);
      return {
        calls: [call(d.shmonad, encodeFunctionData({ abi: ABI, functionName: "requestUnstake", args: [shares] }), { note: "request unstake" })],
        summary:
          `Burn ${formatEther(shares)} shMON${note} and queue about ${approxUnits(mon)} MON for withdrawal. ` +
          "Once the completion epoch passes, propose shmon-complete-unstake to receive it.",
      };
    },
  },
  {
    id: "shmon-complete-unstake",
    label: "Collect MON from a queued shMON unstake",
    usage: [],
    options: [],
    async build(ctx) {
      const d = deployment(ctx);
      await requireCode(ctx, { ShMonad: d.shmonad });
      const [amountMon, completionEpoch] = await read(ctx, d, "getUnstakeRequest", [ctx.treasury]);
      if (amountMon === 0n) throw new IntegrationError("The Treasury has no queued shMON unstake - propose shmon-request-unstake first.");
      return {
        calls: [call(d.shmonad, encodeFunctionData({ abi: ABI, functionName: "completeUnstake" }), { note: "complete unstake" })],
        summary: `Collect the Treasury's queued ${formatEther(amountMon)} MON from shMON (claimable from ShMonad epoch ${completionEpoch}; executing earlier reverts).`,
      };
    },
  },
];
