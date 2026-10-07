import { formatEther } from "viem";
import { getChatDAO, getChatModel, getChatCreator, getChatLinker, getChatMarket, getChatGuardWrapper, getRegisteredToken } from "../db.js";
import { ensureGasFunded, getUnderlyingTokenAddress, resolveTokenReference } from "../contracts.js";
import { getAdapter } from "../governance/index.js";
import { walletClientFor } from "../governance/common.js";
import { getOrCreateUserAccount } from "../walletResolver.js";
import { isWalletStoreConfigured } from "../walletStore.js";
import { opportunityWalletClientFor } from "../opportunityMarket/config.js";
import { currentNetwork } from "../networks.js";
import { proposalCreated } from "../proposalPages.js";

/**
 * Shared building blocks for the platform command groups in
 * ./commands/*.js. Mirrors the checks index.js's Telegram handlers make
 * (requireDAO, creator checks, wallet setup), phrased with ctx.cmd() so
 * usage hints read right on each platform.
 */

export const NO_WALLETS = "Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** An error whose message is safe and useful to show the user verbatim. */
export class UserError extends Error {}

export function reply(text, extra = {}) {
  return { text, ...extra };
}

/**
 * The reply after a proposal is created: the public message plus its
 * page link, and the proposer's private edit link as a follow-up only
 * they see (when proposal pages are set up).
 */
export async function proposalReply(ctx, governanceAddress, model, proposalId, text) {
  const page = await proposalCreated({
    network: currentNetwork().id,
    dao: governanceAddress,
    model,
    proposalId,
    platform: ctx.platform,
    userId: ctx.userId,
    cmd: ctx.cmd,
  });
  if (!page) return reply(text);
  return reply(`${text}\n\n📄 ${page.page} - the proposer is adding the details there.`, { privateFollowUp: page.editText });
}

/** A reply only the caller sees - the equivalent of Telegram's DM delivery for sensitive results. */
export function privateReply(text) {
  return { text, ephemeral: true };
}

export function requireDao(ctx) {
  const address = getChatDAO(ctx.chatId, ctx.platform);
  if (!address) {
    throw new UserError(`This channel isn't linked to a DAO yet. Run \`${ctx.cmd("register")} 0xYourGovernanceAddress [model]\` or \`${ctx.cmd("createdao")}\`.`);
  }
  return address;
}

export function requireMarket(ctx) {
  const address = getChatMarket(ctx.chatId, ctx.platform);
  if (!address) {
    throw new UserError(`This channel isn't linked to an Opportunity Market yet. Run \`${ctx.cmd("registermarket")} 0xYourMarketAddress\`, or create one with \`${ctx.cmd("createmarket")} 0xUnderlyingToken\`.`);
  }
  return address;
}

export function requireGuardWrapper(ctx) {
  const address = getChatGuardWrapper(ctx.chatId, ctx.platform);
  if (!address) {
    throw new UserError(`This channel isn't linked to a guard wrapper yet. The DAO's creator can deploy one with \`${ctx.cmd("deployguardwrapper")}\`, or link one with \`${ctx.cmd("registerguardwrapper")} 0xWrapperAddress\`.`);
  }
  return address;
}

/**
 * The DAO, its model and adapter, requiring that the adapter implements
 * `fnName` - the same "does this model have this step" check every
 * model-specific Telegram command makes before doing anything.
 */
export function requireAdapterFn(ctx, fnName, notSupportedMessage) {
  const address = requireDao(ctx);
  const model = getChatModel(ctx.chatId, ctx.platform);
  const adapter = getAdapter(model);
  if (typeof adapter[fnName] !== "function") {
    throw new UserError(notSupportedMessage.replace("{model}", model));
  }
  return { address, model, adapter };
}

export function requireModel(ctx, expected, notSupportedMessage) {
  const address = requireDao(ctx);
  const model = getChatModel(ctx.chatId, ctx.platform);
  if (model !== expected) throw new UserError(notSupportedMessage.replace("{model}", model));
  return { address, model };
}

/** True only for whoever created this channel's DAO through the bot (see db.js's creatorPlatformUserId). */
export function isCreator(ctx) {
  const creator = getChatCreator(ctx.chatId, ctx.platform);
  return creator !== null && creator === String(ctx.userId);
}

export function requireCreator(ctx, message) {
  if (!isCreator(ctx)) throw new UserError(message);
}

/**
 * Whether the caller may (re)link or unlink this channel's DAO. Anyone
 * may link an unlinked channel; after that only whoever linked it, the
 * DAO's creator, or a platform admin.
 */
export function mayManageLink(ctx) {
  if (!getChatDAO(ctx.chatId, ctx.platform)) return true;
  if (ctx.isAdmin === true) return true;
  const me = String(ctx.userId);
  return getChatLinker(ctx.chatId, ctx.platform) === me || getChatCreator(ctx.chatId, ctx.platform) === me;
}

export function parseId(raw, usage) {
  if (!raw || !/^\d+$/.test(raw)) throw new UserError(`Usage: \`${usage}\``);
  return raw;
}

export function parseAmount(raw, usage) {
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0) throw new UserError(`Usage: \`${usage}\``);
  return amount;
}

/** The caller's Monad signing client, gas-funded - what every Telegram write handler builds first. */
export async function userClient(ctx, { forceFullTopup = false } = {}) {
  if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
  const account = await getOrCreateUserAccount(ctx.userId, ctx.platform);
  await ensureGasFunded(account, forceFullTopup);
  return { account, client: walletClientFor(account) };
}

/**
 * The caller's wallet address, creating their wallet if this is their
 * first command - on Discord/Slack there's no legacy derived wallet to
 * fall back to the way Telegram's getUserAddress has.
 */
export async function callerAddress(ctx) {
  if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
  return (await getOrCreateUserAccount(ctx.userId, ctx.platform)).address;
}

/** The caller's Sepolia client for Opportunity Market actions (no Monad gas top-up applies there). */
export async function opportunityClient(ctx) {
  if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
  const account = await getOrCreateUserAccount(ctx.userId, ctx.platform);
  return { account, client: opportunityWalletClientFor(account) };
}

/**
 * Same resolution order as index.js's resolveToken: the DAO's own token
 * when no reference is given, then this channel's registered tickers,
 * then the DAO token's real on-chain symbol.
 */
export async function resolveToken(ctx, governanceAddress, reference) {
  if (!reference) return getUnderlyingTokenAddress(governanceAddress);
  const registered = getRegisteredToken(ctx.chatId, reference, ctx.platform);
  if (registered) return registered;
  return resolveTokenReference(governanceAddress, reference);
}

/** The zero-weight warning Telegram appends after any snapshot-weighted vote. */
export function weightNote(weight, snapshotWhat = "this proposal's snapshot block") {
  if (weight === undefined) return "";
  if (weight === 0n) {
    return `\n\n⚠️ This carried *zero weight* - your tokens likely weren't staked before ${snapshotWhat}. It's recorded, but didn't affect the tally.`;
  }
  return `\nWeight: ${formatEther(weight)}`;
}

/**
 * The common shape: optional one numeric ID, one adapter call signed by
 * the caller, one confirmation line. `usage` is the arg hint, `idLabel`
 * the option description when there is an ID.
 */
export function adapterWrite({ section, models, description, fn, notSupported, idLabel, done }) {
  return {
    section,
    models,
    usage: idLabel ? "<id>" : "",
    description,
    options: idLabel ? [{ name: "id", description: idLabel, required: true, type: "integer" }] : [],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, fn, notSupported);
      const id = idLabel ? parseId(ctx.args[0], `${ctx.cmd(ctx.command)} <id>`) : undefined;
      const { client } = await userClient(ctx);
      const result = idLabel ? await adapter[fn](client, address, id) : await adapter[fn](client, address);
      return reply(done(ctx, id, result));
    },
  };
}
