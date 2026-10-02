import { isAddress, getAddress, parseEther, formatEther } from "viem";
import { walletClient, publicClient } from "../../config.js";
import { explorerAddressLine, isNativeTokenWord, currentNetwork } from "../../networks.js";
import { getChatModel, getChatCreator, registerToken, getRegisteredTokens, getChatMarket, getChatDAO } from "../../db.js";
import { marketSendMode, sendFromMarketWallet, marketWalletBalances } from "../../opportunityMarket/send.js";
import { tipTokens, getTokenBalance, getTokenSymbol, getUnderlyingTokenAddress } from "../../contracts.js";
import { getAdapter } from "../../governance/index.js";
import { hasToken, getDaoInfo } from "../../governance/common.js";
import { isWalletStoreConfigured } from "../../walletStore.js";
import { short } from "../../format.js";
import { UserError, reply, privateReply, requireDao, requireCreator, userClient, resolveToken, callerAddress, opportunityClient, NO_WALLETS } from "../helpers.js";
import { sendNativeSponsored } from "../../gasSponsor.js";

/** Treasury contributions and token movement - ported from index.js. */

async function daoInfo(ctx, address) {
  const model = getChatModel(ctx.chatId, ctx.platform);
  return { model, ...(hasToken(model) ? await getDaoInfo(model, address) : await getAdapter(model).getDaoInfo(address)) };
}

function requireTokenModel(ctx, what) {
  const model = getChatModel(ctx.chatId, ctx.platform);
  if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token - ${what}.`);
  return model;
}

function parseAmountAndRecipient(ctx, name, usageTail) {
  const [amountRaw, recipientRaw, tokenRef] = ctx.args;
  if (!amountRaw || Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0 || !recipientRaw || !isAddress(recipientRaw)) {
    throw new UserError(`Usage: \`${ctx.cmd(name)} <amount> <recipientAddress> [tokenAddressOrTicker]\`${usageTail}`);
  }
  return { amountRaw, recipientRaw, tokenRef };
}

export const TOKEN_COMMANDS = {
  contribute: {
    section: "The DAO",
    usage: "",
    description: "Get the treasury address to donate to (sent privately)",
    ephemeralByDefault: true,
    options: [],
    async run(ctx) {
      const address = requireDao(ctx);
      const { daoName, treasuryAddress } = await daoInfo(ctx, address);
      return privateReply(
        [
          `💰 *Contribute to ${daoName}*`,
          "",
          `Send ${currentNetwork().nativeSymbol} (or any supported token) directly to the treasury:`,
          `\`${treasuryAddress}\``,
          "",
          explorerAddressLine(treasuryAddress),
          "",
          "⚠️ Funds sent here become DAO-controlled — moving them out requires a passed proposal.",
        ].join("\n")
      );
    },
  },

  tip: {
    section: "Tokens",
    usage: "<amount> <recipient> [token]",
    description: "Send tokens from the operator-held supply (creator only)",
    options: [
      { name: "amount", description: "Whole tokens", required: true },
      { name: "recipient", description: "Recipient address", required: true },
      { name: "token", description: "Token address or registered ticker (default: this DAO's token)", required: false },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      requireTokenModel(ctx, "there's nothing to tip");
      if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
      const { amountRaw, recipientRaw, tokenRef } = parseAmountAndRecipient(ctx, "tip", " — sends from tokens minted to the operator wallet when this DAO was created. Creator only.");
      if (!getChatCreator(ctx.chatId, ctx.platform)) {
        throw new UserError("This DAO's creator isn't on record - it was linked with register rather than created through this bot, so tip has no way to know who's authorized.");
      }
      requireCreator(ctx, "Only this DAO's creator can use tip.");
      const tokenAddress = await resolveToken(ctx, address, tokenRef);
      const { hash } = await tipTokens(walletClient, tokenAddress, recipientRaw, amountRaw);
      return reply(`✅ Tipped ${amountRaw} to \`${short(recipientRaw)}\`.\nTx: \`${short(hash)}\``);
    },
  },

  send: {
    section: "Tokens",
    usage: "<amount> <recipient> [token|native|market]",
    description: "Send tokens or native currency you hold (in a market channel: its token or Sepolia ETH)",
    options: [
      { name: "amount", description: "Amount (whole tokens or native currency)", required: true },
      { name: "recipient", description: "Recipient address", required: true },
      { name: "token", description: "Token, ticker, native/MON/ETH/HYPE, or market (default: DAO token, else the market's token)", required: false },
    ],
    async run(ctx) {
      // In an Opportunity Market channel (Sepolia), send the market's token or Sepolia ETH - e.g. a withdrawn stake or reward.
      const market = getChatMarket(ctx.chatId, ctx.platform);
      const mode = await marketSendMode(market, Boolean(getChatDAO(ctx.chatId, ctx.platform)), ctx.args[2], ctx.cmd);
      if (mode) {
        const [amountRaw, recipientRaw] = ctx.args;
        const all = String(amountRaw).toLowerCase() === "all";
        if (!amountRaw || (!all && !(Number(amountRaw) > 0)) || (all && mode.native) || !recipientRaw || !isAddress(recipientRaw)) {
          throw new UserError(`Usage: \`${ctx.cmd("send")} <amount|all> <recipientAddress>\` sends this market's token on Sepolia; add \`ETH\` to send Sepolia ETH (a number, not all).`);
        }
        const { client } = await opportunityClient(ctx);
        const { hash, sent } = await sendFromMarketWallet(client, market, recipientRaw, amountRaw, mode);
        const left = await marketWalletBalances(market, client.account.address);
        return reply(`✅ Sent ${sent} to \`${short(recipientRaw)}\` on Sepolia.\nTx: \`${short(hash)}\`\nYou now hold ${left.token} and ${left.eth}.`);
      }

      const address = requireDao(ctx);
      const { amountRaw, recipientRaw, tokenRef } = parseAmountAndRecipient(ctx, "send", " — add the native symbol (`MON`, `ETH`, `HYPE`) or `native` to send native currency.");
      const isNativeMon = isNativeTokenWord(tokenRef);
      if (!isNativeMon) {
        const model = getChatModel(ctx.chatId, ctx.platform);
        if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token. Try \`${ctx.cmd("send")} ${amountRaw} ${recipientRaw} ${currentNetwork().nativeSymbol}\` to send native currency.`);
      }
      const { client } = await userClient(ctx);
      let hash;
      if (isNativeMon) {
        hash = await sendNativeSponsored(client, getAddress(recipientRaw), parseEther(amountRaw));
        await publicClient.waitForTransactionReceipt({ hash });
      } else {
        const tokenAddress = await resolveToken(ctx, address, tokenRef);
        ({ hash } = await tipTokens(client, tokenAddress, recipientRaw, amountRaw));
      }
      return reply(`✅ Sent ${amountRaw}${isNativeMon ? ` ${currentNetwork().nativeSymbol}` : ""} to \`${short(recipientRaw)}\`.\nTx: \`${short(hash)}\``);
    },
  },

  tokenbalance: {
    section: "Tokens",
    usage: "[token] [address|treasury]",
    description: "Spendable token balance (yours, anyone's, or the treasury's)",
    options: [
      { name: "token", description: "Token address or ticker (default: this DAO's token)", required: false },
      { name: "holder", description: "Address, or 'treasury' (default: you)", required: false },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      const [tokenRef, holderRaw] = ctx.args;
      // "MON" / "ETH" / "HYPE" / "native" asks for the native balance, which every DAO model has.
      const native = tokenRef !== undefined && isNativeTokenWord(tokenRef);
      const model = native ? getChatModel(ctx.chatId, ctx.platform) : requireTokenModel(ctx, "there's no balance to check");
      let holder = holderRaw;
      if (holder?.toLowerCase() === "treasury") {
        holder = (await getDaoInfo(model, address)).treasuryAddress;
      } else if (holder && !isAddress(holder)) {
        throw new UserError("That doesn't look like a valid address (or the word `treasury`).");
      }
      if (!holder) {
        if (!isWalletStoreConfigured()) throw new UserError(`No address given, and wallets aren't set up. Use \`${ctx.cmd("tokenbalance")} [token] 0xSomeAddress|treasury\`.`);
        holder = await callerAddress(ctx);
      }
      const balance = native
        ? `${formatEther(await publicClient.getBalance({ address: holder }))} ${currentNetwork().nativeSymbol}`
        : await getTokenBalance(await resolveToken(ctx, address, tokenRef), holder);
      return reply(`*${short(holder)}*\nBalance: ${balance}`);
    },
  },

  registertoken: {
    section: "Tokens",
    usage: "<ticker> <tokenAddress>",
    description: "Give a token a ticker shortcut (creator only)",
    options: [
      { name: "ticker", description: "Short name, e.g. USDC", required: true },
      { name: "address", description: "Token contract address", required: true },
    ],
    async run(ctx) {
      requireDao(ctx);
      requireCreator(ctx, "Only this DAO's creator can register a token ticker.");
      const [ticker, tokenAddress] = ctx.args;
      if (!ticker || !tokenAddress || !isAddress(tokenAddress) || !/^[A-Za-z0-9]{1,15}$/.test(ticker)) {
        throw new UserError(`Usage: \`${ctx.cmd("registertoken")} <ticker> <tokenAddress>\` — e.g. \`USDC 0x...\``);
      }
      let symbol;
      try {
        symbol = await getTokenSymbol(tokenAddress);
      } catch {
        throw new UserError("Couldn't read that as a token - double check it's a real, deployed ERC20 address.");
      }
      registerToken(ctx.chatId, ticker, tokenAddress, ctx.platform);
      return reply(`✅ \`${ticker.toUpperCase()}\` now resolves to \`${short(tokenAddress)}\` (on-chain symbol: ${symbol}).`);
    },
  },

  treasuryassets: {
    section: "Tokens",
    usage: "",
    description: "Every token the treasury holds",
    options: [],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = requireTokenModel(ctx, "there are no token assets to list");
      const { treasuryAddress } = await getDaoInfo(model, address);
      const ownTokenAddress = await getUnderlyingTokenAddress(address);
      const entries = [[await getTokenSymbol(ownTokenAddress), ownTokenAddress], ...Object.entries(getRegisteredTokens(ctx.chatId, ctx.platform))];
      const lines = await Promise.all(
        entries.map(async ([symbol, tokenAddress]) => {
          try {
            return `${symbol}: ${await getTokenBalance(tokenAddress, treasuryAddress)}`;
          } catch {
            return `${symbol}: couldn't read balance`;
          }
        })
      );
      return reply(`*Treasury assets* (\`${short(treasuryAddress)}\`)\n${lines.join("\n")}`);
    },
  },
};
