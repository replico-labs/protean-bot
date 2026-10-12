import { isAddress, getAddress, formatUnits } from "viem";
import { registerMarket, unregisterMarket, getChatMarket } from "../../db.js";
import * as opportunityMarket from "../../opportunityMarket/market.js";
import { back as opportunityBack } from "../../opportunityMarket/encryptedBet.js";
import { getBalance, getBet, getAllBets, getMarketAnalytics } from "../../opportunityMarket/decrypt.js";
import { revealAndCompleteWinningTotal, revealAndCompleteWithdrawal } from "../../opportunityMarket/publicReveal.js";
import { short } from "../../format.js";
import { formatMarketAnalytics } from "../../opportunityMarket/analyticsText.js";
import { rewardComputedText, withdrawnText } from "../../opportunityMarket/payoutText.js";
import { UserError, reply, privateReply, requireMarket, parseId, opportunityClient } from "../helpers.js";

/**
 * Opportunity Markets (Sepolia, Zama FHE) - ported from index.js.
 *
 * Privacy: on Telegram, sensitive results go to a DM and bare /back
 * collects the bet over DM so it never sits in the group's history. Here
 * those commands are `ephemeralByDefault`: on Discord that keeps both the
 * reply and the typed options visible only to the caller; on Slack the
 * command and reply are shown only to the caller. So `back` takes its
 * arguments directly - there's no public message to leak them into.
 */

const MARKET = "Opportunity Market";

function simpleMarketWrite({ usage, description, options = [], action, done, privateResult = false }) {
  return {
    section: MARKET,
    usage,
    description,
    options,
    ...(privateResult ? { ephemeralByDefault: true } : {}),
    async run(ctx) {
      const address = requireMarket(ctx);
      const { client } = await opportunityClient(ctx);
      await action(ctx, client, address);
      return privateResult ? privateReply(done(ctx)) : reply(done(ctx));
    },
  };
}

/** /withdraw and /withdrawreward: pay out, then say exactly how much arrived and how to send it on. */
function withdrawal(kind, description) {
  return {
    section: MARKET,
    usage: "",
    description,
    options: [],
    ephemeralByDefault: true,
    async run(ctx) {
      const address = requireMarket(ctx);
      const { account, client } = await opportunityClient(ctx);
      const { amount } = await revealAndCompleteWithdrawal(client, address, kind);
      return privateReply(await withdrawnText(address, kind, amount, account.address, ctx.cmd));
    },
  };
}

export const OPPORTUNITY_COMMANDS = {
  registermarket: {
    section: MARKET,
    usage: "<marketAddress>",
    description: "Link an Opportunity Market created by this bot's factory",
    options: [{ name: "address", description: "OpportunityMarket address", required: true }],
    async run(ctx) {
      const address = ctx.args[0];
      if (!address || !isAddress(address)) throw new UserError(`Usage: \`${ctx.cmd("registermarket")} 0xYourMarketAddress\``);
      const factoryAddress = process.env.OPPORTUNITY_MARKET_FACTORY_ADDRESS;
      if (!factoryAddress) throw new UserError("No OpportunityMarketFactory configured on this bot - ask an admin to set OPPORTUNITY_MARKET_FACTORY_ADDRESS.");
      let fromFactory;
      try {
        fromFactory = await opportunityMarket.isFactoryMarket(factoryAddress, address);
      } catch {
        throw new UserError("Couldn't check that address against the market factory - try again in a moment.");
      }
      if (!fromFactory) throw new UserError(`That address wasn't created by this bot's OpportunityMarket factory, so it can't be linked. Use \`${ctx.cmd("createmarket")}\` to deploy one.`);
      try {
        await opportunityMarket.getUnderlyingDecimals(address);
      } catch {
        throw new UserError("Couldn't read an OpportunityMarket at that address on Sepolia.");
      }
      registerMarket(ctx.chatId, getAddress(address), ctx.platform);
      return reply(`✅ This channel is now linked to the Opportunity Market at \`${short(address)}\`.`);
    },
  },

  unregistermarket: {
    section: MARKET,
    usage: "",
    description: "Unlink the market (channel owners/admins)",
    options: [],
    async run(ctx) {
      // Owners/admins only - enforced by runCommand (ADMIN_COMMANDS).
      const address = getChatMarket(ctx.chatId, ctx.platform);
      if (!address) throw new UserError("No market is linked here.");
      unregisterMarket(ctx.chatId, ctx.platform);
      return reply(`Unlinked. Run \`${ctx.cmd("registermarket")}\` or \`${ctx.cmd("createmarket")}\` to link one again.`);
    },
  },

  createmarket: {
    section: MARKET,
    usage: "<underlyingToken>",
    description: "Deploy a new market (you become its deployer)",
    options: [{ name: "token", description: "Underlying ERC20 on Sepolia", required: true }],
    async run(ctx) {
      const factoryAddress = process.env.OPPORTUNITY_MARKET_FACTORY_ADDRESS;
      if (!factoryAddress) throw new UserError("No OpportunityMarketFactory configured on this bot - ask an admin to set OPPORTUNITY_MARKET_FACTORY_ADDRESS.");
      const underlyingToken = ctx.args[0];
      if (!underlyingToken || !isAddress(underlyingToken)) throw new UserError(`Usage: \`${ctx.cmd("createmarket")} 0xUnderlyingToken\``);
      const { client } = await opportunityClient(ctx);
      const { marketAddress } = await opportunityMarket.createMarket(client, factoryAddress, underlyingToken);
      registerMarket(ctx.chatId, marketAddress, ctx.platform);
      return reply(`✅ Market deployed at \`${short(marketAddress)}\` and linked to this channel. You're its deployer.`);
    },
  },

  listopportunity: {
    section: MARKET,
    usage: "<metadataURI>",
    description: "Add an opportunity people can back",
    options: [{ name: "metadata_uri", description: "Link or text describing the opportunity", required: true, rest: true }],
    async run(ctx) {
      const address = requireMarket(ctx);
      const metadataURI = ctx.args.join(" ").trim();
      if (!metadataURI) throw new UserError(`Usage: \`${ctx.cmd("listopportunity")} <metadataURI>\``);
      const { client } = await opportunityClient(ctx);
      const { id } = await opportunityMarket.listOpportunity(client, address, metadataURI);
      return reply(`✅ Opportunity #${id ?? "?"} listed.`);
    },
  },

  deposit: {
    section: MARKET,
    usage: "<amount>",
    description: "Deposit underlying tokens (this step is public)",
    options: [{ name: "amount", description: "Tokens to deposit", required: true }],
    async run(ctx) {
      const address = requireMarket(ctx);
      const amount = ctx.args[0];
      if (!(Number(amount) > 0)) throw new UserError(`Usage: \`${ctx.cmd("deposit")} <amount>\` — the deposit itself is public on-chain; which opportunity you back stays private.`);
      const { client } = await opportunityClient(ctx);
      await opportunityMarket.deposit(client, address, amount);
      return reply(`✅ Deposited ${amount} tokens.`);
    },
  },

  back: {
    section: MARKET,
    usage: "<opportunityId> <amount>",
    description: "Confidentially back an opportunity (private)",
    ephemeralByDefault: true,
    options: [
      { name: "opportunity", description: "Opportunity ID", required: true, type: "integer" },
      { name: "amount", description: "Amount to back it with", required: true },
    ],
    async run(ctx) {
      const address = requireMarket(ctx);
      const [targetId, amount] = ctx.args;
      if (!targetId || !/^\d+$/.test(targetId) || !(Number(amount) > 0)) throw new UserError(`Usage: \`${ctx.cmd("back")} <opportunityId> <amount>\` — only you can see this.`);
      const { client } = await opportunityClient(ctx);
      await opportunityBack(client, address, Number(targetId), amount);
      return privateReply("✅ Bet placed confidentially.");
    },
  },

  mybalance: {
    section: MARKET,
    usage: "",
    description: "Your confidential balance (private)",
    ephemeralByDefault: true,
    options: [],
    async run(ctx) {
      const address = requireMarket(ctx);
      const { client } = await opportunityClient(ctx);
      const balance = await getBalance(client, address);
      const decimals = await opportunityMarket.getUnderlyingDecimals(address);
      return privateReply(`Your confidential balance: *${formatUnits(balance, decimals)}*`);
    },
  },

  mybet: {
    section: MARKET,
    usage: "<index>",
    description: "Decrypt one of your bets (private)",
    ephemeralByDefault: true,
    options: [{ name: "index", description: "0 is your first bet", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireMarket(ctx);
      const raw = ctx.args[0];
      if (raw === undefined || !/^\d+$/.test(raw)) throw new UserError(`Usage: \`${ctx.cmd("mybet")} <index>\` — 0 is your first bet.`);
      const { client } = await opportunityClient(ctx);
      const { target, amount } = await getBet(client, address, raw);
      const decimals = await opportunityMarket.getUnderlyingDecimals(address);
      return privateReply(`Bet #${raw}: opportunity *${target}*, amount *${formatUnits(amount, decimals)}*`);
    },
  },

  allbets: {
    section: MARKET,
    usage: "",
    description: "Deployer: decrypt every bet (private)",
    ephemeralByDefault: true,
    options: [],
    async run(ctx) {
      const address = requireMarket(ctx);
      const { client } = await opportunityClient(ctx);
      const bets = await getAllBets(client, address);
      if (bets.length === 0) return privateReply("No bets placed yet.");
      const decimals = await opportunityMarket.getUnderlyingDecimals(address);
      const lines = bets.map((b, i) => `${i + 1}. \`${short(b.bettor)}\` → opportunity *${b.target}*, amount *${formatUnits(b.amount, decimals)}*`);
      return privateReply(`*All bets* (${bets.length}):\n${lines.join("\n")}`);
    },
  },

  analytics: {
    section: MARKET,
    usage: "",
    description: "Deployer: totals and average bets, overall and per opportunity (private)",
    ephemeralByDefault: true,
    options: [],
    async run(ctx) {
      const address = requireMarket(ctx);
      const { client } = await opportunityClient(ctx);
      const stats = await getMarketAnalytics(client, address);
      const decimals = await opportunityMarket.getUnderlyingDecimals(address);
      return privateReply(formatMarketAnalytics(stats, decimals));
    },
  },

  fundrewardpool: simpleMarketWrite({
    usage: "<amount>",
    description: "Deployer: fund the winners' reward pool",
    options: [{ name: "amount", description: "Tokens to fund", required: true }],
    action: async (ctx, client, address) => {
      if (!(Number(ctx.args[0]) > 0)) throw new UserError(`Usage: \`${ctx.cmd("fundrewardpool")} <amount>\``);
      await opportunityMarket.fundRewardPool(client, address, ctx.args[0]);
    },
    done: (ctx) => `✅ Reward pool funded with ${ctx.args[0]} tokens.`,
  }),

  cancelmarket: simpleMarketWrite({
    usage: "",
    description: "Deployer: cancel so everyone can reclaim",
    action: (ctx, client, address) => opportunityMarket.cancelMarket(client, address),
    done: () => "✅ Market cancelled. Backers can reclaim their stakes.",
  }),

  resolve: simpleMarketWrite({
    usage: "<winningOpportunityId>",
    description: "Deployer: declare the winning opportunity",
    options: [{ name: "winner", description: "Winning opportunity ID", required: true, type: "integer" }],
    action: async (ctx, client, address) => {
      const id = parseId(ctx.args[0], `${ctx.cmd("resolve")} <winningOpportunityId>`);
      await opportunityMarket.resolve(client, address, id);
    },
    done: (ctx) => `✅ Market resolved. Winning opportunity: #${ctx.args[0]}.`,
  }),

  revealwinningtotal: simpleMarketWrite({
    usage: "",
    description: "Deployer: publicly reveal the winning total",
    action: (ctx, client, address) => revealAndCompleteWinningTotal(client, address),
    done: (ctx) => `✅ Winning total revealed. Backers can now \`${ctx.cmd("computereward")}\`.`,
  }),

  reclaimstake: simpleMarketWrite({
    usage: "",
    description: "Reclaim your stake after a cancellation (private)",
    privateResult: true,
    action: (ctx, client, address) => opportunityMarket.reclaimStake(client, address),
    done: () => "✅ Stake reclaimed.",
  }),

  computereward: {
    section: MARKET,
    usage: "",
    description: "Work out your reward share and see the amount (private)",
    options: [],
    ephemeralByDefault: true,
    async run(ctx) {
      const address = requireMarket(ctx);
      const { client } = await opportunityClient(ctx);
      await opportunityMarket.computeReward(client, address);
      return privateReply(await rewardComputedText(client, address, ctx.cmd));
    },
  },

  withdraw: withdrawal("stake", "Withdraw your reclaimed stake and see the amount (private)"),
  withdrawreward: withdrawal("reward", "Withdraw your computed reward and see the amount (private)"),
};
