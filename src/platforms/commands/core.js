import { takeModelOptions, checkModelOptions, modelOptionsUsage, proposeForModel, proposalNextStep } from "../../modelProposal.js";
import { isAddress, getAddress, formatEther } from "viem";
import { currentNetwork, takeNetworkArg, runOnNetwork, getNetwork, ENABLED_NETWORKS, describeNetwork } from "../../networks.js";
import { registerChat, recordChatLinker, getChatDAO, getChatModel, unregisterChat, getChatNftWrapper, getChatGuardWrapper, getChatNetwork, getRegisteredToken } from "../../db.js";
import { getProposalCount, getTreasuryBalance, getVotingPower } from "../../contracts.js";
import { getAdapter, SUPPORTED_MODELS } from "../../governance/index.js";
import { hasToken, getDaoInfo, getGovernanceTokenAddress, stakeTokens, unstakeTokens, isGovernanceModel, PROPOSAL_STATE_LABELS } from "../../governance/common.js";
import { getOrCreateUserAccount } from "../../walletResolver.js";
import { isWalletStoreConfigured } from "../../walletStore.js";
import { listActionsForModel, getAction } from "../../actionLibrary.js";
import { actionAppliesTo, actionArgSpec, buildActionProposal, buildIntegrationProposal } from "../../proposalBuilder.js";
import { getIntegrationAction, integrationUsage, IntegrationError } from "../../integrations/index.js";
import { integrationListLines, actionInfoText } from "../../integrations/describe.js";
import { CONFIG_DISPLAY_BY_MODEL, VOTE_CHOICES } from "../../display.js";
import { short, stateLine, formatDate } from "../../format.js";
import { NO_WALLETS, UserError, reply, requireDao, parseId, parseAmount, userClient, mayManageLink, callerAddress, proposalReply } from "../helpers.js";
import { budgetLine } from "../../governance/budgetText.js";
import { proposalPageUrl, pendingSubmitLink } from "../../proposalPages.js";
import { getUserAddress } from "../../walletResolver.js";

/** The everyday governance loop - linking, DAO info, wallet, staking, proposing, deciding. */
export const CORE_COMMANDS = {
  register: {
    description: "Link this channel to a deployed DAO",
    options: [
      { name: "address", description: "Governance contract address", required: true },
      { name: "model", description: "Governance model (default tokenWeighted)", required: false, choices: SUPPORTED_MODELS },
      { name: "network", description: "Network the DAO is on (default: this bot's default)", required: false, choices: ENABLED_NETWORKS },
    ],
    async run(ctx) {
      let network, args;
      try {
        ({ network, rest: args } = takeNetworkArg(ctx.args));
      } catch (err) {
        throw new UserError(err.message);
      }
      const [address, modelRaw] = args;
      const model = modelRaw || "tokenWeighted";
      if (!address || !isAddress(address)) {
        throw new UserError(`Usage: \`${ctx.cmd("register")} 0xYourGovernanceAddress [model] [network]\`\nModels: ${SUPPORTED_MODELS.join(", ")}\nNetworks: ${ENABLED_NETWORKS.join(", ")}`);
      }
      if (!SUPPORTED_MODELS.includes(model)) throw new UserError(`Unknown model "${model}". Supported: ${SUPPORTED_MODELS.join(", ")}`);
      if (!mayManageLink(ctx)) throw new UserError("This channel is already linked. Only whoever linked it, or an admin, can change that.");

      if (!(await runOnNetwork(network, () => isGovernanceModel(model, address)))) {
        throw new UserError(`Couldn't read a "${model}" DAO at that address on ${getNetwork(network).chain.name}. Double-check the address, model and network.`);
      }

      // Linking proves nothing about who created the DAO, so the caller is
      // recorded as the channel's linker, never as its creator - creator
      // status unlocks tip, which spends operator-held tokens.
      registerChat(ctx.chatId, getAddress(address), model, ctx.platform, undefined, network);
      recordChatLinker(ctx.chatId, ctx.userId, ctx.platform);
      return reply(`✅ This channel is now linked to the ${model} DAO at \`${short(address)}\` on ${getNetwork(network).chain.name}.`);
    },
  },

  network: {
    description: "Show which network this channel's DAO is on",
    options: [],
    async run(ctx) {
      const linked = Boolean(getChatDAO(ctx.chatId, ctx.platform));
      return reply(
        [
          linked ? `This channel's DAO is on ${describeNetwork()}.` : `No DAO linked here - commands use the default network, ${describeNetwork()}.`,
          "",
          `Networks enabled on this bot: ${ENABLED_NETWORKS.join(", ")}.`,
          `Pick one when creating or linking a DAO, e.g. \`${ctx.cmd("createdao")} MyDAO MDAO 1000 10000 quadratic base\`.`,
        ].join("\n")
      );
    },
  },

  unregister: {
    description: "Unlink this channel from its DAO",
    options: [],
    async run(ctx) {
      requireDao(ctx);
      if (!mayManageLink(ctx)) throw new UserError("Only whoever linked this channel, its creator, or an admin can unlink it.");
      unregisterChat(ctx.chatId, ctx.platform);
      return reply(`Unlinked. Run \`${ctx.cmd("register")}\` to link a DAO again.`);
    },
  },

  dao: {
    description: "Show this channel's DAO",
    options: [],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const { daoName, tokenAddress, treasuryAddress, config } = hasToken(model)
        ? await getDaoInfo(model, address)
        : await getAdapter(model).getDaoInfo(address);
      const lines = [
        `*${daoName}* (${model})`,
        `Governance: \`${short(address)}\``,
        hasToken(model) ? `Token: \`${short(tokenAddress)}\`` : null,
        `Treasury: \`${short(treasuryAddress)}\``,
        "",
        ...(CONFIG_DISPLAY_BY_MODEL[model]?.(config) ?? ["Config format not known for this model."]),
      ].filter((l) => l !== null);
      return reply(lines.join("\n"));
    },
  },

  treasury: {
    description: "Show the DAO treasury balance",
    options: [],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const { treasuryAddress } = hasToken(model) ? await getDaoInfo(model, address) : await getAdapter(model).getDaoInfo(address);
      const balance = await getTreasuryBalance(treasuryAddress);
      return reply(`🏦 Treasury \`${short(treasuryAddress)}\`\nBalance: *${balance} ${currentNetwork().nativeSymbol}*`);
    },
  },

  wallet: {
    description: "Show your wallet address",
    ephemeralByDefault: true,
    options: [],
    async run(ctx) {
      if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
      const account = await getOrCreateUserAccount(ctx.userId, ctx.platform);
      return reply(`Your wallet:\n\`${account.address}\`\n\nCreated automatically for your ${ctx.platform} account — no connect step needed.`, { ephemeral: true });
    },
  },

  balance: {
    description: "Show staked balance and voting power",
    options: [{ name: "address", description: "Address to check (default: yours)", required: false }],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token or voting balance.`);

      let target = ctx.args[0];
      if (target && !isAddress(target)) throw new UserError("That doesn't look like a valid address.");
      if (!target) {
        if (!isWalletStoreConfigured()) throw new UserError(`No address given, and wallets aren't set up. Use \`${ctx.cmd("balance")} 0xSomeAddress\`.`);
        target = await callerAddress(ctx);
      }

      const { tokenAddress } = await getDaoInfo(model, address);
      const { staked, activeVotes, delegatedTo } = await getVotingPower(tokenAddress, target);
      const delegationNote =
        delegatedTo === "0x0000000000000000000000000000000000000000"
          ? "\n⚠️ Not delegated — staked balance carries zero voting power until delegated."
          : `\nDelegated to: \`${short(delegatedTo)}\``;
      return reply(`*${short(target)}*\nStaked: ${staked}\nActive voting power: ${activeVotes}${delegationNote}`);
    },
  },

  proposals: {
    description: "List the latest proposals",
    options: [],
    async run(ctx) {
      const address = requireDao(ctx);
      const count = await getProposalCount(address);
      if (count === 0) return reply(`No proposals yet. Use \`${ctx.cmd("proposeaction")}\` to create one.`);

      const adapter = getAdapter(getChatModel(ctx.chatId, ctx.platform));
      const ids = Array.from({ length: Math.min(count, 10) }, (_, i) => count - i);
      const proposals = await Promise.all(ids.map((id) => adapter.getProposal(address, id)));
      const lines = proposals.map((p) => {
        const label = p.stateLabel ?? p.statusLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";
        return `#${p.id} — ${stateLine(label)}\n${String(p.metadataURI).slice(0, 80)}`;
      });
      return reply(`*Proposals* (showing ${ids.length} of ${count})\n\n${lines.join("\n\n")}\n\nUse \`${ctx.cmd("proposal")} <id>\` for full detail.`);
    },
  },

  proposal: {
    description: "Show one proposal in detail",
    options: [{ name: "id", description: "Proposal ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireDao(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("proposal")} 3`);
      const p = await getAdapter(getChatModel(ctx.chatId, ctx.platform)).getProposal(address, id);
      const label = p.stateLabel ?? p.statusLabel ?? PROPOSAL_STATE_LABELS[p.stateIndex] ?? "Unknown";

      const lines = [`*Proposal #${p.id}* — ${stateLine(label)}`, p.metadataURI, "", `Proposer: \`${short(p.proposer)}\``];
      // Same per-model branching as Telegram's /proposal: vote shapes differ.
      if ("forVotes" in p) {
        const fmt = (v) => (p.voteWeightUnit === "token" ? formatEther(v) : v.toString());
        const unit = p.voteWeightUnit === "token" ? "" : " (voting weight)";
        lines.push(`For: ${fmt(p.forVotes)} · Against: ${fmt(p.againstVotes)} · Abstain: ${fmt(p.abstainVotes)}${unit}`);
        if ("quorumVotes" in p) lines.push(`Quorum needed: ${formatEther(p.quorumVotes)}`);
      } else if ("requiredConviction" in p) {
        lines.push(`Conviction: ${formatEther(p.currentConviction)} / ${formatEther(p.requiredConviction)} needed`);
        if (p.budget) lines.push(budgetLine(p.budget));
      } else if ("confirmations" in p) {
        lines.push(`Confirmations: ${p.confirmations}`);
      } else if ("passTWAP" in p) {
        lines.push(`Pass TWAP: ${p.passTWAP} · Fail TWAP: ${p.failTWAP}`);
      } else if ("approvalForVotes" in p) {
        lines.push(`Approval — For: ${formatEther(p.approvalForVotes)} · Against: ${formatEther(p.approvalAgainstVotes)} · Abstain: ${formatEther(p.approvalAbstainVotes)}`);
      }
      lines.push("");
      if (p.startBlock !== undefined && p.endBlock !== undefined) lines.push(`Voting: block ${p.startBlock} → ${p.endBlock}`);
      else if (p.tradingDeadline !== undefined) lines.push(`Trading deadline: ${formatDate(p.tradingDeadline)}`);
      if (p.queuedAt > 0n) lines.push(`Queued at: ${formatDate(p.queuedAt)}`);
      if (p.executableAfter > 0n) lines.push(`Executable after: ${formatDate(p.executableAfter)}`);
      if (p.actions) lines.push(`Actions: ${p.actions.length}`);
      const page = proposalPageUrl(currentNetwork().id, address, id);
      if (page) lines.push("", `📄 Details and live status: ${page}`);
      // The proposer, before submitting details: their link again, privately.
      const submitLink = page
        ? await pendingSubmitLink({
            network: currentNetwork().id,
            dao: address,
            model: getChatModel(ctx.chatId, ctx.platform),
            proposalId: id,
            platform: ctx.platform,
            userId: ctx.userId,
            walletAddress: await getUserAddress(ctx.userId, ctx.platform).catch(() => null),
            cmd: ctx.cmd,
          }).catch(() => null)
        : null;
      return reply(lines.join("\n"), submitLink ? { privateFollowUp: submitLink } : {});
    },
  },

  stake: {
    description: "Stake tokens to activate voting power",
    options: [{ name: "amount", description: "Whole tokens to stake", required: true }],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token or staking.`);
      const amount = parseAmount(ctx.args[0], `${ctx.cmd("stake")} 100`);
      const { client } = await userClient(ctx);
      const tokenAddress = await getGovernanceTokenAddress(model, address);
      await stakeTokens(client, tokenAddress, amount);
      return reply(`✅ Staked ${amount} tokens. Your voting power is now active.`);
    },
  },

  unstake: {
    description: "Unstake tokens back to your liquid balance",
    options: [{ name: "amount", description: "Whole tokens to unstake", required: true }],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      if (!hasToken(model)) throw new UserError(`This DAO uses ${model} governance, which has no token or staking.`);
      const amount = parseAmount(ctx.args[0], `${ctx.cmd("unstake")} 50`);
      const { client } = await userClient(ctx);
      const tokenAddress = await getGovernanceTokenAddress(model, address);
      await unstakeTokens(client, tokenAddress, amount);
      return reply(`✅ Unstaked ${amount} tokens back to your liquid balance.`);
    },
  },

  listactions: {
    description: "List verified actions this DAO can propose",
    ephemeralByDefault: true,
    options: [],
    async run(ctx) {
      requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const lines = ["*Verified action library*", ""];
      const section = (title, actions) => {
        if (!actions.length) return;
        lines.push(`*${title}:*`);
        for (const a of actions) lines.push(`\`${a.id}\` — ${a.label}`);
        lines.push("");
      };
      section(`Governance (${model})`, listActionsForModel(model));
      section("Treasury & tokens", listActionsForModel("treasury").concat(listActionsForModel("token")));
      if (getChatNftWrapper(ctx.chatId, ctx.platform)) section("NFT wrapper", listActionsForModel("nftWrapper"));
      if (getChatGuardWrapper(ctx.chatId, ctx.platform)) section("Guard wrapper", listActionsForModel("guardWrapper"));
      lines.push(...integrationListLines(getChatNetwork(ctx.chatId, ctx.platform)).slice(1), "");
      lines.push(`Use \`${ctx.cmd("proposeaction")} <actionId> <args...> <description>\` to propose one, and \`${ctx.cmd("actioninfo")} <actionId>\` to see what any of them does and what its arguments mean.`);
      const extra = modelOptionsUsage(model);
      if (extra) lines.push(`This ${model} DAO also needs, anywhere after the action ID: \`${extra}\`.`);
      return reply(lines.join("\n"), { ephemeral: true });
    },
  },

  proposeaction: {
    description: "Propose a verified action",
    options: [
      { name: "action", description: "Action ID from listactions", required: true },
      { name: "args", description: "The action's arguments; Sowellian/Decision Markets also take settings (see actioninfo)", required: false },
      { name: "description", description: "What this proposal does", required: true, rest: true },
    ],
    // Discord passes args and description as separate options; Slack
    // passes one run of words. Both arrive here as [actionId, ...words],
    // and the action's own arg count decides where the description starts.
    async run(ctx) {
      const address = requireDao(ctx);
      const [actionId, ...rest] = ctx.args;
      const action = getAction(actionId);
      if (!action && getIntegrationAction(actionId)) return proposeIntegration(ctx, address, actionId, rest);
      if (!action) throw new UserError(`Usage: \`${ctx.cmd("proposeaction")} <actionId> <args...> <description>\` — see \`${ctx.cmd("listactions")}\`.`);

      const model = getChatModel(ctx.chatId, ctx.platform);
      const guardWrapperAddress = getChatGuardWrapper(ctx.chatId, ctx.platform);
      if (!actionAppliesTo(action, model, { nftWrapperAddress: getChatNftWrapper(ctx.chatId, ctx.platform), guardWrapperAddress })) {
        throw new UserError(`\`${actionId}\` doesn't apply to this DAO. See \`${ctx.cmd("listactions")}\`.`);
      }
      const { count, names } = actionArgSpec(action);
      // Platforms with separate fields (Discord) pass them in ctx.named, so
      // a missing argument is reported as missing instead of the first word
      // of the description being read as that argument. Sowellian and
      // Decision Markets settings (name=value) can sit in either field.
      const named = ctx.named;
      const argWords = takeModelOptions(model, named ? (named.args ?? "").split(/\s+/).filter(Boolean) : rest);
      const descWords = named ? takeModelOptions(model, (named.description ?? "").trim().split(/\s+/).filter(Boolean)) : { options: {}, rest: [] };
      const options = { ...argWords.options, ...descWords.options };
      const actionArgs = named ? argWords.rest : argWords.rest.slice(0, count);
      const description = named ? descWords.rest.join(" ") : argWords.rest.slice(count).join(" ");
      const extra = modelOptionsUsage(model);
      if (actionArgs.length !== count || !description) {
        throw new UserError(`Usage: \`${ctx.cmd("proposeaction")} ${actionId} ${names.join(" ")}${extra ? ` ${extra}` : ""} <description>\``);
      }
      checkModelOptions(model, options);

      const { target, data } = await buildActionProposal({ model, governanceAddress: address, actionId, actionArgs, guardWrapperAddress });
      const { client } = await userClient(ctx, { forceFullTopup: true });
      const { proposalId } = await proposeForModel({ model, client, governanceAddress: address, actions: [{ target, value: 0n, data }], description, options });
      return proposalReply(ctx, address, model, proposalId, `✅ Proposal #${proposalId} created via \`${actionId}\`.\n\n${proposalNextStep(model, proposalId, ctx.cmd)}`);
    },
  },

  actioninfo: {
    description: "What an action does, its arguments and their units",
    ephemeralByDefault: true,
    options: [{ name: "action", description: "Action ID from listactions", required: true }],
    async run(ctx) {
      const text = actionInfoText(ctx.args[0], getChatNetwork(ctx.chatId, ctx.platform), ctx.cmd("proposeaction"), {
        model: getChatModel(ctx.chatId, ctx.platform),
        nftWrapperAddress: getChatNftWrapper(ctx.chatId, ctx.platform),
        guardWrapperAddress: getChatGuardWrapper(ctx.chatId, ctx.platform),
      });
      if (!text) throw new UserError(`Usage: \`${ctx.cmd("actioninfo")} <actionId>\` — see \`${ctx.cmd("listactions")}\`.`);
      return reply(text, { ephemeral: true });
    },
  },

  propose: {
    description: "Propose a raw contract call (advanced)",
    options: [
      { name: "target", description: "Target contract address", required: true },
      { name: "value", description: "Native value in wei", required: true },
      { name: "data", description: "Hex calldata, or 0x", required: true },
      { name: "description", description: "What this proposal does", required: true, rest: true },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      if (model === "sowellian" || model === "decisionMarkets") {
        throw new UserError(`${model} proposals need extra parameters that aren't supported outside Telegram yet.`);
      }
      const [target, value, data, ...descriptionParts] = ctx.args;
      const description = descriptionParts.join(" ");
      if (!target || !isAddress(target) || !/^\d+$/.test(value ?? "") || !/^0x([0-9a-fA-F]{2})*$/.test(data ?? "") || !description) {
        throw new UserError(`Usage: \`${ctx.cmd("propose")} <target> <valueWei> <data> <description>\` — e.g. \`${ctx.cmd("propose")} 0xRecipient 0 0x Test proposal\``);
      }
      const { client } = await userClient(ctx, { forceFullTopup: true });
      const actions = [{ target: getAddress(target), value: BigInt(value), data }];
      const { proposalId } = await getAdapter(model).propose(client, address, actions, description);
      return proposalReply(ctx, address, model, proposalId, `✅ Proposal #${proposalId} created. Use \`${ctx.cmd("proposal")} ${proposalId}\` to check on it.`);
    },
  },

  vote: {
    description: "Vote on a proposal",
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "choice", description: "Your vote", required: true, choices: Object.keys(VOTE_CHOICES) },
      { name: "reason", description: "Optional reason", required: false, rest: true },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      const [idRaw, choiceRaw, ...reasonParts] = ctx.args;
      const choice = choiceRaw?.toLowerCase();
      const id = parseId(idRaw, `${ctx.cmd("vote")} <id> for|against|abstain [reason]`);
      if (!(choice in VOTE_CHOICES)) throw new UserError(`Usage: \`${ctx.cmd("vote")} <id> for|against|abstain [reason]\``);
      const reason = reasonParts.length ? reasonParts.join(" ") : undefined;

      const { client } = await userClient(ctx);
      const model = getChatModel(ctx.chatId, ctx.platform);
      const { weight } = await getAdapter(model).vote(client, address, id, VOTE_CHOICES[choice], reason);
      const weightNote =
        weight === undefined
          ? ""
          : weight === 0n
            ? "\n\n⚠️ This vote carried *zero weight* — your tokens likely weren't staked before this proposal's snapshot block."
            : `\nWeight: ${formatEther(weight)}`;
      const liquidNote = model === "liquid" ? `\n\nVotes delegated to you are added automatically within a minute (or run \`${ctx.cmd("resolvedelegations")} ${id}\`).` : "";
      return reply(`✅ Voted *${choice}* on proposal #${id}.${weightNote}${liquidNote}`);
    },
  },

  queue: {
    description: "Queue a passed proposal",
    options: [{ name: "id", description: "Proposal ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireDao(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("queue")} 3`);
      const { client } = await userClient(ctx);
      await getAdapter(getChatModel(ctx.chatId, ctx.platform)).queue(client, address, id);
      return reply(`✅ Proposal #${id} queued. Check \`${ctx.cmd("proposal")} ${id}\` for when it becomes executable.`);
    },
  },

  execute: {
    description: "Execute a queued proposal",
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "value", description: "Native currency to send, if the actions need it", required: false },
    ],
    async run(ctx) {
      const address = requireDao(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("execute")} 3 [nativeValue]`);
      const value = ctx.args[1] ? parseAmount(ctx.args[1], `${ctx.cmd("execute")} 3 [nativeValue]`) : 0;
      const { client } = await userClient(ctx);
      await getAdapter(getChatModel(ctx.chatId, ctx.platform)).execute(client, address, id, value);
      return reply(`✅ Proposal #${id} executed.`);
    },
  },

  cancel: {
    description: "Cancel a proposal you created",
    options: [{ name: "id", description: "Proposal ID", required: true, type: "integer" }],
    async run(ctx) {
      const address = requireDao(ctx);
      const id = parseId(ctx.args[0], `${ctx.cmd("cancel")} 3`);
      const { client } = await userClient(ctx);
      await getAdapter(getChatModel(ctx.chatId, ctx.platform)).cancel(client, address, id);
      return reply(`✅ Proposal #${id} cancelled.`);
    },
  },
};

/** proposeaction for an external-protocol action: several Treasury calls in one proposal. */
async function proposeIntegration(ctx, address, actionId, rest) {
  const model = getChatModel(ctx.chatId, ctx.platform);
  // Discord passes args and description as separate fields; join them so
  // name=value options and the description parse the same way as Slack.
  const allWords = ctx.named ? [...(ctx.named.args ?? "").split(/\s+/).filter(Boolean), ...(ctx.named.description ?? "").trim().split(/\s+/).filter(Boolean)] : rest;
  // Sowellian / Decision Markets settings come out first; the rest is the action's own.
  const { options: modelOptions, rest: words } = takeModelOptions(model, allWords);
  checkModelOptions(model, modelOptions);
  let built;
  try {
    built = await buildIntegrationProposal({
      model,
      governanceAddress: address,
      actionId,
      words,
      guardWrapperAddress: getChatGuardWrapper(ctx.chatId, ctx.platform),
      nftWrapperAddress: getChatNftWrapper(ctx.chatId, ctx.platform),
      lookupTicker: (ticker) => getRegisteredToken(ctx.chatId, ticker, ctx.platform),
    });
  } catch (err) {
    if (err instanceof IntegrationError) throw new UserError(err.message);
    throw err;
  }
  if (!built.description) {
    const extra = modelOptionsUsage(model);
    throw new UserError(`Add a description at the end: \`${ctx.cmd("proposeaction")} ${actionId} ${integrationUsage(getIntegrationAction(actionId))}${extra ? ` ${extra}` : ""} <description>\``);
  }
  const { client } = await userClient(ctx, { forceFullTopup: true });
  const { proposalId } = await proposeForModel({ model, client, governanceAddress: address, actions: built.actions, description: built.description, options: modelOptions });
  const steps = built.actions.length;
  return proposalReply(ctx, address, model, proposalId, `✅ Proposal #${proposalId} created via \`${actionId}\` (${steps} step${steps === 1 ? "" : "s"}).\n\n${built.summary}\n\n${proposalNextStep(model, proposalId, ctx.cmd)}`);
}
