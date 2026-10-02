import { isAddress, formatEther } from "viem";
import { walletClient } from "../../config.js";
import { blocksToDuration } from "../../networks.js";
import { resolveDelegationsBehind, queueSweep } from "../../governance/liquid.js";
import { settleSortitionRandomness } from "../../governance/sortition.js";
import { isWalletStoreConfigured } from "../../walletStore.js";
import { VOTE_CHOICES } from "../../display.js";
import { short } from "../../format.js";
import { UserError, reply, requireAdapterFn, requireModel, parseId, userClient, weightNote, adapterWrite, callerAddress, NO_WALLETS } from "../helpers.js";

/**
 * Model-specific steps for Board, Liquid, Optimistic, Conviction,
 * Sortition and Delegate DAOs - ported from index.js. Each checks the
 * adapter actually implements the step, exactly as Telegram does.
 */

const ID_OPTION = [{ name: "id", description: "Proposal ID", required: true, type: "integer" }];

export const MODEL_COMMANDS = {
  // --- Board ---
  confirm: adapterWrite({
    section: "Deciding",
    models: ["board"],
    description: "Board signers: confirm a proposal",
    fn: "confirm",
    notSupported: "This DAO uses {model} governance, which has no confirmation step - use vote instead.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Confirmed proposal #${id}. It queues automatically once enough signers confirm.`,
  }),
  revoke: adapterWrite({
    section: "Deciding",
    models: ["board"],
    description: "Board signers: withdraw your confirmation",
    fn: "revokeConfirmation",
    notSupported: "This DAO uses {model} governance, which has no confirmation step to revoke.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Confirmation on proposal #${id} revoked.`,
  }),

  // --- Liquid ---
  delegate: {
    section: "Deciding",
    models: ["liquid"],
    usage: "<address>",
    description: "Delegate your voting power to someone",
    options: [{ name: "to", description: "Address to delegate to", required: true }],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "delegate", "This DAO uses {model} governance, which has no delegation.");
      const to = ctx.args[0];
      if (!to || !isAddress(to)) throw new UserError(`Usage: \`${ctx.cmd("delegate")} 0xSomeAddress\``);
      const { client } = await userClient(ctx);
      await adapter.delegate(client, address, to);
      return reply(`✅ Delegated your voting power to \`${short(to)}\`.`);
    },
  },
  undelegate: adapterWrite({
    section: "Deciding",
    models: ["liquid"],
    description: "Take back delegated voting power",
    fn: "undelegate",
    notSupported: "This DAO uses {model} governance, which has no delegation.",
    done: () => "✅ Voting power returned to you directly.",
  }),
  resolvedelegations: {
    section: "Deciding",
    models: ["liquid"],
    usage: "<id> [address]",
    description: "Add the votes of everyone delegating to an address (default: you) to a proposal",
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "address", description: "Whose delegators to resolve (default: you)", required: false },
    ],
    async run(ctx) {
      const { address } = requireModel(ctx, "liquid", "This DAO uses {model} governance, which has no delegation.");
      const id = parseId(ctx.args[0], `${ctx.cmd("resolvedelegations")} <id> [address]`);
      const root = ctx.args[1] ?? (await callerAddress(ctx));
      if (!isAddress(root)) throw new UserError("That doesn't look like a valid address.");
      const signer = walletClient ?? (await userClient(ctx)).client;
      const r = await queueSweep(() => resolveDelegationsBehind({ client: signer, governanceAddress: address, proposalId: id, root }));
      if (r.resolved === 0) return reply(`Nothing to add on #${id}: everyone delegating to \`${short(root)}\` has already voted or been counted, their chain has no voter yet, or voting isn't open.${r.failed ? ` ${r.failed} couldn't be added - see the logs.` : ""}`);
      return reply(`🗳️ Added ${r.resolved} delegated vote${r.resolved === 1 ? "" : "s"} (${formatEther(r.weight)} voting power) behind \`${short(root)}\` on #${id}.`);
    },
  },

  // --- Optimistic ---
  challenge: adapterWrite({
    section: "Deciding",
    models: ["optimistic"],
    description: "Dispute a proposal, forcing a real vote",
    fn: "challenge",
    notSupported: "This DAO uses {model} governance, which has nothing to challenge.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Proposal #${id} challenged. The fallback vote is open - use \`${ctx.cmd("vote")} ${id} for|against|abstain\`.`,
  }),

  // --- Conviction ---
  support: {
    section: "Deciding",
    models: ["conviction"],
    usage: "<id>",
    description: "Back a proposal with your full staked balance",
    options: ID_OPTION,
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "support", "This DAO uses {model} governance, which has no continuous support - use vote instead.");
      const id = parseId(ctx.args[0], `${ctx.cmd("support")} <id>`);
      const { client } = await userClient(ctx);
      const { weight } = await adapter.support(client, address, id);
      const note = weight === 0n ? "\n\n⚠️ This carried *zero weight* - you likely have no staked balance right now. Stake first, then support again." : weightNote(weight);
      return reply(`✅ Now backing proposal #${id} with your full staked balance.${note}`);
    },
  },
  withdrawsupport: adapterWrite({
    section: "Deciding",
    models: ["conviction"],
    description: "Stop backing your current proposal",
    fn: "withdrawSupport",
    notSupported: "This DAO uses {model} governance, which has no continuous support to withdraw.",
    done: () => "✅ Support withdrawn. Your staked tokens are unlocked.",
  }),
  mysupport: {
    section: "Deciding",
    models: ["conviction"],
    usage: "",
    description: "Which proposal you're backing",
    options: [],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "getCurrentSupport", "This DAO uses {model} governance, which has no continuous support to check.");
      if (!isWalletStoreConfigured()) throw new UserError(NO_WALLETS);
      const proposalId = await adapter.getCurrentSupport(address, await callerAddress(ctx));
      return reply(proposalId === 0n ? "You're not currently backing any proposal." : `You're currently backing proposal #${proposalId}.`, { ephemeral: true });
    },
  },

  // --- Sortition ---
  registereligible: adapterWrite({
    section: "Council",
    models: ["sortition"],
    description: "Enter the pool for the next council draw",
    fn: "registerEligible",
    notSupported: "This DAO uses {model} governance, which has no eligibility pool.",
    done: () => "✅ You're in the eligible pool for the next sortition draw.",
  }),
  withdraweligibility: adapterWrite({
    section: "Council",
    models: ["sortition"],
    description: "Leave the council-draw pool",
    fn: "withdrawEligibility",
    notSupported: "This DAO uses {model} governance, which has no eligibility pool.",
    done: () => "✅ Removed from the eligible pool. This doesn't remove you from a council you're already on.",
  }),
  startsortition: adapterWrite({
    section: "Council",
    models: ["sortition"],
    description: "Start a new random council draw",
    fn: "startSortition",
    notSupported: "This DAO uses {model} governance, which has no sortition draw.",
    done: (ctx, id, { round }) => `✅ Sortition round ${round} started. Once randomness is settled, run \`${ctx.cmd("finalizesortition")}\` to draw the council.`,
  }),
  settlesortition: {
    section: "Council",
    models: ["sortition"],
    usage: "",
    description: "Submit the draw's randomness once it's ready",
    options: [],
    async run(ctx) {
      const { address } = requireModel(ctx, "sortition", "This DAO uses {model} governance, which has no randomness to settle.");
      const { client } = await userClient(ctx);
      const result = await settleSortitionRandomness(client, address);
      switch (result.status) {
        case "no-pending-round":
          return reply(`No sortition round has been started yet — use \`${ctx.cmd("startsortition")}\` first.`);
        case "already-settled":
          return reply(`This round's randomness is already settled. Use \`${ctx.cmd("finalizesortition")}\` to draw the council.`);
        case "not-ready":
          return reply(`Not ready yet — Switchboard's minimum settlement delay hasn't passed. Try again in about ${result.readyIn} more second(s).`);
        default:
          return reply(`✅ Randomness settled. Use \`${ctx.cmd("finalizesortition")}\` to draw the new council.`);
      }
    },
  },
  finalizesortition: adapterWrite({
    section: "Council",
    models: ["sortition"],
    description: "Draw the new council once randomness settles",
    fn: "finalizeSortition",
    notSupported: "This DAO uses {model} governance, which has no sortition draw.",
    done: (ctx) => `✅ New council drawn. Use \`${ctx.cmd("council")}\` to see the roster.`,
  }),

  // --- Delegate and Sortition ---
  council: {
    section: "Council",
    models: ["delegate", "sortition"],
    usage: "",
    description: "Who's on the council",
    options: [],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "getCouncil", "This DAO uses {model} governance, which has no council.");
      const council = await adapter.getCouncil(address);
      const lines = [`*Current council* (${council.length}):`, ...council.map((a, i) => `${i + 1}. \`${short(a)}\``)];
      if (typeof adapter.electionStatusText === "function") {
        const status = await adapter.electionStatusText(address);
        lines.push("", status.replace(/\/([a-z]+)\b/g, (m, n) => ctx.cmd(n)));
      }
      return reply(lines.join("\n"));
    },
  },

  // --- Delegate: elections ---
  startelection: adapterWrite({
    section: "Council",
    models: ["delegate"],
    description: "Open a council election",
    fn: "startElection",
    notSupported: "This DAO uses {model} governance, which has no elections.",
    done: (ctx, id, { electionId, election }) =>
      `✅ Election #${electionId} opened. Candidates: \`${ctx.cmd("declarecandidacy")} ${electionId}\` within ${blocksToDuration(election.candidacyDeadline - election.snapshotBlock)}. ` +
      `Voters: \`${ctx.cmd("voteinelection")} ${electionId} <candidates...>\` after that, for ${blocksToDuration(election.votingEndBlock - election.candidacyDeadline)}. ` +
      `Only tokens staked before this election opened count.`,
  }),
  declarecandidacy: adapterWrite({
    section: "Council",
    models: ["delegate"],
    description: "Stand in an open election",
    fn: "declareCandidacy",
    notSupported: "This DAO uses {model} governance, which has no elections.",
    idLabel: "Election ID",
    done: (ctx, id) => `✅ You're a candidate in election #${id}.`,
  }),
  voteinelection: {
    section: "Council",
    models: ["delegate"],
    usage: "<electionId> <candidate...>",
    description: "Vote for council candidates",
    options: [
      { name: "id", description: "Election ID", required: true, type: "integer" },
      { name: "candidates", description: "Candidate addresses, space-separated", required: true, rest: true },
    ],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "voteInElection", "This DAO uses {model} governance, which has no elections.");
      const [electionId, ...candidates] = ctx.args;
      if (!electionId || !/^\d+$/.test(electionId) || candidates.length === 0 || !candidates.every((c) => isAddress(c))) {
        throw new UserError(`Usage: \`${ctx.cmd("voteinelection")} <electionId> <candidate1> [candidate2] ...\``);
      }
      const { client } = await userClient(ctx);
      const { weight, candidates: counted } = await adapter.voteInElection(client, address, electionId, candidates);
      return reply(`✅ Voted for ${counted.length} candidate(s) in election #${electionId}.${weightNote(weight, "this election's snapshot block")}`);
    },
  },
  finalizeelection: adapterWrite({
    section: "Council",
    models: ["delegate"],
    description: "Close an election and seat the winners",
    fn: "finalizeElection",
    notSupported: "This DAO uses {model} governance, which has no elections.",
    idLabel: "Election ID",
    done: (ctx) => `✅ Election finalized. Use \`${ctx.cmd("council")}\` to see the new roster.`,
  }),

  // --- Delegate: recalls ---
  initiaterecall: {
    section: "Council",
    models: ["delegate"],
    usage: "<councilMember>",
    description: "Start a vote to remove a council member",
    options: [{ name: "member", description: "Council member's address", required: true }],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "initiateRecall", "This DAO uses {model} governance, which has no recall.");
      const member = ctx.args[0];
      if (!member || !isAddress(member)) throw new UserError(`Usage: \`${ctx.cmd("initiaterecall")} 0xCouncilMember\``);
      const { client } = await userClient(ctx);
      const { recallId } = await adapter.initiateRecall(client, address, member);
      return reply(`✅ Recall #${recallId} started against \`${short(member)}\`. Vote with \`${ctx.cmd("voterecall")} ${recallId} for|against|abstain\`.`);
    },
  },
  voterecall: {
    section: "Council",
    models: ["delegate"],
    usage: "<recallId> for|against|abstain",
    description: "Vote on a recall",
    options: [
      { name: "id", description: "Recall ID", required: true, type: "integer" },
      { name: "choice", description: "Your vote", required: true, choices: Object.keys(VOTE_CHOICES) },
    ],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "voteRecall", "This DAO uses {model} governance, which has no recall.");
      const [recallId, choiceRaw] = ctx.args;
      const choice = choiceRaw?.toLowerCase();
      if (!recallId || !/^\d+$/.test(recallId) || !(choice in VOTE_CHOICES)) throw new UserError(`Usage: \`${ctx.cmd("voterecall")} <recallId> for|against|abstain\``);
      const { client } = await userClient(ctx);
      await adapter.voteRecall(client, address, recallId, VOTE_CHOICES[choice]);
      return reply(`✅ Voted *${choice}* on recall #${recallId}.`);
    },
  },
  finalizerecall: adapterWrite({
    section: "Council",
    models: ["delegate"],
    description: "Close a recall vote",
    fn: "finalizeRecall",
    notSupported: "This DAO uses {model} governance, which has no recall.",
    idLabel: "Recall ID",
    done: (ctx) => `✅ Recall finalized. Use \`${ctx.cmd("council")}\` to check the roster.`,
  }),
};
