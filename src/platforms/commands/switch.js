import { isAddress } from "viem";
import { getChatModel, getChatGuardWrapper, getChatNftWrapper, getPreviousGovernance } from "../../db.js";
import { currentNetwork } from "../../networks.js";
import { getAdapter, SUPPORTED_MODELS } from "../../governance/index.js";
import { takeModelOptions, checkModelOptions, modelOptionsUsage, proposeForModel, proposalNextStep } from "../../modelProposal.js";
import { buildSwitch, resolveModelWord, switchExtrasUsage } from "../../modelSwitch.js";
import { short } from "../../format.js";
import { UserError, reply, requireDao, userClient, proposalReply } from "../helpers.js";

function usage(ctx, model) {
  const extra = model ? modelOptionsUsage(model) : "";
  return [
    `Usage: \`${ctx.cmd("switchmodel")} <model> [council or signers…]${extra ? ` ${extra}` : ""} [description]\``,
    "",
    `Proposes moving this DAO to another governance model. Models: ${SUPPORTED_MODELS.join(", ")}.`,
    "Delegate and Sortition need a starting council and Board its signers: list their addresses after the model.",
    "The Treasury, token and everyone's stake stay where they are; only the governance contract changes, once the proposal passes and executes.",
    "",
    `Example: \`${ctx.cmd("switchmodel")} quadratic Move to quadratic voting\``,
    `Example: \`${ctx.cmd("switchmodel")} board 0xAaa… 0xBbb… 0xCcc…\``,
  ].join("\n");
}

export const SWITCH_COMMANDS = {
  switchmodel: {
    section: "Proposing",
    usage: "<model> [council or signers…] [description]",
    description: "Propose switching this DAO to another governance model",
    options: [
      { name: "model", description: "The model to switch to", required: true, choices: SUPPORTED_MODELS },
      { name: "details", description: "Council or signer addresses (delegate, sortition, board), settings, then a description", required: false, rest: true },
    ],
    async run(ctx) {
      const governance = requireDao(ctx);
      const fromModel = getChatModel(ctx.chatId, ctx.platform);
      const [modelWord, ...rest] = ctx.args;
      const toModel = resolveModelWord(modelWord);
      if (!toModel) throw new UserError(usage(ctx, fromModel));

      // Addresses are the new council/signers; name=value words are this
      // DAO's own proposal settings (Sowellian, Decision Markets); the rest
      // is the description.
      const { options, rest: words } = takeModelOptions(fromModel, rest);
      const members = words.filter((w) => isAddress(w, { strict: false }));
      const description = words.filter((w) => !isAddress(w, { strict: false })).join(" ") || `Switch this DAO to ${toModel} governance`;
      checkModelOptions(fromModel, options);

      const plan = await buildSwitch({
        fromModel,
        governance,
        toModel,
        members,
        guardWrapperAddress: getChatGuardWrapper(ctx.chatId, ctx.platform),
        nftWrapperAddress: getChatNftWrapper(ctx.chatId, ctx.platform),
      });

      const { client } = await userClient(ctx, { forceFullTopup: true });
      const { proposalId } = await proposeForModel({ model: fromModel, client, governanceAddress: governance, actions: plan.actions, description, options });

      const lines = [
        `✅ Proposal #${proposalId}: switch from ${fromModel} to *${toModel}* governance.`,
        "",
        `New governance (deployed when it executes): \`${plan.newGovernance}\``,
        `Treasury \`${short(plan.treasury)}\` stays put${plan.staking !== "0x0000000000000000000000000000000000000000" ? `, and so does every member's stake in \`${short(plan.staking)}\`` : ""}.`,
        `It runs on ${currentNetwork().chain.name}'s ${toModel} factory with the same starting rules as a new ${toModel} DAO${switchExtrasUsage(toModel) ? ` and the ${members.length} address${members.length === 1 ? "" : "es"} given` : ""}.`,
        "This chat follows the new governance automatically once the proposal executes.",
        ...plan.notes.map((n) => `• ${n}`),
        "",
        proposalNextStep(fromModel, proposalId, ctx.cmd),
      ];
      return proposalReply(ctx, governance, fromModel, proposalId, lines.join("\n"));
    },
  },

  // Solana DAOs answer this themselves (src/solana/commands.js): each model
  // keeps its own vault there. Here so Discord registers the command.
  migrate: {
    section: "Your wallet",
    usage: "",
    description: "Solana DAOs: move your stake from the models a DAO ran before into the current one",
    options: [],
    async run() {
      return reply("Nothing to move: an EVM DAO keeps one staking contract through every model switch, so your stake is already where it needs to be.", { ephemeral: true });
    },
  },

  withdrawsupport: {
    section: "Deciding",
    models: ["conviction"],
    usage: "",
    description: "Stop backing your current proposal (also on a Conviction governance this DAO switched away from)",
    options: [],
    async run(ctx) {
      const current = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const address = model === "conviction" ? current : getPreviousGovernance(ctx.chatId, "conviction", ctx.platform);
      if (!address) throw new UserError(`This DAO uses ${model} governance, which has no continuous support to withdraw.`);
      const { client } = await userClient(ctx);
      await getAdapter("conviction").withdrawSupport(client, address);
      return reply(
        model === "conviction"
          ? "✅ Support withdrawn. Your staked tokens are unlocked."
          : `✅ Support withdrawn on this DAO's earlier Conviction governance (\`${short(address)}\`). Your staked tokens are unlocked.`
      );
    },
  },
};
