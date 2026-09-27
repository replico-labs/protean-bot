import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { isAddress, getAddress, parseEther, formatUnits, encodeFunctionData } from "viem";
import { BOT_TOKEN, monadTestnet, publicClient, SORTITION_RANDOMNESS_SOURCE, SWITCHBOARD_ORACLE_ADAPTER, walletClient } from "./config.js";
import {
  registerChat,
  getChatDAO,
  getChatModel,
  getChatCreator,
  registerToken,
  getRegisteredToken,
  getRegisteredTokens,
  unregisterChat,
  registerDistributor,
  getChatDistributor,
  registerNftWrapper,
  getChatNftWrapper,
  registerGuardWrapper,
  getChatGuardWrapper,
  registerMarket,
  getChatMarket,
  unregisterMarket,
} from "./db.js";
import {
  getProposalCount,
  getTreasuryBalance,
  getVotingPower,
  getDistributorInfo,
  hasAlreadyClaimed,
  distributeWelcomeGrant,
  createDaoOnChain,
  ensureGasFunded,
  formatEther,
  getDaoCreator,
  resolveTokenReference,
  tipTokens,
  getTokenBalance,
  getTokenSymbol,
  getUnderlyingTokenAddress,
  deployWelcomeDistributor,
  deployNftWrapper,
} from "./contracts.js";
import { getAdapter, SUPPORTED_MODELS } from "./governance/index.js";
import { createDAO as createQuadraticDAO } from "./governance/quadratic.js";
import { createDAO as createLiquidDAO } from "./governance/liquid.js";
import { createDAO as createOptimisticDAO } from "./governance/optimistic.js";
import { createDAO as createDelegateDAO } from "./governance/delegate.js";
import { createDAO as createBoardDAO } from "./governance/board.js";
import { createDAO as createSortitionDAO, settleSortitionRandomness } from "./governance/sortition.js";
import { createDAO as createConvictionDAO } from "./governance/conviction.js";
import { createDAO as createSowellianDAO, deployChainlinkOracle } from "./governance/sowellian.js";
import { createDAO as createDecisionMarketsDAO, getProposalVaults, splitTokens, mergeTokens, redeemTokens, unwrapWmon } from "./governance/decisionMarkets.js";
import {
  stakeTokens,
  unstakeTokens,
  walletClientFor,
  getGovernanceTokenAddress,
  getDaoInfo,
  hasToken,
  PROPOSAL_STATE_LABELS,
} from "./governance/common.js";
import { short, stateLine, formatDate } from "./format.js";
import { deriveUserWallet, isWalletDerivationConfigured } from "./wallet.js";
import { getOrCreateUserAccount, getUserAddress } from "./walletResolver.js";
import { findWalletRecord, createWalletRecord, isWalletStoreConfigured } from "./walletStore.js";
import { opportunityWalletClientFor, isOpportunityMarketConfigured } from "./opportunityMarket/config.js";
import * as opportunityMarket from "./opportunityMarket/market.js";
import * as guardWrapper from "./wrapper.js";
import { listActionsForModel, getAction, encodeAction } from "./actionLibrary.js";
import { startEventListener } from "./eventListener.js";
import { back as opportunityBack } from "./opportunityMarket/encryptedBet.js";
import { getBalance as opportunityGetBalance, getBet as opportunityGetBet, getAllBets as opportunityGetAllBets, getMarketAnalytics as opportunityGetAnalytics } from "./opportunityMarket/decrypt.js";
import { revealAndCompleteWinningTotal, revealAndCompleteWithdrawal } from "./opportunityMarket/publicReveal.js";

const bot = new Bot(BOT_TOKEN);

/**
 * Without this, grammY's default bot.start() processes every single
 * update - from every chat, every user - strictly one at a time. A
 * slow operation (FHE encryption + gateway round-trip + on-chain
 * confirmation, routinely the slowest thing this bot does) blocks
 * every other user's command globally until it finishes - observed
 * directly: a second user's command appeared to "just pause" while
 * an unrelated Opportunity Market action was still running.
 *
 * sequentialize(), keyed per Telegram user id, is what makes it safe
 * to then run updates concurrently via the runner below: different
 * users' commands can now genuinely run at the same time, while each
 * individual user's own updates still process in strict order - this
 * matters because pendingBackRequests (the /back DM flow) and each
 * user's own wallet nonce sequencing are both per-user shared state
 * that would otherwise race against a second update from that same
 * user arriving before the first one finishes.
 */
bot.use(sequentialize((ctx) => ctx.from?.id?.toString()));

/**
 * Tracks users mid-way through a privacy-preserving /back flow: they
 * ran bare `/back` in a group, and the bot is now waiting for their
 * next DM to contain the actual opportunity id and amount. Keyed by
 * Telegram user id. In-memory only, not persisted - an abandoned flow
 * (user never replies, or the bot restarts) just quietly expires
 * rather than causing any harm; a later /back attempt simply
 * overwrites whatever was pending.
 */
const pendingBackRequests = new Map();


console.log("Protean bot starting (long polling)...");

/** Requires the chat to have a linked DAO; replies and returns null if not. */
async function requireDAO(ctx) {
  const address = getChatDAO(ctx.chat.id);
  if (!address) {
    await ctx.reply(
      "This group isn't linked to a DAO yet. An admin can run:\n`/register 0xYourGovernanceAddress`",
      { parse_mode: "Markdown" }
    );
    return null;
  }
  return address;
}

/**
 * Resolves a token reference for this chat: checks the chat's own
 * registered tickers first (registerToken/getRegisteredToken in db.js -
 * for any token the community cares about, not just the DAO's own),
 * then falls back to contracts.js's resolveTokenReference, which
 * matches against the DAO's own token's real on-chain symbol(). An
 * empty/missing reference defaults straight to the DAO's own
 * underlying token, without touching the registry at all.
 */
async function resolveToken(ctx, governanceAddress, reference) {
  if (!reference) return getUnderlyingTokenAddress(governanceAddress);

  const registered = getRegisteredToken(ctx.chat.id, reference);
  if (registered) return registered;

  return resolveTokenReference(governanceAddress, reference);
}

/**
 * Delivers a privacy-sensitive result (bet contents, balances, reward
 * amounts) via DM instead of the group chat, editing `statusMsg` down
 * to a generic, content-free acknowledgment in the group. Unlike
 * /contribute's DM pattern, this deliberately does NOT fall back to
 * posting the real message in the group if the DM fails - that would
 * defeat the entire point for genuinely sensitive content. Instead,
 * the group is told to start a DM with the bot first, and the
 * sensitive message itself is never posted anywhere but the DM.
 */
/**
 * Sends `lines` as one or more messages, splitting between lines
 * (never mid-line) whenever a running chunk would exceed Telegram's
 * real 4096-character limit. Built specifically for /help: with
 * intuitive, fuller explanations per command, a chat with a model like
 * Sowellian (the longest single model block) AND a linked Opportunity
 * Market can genuinely exceed the limit in one combined message -
 * confirmed directly by measuring the actual worst case, not assumed.
 * A fixed safety margin below the real limit (rather than the exact
 * number) covers Markdown formatting characters Telegram counts
 * differently than raw string length.
 */
async function replyChunked(ctx, lines, options = {}) {
  const MAX_CHUNK_CHARS = 3800;
  let chunk = [];
  let chunkLength = 0;

  for (const line of lines) {
    const lineLength = line.length + 1; // +1 for the newline that'll join it
    if (chunk.length > 0 && chunkLength + lineLength > MAX_CHUNK_CHARS) {
      await ctx.reply(chunk.join("\n"), options);
      chunk = [];
      chunkLength = 0;
    }
    chunk.push(line);
    chunkLength += lineLength;
  }
  if (chunk.length > 0) {
    await ctx.reply(chunk.join("\n"), options);
  }
}

async function deliverPrivately(ctx, statusMsg, sensitiveMessage, groupAckText) {
  try {
    await ctx.api.sendMessage(ctx.from.id, sensitiveMessage, { parse_mode: "Markdown" });
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `📬 ${groupAckText}`);
  } catch (dmErr) {
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "Couldn't DM you - please start a chat with me directly first (search for this bot and hit Start), then run this command again. Nothing sensitive is posted here."
    );
  }
}

/**
 * Requires the chat to have a linked OpportunityMarket; replies and
 * returns null if not. Deliberately separate from requireDAO - a chat
 * can have both a DAO and a market linked at once, these are
 * independent systems.
 */
async function requireMarket(ctx) {
  const address = getChatMarket(ctx.chat.id);
  if (!address) {
    await ctx.reply(
      "This group isn't linked to an Opportunity Market yet. An admin can run:\n`/registermarket 0xYourMarketAddress`\n\nOr create a new one with `/createmarket 0xUnderlyingToken`.",
      { parse_mode: "Markdown" }
    );
    return null;
  }
  return address;
}

async function requireGuardWrapper(ctx) {
  const address = getChatGuardWrapper(ctx.chat.id);
  if (!address) {
    await ctx.reply(
      "This group isn't linked to a guard wrapper yet. The DAO's creator can deploy one with `/deployguardwrapper`, or link an existing one with `/registerguardwrapper 0xYourWrapperAddress`.",
      { parse_mode: "Markdown" }
    );
    return null;
  }
  return address;
}

/*//////////////////////////////////////////////////////////////
                            /start, /help
//////////////////////////////////////////////////////////////*/

bot.command("start", (ctx) =>
  ctx.reply("👋 I'm Protean — I connect this chat to an on-chain DAO.\n\nRun /help to see what I can do.")
);

/**
 * Per-model DAO-lifecycle command block. Deliberately NOT derived from a
 * pure `typeof adapter.propose === "function"` check - several adapters
 * export propose/vote/queue/cancel that intentionally throw (see each
 * adapter's own module-level note for why), so existence alone can't
 * tell "this works" from "this exists only to redirect you elsewhere."
 * Each entry here reflects exactly what actually works for that model,
 * cross-checked against the real adapters, not assumed.
 */
const MODEL_HELP_BLOCKS = {
  tokenWeighted: [
    "/propose `<target> <value> <data> <description>` — the main way to make something happen: propose an on-chain action (e.g. sending funds) for the DAO to vote on",
    "/vote `<id> for|against|abstain [reason]` — cast your vote on a proposal that's currently open, weighted by your staked balance",
    "/queue `<id>` — once a proposal has passed, this starts its timelock countdown before it can actually run",
    "/execute `<id>` — after the timelock clears, this actually carries out the proposal's action",
    "/cancel `<id>` — pull back your own proposal before anyone executes it",
  ],
  quadratic: [
    "/propose `<target> <value> <data> <description>` — propose an on-chain action for the DAO to vote on",
    "/vote `<id> for|against|abstain` — cast your vote; your weight is the square root of your staked balance, so whales matter less here than in a plain token vote",
    "/queue `<id>` — start the timelock countdown on a passed proposal",
    "/execute `<id>` — carry out the proposal once its timelock has cleared",
    "/cancel `<id>` — withdraw your own proposal before execution",
  ],
  liquid: [
    "/propose `<target> <value> <data> <description>` — propose an on-chain action for the DAO to vote on",
    "/vote `<id> for|against|abstain` — cast your vote directly, even if you've delegated (your delegate's vote doesn't override yours)",
    "/queue `<id>` — start the timelock countdown on a passed proposal",
    "/execute `<id>` — carry out the proposal once its timelock has cleared",
    "/cancel `<id>` — withdraw your own proposal before execution",
    "/delegate `<address>` — too busy to vote on everything? Hand your voting power to someone you trust — you can still vote yourself any time",
    "/undelegate — take your voting power back from whoever you delegated to",
  ],
  optimistic: [
    "/propose `<target> <value> <data> <description>` — propose an action that passes automatically after its challenge window, unless someone disputes it",
    "/challenge `<id>` — think a proposal shouldn't just sail through? Dispute it here, which forces it into an actual vote instead",
    "/vote `<id> for|against|abstain` — only usable once a proposal has been challenged — settles the dispute",
    "/queue `<id>` — finalizes a proposal once its window closes, whether it was challenged or not",
    "/execute `<id>` — carry out a queued proposal",
    "/cancel `<id>` — withdraw your own proposal before execution",
  ],
  delegate: [
    "/propose `<target> <value> <data> <description>` — council members only: propose an on-chain action",
    "/vote `<id> for|against|abstain` — council members only: cast a vote",
    "/queue `<id>` — start the timelock countdown on a passed proposal",
    "/execute `<id>` — carry out the proposal once its timelock has cleared",
    "/cancel `<id>` — withdraw your own proposal before execution",
    "/council — see who's currently seated",
    "/startelection — open up a new election for council seats",
    "/declarecandidacy `<electionId>` — put your own name forward in an open election",
    "/voteinelection `<electionId> <candidate...>` — vote for one or more candidates",
    "/finalizeelection `<electionId>` — close voting and seat whoever won",
    "/initiaterecall `<address>` — think a sitting council member should be removed early? Start a vote on it",
    "/voterecall `<recallId> for|against|abstain` — vote on an active recall",
    "/finalizerecall `<recallId>` — close the recall vote and remove the member if it passed",
  ],
  board: [
    "/propose `<target> <value> <data> <description>` — propose an on-chain action for the signers to approve",
    "/confirm `<id>` — add your signature as one of the required approvals",
    "/revoke `<id>` — change your mind and pull your signature back",
    "/execute `<id>` — once enough signers have confirmed, run the proposal's action",
    "/cancel `<id>` — withdraw your own proposal before execution",
  ],
  sortition: [
    "/propose `<target> <value> <data> <description>` — anyone who meets the eligibility threshold can propose an action",
    "/vote `<id> for|against|abstain` — council members only: cast a vote",
    "/queue `<id>` — start the timelock countdown on a passed proposal",
    "/execute `<id>` — carry out the proposal once its timelock has cleared",
    "/cancel `<id>` — withdraw your own proposal before execution",
    "/council — see who's currently seated",
    "/registereligible — want a shot at being randomly picked for the next council? Opt in here",
    "/withdraweligibility — take yourself out of the running",
    "/startsortition — kick off a new random council draw (requests randomness from the configured provider)",
    "/settlesortition — once the randomness provider's delay has passed, submit the result on-chain — anyone can run this, not just admins",
    "/finalizesortition — draw the actual new council once randomness has settled",
  ],
  conviction: [
    "/propose `<target> <value> <data> <description>` — propose an on-chain action for the DAO to back",
    "/support `<id>` — commit your entire staked balance behind a proposal; your influence on it grows the longer you keep it committed",
    "/withdrawsupport — stop backing whatever proposal you're currently supporting",
    "/mysupport — check which proposal (if any) you're currently backing",
    "/queue `<id>` — once accumulated support clears the threshold, start the timelock",
    "/execute `<id>` — carry out the proposal once its timelock has cleared",
    "/cancel `<id>` — withdraw your own proposal before execution",
  ],
  sowellian: [
    "/deploychainlinkoracle `<chainlinkFeedAddress>` — one-time setup: wraps a real Chainlink price feed so oracle-track proposals can check it",
    "/proposecriteria `<target> <value> <data> <oracle|human> <oracleAddress|switchboard|-> <oracleSelector|-> <targetValue> <min|max> <measurementPeriod> <description>` — propose an action with a fixed, upfront success condition — checked automatically by an oracle, or resolved by a human afterward",
    "/castapprovalvote `<id> for|against|abstain` — vote on whether this proposal is even worth opening up for betting",
    "/finalizeapproval `<id>` — close the approval vote and open the betting market if it passed",
    "/takeposition `<id> yes|no <amount>` — put real money behind whether you think the outcome will succeed or fail",
    "/execute `<id>` — once betting closes, run the proposal's actual action",
    "/resolveviaoracle `<id>` — for oracle-track proposals: reads the configured oracle and settles the outcome automatically",
    "/proposeresolution `<id> success|failure` — for human-track proposals: state what you believe actually happened (backed by a bond)",
    "/challengeresolution `<id>` — think a proposed resolution is wrong? Dispute it here to force a full vote",
    "/finalizeunchallenged `<id>` — nobody disputed the resolution within the window? Lock it in",
    "/castadjudicationvote `<id> success|failure` — vote on the true outcome of a challenged resolution",
    "/finalizeadjudication `<id>` — close the adjudication vote and settle who was right",
    "/claimposition `<id>` — collect your payout if you backed the side that actually won",
  ],
  decisionMarkets: [
    "/proposemarket `<target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description>` — propose an action and seed two live markets (pass vs. fail) that will decide its fate by price",
    "/split `<id> base|quote <amount>` — convert real tokens into matched pass/fail conditional tokens, so you have something to actually trade",
    "/trade `<id> pass|fail base|quote <amountIn> <minAmountOut>` — put your belief where your money is: trade on whichever side you think will win",
    "/merge `<id> base|quote <amount>` — changed your mind before resolution? Combine matched conditional tokens back into the real asset",
    "/finalizeproposal `<id>` — once trading closes, compare both markets' prices and lock in the outcome",
    "/redeem `<id> base|quote` — after resolution, cash in your winning-side conditional tokens for the real thing",
    "/unwrap `<amount>` — got WMON from a redemption? Convert it back into native MON (optional — only if you want MON specifically)",
    "/execute `<id>` — run a passed proposal's actual action",
    "/cancel `<id>` — withdraw your own proposal before execution",
    "/reclaimliquidity `<id>` — proposer only: get back the liquidity you originally seeded, once resolved",
  ],
};

bot.command("help", async (ctx) => {
  const lines = [
    "*Setup*",
    "/createdao `<name> <symbol> <initialSupply> <maxSupply> [model]` — the main \"spin up a new DAO\" command: deploys a token, treasury, and governance contract, all linked to this chat. Models: " + SUPPORTED_MODELS.filter((m) => m !== "board").join(", "),
    "/createboarddao `<name> <signer1> <signer2> ...` — for a Board (multisig) DAO specifically — no token at all, so it's a separate command",
    "/register `<governance_address> [model]` — already have a DAO deployed elsewhere? Link it to this chat instead of creating a new one (admin)",
    "/unregister — unlink whatever DAO is connected here (admin) — doesn't touch the DAO itself, just this chat's connection to it",
    "/deploywelcomedistributor `<amountPerClaim> <distributionCap>` — solves \"everyone's tokens are stuck in the operator wallet\": deploys a contract new members can claim from (creator only)",
    "/deploynftwrapper — one per DAO: deploys the contract that lets this DAO's treasury participate in NFT marketplaces like OpenSea (creator only)",
    "/setdistributor `<address>` — link an already-deployed welcome distributor so /claim actually works (admin)",
    "",
    "*Your wallet*",
    "/wallet — show your wallet address (created automatically the first time you need one — no setup required)",
    "/migratewallet — used this bot back when it derived wallets from a shared seed? Move your funds to the new, individually-encrypted system",
  ];

  const daoAddress = getChatDAO(ctx.chat.id);
  if (daoAddress) {
    const model = getChatModel(ctx.chat.id);
    lines.push(
      "",
      `*DAO info* (this group's DAO uses ${model} governance)`,
      "/dao — DAO name, token, treasury, and full governance config in one place",
      "/treasury — current treasury balance",
      "/contribute — want to donate? Get the treasury's address sent to you privately",
      "/balance `[address]` — your (or anyone's) staked voting power — different from your raw token balance",
      "/tokenbalance `[tokenAddressOrTicker] [address|treasury]` — your (or anyone's) actual, spendable token balance. No args: your own balance of this DAO's token. Add `treasury` to check the DAO's own holdings.",
      "/treasuryassets — every token the treasury holds, all at once, not just this DAO's own",
      "/registertoken `<ticker> <tokenAddress>` — teach the bot a shortcut so `/tip`/`/send`/`/tokenbalance` can use a ticker instead of a raw address (creator only)",
      "/tip `<amount> <recipient> [tokenAddressOrTicker]` — distribute tokens from the DAO's own operator-held supply (creator only) — this is how newly-created tokens actually reach people",
      "/send `<amount> <recipient> [tokenAddressOrTicker]` — send tokens YOU personally hold to anyone, no restrictions — add `MON` at the end to send native currency instead of a token",
      "/proposals — see every proposal this DAO has, with current status",
      "/proposal `<id>` — full detail on one specific proposal"
    );
    if (hasToken(model)) {
      lines.push(
        "/stake `<amount>` — convert raw tokens into voting power",
        "/unstake `<amount>` — convert voting power back into raw, transferable tokens"
      );
    }
    lines.push("", "*Proposals & actions for this DAO*", ...(MODEL_HELP_BLOCKS[model] ?? ["No commands known for this model."]));
  } else {
    lines.push("", "_This group isn't linked to a DAO yet - run /register or /createdao to see DAO commands here._");
  }

  const marketAddress = getChatMarket(ctx.chat.id);
  if (marketAddress) {
    lines.push(
      "",
      "*Opportunity Market* (linked to this group — runs on Sepolia, separate from everything above)",
      "/listopportunity `<metadataURI>` — add something people can confidentially back",
      "/deposit `<amount>` — put underlying tokens into the market (this part is public; what you do with it after isn't)",
      "/back — the core confidential action: run it bare and the bot DMs you to collect your opportunity + amount privately, so neither ever appears in this chat",
      "/mybalance — check your own confidential balance, sent to you privately",
      "/mybet `<index>` — decrypt one of your own bets (0 is your first), sent to you privately",
      "/reclaimstake — get your stake back (after a cancelled market), sent to you privately",
      "/computereward — work out your share of the reward pool once resolved, sent to you privately",
      "/withdraw — withdraw your reclaimed stake, sent to you privately",
      "/withdrawreward — withdraw your computed reward, sent to you privately",
      "/fundrewardpool `<amount>` — deployer only: funds what backers of the winning opportunity get paid from",
      "/resolve `<winningOpportunityId>` — deployer only: declares which opportunity turned out to be real",
      "/cancelmarket — deployer only: cancels the market so everyone can reclaim their stake",
      "/revealwinningtotal — deployer only, but public on purpose: everyone needs this number to compute their own reward",
      "/allbets — deployer only: decrypts every single bet at once, sent to you privately",
      "/analytics — deployer only: total staked and backer count per opportunity, sent to you privately"
    );
  } else {
    lines.push(
      "",
      "_No Opportunity Market linked - /registermarket `<address>` or /createmarket `<underlyingToken>` to link one, /unregistermarket to unlink (deployer only)._"
    );
  }

  const guardWrapperAddress = getChatGuardWrapper(ctx.chat.id);
  if (guardWrapperAddress) {
    lines.push(
      "",
      "*Guard Wrapper* (linked to this group)",
      "/guardwrapper — current signers, required confirmations, and tenure status",
      "/instruction `<id>` — full detail on one instruction, including its raw calldata",
      "/confirminstruction `<id>` — signers only: confirm a pending instruction, executes automatically once enough do",
      "/rejectinstruction `<id>` — signers only: permanently cancel an instruction once enough signers agree",
      "/revokeconfirmation `<id>` — withdraw your own earlier confirmation before execution",
      "/handovertowrapper `<wrapperAddress>` — creator only: computes the proposals that hand Treasury and token-minting control to a wrapper, sent to you privately"
    );
  } else {
    lines.push(
      "",
      "_No guard wrapper linked - /deployguardwrapper `<requiredApprovals> <tenureLengthSeconds> <signer...>` to deploy one, or /registerguardwrapper `<address>` to link an existing one (creator only)._"
    );
  }

  lines.push("", "*Welcome tokens*", "/claim — claim your welcome tokens");

  await replyChunked(ctx, lines, { parse_mode: "Markdown" });
});

/*//////////////////////////////////////////////////////////////
                            /createdao
//////////////////////////////////////////////////////////////*/

// Models reachable through /createdao itself - Board is deliberately
// excluded, since its real createDAO signature has no symbol/supply at
// all and would make this command's parsing ambiguous either way - see
// /createboarddao instead, matching the same "genuinely different shape
// gets its own command" precedent already used for /proposecriteria and
// /proposemarket.
const CREATE_DAO_FUNCTIONS = {
  tokenWeighted: (name, symbol, initialSupply, maxSupply) => createDaoOnChain(name, symbol, initialSupply, maxSupply),
  quadratic: (name, symbol, initialSupply, maxSupply) => createQuadraticDAO(name, symbol, initialSupply, maxSupply),
  liquid: (name, symbol, initialSupply, maxSupply) => createLiquidDAO(name, symbol, initialSupply, maxSupply),
  optimistic: (name, symbol, initialSupply, maxSupply) => createOptimisticDAO(name, symbol, initialSupply, maxSupply),
  conviction: (name, symbol, initialSupply, maxSupply) => createConvictionDAO(name, symbol, initialSupply, maxSupply),
  sowellian: (name, symbol, initialSupply, maxSupply) => createSowellianDAO(name, symbol, initialSupply, maxSupply),
  decisionMarkets: (name, symbol, initialSupply, maxSupply) => createDecisionMarketsDAO(name, symbol, initialSupply, maxSupply),
  // These two need extra args beyond the standard four - handled explicitly below, not through this simple table.
  delegate: (name, symbol, initialSupply, maxSupply, extra) => createDelegateDAO(name, symbol, initialSupply, maxSupply, extra.council),
  sortition: (name, symbol, initialSupply, maxSupply, extra) =>
    createSortitionDAO(name, symbol, initialSupply, maxSupply, extra.randomnessSource, extra.council),
};

bot.command("createdao", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) ?? [];

  if (args.length < 4) {
    await ctx.reply(
      [
        "Usage: `/createdao <name> <symbol> <initialSupply> <maxSupply> [model] [network] [extra...]`",
        "",
        "Example: `/createdao ArkDAO ARK 1000000 10000000`",
        "Example (quadratic): `/createdao ArkDAO ARK 1000000 10000000 quadratic`",
        "Example (delegate, needs a starting council): `/createdao ArkDAO ARK 1000000 10000000 delegate 0xA... 0xB... 0xC...`",
        "Example (sortition, needs a starting council - randomness source is configured by the bot admin): `/createdao ArkDAO ARK 1000000 10000000 sortition 0xA... 0xB... 0xC...`",
        "",
        `Models: ${Object.keys(CREATE_DAO_FUNCTIONS).join(", ")} (defaults to tokenWeighted). Board has no token at all - use /createboarddao instead.`,
        "",
        "Network can go anywhere after the model (`monad`, `hyperliquid`, or `base`) - only `monad` is actually live right now, the others are recognized but not deployable yet.",
        "",
        "⚠️ Name and symbol must be single words (no spaces) for now.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const [name, symbol, initialSupplyStr, maxSupplyStr, modelArg, ...restArgs] = args;
  const model = modelArg || "tokenWeighted";
  const initialSupply = Number(initialSupplyStr);
  const maxSupply = Number(maxSupplyStr);

  // Network is detected anywhere in the trailing args, not a fixed
  // position - a network name (a plain word) can never collide with a
  // council address (always 0x-prefixed hex), so this is safe
  // regardless of how many council addresses follow it. Only "monad"
  // is actually deployable right now; Hyperliquid and Base are
  // recognized and rejected with a clear reason, not silently ignored,
  // so this same syntax keeps working once either goes live without
  // another command-format change.
  const KNOWN_NETWORKS = ["monad", "hyperliquid", "base"];
  let network = "monad";
  let rest = restArgs;
  const networkIndex = restArgs.findIndex((arg) => KNOWN_NETWORKS.includes(arg.toLowerCase()));
  if (networkIndex !== -1) {
    network = restArgs[networkIndex].toLowerCase();
    rest = [...restArgs.slice(0, networkIndex), ...restArgs.slice(networkIndex + 1)];
  }
  if (network !== "monad") {
    await ctx.reply(`"${network}" isn't deployed yet - only Monad is available right now. Your DAO will need to wait until it's live there.`);
    return;
  }

  if (!Number.isFinite(initialSupply) || !Number.isFinite(maxSupply) || initialSupply <= 0 || maxSupply <= 0) {
    await ctx.reply("Initial supply and max supply must be positive numbers.");
    return;
  }
  if (initialSupply > maxSupply) {
    await ctx.reply("Initial supply can't exceed max supply.");
    return;
  }

  const createFn = CREATE_DAO_FUNCTIONS[model];
  if (!createFn) {
    await ctx.reply(
      model === "board"
        ? "Board has no token at all - use `/createboarddao <name> <signer1> <signer2> ...` instead."
        : `Unknown model "${model}". Supported: ${Object.keys(CREATE_DAO_FUNCTIONS).join(", ")}, board (via /createboarddao)`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  let extra = {};
  if (model === "delegate") {
    if (rest.length === 0 || !rest.every((s) => isAddress(s, { strict: false }))) {
      await ctx.reply("Delegate needs a starting council: `/createdao <name> <symbol> <initialSupply> <maxSupply> delegate <address...>`", { parse_mode: "Markdown" });
      return;
    }
    extra = { council: rest };
  } else if (model === "sortition") {
    if (!SORTITION_RANDOMNESS_SOURCE) {
      await ctx.reply("This bot has no randomness source configured yet - ask an admin to set SORTITION_RANDOMNESS_SOURCE.");
      return;
    }
    if (rest.length === 0 || !rest.every((s) => isAddress(s, { strict: false }))) {
      await ctx.reply("Sortition needs a starting council: `/createdao <name> <symbol> <initialSupply> <maxSupply> sortition <address...>`", { parse_mode: "Markdown" });
      return;
    }
    extra = { randomnessSource: SORTITION_RANDOMNESS_SOURCE, council: rest };
  }

  const statusMsg = await ctx.reply("⏳ Creating DAO on-chain — this takes a moment…");

  try {
    const result = await createFn(name, symbol, initialSupply, maxSupply, extra);

    // Auto-link this chat to the new DAO, saving a manual /register step.
    registerChat(ctx.chat.id, result.governance, model, "telegram", ctx.from.id, network);

    const lines = [
      `✅ *${name}* (${model}) created and linked to this group.`,
      "",
      `Governance: \`${short(result.governance)}\``,
      hasToken(model) ? `Token (staking wrapper): \`${short(result.governanceToken)}\`` : null,
      hasToken(model) ? `Underlying token: \`${short(result.underlyingToken)}\`` : null,
      `Treasury: \`${short(result.treasury)}\``,
      "",
      `⚠️ The entire initial supply (${initialSupply} ${symbol}) is currently held by the bot's operator wallet, not any individual — this is a temporary shortcut until DAO creation moves to protean-connect. Someone will need to receive and distribute it manually for now.`,
    ].filter(Boolean);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, lines.join("\n"), {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't create the DAO: ${err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                          /createboarddao
//////////////////////////////////////////////////////////////*/

bot.command("createboarddao", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) ?? [];

  if (args.length < 2) {
    await ctx.reply(
      [
        "Usage: `/createboarddao <name> <signer1> <signer2> ...`",
        "",
        "Example: `/createboarddao ArkBoard 0xAaa... 0xBbb... 0xCcc...`",
        "",
        "⚠️ Board has no token at all - signers approve directly. Name must be a single word for now.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const [name, ...signers] = args;
  if (!signers.every((s) => isAddress(s, { strict: false }))) {
    await ctx.reply("All signer addresses must be valid.");
    return;
  }

  const statusMsg = await ctx.reply("⏳ Creating DAO on-chain — this takes a moment…");

  try {
    const result = await createBoardDAO(name, signers);
    registerChat(ctx.chat.id, result.governance, "board", "telegram", ctx.from.id);

    const lines = [
      `✅ *${name}* (board) created and linked to this group.`,
      "",
      `Governance: \`${short(result.governance)}\``,
      `Treasury: \`${short(result.treasury)}\``,
      `Signers: ${signers.length}`,
    ];

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't create the DAO: ${err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /register
//////////////////////////////////////////////////////////////*/

bot.command("register", async (ctx) => {
  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const [address, modelRaw] = args;
  const model = modelRaw || "tokenWeighted";

  if (!address || !isAddress(address)) {
    await ctx.reply(
      `Usage: \`/register 0xYourGovernanceAddress [model]\`\n\nSupported models: ${SUPPORTED_MODELS.join(", ")} (defaults to tokenWeighted if omitted)`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (!SUPPORTED_MODELS.includes(model)) {
    await ctx.reply(`Unknown model "${model}". Supported: ${SUPPORTED_MODELS.join(", ")}`);
    return;
  }

  try {
    // Sanity check: does this actually look like a governance contract
    // of the claimed model? A cheap read that only a real deployment of
    // that specific model will answer.
    getAdapter(model); // throws if model isn't registered - already validated above, but cheap to keep
    await getGovernanceTokenAddress(model, address);
  } catch (err) {
    await ctx.reply(
      `Couldn't read a "${model}" DAO at that address on ${monadTestnet.name}. Double-check the address and model.`
    );
    return;
  }

  registerChat(ctx.chat.id, address, model);
  await ctx.reply(`✅ This group is now linked to the ${model} DAO at \`${short(address)}\`.`, {
    parse_mode: "Markdown",
  });
});

bot.command("unregister", async (ctx) => {
  unregisterChat(ctx.chat.id);
  await ctx.reply("Unlinked. Run /register to link a DAO again.");
});

/*//////////////////////////////////////////////////////////////
                    /deploywelcomedistributor
//////////////////////////////////////////////////////////////*/

bot.command("deploywelcomedistributor", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(`This DAO uses ${model} governance, which has no token - there's nothing to distribute.`);
    return;
  }
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const chatCreator = getChatCreator(ctx.chat.id);
  if (!chatCreator || String(ctx.from.id) !== chatCreator) {
    await ctx.reply("Only this DAO's creator can deploy a welcome distributor.");
    return;
  }

  const parts = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  const [amountPerClaimRaw, distributionCapRaw] = parts;
  const amountPerClaim = Number(amountPerClaimRaw);
  const distributionCap = Number(distributionCapRaw);

  if (!amountPerClaimRaw || Number.isNaN(amountPerClaim) || amountPerClaim <= 0 || !distributionCapRaw || Number.isNaN(distributionCap) || distributionCap <= 0) {
    await ctx.reply(
      "Usage: `/deploywelcomedistributor <amountPerClaim> <distributionCap>`\n\nDeploys a fresh distributor for this DAO's own token - one claim per address, up to the cap. Only the DAO's creator can run this.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  if (distributionCap < amountPerClaim) {
    await ctx.reply("The distribution cap has to be at least as large as the amount per claim, or nobody could ever claim anything.");
    return;
  }

  const statusMsg = await ctx.reply("⏳ Deploying a new welcome distributor…");

  try {
    const tokenAddress = await getUnderlyingTokenAddress(address);
    const { distributorAddress } = await deployWelcomeDistributor(walletClient, tokenAddress, address, amountPerClaim, distributionCap);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Deployed at \`${short(distributorAddress)}\`.\n\nTwo steps left before it's live:\n1. Send it enough of this DAO's token to cover claims (up to ${distributionCap} total)\n2. Run \`/setdistributor ${distributorAddress}\` to link it here`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't deploy the distributor: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /deploynftwrapper
//////////////////////////////////////////////////////////////*/

bot.command("deploynftwrapper", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const chatCreator = getChatCreator(ctx.chat.id);
  if (!chatCreator || String(ctx.from.id) !== chatCreator) {
    await ctx.reply("Only this DAO's creator can deploy an NFT marketplace wrapper.");
    return;
  }

  const existing = getChatNftWrapper(ctx.chat.id);
  if (existing) {
    await ctx.reply(`This DAO already has one deployed at \`${short(existing)}\`. Deploying another won't replace it automatically.`, {
      parse_mode: "Markdown",
    });
    return;
  }

  const statusMsg = await ctx.reply("⏳ Deploying an NFT marketplace wrapper…");

  try {
    const model = getChatModel(ctx.chat.id);
    const { treasuryAddress } = await getDaoInfo(model, address);
    const { wrapperAddress } = await deployNftWrapper(walletClient, address, treasuryAddress);
    registerNftWrapper(ctx.chat.id, wrapperAddress);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Deployed at \`${short(wrapperAddress)}\`.\n\nThis wrapper is now linked to this DAO. Governance-gated only - approving listings, sending NFTs to it, and sweeping assets back to Treasury all need to go through a passed \`/propose\`, same as any other treasury action.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't deploy the wrapper: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /handovertowrapper
//////////////////////////////////////////////////////////////*/

bot.command("handovertowrapper", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const chatCreator = getChatCreator(ctx.chat.id);
  if (!chatCreator || String(ctx.from.id) !== chatCreator) {
    await ctx.reply("Only this DAO's creator can compute a handover to a guard wrapper.");
    return;
  }

  const wrapperAddress = ctx.match?.trim();
  if (!wrapperAddress || !isAddress(wrapperAddress)) {
    await ctx.reply(
      "Usage: `/handovertowrapper <wrapperAddress>` — computes the exact `/propose` commands needed to hand Treasury and token-minting control to an already-deployed GuardWrapper.\n\nBoth still need to actually be proposed and pass a real vote - this only computes the calldata, it doesn't submit anything.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const statusMsg = await ctx.reply("⏳ Computing handover proposals…");

  try {
    const model = getChatModel(ctx.chat.id);
    const { treasuryAddress, tokenAddress } = await getDaoInfo(model, address);

    // tokenAddress here is the staking wrapper, not the raw, mintable
    // token - same distinction stakeTokens() already has to account
    // for. transferOwnership() (needed to hand over minting rights)
    // lives on the underlying token, not the staking wrapper.
    const underlyingTokenAddress = await publicClient.readContract({
      address: getAddress(tokenAddress),
      abi: abis.StakedGovernanceToken,
      functionName: "underlying",
    });

    // Both selectors computed via real keccak256, not guessed:
    // transferGovernance(address) -> 0xd38bfff4
    // transferOwnership(address) -> 0xf2fde38b (standard OZ Ownable)
    const treasuryData =
      "0xd38bfff4" + getAddress(wrapperAddress).slice(2).toLowerCase().padStart(64, "0");
    const tokenData =
      "0xf2fde38b" + getAddress(wrapperAddress).slice(2).toLowerCase().padStart(64, "0");

    const message = [
      "*Handover proposals* - both are normal proposals, needing a full vote each. Run them one at a time, whenever you're ready:",
      "",
      "*1. Hand Treasury control to the wrapper:*",
      `\`/propose ${treasuryAddress} 0 ${treasuryData} Hand Treasury control to the security guard wrapper\``,
      "",
      "*2. Hand token-minting control to the wrapper:*",
      `\`/propose ${underlyingTokenAddress} 0 ${tokenData} Hand token-minting control to the security guard wrapper\``,
      "",
      "⚠️ Once #1 executes, this DAO's governance can no longer move Treasury funds directly - every future Treasury action has to go through the wrapper's own proposeInstruction, confirmed by its signers, from that point on. Same for #2 and minting, once it executes. Consider proposing and confirming a real test instruction through the wrapper before relying on this for anything that matters.",
    ].join("\n");

    await deliverPrivately(ctx, statusMsg, message, "Sent the handover proposals.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't compute the handover proposals: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /deployguardwrapper
//////////////////////////////////////////////////////////////*/

bot.command("deployguardwrapper", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const chatCreator = getChatCreator(ctx.chat.id);
  if (!chatCreator || String(ctx.from.id) !== chatCreator) {
    await ctx.reply("Only this DAO's creator can deploy a guard wrapper.");
    return;
  }

  const existing = getChatGuardWrapper(ctx.chat.id);
  if (existing) {
    await ctx.reply(`This DAO already has one linked at \`${short(existing)}\`. Deploying another won't replace it automatically.`, {
      parse_mode: "Markdown",
    });
    return;
  }

  const args = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  const [requiredApprovalsStr, tenureLengthStr, ...signers] = args;
  const requiredApprovals = Number(requiredApprovalsStr);
  const tenureLengthSeconds = Number(tenureLengthStr);

  if (
    !requiredApprovalsStr ||
    !Number.isInteger(requiredApprovals) ||
    requiredApprovals <= 0 ||
    !tenureLengthStr ||
    !Number.isInteger(tenureLengthSeconds) ||
    tenureLengthSeconds <= 0 ||
    signers.length === 0 ||
    requiredApprovals > signers.length ||
    !signers.every((s) => isAddress(s, { strict: false }))
  ) {
    await ctx.reply(
      "Usage: `/deployguardwrapper <requiredApprovals> <tenureLengthSeconds> <signer1> <signer2> ...`\n\nExample: `/deployguardwrapper 2 2592000 0xAb1...ef2 0xCd3...gh4 0xEf5...ij6` — a 3-signer wrapper needing 2 confirmations, with a 30-day tenure (2592000 seconds) before signers can be replaced.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const statusMsg = await ctx.reply("⏳ Deploying a guard wrapper…");

  try {
    const { wrapperAddress } = await guardWrapper.deployGuardWrapper(walletClient, address, signers, requiredApprovals, tenureLengthSeconds);
    registerGuardWrapper(ctx.chat.id, wrapperAddress);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Deployed at \`${short(wrapperAddress)}\`.\n\nThis wrapper is now linked to this DAO. Nothing routes through it automatically - use \`/handovertowrapper ${wrapperAddress}\` to compute the proposals that actually hand Treasury and token-minting control over to it.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't deploy the guard wrapper: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /registerguardwrapper
//////////////////////////////////////////////////////////////*/

bot.command("registerguardwrapper", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const chatCreator = getChatCreator(ctx.chat.id);
  if (!chatCreator || String(ctx.from.id) !== chatCreator) {
    await ctx.reply("Only this DAO's creator can link a guard wrapper.");
    return;
  }

  const wrapperAddress = ctx.match?.trim();
  if (!wrapperAddress || !isAddress(wrapperAddress, { strict: false })) {
    await ctx.reply("Usage: `/registerguardwrapper <wrapperAddress>`", { parse_mode: "Markdown" });
    return;
  }

  registerGuardWrapper(ctx.chat.id, getAddress(wrapperAddress.toLowerCase()));
  await ctx.reply(`Linked. Run /guardwrapper to see its current signers and status.`);
});

/*//////////////////////////////////////////////////////////////
                            /guardwrapper
//////////////////////////////////////////////////////////////*/

bot.command("guardwrapper", async (ctx) => {
  const address = await requireGuardWrapper(ctx);
  if (!address) return;

  try {
    const [info, signers] = await Promise.all([guardWrapper.getWrapperInfo(address), guardWrapper.getSigners(address)]);
    const tenureEndDate = new Date(Number(info.tenureEnd) * 1000).toUTCString();
    const lines = [
      `*Guard wrapper* \`${short(address)}\``,
      `Governance: \`${short(info.governance)}\``,
      `Required confirmations: *${info.requiredApprovals}* of *${signers.length}* signers`,
      `Tenure ends: *${tenureEndDate}*`,
      `Instructions so far: *${info.instructionCount}*`,
      "",
      "*Signers:*",
      ...signers.map((s, i) => `${i + 1}. \`${short(s)}\``),
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't read wrapper info: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /instruction
//////////////////////////////////////////////////////////////*/

bot.command("instruction", async (ctx) => {
  const address = await requireGuardWrapper(ctx);
  if (!address) return;

  const idStr = ctx.match?.trim();
  if (!idStr || !/^\d+$/.test(idStr)) {
    await ctx.reply("Usage: `/instruction <id>` — full detail on one pending or resolved instruction, including its raw calldata.", {
      parse_mode: "Markdown",
    });
    return;
  }

  try {
    const instruction = await guardWrapper.getInstruction(address, idStr);
    const status = instruction.executed ? "✅ Executed" : instruction.rejected ? "❌ Rejected" : "⏳ Pending";
    const lines = [
      `*Instruction #${idStr}* — ${status}`,
      `Target: \`${instruction.target}\``,
      `Value: *${instruction.value}* wei`,
      `Confirmations: *${instruction.confirmations}*`,
      `Rejections: *${instruction.rejections}*`,
      "",
      "*Raw calldata:*",
      `\`${instruction.data}\``,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't read that instruction: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /confirminstruction
//////////////////////////////////////////////////////////////*/

bot.command("confirminstruction", async (ctx) => {
  const address = await requireGuardWrapper(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const idStr = ctx.match?.trim();
  if (!idStr || !/^\d+$/.test(idStr)) {
    await ctx.reply("Usage: `/confirminstruction <id>` — signers only. Executes automatically once enough confirmations accumulate.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Confirming…");

  try {
    await ensureGasFunded(account);
    const { hash } = await guardWrapper.confirmInstruction(client, address, idStr);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Confirmed instruction #${idStr}.\nTx: \`${short(hash)}\`\n\nCheck \`/instruction ${idStr}\` to see if it's executed yet.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't confirm (this only works if you're a signer on this wrapper): ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /rejectinstruction
//////////////////////////////////////////////////////////////*/

bot.command("rejectinstruction", async (ctx) => {
  const address = await requireGuardWrapper(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const idStr = ctx.match?.trim();
  if (!idStr || !/^\d+$/.test(idStr)) {
    await ctx.reply("Usage: `/rejectinstruction <id>` — signers only. Once enough signers reject, the instruction is permanently cancelled - nobody can confirm it afterward.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Rejecting…");

  try {
    await ensureGasFunded(account);
    const { hash } = await guardWrapper.rejectInstruction(client, address, idStr);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Rejected instruction #${idStr}.\nTx: \`${short(hash)}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't reject (this only works if you're a signer on this wrapper): ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /revokeconfirmation
//////////////////////////////////////////////////////////////*/

bot.command("revokeconfirmation", async (ctx) => {
  const address = await requireGuardWrapper(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const idStr = ctx.match?.trim();
  if (!idStr || !/^\d+$/.test(idStr)) {
    await ctx.reply("Usage: `/revokeconfirmation <id>` — withdraw your own earlier confirmation, before the instruction executes.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Revoking…");

  try {
    await ensureGasFunded(account);
    const { hash } = await guardWrapper.revokeConfirmation(client, address, idStr);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Revoked your confirmation on instruction #${idStr}.\nTx: \`${short(hash)}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't revoke: ${err.shortMessage || err.message}`);
  }
});

bot.command("setdistributor", async (ctx) => {
  const address = ctx.match?.trim();

  if (!address || !isAddress(address)) {
    await ctx.reply("Usage: `/setdistributor 0xYourWelcomeDistributorAddress`", {
      parse_mode: "Markdown",
    });
    return;
  }

  let info;
  try {
    info = await getDistributorInfo(address);
  } catch (err) {
    await ctx.reply("Couldn't read a WelcomeDistributor at that address. Double-check it's deployed correctly.");
    return;
  }

  registerDistributor(ctx.chat.id, address);
  await ctx.reply(
    `✅ Welcome distributor linked. New members will be offered ${info.amountPerClaim} tokens once they've connected a wallet.`
  );
});

/*//////////////////////////////////////////////////////////////
                              /wallet
//////////////////////////////////////////////////////////////*/

bot.command("wallet", async (ctx) => {
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  try {
    const account = await getOrCreateUserAccount(ctx.from.id);
    await ctx.reply(
      `Your wallet:\n\`${account.address}\`\n\nTap the address above to copy it. This wallet is generated automatically from your Telegram account — no separate connect step needed.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply(err.message || "Couldn't generate your wallet right now.");
  }
});

/*//////////////////////////////////////////////////////////////
                          /migratewallet
//////////////////////////////////////////////////////////////*/

bot.command("migratewallet", async (ctx) => {
  if (!isWalletDerivationConfigured()) {
    await ctx.reply("The old wallet system isn't configured on this bot - nothing to migrate.");
    return;
  }
  if (!isWalletStoreConfigured()) {
    await ctx.reply("The new wallet system isn't configured on this bot yet - ask an admin.");
    return;
  }

  const oldAccount = deriveUserWallet(ctx.from.id);
  const statusMsg = await ctx.reply("⏳ Checking your old wallet…");

  try {
    const nativeBalance = await publicClient.getBalance({ address: oldAccount.address });

    const existing = await findWalletRecord("telegram", ctx.from.id);
    const newAddress = existing ? existing.address : (await createWalletRecord("telegram", ctx.from.id)).address;

    if (nativeBalance === 0n) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `Your old wallet has no native MON balance to move. Your new wallet is ready: \`${short(newAddress)}\`.\n\n` +
          `⚠️ This only sweeps native MON automatically - if you hold ERC20 tokens under the old address ` +
          `(\`${short(oldAccount.address)}\`), move those manually too.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const GAS_RESERVE = parseEther("0.005"); // matches this bot's MIN_GAS_BALANCE convention elsewhere
    if (nativeBalance <= GAS_RESERVE) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `Your old wallet's balance (${formatEther(nativeBalance)} MON) is too small to cover gas for a transfer. ` +
          `New wallet ready: \`${short(newAddress)}\`.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const oldClient = walletClientFor(oldAccount);
    const sendAmount = nativeBalance - GAS_RESERVE;

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "⏳ Moving your balance to the new wallet…");
    const hash = await oldClient.sendTransaction({ to: newAddress, value: sendAmount });
    await publicClient.waitForTransactionReceipt({ hash });

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Moved ${formatEther(sendAmount)} MON to your new wallet \`${short(newAddress)}\`. Every command now uses this wallet.\n\n` +
        `⚠️ This only sweeps native MON - if you hold ERC20 tokens under the old address ` +
        `(\`${short(oldAccount.address)}\`), move those manually too.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Migration failed: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /contribute
//////////////////////////////////////////////////////////////*/

bot.command("contribute", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    const { daoName, treasuryAddress } = hasToken(model)
      ? await getDaoInfo(model, address)
      : await adapter.getDaoInfo(address);
    const message = [
      `💰 *Contribute to ${daoName}*`,
      "",
      "Send MON (or any supported token) directly to the treasury:",
      `\`${treasuryAddress}\``,
      "",
      `Explorer: ${monadTestnet.blockExplorers.default.url}/address/${treasuryAddress}`,
      "",
      "⚠️ Funds sent here become DAO-controlled — moving them back out requires a passed governance proposal, not a unilateral withdrawal.",
    ].join("\n");

    try {
      await ctx.api.sendMessage(ctx.from.id, message, { parse_mode: "Markdown" });
      if (ctx.chat.type !== "private") {
        await ctx.reply("📬 Sent you the treasury address.");
      }
    } catch (dmErr) {
      await ctx.reply("Couldn't DM you - please start a chat with me directly first (search for this bot and hit Start), then run `/contribute` again.");
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read the treasury address right now.");
  }
});

/*//////////////////////////////////////////////////////////////
                                /dao
//////////////////////////////////////////////////////////////*/

// Per-model config display for /dao - every model genuinely has a
// different config struct shape, confirmed directly from each
// contract's real struct fields, not assumed. tokenWeighted/quadratic/
// liquid happen to share the exact same 7-field shape; every other
// model differs, several completely.
function hoursFrom(seconds) {
  return (Number(seconds) / 3600).toFixed(1);
}

const STANDARD_CONFIG_LINES = (c) => [
  `Quorum: ${Number(c.quorumBps) / 100}%`,
  `Approval threshold: ${Number(c.approvalThresholdBps) / 100}%`,
  `Voting delay: ${c.votingDelay} blocks`,
  `Voting period: ${c.votingPeriod} blocks`,
  `Timelock: ${hoursFrom(c.timelockDelay)}h`,
  `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
];

const CONFIG_DISPLAY_BY_MODEL = {
  tokenWeighted: STANDARD_CONFIG_LINES,
  quadratic: STANDARD_CONFIG_LINES,
  liquid: STANDARD_CONFIG_LINES,
  optimistic: (c) => [
    `Challenge period: ${hoursFrom(c.challengePeriod)}h`,
    `Challenge bond: ${formatEther(c.challengeBond)} tokens`,
    `Quorum (if challenged): ${Number(c.quorumBps) / 100}%`,
    `Approval threshold (if challenged): ${Number(c.approvalThresholdBps) / 100}%`,
    `Voting period (if challenged): ${c.votingPeriod} blocks`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
    `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
  ],
  delegate: (c) => [
    `Council size: ${c.councilSize}`,
    `Term length: ${(Number(c.termLength) / 86400).toFixed(1)} days`,
    `Candidacy threshold: ${formatEther(c.candidacyThreshold)} tokens`,
    `Candidacy period: ${c.candidacyPeriod} blocks`,
    `Election voting period: ${c.electionVotingPeriod} blocks`,
    `Council quorum: ${c.councilQuorum}`,
    `Council approval threshold: ${Number(c.councilApprovalThresholdBps) / 100}%`,
    `Voting delay: ${c.votingDelay} blocks`,
    `Voting period: ${c.votingPeriod} blocks`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
    `Recall quorum: ${Number(c.recallQuorumBps) / 100}%`,
    `Recall approval threshold: ${Number(c.recallApprovalThresholdBps) / 100}%`,
    `Recall voting period: ${c.recallVotingPeriod} blocks`,
  ],
  board: (c) => [
    `Required approvals: ${c.requiredApprovals}`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
  sortition: (c) => [
    `Council size: ${c.councilSize}`,
    `Term length: ${(Number(c.termLength) / 86400).toFixed(1)} days`,
    `Eligibility threshold: ${formatEther(c.eligibilityThreshold)} tokens`,
    `Council quorum: ${c.councilQuorum}`,
    `Council approval threshold: ${Number(c.councilApprovalThresholdBps) / 100}%`,
    `Voting delay: ${c.votingDelay} blocks`,
    `Voting period: ${c.votingPeriod} blocks`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
  conviction: (c) => [
    `Conviction growth rate: ${c.convictionGrowthRate} per block`,
    `Min threshold conviction: ${formatEther(c.minThresholdConviction)}`,
    `Threshold multiplier: ${c.thresholdMultiplier} per token requested`,
    `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
  sowellian: (c) => [
    `Proposal bond: ${formatEther(c.proposalBondAmount)} tokens`,
    `Approval voting delay: ${c.approvalVotingDelay} blocks`,
    `Approval voting period: ${c.approvalVotingPeriod} blocks`,
    `Approval quorum: ${Number(c.approvalQuorumBps) / 100}%`,
    `Approval threshold: ${Number(c.approvalThresholdBps) / 100}%`,
    `Positions window: ${hoursFrom(c.positionsWindow)}h`,
    `Execution timelock: ${hoursFrom(c.executionTimelockDelay)}h`,
    `Resolution bond: ${formatEther(c.resolutionBondAmount)} tokens`,
    `Challenge period: ${hoursFrom(c.challengePeriod)}h`,
    `Challenge bond: ${formatEther(c.challengeBondAmount)} tokens`,
    `Adjudication voting period: ${c.adjudicationVotingPeriod} blocks`,
    `Adjudication quorum: ${Number(c.adjudicationQuorumBps) / 100}%`,
    `Adjudication threshold: ${Number(c.adjudicationThresholdBps) / 100}%`,
    `Max oracle staleness: ${hoursFrom(c.maxOracleStaleness)}h`,
  ],
  decisionMarkets: (c) => [
    `Trading period: ${hoursFrom(c.tradingPeriod)}h`,
    `Pass must beat fail by: ${Number(c.thresholdBps) / 100}%`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
};

bot.command("dao", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const model = getChatModel(ctx.chat.id);
    // Board is deliberately excluded from common.js's shared getDaoInfo
    // (no governanceToken at all) - use its own adapter-level version
    // instead, which has no tokenAddress field to begin with.
    const adapter = getAdapter(model);
    const { daoName, tokenAddress, treasuryAddress, config } = hasToken(model)
      ? await getDaoInfo(model, address)
      : await adapter.getDaoInfo(address);

    const lines = [
      `*${daoName}*`,
      `Governance: \`${short(address)}\``,
      hasToken(model) ? `Token: \`${short(tokenAddress)}\`` : null,
      `Treasury: \`${short(treasuryAddress)}\``,
      "",
      ...(CONFIG_DISPLAY_BY_MODEL[model]?.(config) ?? ["Config format not known for this model."]),
    ].filter(Boolean);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read DAO info — the linked address may be stale.");
  }
});

/*//////////////////////////////////////////////////////////////
                            /treasury
//////////////////////////////////////////////////////////////*/

bot.command("treasury", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    const { treasuryAddress } = hasToken(model) ? await getDaoInfo(model, address) : await adapter.getDaoInfo(address);
    const balance = await getTreasuryBalance(treasuryAddress);
    await ctx.reply(`🏦 Treasury \`${short(treasuryAddress)}\`\nBalance: *${balance} MON*`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read the treasury balance.");
  }
});

/*//////////////////////////////////////////////////////////////
                            /balance
//////////////////////////////////////////////////////////////*/

bot.command("balance", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(
      `This DAO uses ${model} governance, which has no token or voting balance - signers act directly, with equal standing. There's no balance to check here.`
    );
    return;
  }

  let target = ctx.match?.trim();
  if (target && !isAddress(target)) {
    await ctx.reply("That doesn't look like a valid address.");
    return;
  }

  if (!target) {
    if (!isWalletStoreConfigured()) {
      await ctx.reply(
        "No address given, and wallets aren't set up.\nUse `/balance 0xSomeAddress`.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    target = await getUserAddress(ctx.from.id);
  }

  try {
    const { tokenAddress } = await getDaoInfo(model, address);
    const { staked, activeVotes, delegatedTo } = await getVotingPower(tokenAddress, target);

    const delegationNote =
      delegatedTo === "0x0000000000000000000000000000000000000000"
        ? "\n⚠️ Not delegated — staked balance carries zero voting power until delegated (staking auto-delegates to self, so this shouldn't normally happen)."
        : `\nDelegated to: \`${short(delegatedTo)}\``;

    await ctx.reply(
      `*${short(target)}*\nStaked: ${staked}\nActive voting power: ${activeVotes}${delegationNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read voting power for that address.");
  }
});

/*//////////////////////////////////////////////////////////////
                              /tip
//////////////////////////////////////////////////////////////*/

bot.command("tip", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(`This DAO uses ${model} governance, which has no token - there's nothing to tip.`);
    return;
  }
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const parts = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  const [amountRaw, recipientRaw, tokenRef] = parts;

  if (!amountRaw || Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0 || !recipientRaw || !isAddress(recipientRaw)) {
    await ctx.reply(
      "Usage: `/tip <amount> <recipientAddress> [tokenAddressOrTicker]`\n\nThe token slot is optional - it defaults to this DAO's own token, and also accepts any ticker registered with `/registertoken`. Only the DAO's creator can tip, and it sends from the tokens minted to the operator wallet when this DAO was created.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    const chatCreator = getChatCreator(ctx.chat.id);
    if (!chatCreator) {
      await ctx.reply(
        "This DAO's creator isn't on record - it was probably linked with /register rather than created through this bot, so /tip has no way to know who's authorized. Ask an admin to /register it again after re-checking, or use a direct on-chain transfer instead."
      );
      return;
    }
    if (String(ctx.from.id) !== chatCreator) {
      await ctx.reply("Only this DAO's creator can use /tip.");
      return;
    }

    const tokenAddress = await resolveToken(ctx, address, tokenRef);
    const { hash } = await tipTokens(walletClient, tokenAddress, recipientRaw, amountRaw);
    await ctx.reply(`✅ Tipped ${amountRaw} to \`${short(recipientRaw)}\`.\nTx: \`${short(hash)}\``, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't send that tip: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                              /send
//////////////////////////////////////////////////////////////*/

bot.command("send", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const parts = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  const [amountRaw, recipientRaw, tokenRef] = parts;

  if (!amountRaw || Number.isNaN(Number(amountRaw)) || Number(amountRaw) <= 0 || !recipientRaw || !isAddress(recipientRaw)) {
    await ctx.reply(
      "Usage: `/send <amount> <recipientAddress> [tokenAddressOrTicker]`\n\nSends tokens (or native MON) you're currently holding to someone else - your own wallet, your own balance, no approval needed from the DAO's creator. The token slot is optional: defaults to this DAO's own token, also accepts `MON` for native currency, or any ticker registered with `/registertoken`. This will fail if you don't hold enough to cover the amount.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // MON is native currency, independent of whether this DAO's model
  // even has a governance token at all (Board has none) - handled
  // entirely separately from the token-transfer path below, since it
  // needs a plain sendTransaction, not an ERC20 call.
  const isNativeMon = tokenRef?.toUpperCase() === "MON";

  if (!isNativeMon) {
    const model = getChatModel(ctx.chat.id);
    if (!hasToken(model)) {
      await ctx.reply(`This DAO uses ${model} governance, which has no token - there's nothing to send. Try \`/send ${amountRaw} ${recipientRaw} MON\` to send native currency instead.`, {
        parse_mode: "Markdown",
      });
      return;
    }
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Sending…");

  try {
    await ensureGasFunded(account);

    let hash;
    if (isNativeMon) {
      hash = await client.sendTransaction({ to: getAddress(recipientRaw), value: parseEther(amountRaw) });
      await publicClient.waitForTransactionReceipt({ hash });
    } else {
      const tokenAddress = await resolveToken(ctx, address, tokenRef);
      ({ hash } = await tipTokens(client, tokenAddress, recipientRaw, amountRaw));
    }

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Sent ${amountRaw}${isNativeMon ? " MON" : ""} to \`${short(recipientRaw)}\`.\nTx: \`${short(hash)}\``,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't send that: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                          /tokenbalance
//////////////////////////////////////////////////////////////*/

bot.command("tokenbalance", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(`This DAO uses ${model} governance, which has no token - there's no balance to check.`);
    return;
  }

  const parts = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  const [tokenRef, holderRaw] = parts;

  let holder = holderRaw;
  if (holder?.toLowerCase() === "treasury") {
    const { treasuryAddress } = await getDaoInfo(model, address);
    holder = treasuryAddress;
  } else if (holder && !isAddress(holder)) {
    await ctx.reply("That doesn't look like a valid address (or the word `treasury`).", { parse_mode: "Markdown" });
    return;
  }
  if (!holder) {
    if (!isWalletStoreConfigured()) {
      await ctx.reply(
        "No address given, and wallets aren't set up.\nUse `/tokenbalance [tokenAddressOrTicker] 0xSomeAddress|treasury`.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    holder = await getUserAddress(ctx.from.id);
  }

  try {
    const tokenAddress = await resolveToken(ctx, address, tokenRef);
    const balance = await getTokenBalance(tokenAddress, holder);
    const hint = holderRaw ? "" : "\n\n_Tip: `/tokenbalance [token] <address>` checks anyone else's, or `treasury` for the DAO's own holdings._";
    await ctx.reply(`*${short(holder)}*\nBalance: ${balance}${hint}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't read that balance: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                          /registertoken
//////////////////////////////////////////////////////////////*/

bot.command("registertoken", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const chatCreator = getChatCreator(ctx.chat.id);
  if (!chatCreator || String(ctx.from.id) !== chatCreator) {
    await ctx.reply("Only this DAO's creator can register a token ticker.");
    return;
  }

  const parts = (ctx.match?.trim() ?? "").split(/\s+/).filter(Boolean);
  const [ticker, tokenAddress] = parts;

  if (!ticker || !tokenAddress || !isAddress(tokenAddress) || !/^[A-Za-z0-9]{1,15}$/.test(ticker)) {
    await ctx.reply(
      "Usage: `/registertoken <ticker> <tokenAddress>` — e.g. `/registertoken USDC 0x...`\n\nLets `/tip` and `/tokenbalance` accept this ticker instead of the raw address. This doesn't need to be a token this DAO issued - any real ERC20 the community wants a shortcut for.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    const symbol = await getTokenSymbol(tokenAddress);
    registerToken(ctx.chat.id, ticker, tokenAddress);
    await ctx.reply(`✅ \`${ticker.toUpperCase()}\` now resolves to \`${short(tokenAddress)}\` (real on-chain symbol: ${symbol}).`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    await ctx.reply("Couldn't read that as a token - double check it's a real, deployed ERC20 address.");
  }
});

/*//////////////////////////////////////////////////////////////
                          /treasuryassets
//////////////////////////////////////////////////////////////*/

bot.command("treasuryassets", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(`This DAO uses ${model} governance, which has no token - there are no token assets to list.`);
    return;
  }

  try {
    const { treasuryAddress } = await getDaoInfo(model, address);
    const ownTokenAddress = await getUnderlyingTokenAddress(address);
    const registered = getRegisteredTokens(ctx.chat.id);

    const entries = [[await getTokenSymbol(ownTokenAddress), ownTokenAddress], ...Object.entries(registered)];

    const lines = await Promise.all(
      entries.map(async ([symbol, tokenAddress]) => {
        try {
          const balance = await getTokenBalance(tokenAddress, treasuryAddress);
          return `${symbol}: ${balance}`;
        } catch {
          return `${symbol}: couldn't read balance`;
        }
      })
    );

    await ctx.reply(`*Treasury assets* (\`${short(treasuryAddress)}\`)\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't read treasury assets: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /proposals
//////////////////////////////////////////////////////////////*/

bot.command("proposals", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  try {
    const count = await getProposalCount(address);
    if (count === 0) {
      await ctx.reply("No proposals yet. Use /propose to create one.");
      return;
    }

    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);

    // Most recent first, capped so one command can't dump a huge wall of text.
    const ids = Array.from({ length: Math.min(count, 10) }, (_, i) => count - i);
    const proposals = await Promise.all(ids.map((id) => adapter.getProposal(address, id)));

    const lines = proposals.map((p) => {
      const stateLabel = p.stateLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";
      return `#${p.id} — ${stateLine(stateLabel)}\n${p.metadataURI.slice(0, 80)}`;
    });

    await ctx.reply(
      `*Proposals* (showing ${ids.length} of ${count})\n\n${lines.join("\n\n")}\n\nUse /proposal \`<id>\` for full detail.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't load proposals.");
  }
});

/*//////////////////////////////////////////////////////////////
                        /proposal <id>
//////////////////////////////////////////////////////////////*/

bot.command("proposal", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/proposal 3`", { parse_mode: "Markdown" });
    return;
  }

  try {
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    const p = await adapter.getProposal(address, id);
    const stateLabel = p.stateLabel ?? p.statusLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";

    const lines = [
      `*Proposal #${p.id}* — ${stateLine(stateLabel)}`,
      p.metadataURI,
      "",
      `Proposer: \`${short(p.proposer)}\``,
    ];

    // Vote/support breakdown - genuinely different shape per model,
    // branched on which fields actually exist rather than assumed
    // universal. Four models (Conviction, Board, DecisionMarkets,
    // Sowellian) don't share the original model's forVotes/against/
    // abstain shape at all - confirmed directly from each contract's
    // real Proposal struct, not assumed.
    if ("forVotes" in p) {
      // Vote totals are only safe to run through formatEther when
      // they're real 18-decimal token amounts - a model like Quadratic
      // reports sqrt-weighted values on a completely different scale,
      // which would formatEther into a tiny, meaningless number instead.
      const formatVotes = (v) => (p.voteWeightUnit === "token" ? formatEther(v) : v.toString());
      const voteLabel = p.voteWeightUnit === "token" ? "" : " (voting weight)";
      lines.push(`For: ${formatVotes(p.forVotes)} · Against: ${formatVotes(p.againstVotes)} · Abstain: ${formatVotes(p.abstainVotes)}${voteLabel}`);
      if ("quorumVotes" in p) lines.push(`Quorum needed: ${formatEther(p.quorumVotes)}`);
    } else if ("requiredConviction" in p) {
      lines.push(`Conviction: ${formatEther(p.currentConviction)} / ${formatEther(p.requiredConviction)} needed`);
    } else if ("confirmations" in p) {
      lines.push(`Confirmations: ${p.confirmations}`);
    } else if ("passTWAP" in p) {
      lines.push(`Pass TWAP: ${p.passTWAP} · Fail TWAP: ${p.failTWAP}`);
    } else if ("approvalForVotes" in p) {
      lines.push(
        `Approval — For: ${formatEther(p.approvalForVotes)} · Against: ${formatEther(p.approvalAgainstVotes)} · Abstain: ${formatEther(p.approvalAbstainVotes)}`
      );
      if ((p.adjudicateSuccessVotes ?? 0n) > 0n || (p.adjudicateFailureVotes ?? 0n) > 0n) {
        lines.push(`Adjudication — Success: ${formatEther(p.adjudicateSuccessVotes)} · Failure: ${formatEther(p.adjudicateFailureVotes)}`);
      }
    }

    lines.push("");

    // Voting/timing window - also genuinely absent for several models
    // (Board and Conviction have no discrete window at all; Decision
    // Markets uses a trading deadline instead of start/end blocks) -
    // checked the same way, not assumed present.
    if (p.startBlock !== undefined && p.endBlock !== undefined) {
      lines.push(`Voting: block ${p.startBlock} → ${p.endBlock}`);
    } else if (p.tradingDeadline !== undefined) {
      lines.push(`Trading deadline: ${formatDate(p.tradingDeadline)}`);
    }

    if (p.queuedAt > 0n) lines.push(`Queued at: ${formatDate(p.queuedAt)}`);
    if (p.executableAfter > 0n) lines.push(`Executable after: ${formatDate(p.executableAfter)}`);
    lines.push(`Actions: ${p.actions.length}`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't find proposal #${id} — check the ID and try again.`);
  }
});

/*//////////////////////////////////////////////////////////////
                              /stake
//////////////////////////////////////////////////////////////*/

bot.command("stake", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(
      `This DAO uses ${model} governance, which has no token or staking - signers act directly. There's nothing to stake here.`
    );
    return;
  }

  const amountStr = ctx.match?.trim();
  const amount = Number(amountStr);
  if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Usage: `/stake 100` — stakes 100 of your tokens to activate voting power.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Staking — this takes a moment…");

  try {
    await ensureGasFunded(account);
    const tokenAddress = await getGovernanceTokenAddress(model, address);
    await stakeTokens(client, tokenAddress, amount);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Staked ${amount} tokens. Your voting power is now active.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't stake: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /propose
//////////////////////////////////////////////////////////////*/

bot.command("propose", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model === "sowellian") {
    await ctx.reply("This DAO uses sowellian governance, which needs resolution criteria. Use `/proposecriteria` instead - see `/help` for its format.", { parse_mode: "Markdown" });
    return;
  }
  if (model === "decisionMarkets") {
    await ctx.reply("This DAO uses decisionMarkets governance, which needs seed liquidity. Use `/proposemarket` instead - see `/help` for its format.", { parse_mode: "Markdown" });
    return;
  }

  // Format: /propose <target> <value> <data> <description...>
  const raw = ctx.match?.trim() ?? "";
  const parts = raw.split(/\s+/);
  const [target, value, data, ...descriptionParts] = parts;
  const description = descriptionParts.join(" ");

  if (!target || !isAddress(target) || !value || !data || !description) {
    await ctx.reply(
      [
        "Usage: `/propose <target> <value> <data> <description>`",
        "",
        "Example (no-op proposal for testing):",
        "`/propose 0xRecipient 0 0x Send a test proposal`",
        "",
        "⚠️ `data` must be `0x` or a full hex-encoded calldata string — this is a low-level, advanced-users command for now.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Submitting proposal…");

  try {
    await ensureGasFunded(account, true);
    const adapter = getAdapter(model);
    const actions = [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }];
    const { proposalId } = await adapter.propose(client, address, actions, description);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created.\n\nUse /proposal ${proposalId} to check on it, or /vote ${proposalId} for|against|abstain once voting opens.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't create the proposal: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                            /listactions
//////////////////////////////////////////////////////////////*/

bot.command("listactions", async (ctx) => {
  const model = getChatModel(ctx.chat.id);
  const modelActions = listActionsForModel(model);
  const universalActions = listActionsForModel("treasury").concat(listActionsForModel("token"));
  const daoSpecific = getChatNftWrapper(ctx.chat.id) ? listActionsForModel("nftWrapper") : [];
  const guarded = getChatGuardWrapper(ctx.chat.id) ? listActionsForModel("guardWrapper") : [];

  const lines = ["*Verified action library*", "", "Only native, already-verified DAO instructions - no external platform actions yet.", ""];

  if (modelActions.length) {
    lines.push(`*Governance (${model}):*`);
    for (const a of modelActions) lines.push(`\`${a.id}\` — ${a.label}`);
    lines.push("");
  }
  lines.push("*Treasury & tokens:*");
  for (const a of universalActions) lines.push(`\`${a.id}\` — ${a.label}`);

  if (daoSpecific.length) {
    lines.push("", "*NFT wrapper:*");
    for (const a of daoSpecific) lines.push(`\`${a.id}\` — ${a.label}`);
  }
  if (guarded.length) {
    lines.push("", "*Guard wrapper:*");
    for (const a of guarded) lines.push(`\`${a.id}\` — ${a.label}`);
  }

  lines.push("", "Use `/proposeaction <actionId> <arg1> <arg2> ... <description>` to propose one.");
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

/*//////////////////////////////////////////////////////////////
                            /proposeaction
//////////////////////////////////////////////////////////////*/

bot.command("proposeaction", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const parts = (ctx.match?.trim() ?? "").split(/\s+/);
  const [actionId, ...rest] = parts;
  const action = getAction(actionId);

  if (!action) {
    await ctx.reply("Usage: `/proposeaction <actionId> <arg1> <arg2> ... <description>` — run `/listactions` to see what's available.", { parse_mode: "Markdown" });
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const appliesHere =
    action.appliesTo === "any" ||
    action.appliesTo === model ||
    (Array.isArray(action.appliesTo) && action.appliesTo.includes(model)) ||
    (action.appliesTo === "treasury") ||
    (action.appliesTo === "token") ||
    (action.appliesTo === "nftWrapper" && getChatNftWrapper(ctx.chat.id)) ||
    (action.appliesTo === "guardWrapper" && getChatGuardWrapper(ctx.chat.id));

  if (!appliesHere) {
    await ctx.reply(`\`${actionId}\` doesn't apply to this DAO. Run \`/listactions\` to see what does.`, { parse_mode: "Markdown" });
    return;
  }

  const argCount = action.params.length === 1 && action.params[0].type === "tuple" ? action.params[0].fields.length : action.params.length;
  const actionArgs = rest.slice(0, argCount);
  const description = rest.slice(argCount).join(" ");

  if (actionArgs.length !== argCount || !description) {
    const argNames =
      action.params.length === 1 && action.params[0].type === "tuple"
        ? action.params[0].fields.join(" ")
        : action.params.map((p) => p.name).join(" ");
    await ctx.reply(`Usage: \`/proposeaction ${actionId} ${argNames} <description>\``, { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Encoding and submitting proposal…");

  try {
    let { data, target: fixedTarget } = encodeAction(actionId, actionArgs);

    let target;
    if (action.targetKind === "governance") {
      target = address;
    } else if (action.targetKind === "treasury") {
      const { treasuryAddress } = await getDaoInfo(model, address);
      target = treasuryAddress;

      // Treasury may no longer accept calls from this DAO's own
      // governance at all - if a GuardWrapper handover already ran
      // (Treasury.transferGovernance(wrapper)), Treasury's own
      // governance field now points at the wrapper, not this DAO's
      // Governance contract. Proposing a direct call in that state
      // would pass its vote and timelock, then fail only at execution.
      // Checking Treasury's real, current governance address here -
      // not assuming it's still this DAO - catches that before the
      // proposal is even created.
      const currentTreasuryGovernance = await publicClient.readContract({
        address: getAddress(treasuryAddress),
        abi: [{ type: "function", name: "governance", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "governance",
      });

      if (getAddress(currentTreasuryGovernance) !== getAddress(address)) {
        // A mismatch alone doesn't prove it's a GuardWrapper - it could
        // be any address for any reason. Only proceed with the
        // proposeInstruction wrapping if it genuinely matches this
        // chat's own registered wrapper; otherwise calling
        // proposeInstruction on an unconfirmed address would likely
        // just revert (wrong selector, no matching function) - an
        // opaque failure discovered only at execution, not a helpful
        // one discovered now.
        const registeredWrapper = getChatGuardWrapper(ctx.chat.id);
        if (!registeredWrapper || getAddress(registeredWrapper) !== getAddress(currentTreasuryGovernance)) {
          throw new Error(
            `Treasury's governance has changed to ${currentTreasuryGovernance}, which isn't this chat's registered guard wrapper` +
              (registeredWrapper ? ` (${registeredWrapper})` : " (none registered)") +
              `. Won't guess - link it first with /registerguardwrapper if that address is genuinely a GuardWrapper, or investigate if it's not.`
          );
        }
        data = encodeFunctionData({
          abi: [{ type: "function", name: "proposeInstruction", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ name: "instructionId", type: "uint256" }] }],
          functionName: "proposeInstruction",
          args: [getAddress(treasuryAddress), 0n, data],
        });
        target = currentTreasuryGovernance; // confirmed to be the registered wrapper
      }
    } else {
      target = fixedTarget; // supplied inline as the action's own first arg

      // Same risk as Treasury, different access-control shape: token
      // and staking-wrapper contracts are Ownable-style (owner(), not
      // governance()), and a handover via transferOwnership() would
      // leave them only accepting calls from whatever now holds
      // ownership - typically a GuardWrapper. Only checked for
      // "token"-appliesTo actions, since NFT/Guard wrapper targets
      // aren't ordinarily handed over to a further wrapper themselves.
      if (action.appliesTo === "token") {
        const currentOwner = await publicClient.readContract({
          address: target,
          abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
          functionName: "owner",
        });

        if (getAddress(currentOwner) !== getAddress(address)) {
          // Same verification as Treasury above - don't assume, confirm
          // against this chat's actual registered wrapper first.
          const registeredWrapper = getChatGuardWrapper(ctx.chat.id);
          if (!registeredWrapper || getAddress(registeredWrapper) !== getAddress(currentOwner)) {
            throw new Error(
              `This token's owner has changed to ${currentOwner}, which isn't this chat's registered guard wrapper` +
                (registeredWrapper ? ` (${registeredWrapper})` : " (none registered)") +
                `. Won't guess - link it first with /registerguardwrapper if that address is genuinely a GuardWrapper, or investigate if it's not.`
            );
          }
          data = encodeFunctionData({
            abi: [{ type: "function", name: "proposeInstruction", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ name: "instructionId", type: "uint256" }] }],
            functionName: "proposeInstruction",
            args: [target, 0n, data],
          });
          target = currentOwner; // confirmed to be the registered wrapper
        }
      }
    }

    await ensureGasFunded(account, true);
    const adapter = getAdapter(model);
    const actions = [{ target: getAddress(target), value: 0n, data }];
    const { proposalId } = await adapter.propose(client, address, actions, description);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created via \`${actionId}\`.\n\nUse /proposal ${proposalId} to check on it, or /vote ${proposalId} for|against|abstain once voting opens.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't create the proposal: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                      /deploychainlinkoracle
//////////////////////////////////////////////////////////////*/

bot.command("deploychainlinkoracle", async (ctx) => {
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const feedAddress = ctx.match?.trim();
  if (!feedAddress || !isAddress(feedAddress)) {
    await ctx.reply(
      [
        "Usage: `/deploychainlinkoracle <chainlinkFeedAddress>` — deploys a fresh oracle adapter wrapping a real Chainlink Data Feed, so you can reference it in `/proposecriteria`.",
        "",
        "⚠️ Unlike Switchboard, Chainlink needs a genuinely new adapter for every distinct metric - confirm the feed address is real and actually exists on this chain before deploying, since a wrong address deploys successfully but fails the first time anyone tries to resolve a proposal against it.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Deploying a new Chainlink oracle adapter…");

  try {
    await ensureGasFunded(account);
    const { adapterAddress } = await deployChainlinkOracle(client, feedAddress);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Adapter deployed at \`${short(adapterAddress)}\`. Use this as the oracle address in /proposecriteria - pass \`-\` for its selector, since Chainlink ignores it.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't deploy the adapter: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                          /proposecriteria
//////////////////////////////////////////////////////////////*/

bot.command("proposecriteria", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "sowellian") {
    await ctx.reply(`This DAO uses ${model} governance, which doesn't use resolution criteria. Use /propose instead.`);
    return;
  }

  // Format: /proposecriteria <target> <value> <data> <oracle|human> <oracleAddress|switchboard|-> <oracleSelector|-> <targetValue> <min|max> <measurementPeriodSeconds> <description...>
  const raw = ctx.match?.trim() ?? "";
  const parts = raw.split(/\s+/);
  const [target, value, data, methodRaw, oracleRawInput, selectorRaw, targetValue, directionRaw, measurementPeriod, ...descriptionParts] = parts;
  const description = descriptionParts.join(" ");
  const method = methodRaw?.toLowerCase();
  const direction = directionRaw?.toLowerCase();

  let oracleRaw = oracleRawInput;
  let switchboardShorthandError = null;
  if (method === "oracle" && oracleRawInput?.toLowerCase() === "switchboard") {
    if (!SWITCHBOARD_ORACLE_ADAPTER) {
      switchboardShorthandError = "No Switchboard oracle adapter configured on this bot - ask an admin to set SWITCHBOARD_ORACLE_ADAPTER, or pass a real adapter address directly.";
    } else {
      oracleRaw = SWITCHBOARD_ORACLE_ADAPTER;
    }
  }

  const valid =
    !switchboardShorthandError &&
    target && isAddress(target) && value && data &&
    (method === "oracle" || method === "human") &&
    targetValue !== undefined && !Number.isNaN(Number(targetValue)) &&
    (direction === "min" || direction === "max") &&
    measurementPeriod && /^\d+$/.test(measurementPeriod) &&
    description &&
    (method !== "oracle" || (oracleRaw && isAddress(oracleRaw))) &&
    (method !== "oracle" || selectorRaw === "-" || /^0x[0-9a-fA-F]{64}$/.test(selectorRaw));

  if (!valid) {
    if (switchboardShorthandError) {
      await ctx.reply(switchboardShorthandError);
      return;
    }
    await ctx.reply(
      [
        "Usage: `/proposecriteria <target> <value> <data> <oracle|human> <oracleAddress|-> <oracleSelector|-> <targetValue> <min|max> <measurementPeriodSeconds> <description>`",
        "",
        "`oracle` needs a real deployed IMetricOracle address, or the literal word `switchboard` (if this bot has one configured); for `human`, pass `-` in that slot.",
        "`oracleSelector` is the specific feed to read on that oracle - a full `0x`-prefixed 32-byte value for Switchboard (its feedId), or `-` for Chainlink and human track, where it's ignored.",
        "`min` means success if the metric ends up >= targetValue; `max` means success if it ends up <= targetValue.",
        "",
        "Example (human track, resolves 7 days after execution):",
        "`/proposecriteria 0xRecipient 0 0x human - - 0 min 604800 Fund the community grant`",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Submitting proposal…");

  try {
    await ensureGasFunded(account, true);
    const adapter = getAdapter("sowellian");
    const actions = [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }];
    const resolutionMethod = method === "oracle" ? 0 : 1;
    const oracle = method === "oracle" ? oracleRaw : "0x0000000000000000000000000000000000000000";
    const oracleSelector = selectorRaw === "-" || !selectorRaw ? "0x0000000000000000000000000000000000000000000000000000000000000000" : selectorRaw;

    const { proposalId } = await adapter.proposeWithCriteria(
      client,
      address,
      actions,
      description,
      resolutionMethod,
      oracle,
      oracleSelector,
      targetValue,
      direction === "min",
      measurementPeriod
    );

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created. Use /proposal ${proposalId} to follow it through approval voting.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't create the proposal: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                          /proposemarket
//////////////////////////////////////////////////////////////*/

bot.command("proposemarket", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "decisionMarkets") {
    await ctx.reply(`This DAO uses ${model} governance, which doesn't use seeded markets. Use /propose instead.`);
    return;
  }

  // Format: /proposemarket <target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description...>
  const raw = ctx.match?.trim() ?? "";
  const parts = raw.split(/\s+/);
  const [target, value, data, baseSeedAmount, quoteSeedAmount, ...descriptionParts] = parts;
  const description = descriptionParts.join(" ");

  const valid =
    target && isAddress(target) && value && data &&
    baseSeedAmount && !Number.isNaN(Number(baseSeedAmount)) && Number(baseSeedAmount) > 0 &&
    quoteSeedAmount && !Number.isNaN(Number(quoteSeedAmount)) && Number(quoteSeedAmount) > 0 &&
    description;

  if (!valid) {
    await ctx.reply(
      [
        "Usage: `/proposemarket <target> <value> <data> <baseSeedAmount> <quoteSeedAmountMON> <description>`",
        "",
        "`baseSeedAmount` is DAO governance tokens (needs your prior approval to the governance contract), " +
          "`quoteSeedAmountMON` is native MON you're sending to seed the other side of both markets.",
        "",
        "Example:",
        "`/proposemarket 0xRecipient 0 0x 1000 5 Fund the marketing campaign`",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Deploying and seeding both markets — this takes a moment…");

  try {
    await ensureGasFunded(account, true);
    const adapter = getAdapter("decisionMarkets");
    const actions = [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }];

    const { proposalId } = await adapter.proposeWithSeed(
      client,
      address,
      actions,
      description,
      baseSeedAmount,
      quoteSeedAmount
    );

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${proposalId} created, both markets are live. Use /trade to back Pass or Fail.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't create the proposal: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /vote
//////////////////////////////////////////////////////////////*/

const VOTE_CHOICES = { for: 1, against: 0, abstain: 2 };

bot.command("vote", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const [id, choiceRaw, ...reasonParts] = args;
  const choice = choiceRaw?.toLowerCase();
  const reason = reasonParts.length > 0 ? reasonParts.join(" ") : undefined;

  if (!id || !/^\d+$/.test(id) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/vote <id> for|against|abstain [reason]`", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting vote…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    const { weight } = await adapter.vote(client, address, id, VOTE_CHOICES[choice], reason);

    const weightNote =
      weight !== undefined
        ? weight === 0n
          ? "\n\n⚠️ This vote carried *zero weight* - your tokens likely weren't staked before this proposal's snapshot block. It's recorded, but didn't affect the tally. Future proposals will count your current stake correctly."
          : `\nWeight: ${formatEther(weight)}`
        : "";

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Voted *${choice}* on proposal #${id}.${weightNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't vote: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /queue
//////////////////////////////////////////////////////////////*/

bot.command("queue", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/queue 3` — queues a proposal that has passed voting, starting its timelock.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Queuing proposal…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.queue(client, address, id);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${id} queued. Check /proposal ${id} for when it becomes executable.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't queue: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                              /execute
//////////////////////////////////////////////////////////////*/

bot.command("execute", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const args = ctx.match?.trim().split(/\s+/) ?? [];
  const [id, valueRaw] = args;
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/execute 3 [nativeValue]` — runs a queued proposal's actions once its timelock has passed. Omit nativeValue unless the proposal's actions require sending MON.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Executing proposal…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.execute(client, address, id, valueRaw ? Number(valueRaw) : 0);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} executed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't execute: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /cancel
//////////////////////////////////////////////////////////////*/

bot.command("cancel", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/cancel 3` — withdraws a proposal you created, before it's been decided.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Cancelling proposal…");

  try {
    await ensureGasFunded(account);
    const model = getChatModel(ctx.chat.id);
    const adapter = getAdapter(model);
    await adapter.cancel(client, address, id);

    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} cancelled.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't cancel: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /unstake
//////////////////////////////////////////////////////////////*/

/*//////////////////////////////////////////////////////////////
                        /confirm, /revoke
//////////////////////////////////////////////////////////////*/

bot.command("confirm", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.confirm !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no confirmation step - use /vote instead.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/confirm 3` — as a signer, confirms proposal #3.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Confirming…");

  try {
    await ensureGasFunded(account);
    await adapter.confirm(client, address, id);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Confirmed proposal #${id}. It queues automatically once enough signers confirm.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't confirm: ${err.shortMessage || err.message}`
    );
  }
});

bot.command("revoke", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.revokeConfirmation !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no confirmation step to revoke.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/revoke 3` — withdraws your confirmation on proposal #3.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Revoking confirmation…");

  try {
    await ensureGasFunded(account);
    await adapter.revokeConfirmation(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Confirmation on proposal #${id} revoked.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't revoke: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                      /delegate, /undelegate
//////////////////////////////////////////////////////////////*/

bot.command("delegate", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.delegate !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no delegation.`);
    return;
  }

  const to = ctx.match?.trim();
  if (!to || !isAddress(to)) {
    await ctx.reply("Usage: `/delegate 0xSomeAddress` — sends your voting power to someone else.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Delegating…");

  try {
    await ensureGasFunded(account);
    await adapter.delegate(client, address, to);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Delegated your voting power to \`${short(to)}\`.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't delegate: ${err.shortMessage || err.message}`);
  }
});

bot.command("undelegate", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.undelegate !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no delegation.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Undelegating…");

  try {
    await ensureGasFunded(account);
    await adapter.undelegate(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Voting power returned to you directly.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't undelegate: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /challenge
//////////////////////////////////////////////////////////////*/

bot.command("challenge", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.challenge !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has nothing to challenge.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/challenge 3` — disputes proposal #3 within its challenge window, posting the configured bond and opening a fallback vote.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Challenging…");

  try {
    await ensureGasFunded(account);
    await adapter.challenge(client, address, id);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposal #${id} challenged. Fallback vote is now open - use /vote ${id} for|against|abstain.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't challenge: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                    /support, /withdrawsupport
//////////////////////////////////////////////////////////////*/

bot.command("support", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.support !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no continuous support to back - use /vote instead.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/support <id>` — backs a proposal with your entire staked balance. Replaces whatever you were previously supporting, if anything.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Backing this proposal…");

  try {
    await ensureGasFunded(account);
    const { weight } = await adapter.support(client, address, id);

    const weightNote =
      weight === 0n
        ? "\n\n⚠️ This carried *zero weight* - you likely have no staked balance right now. It's recorded, but doesn't actually back the proposal. Stake first, then support again."
        : `\nWeight: ${formatEther(weight)}`;

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Now backing proposal #${id} with your full staked balance.${weightNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't back that proposal: ${err.shortMessage || err.message}`);
  }
});

bot.command("withdrawsupport", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.withdrawSupport !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no continuous support to withdraw.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Withdrawing your support…");

  try {
    await ensureGasFunded(account);
    await adapter.withdrawSupport(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Support withdrawn. Your staked tokens are unlocked.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't withdraw support: ${err.shortMessage || err.message}`);
  }
});

bot.command("mysupport", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.getCurrentSupport !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no continuous support to check.`);
    return;
  }

  try {
    const userAddress = await getUserAddress(ctx.from.id);
    const proposalId = await adapter.getCurrentSupport(address, userAddress);
    if (proposalId === 0n) {
      await ctx.reply("You're not currently backing any proposal.");
    } else {
      await ctx.reply(`You're currently backing proposal #${proposalId}.`);
    }
  } catch (err) {
    console.error(err);
    await ctx.reply(`Couldn't check your support: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
              /registereligible, /withdraweligibility
//////////////////////////////////////////////////////////////*/

bot.command("registereligible", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.registerEligible !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no eligibility pool.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Registering…");

  try {
    await ensureGasFunded(account);
    await adapter.registerEligible(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ You're in the eligible pool for the next sortition draw.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't register: ${err.shortMessage || err.message}`);
  }
});

bot.command("withdraweligibility", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.withdrawEligibility !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no eligibility pool.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Withdrawing from the pool…");

  try {
    await ensureGasFunded(account);
    await adapter.withdrawEligibility(client, address);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      "✅ Removed from the eligible pool. This doesn't remove you from a council you're already serving on."
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't withdraw: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
              /startsortition, /finalizesortition
//////////////////////////////////////////////////////////////*/

bot.command("startsortition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.startSortition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no sortition draw.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Requesting randomness for a new sortition round…");

  try {
    await ensureGasFunded(account);
    const { round } = await adapter.startSortition(client, address);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Sortition round ${round} started. Once the randomness request is fulfilled, run /finalizesortition to draw the new council.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't start sortition: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                        /settlesortition
//////////////////////////////////////////////////////////////*/

bot.command("settlesortition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "sortition") {
    await ctx.reply(`This DAO uses ${model} governance, which has no randomness to settle.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply(
    "⏳ Checking the current sortition round and settling with Switchboard if it's ready — this can take a moment…"
  );

  try {
    await ensureGasFunded(account);
    const result = await settleSortitionRandomness(client, address);

    switch (result.status) {
      case "no-pending-round":
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "No sortition round has been started yet — use /startsortition first.");
        break;
      case "already-settled":
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "This round's randomness is already settled. Use /finalizesortition to draw the council.");
        break;
      case "not-ready":
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `Not ready yet — Switchboard's minimum settlement delay hasn't passed. Try again in about ${result.readyIn} more second(s).`
        );
        break;
      case "settled":
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Randomness settled. Use /finalizesortition to draw the new council.");
        break;
    }
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't settle randomness: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizesortition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeSortition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no sortition draw.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Drawing the new council…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeSortition(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ New council drawn. Use /council to see the roster.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't finalize sortition (the randomness request may not be fulfilled yet): ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                              /council
//////////////////////////////////////////////////////////////*/

bot.command("council", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.getCouncil !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no council.`);
    return;
  }

  try {
    const council = await adapter.getCouncil(address);
    const lines = council.map((addr, i) => `${i + 1}. \`${short(addr)}\``);
    await ctx.reply(`*Current council* (${council.length}):\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't read the council.");
  }
});

/*//////////////////////////////////////////////////////////////
    /startelection, /declarecandidacy, /voteinelection,
    /finalizeelection
//////////////////////////////////////////////////////////////*/

bot.command("startelection", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.startElection !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Opening a new election…");

  try {
    await ensureGasFunded(account);
    const { electionId } = await adapter.startElection(client, address);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Election #${electionId} opened. Candidates: /declarecandidacy ${electionId}. Voters: /voteinelection ${electionId} once candidacy closes.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't start the election: ${err.shortMessage || err.message}`);
  }
});

bot.command("declarecandidacy", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.declareCandidacy !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  const electionId = ctx.match?.trim();
  if (!electionId || !/^\d+$/.test(electionId)) {
    await ctx.reply("Usage: `/declarecandidacy <electionId>` — declares your candidacy in an open election.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Declaring candidacy…");

  try {
    await ensureGasFunded(account);
    await adapter.declareCandidacy(client, address, electionId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ You're a candidate in election #${electionId}.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't declare candidacy: ${err.shortMessage || err.message}`);
  }
});

bot.command("voteinelection", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.voteInElection !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  // Format: /voteinelection <electionId> <candidate1> [candidate2] ...
  const parts = (ctx.match?.trim() ?? "").split(/\s+/);
  const [electionId, ...candidates] = parts;

  if (!electionId || !/^\d+$/.test(electionId) || candidates.length === 0 || !candidates.every(isAddress)) {
    await ctx.reply(
      "Usage: `/voteinelection <electionId> <candidate1> [candidate2] ...` — votes for up to councilSize distinct candidates.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting your election vote…");

  try {
    await ensureGasFunded(account);
    const { weight } = await adapter.voteInElection(client, address, electionId, candidates);

    const weightNote =
      weight === 0n
        ? "\n\n⚠️ This carried *zero weight* - your tokens likely weren't staked before this election's snapshot block. It's recorded, but doesn't affect any candidate's tally."
        : `\nWeight: ${formatEther(weight)}`;

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Voted for ${candidates.length} candidate(s) in election #${electionId}.${weightNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeelection", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeElection !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no elections.`);
    return;
  }

  const electionId = ctx.match?.trim();
  if (!electionId || !/^\d+$/.test(electionId)) {
    await ctx.reply("Usage: `/finalizeelection <electionId>` — closes voting and seats the top vote-getters as the new council.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing the election…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeElection(client, address, electionId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Election finalized. Use /council to see the new roster.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize the election: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
    /initiaterecall, /voterecall, /finalizerecall
//////////////////////////////////////////////////////////////*/

bot.command("initiaterecall", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.initiateRecall !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no recall.`);
    return;
  }

  const delegateAddress = ctx.match?.trim();
  if (!delegateAddress || !isAddress(delegateAddress)) {
    await ctx.reply("Usage: `/initiaterecall 0xCouncilMember` — starts a token-weighted vote to remove a sitting council member.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Starting a recall vote…");

  try {
    await ensureGasFunded(account);
    const { recallId } = await adapter.initiateRecall(client, address, delegateAddress);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Recall #${recallId} started against \`${short(delegateAddress)}\`. Vote with /voterecall ${recallId} for|against|abstain.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't start the recall: ${err.shortMessage || err.message}`);
  }
});

bot.command("voterecall", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.voteRecall !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no recall.`);
    return;
  }

  const [recallId, choiceRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const choice = choiceRaw?.toLowerCase();
  if (!recallId || !/^\d+$/.test(recallId) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/voterecall <recallId> for|against|abstain`", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting your recall vote…");

  try {
    await ensureGasFunded(account);
    await adapter.voteRecall(client, address, recallId, VOTE_CHOICES[choice]);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Voted *${choice}* on recall #${recallId}.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizerecall", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeRecall !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no recall.`);
    return;
  }

  const recallId = ctx.match?.trim();
  if (!recallId || !/^\d+$/.test(recallId)) {
    await ctx.reply("Usage: `/finalizerecall <recallId>` — closes voting and removes the council member if the recall passed.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing the recall…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeRecall(client, address, recallId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Recall finalized. Use /council to check the roster.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize the recall: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
    SOWELLIAN LIFECYCLE - approval vote, positions, both
    resolution tracks, adjudication, settlement
//////////////////////////////////////////////////////////////*/

const OUTCOME_CHOICES = { success: 1, failure: 2 }; // Outcome.Unresolved (0) deliberately excluded - invalid for these calls

bot.command("castapprovalvote", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.castApprovalVote !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no approval vote.`);
    return;
  }

  const [id, choiceRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const choice = choiceRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || !(choice in VOTE_CHOICES)) {
    await ctx.reply("Usage: `/castapprovalvote <id> for|against|abstain` — votes on whether a proposal opens for betting.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting approval vote…");

  try {
    await ensureGasFunded(account);
    const { weight } = await adapter.castApprovalVote(client, address, id, VOTE_CHOICES[choice]);

    const weightNote =
      weight === 0n
        ? "\n\n⚠️ This vote carried *zero weight* - your tokens likely weren't staked before this proposal's approval snapshot block. It's recorded, but didn't affect the tally."
        : `\nWeight: ${formatEther(weight)}`;

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Voted *${choice}* on proposal #${id}'s approval.${weightNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeapproval", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeApproval !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no approval vote.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeapproval <id>` — closes the approval vote and opens the positions market if it passed.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing approval…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeApproval(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Approval finalized for proposal #${id}. Check /proposal ${id} for the outcome.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("takeposition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.takePosition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no positions market.`);
    return;
  }

  const [id, sideRaw, amount] = (ctx.match?.trim() ?? "").split(/\s+/);
  const side = sideRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || (side !== "yes" && side !== "no") || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply(
      "Usage: `/takeposition <id> yes|no <amount>` — backs the metric ending up true (yes) or false (no). Positions can only grow, never shrink.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Taking your position…");

  try {
    await ensureGasFunded(account);
    await adapter.takePosition(client, address, id, side === "yes" ? 0 : 1, amount);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Backed *${side}* on proposal #${id} with ${amount} tokens.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't take that position: ${err.shortMessage || err.message}`);
  }
});

bot.command("resolveviaoracle", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.resolveViaOracle !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no oracle-track resolution.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/resolveviaoracle <id>` — reads the proposal's configured oracle and finalizes automatically.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Reading the oracle and resolving…");

  try {
    await ensureGasFunded(account);
    await adapter.resolveViaOracle(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} resolved via oracle. Use /claimposition ${id} to collect a winning position.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't resolve: ${err.shortMessage || err.message}`);
  }
});

bot.command("proposeresolution", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.proposeResolution !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no human-track resolution.`);
    return;
  }

  const [id, outcomeRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const outcome = outcomeRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || !(outcome in OUTCOME_CHOICES)) {
    await ctx.reply(
      "Usage: `/proposeresolution <id> success|failure` — states what you believe the real outcome was, posting a bond. Others can dispute within the challenge window.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Proposing resolution…");

  try {
    await ensureGasFunded(account);
    await adapter.proposeResolution(client, address, id, OUTCOME_CHOICES[outcome]);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Proposed *${outcome}* for proposal #${id}. If unchallenged, run /finalizeunchallenged ${id} once the window closes.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't propose a resolution: ${err.shortMessage || err.message}`);
  }
});

bot.command("challengeresolution", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.challengeResolution !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no resolution to dispute.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply(
      "Usage: `/challengeresolution <id>` — disputes a proposed resolution, posting a bond and opening the adjudication vote.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Challenging the resolution…");

  try {
    await ensureGasFunded(account);
    await adapter.challengeResolution(client, address, id);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Resolution challenged for proposal #${id}. Adjudication vote is open - use /castadjudicationvote ${id} success|failure.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't challenge: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeunchallenged", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeUnchallenged !== "function") {
    await ctx.reply(`This DAO uses ${model} governance - for optimistic proposals, use /queue instead, which handles this automatically.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeunchallenged <id>` — finalizes a resolution that went unchallenged through its full window.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeUnchallenged(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} finalized as originally proposed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("castadjudicationvote", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.castAdjudicationVote !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no adjudication vote.`);
    return;
  }

  const [id, outcomeRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const outcome = outcomeRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || !(outcome in OUTCOME_CHOICES)) {
    await ctx.reply("Usage: `/castadjudicationvote <id> success|failure` — votes on the true outcome of a disputed resolution.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Casting adjudication vote…");

  try {
    await ensureGasFunded(account);
    const { weight } = await adapter.castAdjudicationVote(client, address, id, OUTCOME_CHOICES[outcome]);

    const weightNote =
      weight === 0n
        ? "\n\n⚠️ This vote carried *zero weight* - your tokens likely weren't staked before this proposal's adjudication snapshot block. It's recorded, but didn't affect the tally."
        : `\nWeight: ${formatEther(weight)}`;

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Voted *${outcome}* on proposal #${id}'s adjudication.${weightNote}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't vote: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeadjudication", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeAdjudication !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no adjudication vote.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeadjudication <id>` — closes the adjudication vote and settles the resolver/challenger bonds.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Finalizing adjudication…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeAdjudication(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Adjudication finalized for proposal #${id}. Use /claimposition ${id} to collect a winning position.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("claimposition", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.claimPosition !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no positions to claim.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/claimposition <id>` — collects your share of the pool if you backed the winning side.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Claiming…");

  try {
    await ensureGasFunded(account);
    await adapter.claimPosition(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Position claimed for proposal #${id}.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't claim: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
    DECISION MARKETS - trade, finalize, reclaim liquidity
//////////////////////////////////////////////////////////////*/

bot.command("split", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "decisionMarkets") {
    await ctx.reply(`This DAO uses ${model} governance, which has no split tokens.`);
    return;
  }

  const [id, sideRaw, amount] = (ctx.match?.trim() ?? "").split(/\s+/);
  const side = sideRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || (side !== "base" && side !== "quote") || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply(
      "Usage: `/split <id> base|quote <amount>` — splits real tokens into an equal amount of pass and fail conditional tokens, so you have something to /trade. `base` = the DAO token side, `quote` = the MON/WMON side.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Splitting…");

  try {
    await ensureGasFunded(account);
    const { baseVault, quoteVault } = await getProposalVaults(address, id);
    await splitTokens(client, side === "base" ? baseVault : quoteVault, amount);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Split ${amount} tokens into pass/fail conditional tokens on the ${side} side.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't split: ${err.shortMessage || err.message}`);
  }
});

bot.command("merge", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "decisionMarkets") {
    await ctx.reply(`This DAO uses ${model} governance, which has no conditional tokens to merge.`);
    return;
  }

  const [id, sideRaw, amount] = (ctx.match?.trim() ?? "").split(/\s+/);
  const side = sideRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || (side !== "base" && side !== "quote") || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply(
      "Usage: `/merge <id> base|quote <amount>` — reverses a split before resolution, returning your real tokens. Only works before /finalizeproposal has resolved this proposal.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Merging…");

  try {
    await ensureGasFunded(account);
    const { baseVault, quoteVault } = await getProposalVaults(address, id);
    await mergeTokens(client, side === "base" ? baseVault : quoteVault, amount);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Merged ${amount} conditional tokens back into real tokens on the ${side} side.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't merge: ${err.shortMessage || err.message}`);
  }
});

bot.command("redeem", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "decisionMarkets") {
    await ctx.reply(`This DAO uses ${model} governance, which has no conditional tokens to redeem.`);
    return;
  }

  const [id, sideRaw] = (ctx.match?.trim() ?? "").split(/\s+/);
  const side = sideRaw?.toLowerCase();
  if (!id || !/^\d+$/.test(id) || (side !== "base" && side !== "quote")) {
    await ctx.reply(
      "Usage: `/redeem <id> base|quote` — redeems your entire conditional token balance for real tokens, weighted by the resolved outcome. Only works after /finalizeproposal has resolved this proposal.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Redeeming…");

  try {
    await ensureGasFunded(account);
    const { baseVault, quoteVault } = await getProposalVaults(address, id);
    await redeemTokens(client, side === "base" ? baseVault : quoteVault);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Redeemed your ${side}-side conditional tokens for real tokens.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't redeem: ${err.shortMessage || err.message}`);
  }
});

bot.command("unwrap", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (model !== "decisionMarkets") {
    await ctx.reply(`This DAO uses ${model} governance, which has no WMON to unwrap.`);
    return;
  }

  const amount = ctx.match?.trim();
  if (!amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply(
      "Usage: `/unwrap <amount>` — converts WMON you're holding back into native MON. Only needed if you actually want native currency back; skip this if you'd rather keep holding WMON to trade or seed another proposal.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Unwrapping…");

  try {
    await ensureGasFunded(account);
    await unwrapWmon(client, address, amount);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Unwrapped ${amount} WMON to native MON.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't unwrap: ${err.shortMessage || err.message}`);
  }
});

bot.command("trade", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.trade !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no trading markets.`);
    return;
  }

  // Format: /trade <id> pass|fail base|quote <amountIn> <minAmountOut>
  const [id, marketRaw, sideRaw, amountIn, minAmountOut] = (ctx.match?.trim() ?? "").split(/\s+/);
  const marketChoice = marketRaw?.toLowerCase();
  const sideChoice = sideRaw?.toLowerCase();
  const valid =
    id && /^\d+$/.test(id) &&
    (marketChoice === "pass" || marketChoice === "fail") &&
    (sideChoice === "base" || sideChoice === "quote") &&
    amountIn && !Number.isNaN(Number(amountIn)) && Number(amountIn) > 0 &&
    minAmountOut !== undefined && !Number.isNaN(Number(minAmountOut)) && Number(minAmountOut) >= 0;

  if (!valid) {
    await ctx.reply(
      [
        "Usage: `/trade <id> pass|fail base|quote <amountIn> <minAmountOut>`",
        "",
        "`pass`/`fail` picks which market; `base`/`quote` picks which conditional token you're selling (base = the DAO token side, quote = the MON side).",
        "`minAmountOut` is real slippage protection - never leave it at 0 in practice.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Trading…");

  try {
    await ensureGasFunded(account);
    await adapter.trade(
      client,
      address,
      id,
      marketChoice === "pass" ? 0 : 1,
      sideChoice === "base" ? 0 : 1,
      amountIn,
      minAmountOut
    );
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Traded on the *${marketChoice}* market for proposal #${id}.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't trade: ${err.shortMessage || err.message}`);
  }
});

bot.command("finalizeproposal", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.finalizeProposal !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no trading markets to finalize.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/finalizeproposal <id>` — compares both markets' TWAP and resolves pass or fail. Callable by anyone once trading closes.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Comparing market prices and finalizing…");

  try {
    await ensureGasFunded(account);
    await adapter.finalizeProposal(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Proposal #${id} finalized. Check /proposal ${id} for whether it passed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't finalize: ${err.shortMessage || err.message}`);
  }
});

bot.command("reclaimliquidity", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  const adapter = getAdapter(model);
  if (typeof adapter.reclaimLiquidity !== "function") {
    await ctx.reply(`This DAO uses ${model} governance, which has no seed liquidity to reclaim.`);
    return;
  }

  const id = ctx.match?.trim();
  if (!id || !/^\d+$/.test(id)) {
    await ctx.reply("Usage: `/reclaimliquidity <id>` — recovers a finalized proposal's seed liquidity back to its original proposer.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Reclaiming liquidity…");

  try {
    await ensureGasFunded(account);
    await adapter.reclaimLiquidity(client, address, id);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Seed liquidity for proposal #${id} reclaimed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't reclaim: ${err.shortMessage || err.message}`);
  }
});

bot.command("unstake", async (ctx) => {
  const address = await requireDAO(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const model = getChatModel(ctx.chat.id);
  if (!hasToken(model)) {
    await ctx.reply(
      `This DAO uses ${model} governance, which has no token or staking - signers act directly. There's nothing to unstake here.`
    );
    return;
  }

  const amountStr = ctx.match?.trim();
  const amount = Number(amountStr);
  if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
    await ctx.reply("Usage: `/unstake 50` — returns 50 of your staked tokens to your liquid balance.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = walletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Unstaking — this takes a moment…");

  try {
    await ensureGasFunded(account);
    const tokenAddress = await getGovernanceTokenAddress(model, address);
    await unstakeTokens(client, tokenAddress, amount);

    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Unstaked ${amount} tokens back to your liquid balance.`
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't unstake: ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                            ERROR HANDLING
//////////////////////////////////////////////////////////////*/

bot.catch((err) => {
  console.error("Unhandled bot error:", err);
  const ctx = err.ctx;
  if (ctx) {
    ctx.reply(`Something went wrong: ${err.error?.message || err.message || "unknown error"}`).catch(() => {});
  }
});

run(bot);
startEventListener(bot);

/*//////////////////////////////////////////////////////////////
                    WELCOME DISTRIBUTION
//////////////////////////////////////////////////////////////*/

/**
 * Attempts to distribute the welcome grant to a Telegram user in a given
 * chat. Returns a short status string describing what happened (used by
 * both the automatic join handler and the manual /claim fallback).
 *
 * NOTE ON TRUST: this only checks "has this address already claimed" and
 * "is a wallet linked" - it does not independently verify Telegram
 * membership beyond what grammY's own event told us. See
 * WelcomeDistributor.sol's natspec for the full trust-model note.
 */
async function attemptClaim(chatId, telegramUserId) {
  const distributorAddress = getChatDistributor(chatId);
  if (!distributorAddress) return { status: "no-distributor" };

  let account;
  try {
    account = await getOrCreateUserAccount(telegramUserId);
  } catch (err) {
    return { status: "no-wallet", error: err.message };
  }

  const alreadyClaimed = await hasAlreadyClaimed(distributorAddress, account.address).catch(() => false);
  if (alreadyClaimed) return { status: "already-claimed" };

  try {
    const hash = await distributeWelcomeGrant(distributorAddress, account.address);
    return { status: "sent", hash, walletAddress: account.address };
  } catch (err) {
    console.error("distributeWelcomeGrant failed:", err);
    return { status: "error", error: err.message };
  }
}

bot.on("message:new_chat_members", async (ctx) => {
  const distributorAddress = getChatDistributor(ctx.chat.id);
  if (!distributorAddress) return; // no distributor configured, nothing to do

  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;

    const result = await attemptClaim(ctx.chat.id, member.id);

    if (result.status === "sent") {
      await ctx.reply(`🎉 Welcome, ${member.first_name}! Sent your welcome tokens.`);
    }
    // "no-wallet" (MASTER_WALLET_SEED not configured), "already-claimed",
    // and "error" cases are silent here - a join event isn't the place to
    // surface a bot-wide misconfiguration to the whole group; /claim gives
    // the user a way to see what actually happened.
  }
});

bot.command("claim", async (ctx) => {
  const result = await attemptClaim(ctx.chat.id, ctx.from.id);

  switch (result.status) {
    case "no-distributor":
      await ctx.reply("No welcome distribution is set up for this group.");
      break;
    case "no-wallet":
      await ctx.reply(result.error || "Wallets aren't set up on this bot yet - ask an admin.");
      break;
    case "already-claimed":
      await ctx.reply("You've already claimed your welcome tokens.");
      break;
    case "sent":
      await ctx.reply(`✅ Sent your welcome tokens to \`${short(result.walletAddress)}\`.`, {
        parse_mode: "Markdown",
      });
      break;
    case "error":
      await ctx.reply("Something went wrong sending your tokens — try again in a moment.");
      break;
  }
});

/*//////////////////////////////////////////////////////////////
                    OPPORTUNITY MARKETS
    Separate system, separate network (Sepolia) - see
    src/opportunityMarket/ for the full implementation.
//////////////////////////////////////////////////////////////*/

bot.command("registermarket", async (ctx) => {
  const address = ctx.match?.trim();
  if (!address || !isAddress(address)) {
    await ctx.reply("Usage: `/registermarket 0xYourMarketAddress`", { parse_mode: "Markdown" });
    return;
  }

  try {
    await opportunityMarket.marketContract(address);
    await opportunityMarket.getUnderlyingDecimals(address);
  } catch (err) {
    await ctx.reply("Couldn't read an OpportunityMarket at that address on Sepolia. Double-check it's deployed and correct.");
    return;
  }

  registerMarket(ctx.chat.id, address);
  await ctx.reply(`✅ This group is now linked to the Opportunity Market at \`${short(address)}\`.`, { parse_mode: "Markdown" });
});

bot.command("unregistermarket", async (ctx) => {
  const address = getChatMarket(ctx.chat.id);
  if (!address) {
    await ctx.reply("No market is linked here.");
    return;
  }

  try {
    const deployer = await opportunityMarket.getDeployer(address);
    const callerAddress = isWalletStoreConfigured() ? await getUserAddress(ctx.from.id) : null;
    if (!callerAddress || getAddress(callerAddress) !== getAddress(deployer)) {
      await ctx.reply("Only this market's deployer can unregister it.");
      return;
    }
  } catch (err) {
    console.error(err);
    await ctx.reply("Couldn't confirm you're the deployer - try again in a moment.");
    return;
  }

  unregisterMarket(ctx.chat.id);
  await ctx.reply("Unlinked. Run /registermarket or /createmarket to link one again.");
});

bot.command("createmarket", async (ctx) => {
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }
  const factoryAddress = process.env.OPPORTUNITY_MARKET_FACTORY_ADDRESS;
  if (!factoryAddress) {
    await ctx.reply("No OpportunityMarketFactory configured on this bot - ask an admin to set OPPORTUNITY_MARKET_FACTORY_ADDRESS.");
    return;
  }

  const underlyingToken = ctx.match?.trim();
  if (!underlyingToken || !isAddress(underlyingToken)) {
    await ctx.reply(
      "Usage: `/createmarket 0xUnderlyingToken` — deploys a new, independent market. You become its deployer.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Deploying a new market on Sepolia…");

  try {
    const { marketAddress } = await opportunityMarket.createMarket(client, factoryAddress, underlyingToken);
    registerMarket(ctx.chat.id, marketAddress);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `✅ Market deployed at \`${short(marketAddress)}\` and linked to this group. You're its deployer.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't create the market: ${err.shortMessage || err.message}`);
  }
});

bot.command("listopportunity", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const metadataURI = ctx.match?.trim();
  if (!metadataURI) {
    await ctx.reply("Usage: `/listopportunity <metadataURI>` — adds a new opportunity people can back.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Listing…");

  try {
    const { id } = await opportunityMarket.listOpportunity(client, address, metadataURI);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Opportunity #${id ?? "?"} listed.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't list: ${err.shortMessage || err.message}`);
  }
});

bot.command("deposit", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const amountStr = ctx.match?.trim();
  if (!amountStr || Number.isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
    await ctx.reply(
      "Usage: `/deposit <amount>` — deposits the underlying token into the market. ⚠️ This initial deposit is publicly visible on-chain; only which opportunity you later back stays private.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Depositing…");

  try {
    await opportunityMarket.deposit(client, address, amountStr);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Deposited ${amountStr} tokens.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't deposit: ${err.shortMessage || err.message}`);
  }
});

/**
 * The actual bet-placing logic, shared between /back's inline-argument
 * path (args typed directly in the command) and the DM-reply path
 * (bare /back in a group, details supplied privately afterward).
 * `ctx` here may be the original group ctx (inline path) or the DM ctx
 * (reply path) - either way, replies go wherever `ctx.reply`/
 * `deliverPrivately` naturally route for that ctx.
 */
async function placeBet(ctx, marketAddress, targetId, amount) {
  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Encrypting and submitting your bet — this takes a moment…");

  try {
    await opportunityBack(client, marketAddress, Number(targetId), amount);
    await deliverPrivately(ctx, statusMsg, "✅ Bet placed confidentially.", "Confirmed your bet.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't place that bet: ${err.shortMessage || err.message}`);
  }
}

bot.command("back", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const raw = ctx.match?.trim() ?? "";

  // Bare /back in a group - the privacy-preserving path. Neither the
  // request nor the reply ever touches the group; both happen entirely
  // in DM. This is genuinely different from just DMing the *result*
  // (deliverPrivately) - typing the opportunity id and amount directly
  // into a group command would already leak them into that group's
  // permanent message history, regardless of what the bot does with
  // them afterward.
  if (!raw && ctx.chat.type !== "private") {
    pendingBackRequests.set(ctx.from.id, { marketAddress: address, groupChatId: ctx.chat.id });
    try {
      await ctx.api.sendMessage(
        ctx.from.id,
        "Reply here with your bet: `<opportunityId> <amount>`\n\nExample: `3 500`",
        { parse_mode: "Markdown" }
      );
      await ctx.reply("📬 Check your DMs to place your bet privately.");
    } catch (dmErr) {
      pendingBackRequests.delete(ctx.from.id);
      await ctx.reply("Couldn't DM you - please start a chat with me directly first (search for this bot and hit Start), then run `/back` again.");
    }
    return;
  }

  const [targetId, amount] = raw.split(/\s+/);
  if (!targetId || !/^\d+$/.test(targetId) || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply(
      "Usage: `/back` (with no arguments, in a group) — the bot will DM you to collect the details privately.\n\nOr `/back <opportunityId> <amount>` directly, if you don't mind those values sitting in this chat's message history.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  await placeBet(ctx, address, targetId, amount);
});

bot.command("mybalance", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Decrypting your balance — this needs a signature the first time…");

  try {
    const balance = await opportunityGetBalance(client, address);
    const decimals = await opportunityMarket.getUnderlyingDecimals(address);
    await deliverPrivately(ctx, statusMsg, `Your confidential balance: *${formatUnits(balance, decimals)}*`, "Sent your balance.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't read your balance: ${err.shortMessage || err.message}`);
  }
});

bot.command("mybet", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const index = ctx.match?.trim();
  if (!index || !/^\d+$/.test(index)) {
    await ctx.reply("Usage: `/mybet <index>` — decrypts one of your own bets (0 is your first).", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Decrypting…");

  try {
    const { target, amount } = await opportunityGetBet(client, address, index);
    const decimals = await opportunityMarket.getUnderlyingDecimals(address);
    await deliverPrivately(ctx, statusMsg, `Bet #${index}: opportunity *${target}*, amount *${formatUnits(amount, decimals)}*`, "Sent your bet details.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't read that bet: ${err.shortMessage || err.message}`);
  }
});

/*//////////////////////////////////////////////////////////////
                            /allbets
//////////////////////////////////////////////////////////////*/

bot.command("allbets", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply(
    "⏳ Decrypting every bet — this only works for the market's actual deployer, and needs a signature the first time…"
  );

  try {
    const bets = await opportunityGetAllBets(client, address);
    if (bets.length === 0) {
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "No bets placed yet.");
      return;
    }
    const decimals = await opportunityMarket.getUnderlyingDecimals(address);
    const lines = bets.map((b, i) => `${i + 1}. \`${short(b.bettor)}\` → opportunity *${b.target}*, amount *${formatUnits(b.amount, decimals)}*`);
    await deliverPrivately(ctx, statusMsg, `*All bets* (${bets.length}):\n${lines.join("\n")}`, "Sent the full bet list.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't read all bets (this only works if you're the market's deployer): ${err.shortMessage || err.message}`
    );
  }
});

/*//////////////////////////////////////////////////////////////
                            /analytics
//////////////////////////////////////////////////////////////*/

bot.command("analytics", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply(
    "⏳ Computing market analytics — this only works for the market's actual deployer, and needs a signature the first time…"
  );

  try {
    const stats = await opportunityGetAnalytics(client, address);
    const decimals = await opportunityMarket.getUnderlyingDecimals(address);
    const lines = stats.opportunities.map(
      (o) => `#${o.id} (\`${short(o.lister)}\`): *${formatUnits(o.totalStaked, decimals)}* staked across *${o.backerCount}* backer(s)`
    );
    const message = [
      `*Market analytics*`,
      "",
      `Total bets placed: *${stats.totalBets}*`,
      `Total staked overall: *${formatUnits(stats.totalStakedOverall, decimals)}*`,
      `Unique bettors: *${stats.totalUniqueBettors}*`,
      "",
      "*Per opportunity:*",
      ...(lines.length ? lines : ["No opportunities listed yet."]),
    ].join("\n");
    await deliverPrivately(ctx, statusMsg, message, "Sent the market analytics.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      `Couldn't compute analytics (this only works if you're the market's deployer): ${err.shortMessage || err.message}`
    );
  }
});

bot.command("fundrewardpool", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const amountStr = ctx.match?.trim();
  if (!amountStr || Number.isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
    await ctx.reply("Usage: `/fundrewardpool <amount>` — deployer-only. Funds the pool paid out to backers of the winning opportunity.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Funding the reward pool…");

  try {
    await opportunityMarket.fundRewardPool(client, address, amountStr);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Reward pool funded with ${amountStr} tokens.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't fund the pool: ${err.shortMessage || err.message}`);
  }
});

bot.command("cancelmarket", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Cancelling the market — deployer-only…");

  try {
    await opportunityMarket.cancelMarket(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Market cancelled. Backers can reclaim their stakes.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't cancel: ${err.shortMessage || err.message}`);
  }
});

bot.command("resolve", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const winningId = ctx.match?.trim();
  if (!winningId || !/^\d+$/.test(winningId)) {
    await ctx.reply("Usage: `/resolve <winningOpportunityId>` — deployer-only. Declares which opportunity turned out real.", { parse_mode: "Markdown" });
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Resolving — deployer-only…");

  try {
    await opportunityMarket.resolve(client, address, winningId);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `✅ Market resolved. Winning opportunity: #${winningId}.`);
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't resolve: ${err.shortMessage || err.message}`);
  }
});

bot.command("reclaimstake", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Reclaiming your stake…");

  try {
    await opportunityMarket.reclaimStake(client, address);
    await deliverPrivately(ctx, statusMsg, "✅ Stake reclaimed.", "Confirmed your stake reclaim.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't reclaim: ${err.shortMessage || err.message}`);
  }
});

bot.command("computereward", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Computing your reward…");

  try {
    await opportunityMarket.computeReward(client, address);
    await deliverPrivately(ctx, statusMsg, "✅ Reward computed. Use /withdrawreward to collect it.", "Confirmed your reward computation.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't compute reward: ${err.shortMessage || err.message}`);
  }
});

bot.command("revealwinningtotal", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Revealing the aggregate winning total — this takes a moment…");

  try {
    await revealAndCompleteWinningTotal(client, address);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, "✅ Winning total revealed. Backers can now /computereward.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't reveal: ${err.shortMessage || err.message}`);
  }
});

bot.command("withdraw", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Withdrawing your stake — this takes a moment…");

  try {
    await revealAndCompleteWithdrawal(client, address, "stake");
    await deliverPrivately(ctx, statusMsg, "✅ Stake withdrawn.", "Confirmed your withdrawal.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't withdraw: ${err.shortMessage || err.message}`);
  }
});

bot.command("withdrawreward", async (ctx) => {
  const address = await requireMarket(ctx);
  if (!address) return;
  if (!isWalletStoreConfigured()) {
    await ctx.reply("Wallets aren't set up on this bot yet - ask an admin to configure the KMS/Supabase wallet system.");
    return;
  }

  const account = await getOrCreateUserAccount(ctx.from.id);
  const client = opportunityWalletClientFor(account);
  const statusMsg = await ctx.reply("⏳ Withdrawing your reward — this takes a moment…");

  try {
    await revealAndCompleteWithdrawal(client, address, "reward");
    await deliverPrivately(ctx, statusMsg, "✅ Reward withdrawn.", "Confirmed your reward withdrawal.");
  } catch (err) {
    console.error(err);
    await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `Couldn't withdraw: ${err.shortMessage || err.message}`);
  }
});

/**
 * Catches a DM reply to a pending /back request (see the bare-/back
 * branch above). Only ever acts on private-chat messages from a user
 * with a genuinely pending request, and only when the message isn't
 * itself a command - otherwise a stray "/help" typed while a request
 * happens to be pending would get swallowed as if it were bet details.
 */
bot.on("message:text", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  if (ctx.message.text.startsWith("/")) return;

  const pending = pendingBackRequests.get(ctx.from.id);
  if (!pending) return;

  const [targetId, amount] = ctx.message.text.trim().split(/\s+/);
  if (!targetId || !/^\d+$/.test(targetId) || !amount || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    await ctx.reply("That doesn't look right. Reply with: `<opportunityId> <amount>` — e.g. `3 500`", { parse_mode: "Markdown" });
    return; // keep the pending request open so they can just retry
  }

  pendingBackRequests.delete(ctx.from.id);
  await placeBet(ctx, pending.marketAddress, targetId, amount);
});

process.on("SIGINT", () => {
  bot.stop();
  process.exit(0);
});