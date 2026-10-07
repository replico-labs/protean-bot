import { isAddress, getAddress } from "viem";
import { getAdapter } from "../../governance/index.js";
import { getProposalVaults, splitTokens, mergeTokens, redeemTokens, unwrapWmon } from "../../governance/decisionMarkets.js";
import { UserError, reply, requireModel, requireAdapterFn, userClient, adapterWrite, proposalReply } from "../helpers.js";

/** Decision markets (futarchy): seeding, conditional tokens, trading, resolution. Ported from index.js. */

const DM = ["decisionMarkets"];
const NOT_DM = "This DAO uses {model} governance, which has no decision markets.";

function vaultAction({ name, description, usage, needsAmount, action, done }) {
  return {
    section: "Decision markets",
    models: DM,
    usage,
    description,
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "side", description: "base = DAO token side, quote = MON/WMON side", required: true, choices: ["base", "quote"] },
      ...(needsAmount ? [{ name: "amount", description: "Amount", required: true }] : []),
    ],
    async run(ctx) {
      const { address } = requireModel(ctx, "decisionMarkets", NOT_DM);
      const [id, sideRaw, amount] = ctx.args;
      const side = sideRaw?.toLowerCase();
      if (!id || !/^\d+$/.test(id) || (side !== "base" && side !== "quote") || (needsAmount && !(Number(amount) > 0))) {
        throw new UserError(`Usage: \`${ctx.cmd(name)} ${usage}\``);
      }
      const { client } = await userClient(ctx);
      const { baseVault, quoteVault } = await getProposalVaults(address, id);
      await action(client, side === "base" ? baseVault : quoteVault, amount);
      return reply(done(side, amount));
    },
  };
}

export const MARKET_COMMANDS = {
  proposemarket: {
    section: "Decision markets",
    models: DM,
    usage: "<target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description>",
    description: "Propose and seed the pass/fail markets",
    options: [
      { name: "target", description: "Target contract address", required: true },
      { name: "value", description: "Native value in wei", required: true },
      { name: "data", description: "Hex calldata, or 0x", required: true },
      { name: "base_seed", description: "DAO tokens to seed (needs prior approval)", required: true },
      { name: "quote_seed_mon", description: "MON to seed the other side", required: true },
      { name: "description", description: "What this proposal does", required: true, rest: true },
    ],
    async run(ctx) {
      const { address } = requireModel(ctx, "decisionMarkets", "This DAO uses {model} governance, which doesn't use seeded markets. Use propose instead.");
      const [target, value, data, baseSeedAmount, quoteSeedAmount, ...descriptionParts] = ctx.args;
      const description = descriptionParts.join(" ");
      if (!target || !isAddress(target) || !value || !data || !(Number(baseSeedAmount) > 0) || !(Number(quoteSeedAmount) > 0) || !description) {
        throw new UserError(`Usage: \`${ctx.cmd("proposemarket")} <target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description>\` — e.g. \`0xRecipient 0 0x 1000 5 Fund the marketing campaign\``);
      }
      const { client } = await userClient(ctx, { forceFullTopup: true });
      const { proposalId } = await getAdapter("decisionMarkets").proposeWithSeed(
        client,
        address,
        [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }],
        description,
        baseSeedAmount,
        quoteSeedAmount
      );
      return proposalReply(ctx, address, "decisionMarkets", proposalId, `✅ Proposal #${proposalId} created and both markets are live. Use \`${ctx.cmd("trade")}\` to back pass or fail.`);
    },
  },

  split: vaultAction({
    name: "split",
    usage: "<id> base|quote <amount>",
    description: "Split real tokens into pass/fail tokens",
    needsAmount: true,
    action: (client, vault, amount) => splitTokens(client, vault, amount),
    done: (side, amount) => `✅ Split ${amount} tokens into pass/fail conditional tokens on the ${side} side.`,
  }),

  merge: vaultAction({
    name: "merge",
    usage: "<id> base|quote <amount>",
    description: "Merge pass/fail tokens back before resolution",
    needsAmount: true,
    action: (client, vault, amount) => mergeTokens(client, vault, amount),
    done: (side, amount) => `✅ Merged ${amount} conditional tokens back into real tokens on the ${side} side.`,
  }),

  redeem: vaultAction({
    name: "redeem",
    usage: "<id> base|quote",
    description: "Redeem winning conditional tokens after resolution",
    needsAmount: false,
    action: (client, vault) => redeemTokens(client, vault),
    done: (side) => `✅ Redeemed your ${side}-side conditional tokens for real tokens.`,
  }),

  unwrap: {
    section: "Decision markets",
    models: DM,
    usage: "<amount>",
    description: "Convert WMON back into MON",
    options: [{ name: "amount", description: "WMON to unwrap", required: true }],
    async run(ctx) {
      const { address } = requireModel(ctx, "decisionMarkets", "This DAO uses {model} governance, which has no WMON to unwrap.");
      const amount = ctx.args[0];
      if (!(Number(amount) > 0)) throw new UserError(`Usage: \`${ctx.cmd("unwrap")} <amount>\``);
      const { client } = await userClient(ctx);
      await unwrapWmon(client, address, amount);
      return reply(`✅ Unwrapped ${amount} WMON to native MON.`);
    },
  },

  trade: {
    section: "Decision markets",
    models: DM,
    usage: "<id> pass|fail base|quote <amountIn> <minAmountOut>",
    description: "Trade in the pass or fail market",
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "market", description: "Which market", required: true, choices: ["pass", "fail"] },
      { name: "side", description: "Which conditional token you're selling", required: true, choices: ["base", "quote"] },
      { name: "amount_in", description: "Amount to sell", required: true },
      { name: "min_amount_out", description: "Slippage protection - don't leave at 0", required: true },
    ],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "trade", "This DAO uses {model} governance, which has no trading markets.");
      const [id, marketRaw, sideRaw, amountIn, minAmountOut] = ctx.args;
      const market = marketRaw?.toLowerCase();
      const side = sideRaw?.toLowerCase();
      const valid =
        id && /^\d+$/.test(id) && (market === "pass" || market === "fail") && (side === "base" || side === "quote") &&
        Number(amountIn) > 0 && minAmountOut !== undefined && !Number.isNaN(Number(minAmountOut)) && Number(minAmountOut) >= 0;
      if (!valid) throw new UserError(`Usage: \`${ctx.cmd("trade")} <id> pass|fail base|quote <amountIn> <minAmountOut>\``);
      const { client } = await userClient(ctx);
      await adapter.trade(client, address, id, market === "pass" ? 0 : 1, side === "base" ? 0 : 1, amountIn, minAmountOut);
      return reply(`✅ Traded on the *${market}* market for proposal #${id}.`);
    },
  },

  finalizeproposal: adapterWrite({
    section: "Decision markets",
    models: DM,
    description: "Compare market prices and resolve pass/fail",
    fn: "finalizeProposal",
    notSupported: "This DAO uses {model} governance, which has no trading markets to finalize.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Proposal #${id} finalized. Check \`${ctx.cmd("proposal")} ${id}\` for whether it passed.`,
  }),

  reclaimliquidity: adapterWrite({
    section: "Decision markets",
    models: DM,
    description: "Proposer: recover seed liquidity after resolution",
    fn: "reclaimLiquidity",
    notSupported: "This DAO uses {model} governance, which has no seed liquidity to reclaim.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Seed liquidity for proposal #${id} reclaimed.`,
  }),
};
