import { isAddress, getAddress } from "viem";
import { walletClient, sortitionRandomnessSource } from "../../config.js";
import { ENABLED_NETWORKS, takeNetworkArg, runOnNetwork, currentNetwork, getNetwork, networkEnvName } from "../../networks.js";
import {
  registerChat,
  recordChatLinker,
  getChatModel,
  getChatNftWrapper,
  getChatGuardWrapper,
  getChatDistributor,
  registerDistributor,
  registerNftWrapper,
  registerGuardWrapper,
} from "../../db.js";
import {
  createDaoOnChain,
  getUnderlyingTokenAddress,
  deployWelcomeDistributor,
  deployNftWrapper,
  getDistributorInfo,
  hasAlreadyClaimed,
  distributeWelcomeGrant,
} from "../../contracts.js";
import { hasToken, getDaoInfo } from "../../governance/common.js";
import { createDAO as createQuadraticDAO } from "../../governance/quadratic.js";
import { createDAO as createLiquidDAO } from "../../governance/liquid.js";
import { createDAO as createOptimisticDAO } from "../../governance/optimistic.js";
import { createDAO as createDelegateDAO } from "../../governance/delegate.js";
import { createDAO as createBoardDAO } from "../../governance/board.js";
import { createDAO as createSortitionDAO } from "../../governance/sortition.js";
import { createDAO as createConvictionDAO } from "../../governance/conviction.js";
import { createDAO as createSowellianDAO } from "../../governance/sowellian.js";
import { createDAO as createDecisionMarketsDAO } from "../../governance/decisionMarkets.js";
import { getOrCreateUserAccount } from "../../walletResolver.js";
import { isWalletStoreConfigured } from "../../walletStore.js";
import * as guardWrapper from "../../wrapper.js";
import { computeHandoverProposals } from "../../proposalBuilder.js";
import { short } from "../../format.js";
import {
  NO_WALLETS,
  UserError,
  reply,
  privateReply,
  requireDao,
  requireGuardWrapper,
  requireCreator,
  mayManageLink,
  parseId,
  userClient,
} from "../helpers.js";

/**
 * Creating DAOs, welcome distribution, and the NFT / guard wrappers -
 * ported from index.js's Telegram handlers of the same names.
 */

// Same table as index.js's CREATE_DAO_FUNCTIONS. Board has no token, so
// it gets its own command, as on Telegram.
const CREATE_DAO_FUNCTIONS = {
  tokenWeighted: (n, s, i, m) => createDaoOnChain(n, s, i, m),
  quadratic: (n, s, i, m) => createQuadraticDAO(n, s, i, m),
  liquid: (n, s, i, m) => createLiquidDAO(n, s, i, m),
  optimistic: (n, s, i, m) => createOptimisticDAO(n, s, i, m),
  conviction: (n, s, i, m) => createConvictionDAO(n, s, i, m),
  sowellian: (n, s, i, m) => createSowellianDAO(n, s, i, m),
  decisionMarkets: (n, s, i, m) => createDecisionMarketsDAO(n, s, i, m),
  delegate: (n, s, i, m, extra) => createDelegateDAO(n, s, i, m, extra.council),
  sortition: (n, s, i, m, extra) => createSortitionDAO(n, s, i, m, extra.randomnessSource, extra.council),
};
/** Discord choices / help for the optional network argument. */
const NETWORK_OPTION = { name: "network", description: "Network (default: this bot's default)", required: false, choices: ENABLED_NETWORKS };

/** A user-facing error for a network word that is known but not enabled. */
function networkArg(args) {
  try {
    return takeNetworkArg(args);
  } catch (err) {
    throw new UserError(err.message);
  }
}

/** After creating a DAO the caller is both its creator and the channel's linker. */
function linkNewDao(ctx, governance, model, network = currentNetwork().id) {
  registerChat(ctx.chatId, governance, model, ctx.platform, ctx.userId, network);
  recordChatLinker(ctx.chatId, ctx.userId, ctx.platform, { keepCreator: true });
}

function assertMayRelink(ctx) {
  if (!mayManageLink(ctx)) throw new UserError("This channel is already linked to a DAO. Only whoever linked it, its creator, or an admin can replace that link.");
}

/** Same outcomes as index.js's attemptClaim, keyed by platform. */
async function attemptClaim(ctx) {
  const distributorAddress = getChatDistributor(ctx.chatId, ctx.platform);
  if (!distributorAddress) return { status: "no-distributor" };
  let account;
  try {
    account = await getOrCreateUserAccount(ctx.userId, ctx.platform);
  } catch (err) {
    return { status: "no-wallet", error: err.message };
  }
  if (await hasAlreadyClaimed(distributorAddress, account.address).catch(() => false)) return { status: "already-claimed" };
  try {
    const hash = await distributeWelcomeGrant(distributorAddress, account.address);
    return { status: "sent", hash, walletAddress: account.address };
  } catch (err) {
    console.error("distributeWelcomeGrant failed:", err);
    return { status: "error", error: err.message };
  }
}
export { attemptClaim };

export const SETUP_COMMANDS = {
  createdao: {
    section: "Setup",
    usage: "<name> <symbol> <initialSupply> <maxSupply> [model] [network] [council...]",
    description: "Create a new DAO and link it to this channel",
    options: [
      { name: "name", description: "DAO name (one word)", required: true },
      { name: "symbol", description: "Token symbol", required: true },
      { name: "initial_supply", description: "Initial token supply (whole tokens)", required: true },
      { name: "max_supply", description: "Maximum token supply (whole tokens)", required: true },
      { name: "model", description: "Governance model (default tokenWeighted)", required: false, choices: Object.keys(CREATE_DAO_FUNCTIONS) },
      NETWORK_OPTION,
      { name: "council", description: "delegate/sortition only: starting council addresses, space-separated", required: false, rest: true },
    ],
    async run(ctx) {
      const [name, symbol, initialSupplyStr, maxSupplyStr, ...tail] = ctx.args;
      // The network word can be anywhere after the supplies (Discord drops
      // omitted options, so positions shift) - take it out first.
      const { network, rest: afterNetwork } = networkArg(tail);
      const [modelArg, ...rest] = afterNetwork;
      if (!maxSupplyStr) {
        throw new UserError(
          [
            `Usage: \`${ctx.cmd("createdao")} <name> <symbol> <initialSupply> <maxSupply> [model] [network] [council...]\``,
            `Example: \`${ctx.cmd("createdao")} ArkDAO ARK 1000000 10000000\``,
            `Models: ${Object.keys(CREATE_DAO_FUNCTIONS).join(", ")} (default tokenWeighted). Delegate and sortition also need starting council addresses. For a token-less multisig use \`${ctx.cmd("createboarddao")}\`.`,
          ].join("\n")
        );
      }
      assertMayRelink(ctx);
      const model = modelArg || "tokenWeighted";
      const initialSupply = Number(initialSupplyStr);
      const maxSupply = Number(maxSupplyStr);

      if (!Number.isFinite(initialSupply) || !Number.isFinite(maxSupply) || initialSupply <= 0 || maxSupply <= 0) throw new UserError("Initial supply and max supply must be positive numbers.");
      if (initialSupply > maxSupply) throw new UserError("Initial supply can't exceed max supply.");

      const createFn = CREATE_DAO_FUNCTIONS[model];
      if (!createFn) {
        throw new UserError(model === "board" ? `Board has no token - use \`${ctx.cmd("createboarddao")}\` instead.` : `Unknown model "${model}". Supported: ${Object.keys(CREATE_DAO_FUNCTIONS).join(", ")}`);
      }

      let result;
      try {
        // Config checks and the factory call run on the chosen network.
        result = await runOnNetwork(network, async () => {
          let extra = {};
          if (model === "delegate" || model === "sortition") {
            if (rest.length === 0 || !rest.every((a) => isAddress(a, { strict: false }))) {
              throw new UserError(`${model} needs a starting council: \`${ctx.cmd("createdao")} <name> <symbol> <initialSupply> <maxSupply> ${model} <address...>\``);
            }
            if (model === "sortition" && !sortitionRandomnessSource()) throw new UserError(`This bot has no randomness source configured for ${currentNetwork().chain.name} yet - ask an admin to set ${networkEnvName(network, "SORTITION_RANDOMNESS_SOURCE")}.`);
            extra = model === "delegate" ? { council: rest } : { randomnessSource: sortitionRandomnessSource(), council: rest };
          }
          return createFn(name, symbol, initialSupply, maxSupply, extra);
        });
      } catch (err) {
        if (err instanceof UserError) throw err;
        // Same as Telegram: surface the full message, creation errors are config problems worth seeing.
        throw new UserError(`Couldn't create the DAO: ${err.shortMessage || err.message}`);
      }
      linkNewDao(ctx, result.governance, model, network);
      return reply(
        [
          `✅ *${name}* (${model}) created on ${getNetwork(network).chain.name} and linked to this channel.`,
          "",
          `Governance: \`${short(result.governance)}\``,
          hasToken(model) ? `Token (staking wrapper): \`${short(result.governanceToken)}\`` : null,
          hasToken(model) ? `Underlying token: \`${short(result.underlyingToken)}\`` : null,
          `Treasury: \`${short(result.treasury)}\``,
          "",
          `⚠️ The entire initial supply (${initialSupply} ${symbol}) is held by the bot's operator wallet for now. Use \`${ctx.cmd("tip")}\` (creator only) or a welcome distributor to get it to members.`,
        ]
          .filter((l) => l !== null)
          .join("\n")
      );
    },
  },

  createboarddao: {
    section: "Setup",
    usage: "<name> <signer1> <signer2> ... [network]",
    description: "Create a Board (multisig) DAO and link it here",
    options: [
      { name: "name", description: "DAO name (one word)", required: true },
      { name: "signers", description: "Signer addresses, space-separated", required: true, rest: true },
      NETWORK_OPTION,
    ],
    async run(ctx) {
      const [name, ...signerArgs] = ctx.args;
      const { network, rest: signers } = networkArg(signerArgs);
      if (!name || signers.length === 0) throw new UserError(`Usage: \`${ctx.cmd("createboarddao")} <name> <signer1> <signer2> ...\``);
      if (!signers.every((s) => isAddress(s, { strict: false }))) throw new UserError("All signer addresses must be valid.");
      assertMayRelink(ctx);
      let result;
      try {
        result = await runOnNetwork(network, () => createBoardDAO(name, signers));
      } catch (err) {
        throw new UserError(`Couldn't create the DAO: ${err.shortMessage || err.message}`);
      }
      linkNewDao(ctx, result.governance, "board", network);
      return reply(`✅ *${name}* (board) created on ${getNetwork(network).chain.name} and linked to this channel.\n\nGovernance: \`${short(result.governance)}\`\nTreasury: \`${short(result.treasury)}\`\nSigners: ${signers.length}`);
    },
  },

  deploywelcomedistributor: {
    section: "Setup",
    usage: "<amountPerClaim> <distributionCap>",
    description: "Deploy a welcome-token distributor (creator only)",
    options: [
      { name: "amount_per_claim", description: "Tokens each member can claim", required: true },
      { name: "distribution_cap", description: "Total tokens the distributor may hand out", required: true },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token - there's nothing to distribute.`);
      if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
      requireCreator(ctx, "Only this DAO's creator can deploy a welcome distributor.");
      const amountPerClaim = Number(ctx.args[0]);
      const distributionCap = Number(ctx.args[1]);
      if (!(amountPerClaim > 0) || !(distributionCap > 0)) throw new UserError(`Usage: \`${ctx.cmd("deploywelcomedistributor")} <amountPerClaim> <distributionCap>\``);
      if (distributionCap < amountPerClaim) throw new UserError("The distribution cap has to be at least as large as the amount per claim.");
      const tokenAddress = await getUnderlyingTokenAddress(address);
      const { distributorAddress } = await deployWelcomeDistributor(walletClient, tokenAddress, address, amountPerClaim, distributionCap);
      return reply(`✅ Deployed at \`${short(distributorAddress)}\`.\n\nTwo steps left:\n1. Send it enough of this DAO's token to cover claims (up to ${distributionCap})\n2. Run \`${ctx.cmd("setdistributor")} ${distributorAddress}\` to link it here`);
    },
  },

  setdistributor: {
    section: "Setup",
    usage: "<distributorAddress>",
    description: "Link a deployed welcome distributor (creator/linker/admin)",
    options: [{ name: "address", description: "WelcomeDistributor address", required: true }],
    async run(ctx) {
      requireDao(ctx);
      // Telegram doesn't gate this; here it follows the channel-link rule,
      // since whoever sets the distributor decides where claims come from.
      if (!mayManageLink(ctx)) throw new UserError("Only whoever linked this channel, its creator, or an admin can set its distributor.");
      const address = ctx.args[0];
      if (!address || !isAddress(address)) throw new UserError(`Usage: \`${ctx.cmd("setdistributor")} 0xYourWelcomeDistributorAddress\``);
      let info;
      try {
        info = await getDistributorInfo(address);
      } catch {
        throw new UserError("Couldn't read a WelcomeDistributor at that address. Double-check it's deployed correctly.");
      }
      registerDistributor(ctx.chatId, getAddress(address), ctx.platform);
      return reply(`✅ Welcome distributor linked. Members can run \`${ctx.cmd("claim")}\` to receive ${info.amountPerClaim} tokens.`);
    },
  },

  claim: {
    section: "Your wallet",
    usage: "",
    description: "Claim your welcome tokens",
    options: [],
    async run(ctx) {
      const result = await attemptClaim(ctx);
      switch (result.status) {
        case "no-distributor":
          throw new UserError("No welcome distribution is set up for this channel.");
        case "no-wallet":
          throw new UserError(result.error || NO_WALLETS);
        case "already-claimed":
          throw new UserError("You've already claimed your welcome tokens.");
        case "sent":
          return reply(`✅ Sent your welcome tokens to \`${short(result.walletAddress)}\`.`);
        default:
          throw new UserError("Something went wrong sending your tokens — try again in a moment.");
      }
    },
  },

  deploynftwrapper: {
    section: "Setup",
    usage: "",
    description: "Deploy this DAO's NFT marketplace wrapper (creator only)",
    options: [],
    async run(ctx) {
      const address = requireDao(ctx);
      requireCreator(ctx, "Only this DAO's creator can deploy an NFT marketplace wrapper.");
      const existing = getChatNftWrapper(ctx.chatId, ctx.platform);
      if (existing) throw new UserError(`This DAO already has one deployed at \`${short(existing)}\`.`);
      const { treasuryAddress } = await getDaoInfo(getChatModel(ctx.chatId, ctx.platform), address);
      const { wrapperAddress } = await deployNftWrapper(walletClient, address, treasuryAddress);
      registerNftWrapper(ctx.chatId, wrapperAddress, ctx.platform);
      return reply(`✅ Deployed at \`${short(wrapperAddress)}\` and linked to this DAO. It's where this DAO's NFTs live - send NFTs here, never to the Treasury (it can't receive them). Listing, sending NFTs out and sweeping proceeds back to Treasury all go through passed proposals.`);
    },
  },

  handovertowrapper: {
    section: "Guard wrapper",
    usage: "<wrapperAddress>",
    description: "Compute the proposals that hand control to a guard wrapper (creator only)",
    ephemeralByDefault: true,
    options: [{ name: "wrapper", description: "Deployed GuardWrapper address", required: true }],
    async run(ctx) {
      const address = requireDao(ctx);
      requireCreator(ctx, "Only this DAO's creator can compute a handover to a guard wrapper.");
      const wrapperAddress = ctx.args[0];
      if (!wrapperAddress || !isAddress(wrapperAddress)) throw new UserError(`Usage: \`${ctx.cmd("handovertowrapper")} <wrapperAddress>\` — computes the proposals only; nothing is submitted.`);
      const { treasuryAddress, treasuryData, underlyingTokenAddress, tokenData } = await computeHandoverProposals(getChatModel(ctx.chatId, ctx.platform), address, wrapperAddress);
      return privateReply(
        [
          "*Handover proposals* - each is a normal proposal needing a full vote. Run them one at a time:",
          "",
          "*1. Hand Treasury control to the wrapper:*",
          `\`${ctx.cmd("propose")} ${treasuryAddress} 0 ${treasuryData} Hand Treasury control to the security guard wrapper\``,
          "",
          ...(tokenData
            ? ["*2. Hand token-minting control to the wrapper:*", `\`${ctx.cmd("propose")} ${underlyingTokenAddress} 0 ${tokenData} Hand token-minting control to the security guard wrapper\``, ""]
            : []),
          "⚠️ Once #1 executes, Treasury actions must go through the wrapper's proposeInstruction and its signers. Same for minting after #2. Try a small test instruction first.",
        ].join("\n")
      );
    },
  },

  deployguardwrapper: {
    section: "Guard wrapper",
    usage: "<requiredApprovals> <tenureLengthSeconds> <signer1> <signer2> ...",
    description: "Deploy a guard wrapper for this DAO (creator only)",
    options: [
      { name: "required_approvals", description: "Confirmations needed per instruction", required: true, type: "integer" },
      { name: "tenure_seconds", description: "Seconds before signers can be replaced", required: true, type: "integer" },
      { name: "signers", description: "Signer addresses, space-separated", required: true, rest: true },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      requireCreator(ctx, "Only this DAO's creator can deploy a guard wrapper.");
      const existing = getChatGuardWrapper(ctx.chatId, ctx.platform);
      if (existing) throw new UserError(`This DAO already has one linked at \`${short(existing)}\`.`);
      const [requiredStr, tenureStr, ...signers] = ctx.args;
      const requiredApprovals = Number(requiredStr);
      const tenure = Number(tenureStr);
      if (!Number.isInteger(requiredApprovals) || requiredApprovals <= 0 || !Number.isInteger(tenure) || tenure <= 0 || signers.length === 0 || requiredApprovals > signers.length || !signers.every((s) => isAddress(s, { strict: false }))) {
        throw new UserError(`Usage: \`${ctx.cmd("deployguardwrapper")} <requiredApprovals> <tenureLengthSeconds> <signer1> <signer2> ...\` — e.g. \`2 2592000 0xA… 0xB… 0xC…\``);
      }
      const { wrapperAddress } = await guardWrapper.deployGuardWrapper(walletClient, address, signers, requiredApprovals, tenure);
      registerGuardWrapper(ctx.chatId, wrapperAddress, ctx.platform);
      return reply(`✅ Deployed at \`${short(wrapperAddress)}\` and linked. Nothing routes through it yet - use \`${ctx.cmd("handovertowrapper")} ${wrapperAddress}\` to compute the handover proposals.`);
    },
  },

  registerguardwrapper: {
    section: "Guard wrapper",
    usage: "<wrapperAddress>",
    description: "Link an existing guard wrapper (creator only)",
    options: [{ name: "wrapper", description: "GuardWrapper address", required: true }],
    async run(ctx) {
      requireDao(ctx);
      requireCreator(ctx, "Only this DAO's creator can link a guard wrapper.");
      const wrapperAddress = ctx.args[0];
      if (!wrapperAddress || !isAddress(wrapperAddress, { strict: false })) throw new UserError(`Usage: \`${ctx.cmd("registerguardwrapper")} <wrapperAddress>\``);
      registerGuardWrapper(ctx.chatId, getAddress(wrapperAddress.toLowerCase()), ctx.platform);
      return reply(`Linked. Run \`${ctx.cmd("guardwrapper")}\` to see its signers and status.`);
    },
  },

  guardwrapper: {
    section: "Guard wrapper",
    usage: "",
    description: "Show the guard wrapper's signers and status",
    options: [],
    async run(ctx) {
      const address = requireGuardWrapper(ctx);
      const [info, signers] = await Promise.all([guardWrapper.getWrapperInfo(address), guardWrapper.getSigners(address)]);
      return reply(
        [
          `*Guard wrapper* \`${short(address)}\``,
          `Governance: \`${short(info.governance)}\``,
          `Required confirmations: *${info.requiredApprovals}* of *${signers.length}* signers`,
          `Tenure ends: *${new Date(Number(info.tenureEnd) * 1000).toUTCString()}*`,
          `Instructions so far: *${info.instructionCount}*`,
          "",
          "*Signers:*",
          ...signers.map((s, i) => `${i + 1}. \`${short(s)}\``),
        ].join("\n")
      );
    },
  },

  instruction: {
    section: "Guard wrapper",
    usage: "<id>",
    description: "Show one guard-wrapper instruction",
    options: [{ name: "id", description: "Instruction ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireGuardWrapper(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("instruction")} <id>`);
      const ins = await guardWrapper.getInstruction(address, id);
      const status = ins.executed ? "✅ Executed" : ins.rejected ? "❌ Rejected" : "⏳ Pending";
      return reply([`*Instruction #${id}* — ${status}`, `Target: \`${ins.target}\``, `Value: *${ins.value}* wei`, `Confirmations: *${ins.confirmations}*`, `Rejections: *${ins.rejections}*`, "", "*Raw calldata:*", `\`${ins.data}\``].join("\n"));
    },
  },

  confirminstruction: {
    section: "Guard wrapper",
    usage: "<id>",
    description: "Signers: confirm an instruction (executes at threshold)",
    options: [{ name: "id", description: "Instruction ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireGuardWrapper(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("confirminstruction")} <id>`);
      const { client } = await userClient(ctx);
      const { hash } = await guardWrapper.confirmInstruction(client, address, id);
      return reply(`✅ Confirmed instruction #${id}.\nTx: \`${short(hash)}\`\n\nCheck \`${ctx.cmd("instruction")} ${id}\` to see if it's executed.`);
    },
  },

  rejectinstruction: {
    section: "Guard wrapper",
    usage: "<id>",
    description: "Signers: reject an instruction",
    options: [{ name: "id", description: "Instruction ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireGuardWrapper(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("rejectinstruction")} <id>`);
      const { client } = await userClient(ctx);
      const { hash } = await guardWrapper.rejectInstruction(client, address, id);
      return reply(`✅ Rejected instruction #${id}.\nTx: \`${short(hash)}\``);
    },
  },

  revokeconfirmation: {
    section: "Guard wrapper",
    usage: "<id>",
    description: "Withdraw your confirmation on an instruction",
    options: [{ name: "id", description: "Instruction ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireGuardWrapper(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("revokeconfirmation")} <id>`);
      const { client } = await userClient(ctx);
      const { hash } = await guardWrapper.revokeConfirmation(client, address, id);
      return reply(`✅ Revoked your confirmation on instruction #${id}.\nTx: \`${short(hash)}\``);
    },
  },
};
