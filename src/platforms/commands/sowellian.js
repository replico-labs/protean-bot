import { isAddress, getAddress, zeroHash } from "viem";
import { resolveOracleWord, oracleGoalValue } from "../../modelProposal.js";
import { getAdapter } from "../../governance/index.js";
import { VOTE_CHOICES } from "../../display.js";
import { UserError, reply, requireModel, requireAdapterFn, parseId, userClient, weightNote, adapterWrite, ZERO_ADDRESS } from "../helpers.js";

/** The Sowellian lifecycle: criteria, approval, positions, both resolution tracks, adjudication. Ported from index.js. */

// Outcome.Unresolved (0) is deliberately excluded - invalid for these calls.
const OUTCOME_CHOICES = { success: 1, failure: 2 };
const SOWELLIAN = ["sowellian"];

function outcomeVote({ name, fn, description, notSupported, snapshotWhat, doneLabel }) {
  return {
    section: "Sowellian",
    models: SOWELLIAN,
    usage: "<id> success|failure",
    description,
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "outcome", description: "What actually happened", required: true, choices: Object.keys(OUTCOME_CHOICES) },
    ],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, fn, notSupported);
      const [id, outcomeRaw] = ctx.args;
      const outcome = outcomeRaw?.toLowerCase();
      if (!id || !/^\d+$/.test(id) || !(outcome in OUTCOME_CHOICES)) throw new UserError(`Usage: \`${ctx.cmd(name)} <id> success|failure\``);
      const { client } = await userClient(ctx);
      const result = await adapter[fn](client, address, id, OUTCOME_CHOICES[outcome]);
      return reply(doneLabel(ctx, id, outcome) + (snapshotWhat ? weightNote(result?.weight, snapshotWhat) : ""));
    },
  };
}

export const SOWELLIAN_COMMANDS = {
  proposecriteria: {
    section: "Sowellian",
    models: SOWELLIAN,
    usage: "<target> <value> <data> <oracle|human> <pyth|adapter|-> <feedId|-> <targetValue> <min|max> <measurementSeconds> <description>",
    description: "Propose with an upfront success condition",
    options: [
      { name: "target", description: "Target contract address", required: true },
      { name: "value", description: "Native value in wei", required: true },
      { name: "data", description: "Hex calldata, or 0x", required: true },
      { name: "method", description: "How the outcome is resolved", required: true, choices: ["oracle", "human"] },
      { name: "oracle", description: "pyth (this network's Pyth adapter), an adapter address, or - for human", required: true },
      { name: "selector", description: "Pyth price feed ID (0x + 64 hex), or - for human", required: true },
      { name: "target_value", description: "Oracle: the price, e.g. 3000 (sent as 18 decimals). Human: a whole number", required: true },
      { name: "direction", description: "min: success if >= target; max: success if <= target", required: true, choices: ["min", "max"] },
      { name: "measurement_seconds", description: "Seconds after execution before resolving", required: true, type: "integer" },
      { name: "description", description: "What this proposal does", required: true, rest: true },
    ],
    async run(ctx) {
      const { address } = requireModel(ctx, "sowellian", "This DAO uses {model} governance, which doesn't use resolution criteria. Use propose instead.");
      const [target, value, data, methodRaw, oracleInput, selectorRaw, targetValue, directionRaw, measurementPeriod, ...descriptionParts] = ctx.args;
      const description = descriptionParts.join(" ");
      const method = methodRaw?.toLowerCase();
      const direction = directionRaw?.toLowerCase();

      const usage = [
        `Usage: \`${ctx.cmd("proposecriteria")} <target> <value> <data> <oracle|human> <pyth|adapter|-> <feedId|-> <targetValue> <min|max> <measurementSeconds> <description>\``,
        "",
        `Example (oracle track, ETH/USD at least $3,000 30 days after execution): \`${ctx.cmd("proposecriteria")} 0xRecipient 0 0x oracle pyth 0x<ETH/USD feed ID> 3000 min 2592000 Grow treasury\``,
        `Example (human track, resolves 7 days after execution): \`${ctx.cmd("proposecriteria")} 0xRecipient 0 0x human - - 0 min 604800 Fund the community grant\``,
        `Easier: \`${ctx.cmd("proposeaction")}\` builds the call for you - see \`${ctx.cmd("actioninfo")}\`.`,
      ].join("\n");
      const valid =
        target && isAddress(target) && value && /^\d+$/.test(value) && data &&
        (method === "oracle" || method === "human") &&
        targetValue !== undefined &&
        (direction === "min" || direction === "max") &&
        measurementPeriod && /^\d+$/.test(measurementPeriod) &&
        description;
      if (!valid) throw new UserError(usage);
      let oracle = ZERO_ADDRESS;
      let selector = zeroHash;
      let goal;
      try {
        if (method === "oracle") {
          oracle = resolveOracleWord(oracleInput);
          if (!/^0x[0-9a-fA-F]{64}$/.test(selectorRaw ?? "")) throw new UserError(`The oracle track needs a Pyth price feed ID (0x + 64 hex) in the feed slot.\n\n${usage}`);
          selector = selectorRaw;
          goal = oracleGoalValue(targetValue);
        } else {
          if (!/^-?\d+$/.test(targetValue)) throw new UserError(`On the human track the target value is a whole number.\n\n${usage}`);
          goal = targetValue;
        }
      } catch (err) {
        if (err.userFacing) throw new UserError(err.message);
        throw err;
      }
      const { client } = await userClient(ctx, { forceFullTopup: true });
      const { proposalId } = await getAdapter("sowellian").proposeWithCriteria(
        client,
        address,
        [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }],
        description,
        method === "oracle" ? 0 : 1,
        oracle,
        selector,
        goal,
        direction === "min",
        measurementPeriod
      );
      return reply(`✅ Proposal #${proposalId} created. Follow it with \`${ctx.cmd("proposal")} ${proposalId}\`.`);
    },
  },

  castapprovalvote: {
    section: "Sowellian",
    models: SOWELLIAN,
    usage: "<id> for|against|abstain",
    description: "Vote on whether a proposal opens for betting",
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "choice", description: "Your vote", required: true, choices: Object.keys(VOTE_CHOICES) },
    ],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "castApprovalVote", "This DAO uses {model} governance, which has no approval vote.");
      const [id, choiceRaw] = ctx.args;
      const choice = choiceRaw?.toLowerCase();
      if (!id || !/^\d+$/.test(id) || !(choice in VOTE_CHOICES)) throw new UserError(`Usage: \`${ctx.cmd("castapprovalvote")} <id> for|against|abstain\``);
      const { client } = await userClient(ctx);
      const { weight } = await adapter.castApprovalVote(client, address, id, VOTE_CHOICES[choice]);
      return reply(`✅ Voted *${choice}* on proposal #${id}'s approval.${weightNote(weight, "this proposal's approval snapshot block")}`);
    },
  },

  finalizeapproval: adapterWrite({
    section: "Sowellian",
    models: SOWELLIAN,
    description: "Close the approval vote",
    fn: "finalizeApproval",
    notSupported: "This DAO uses {model} governance, which has no approval vote.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Approval finalized for proposal #${id}. Check \`${ctx.cmd("proposal")} ${id}\` for the outcome.`,
  }),

  takeposition: {
    section: "Sowellian",
    models: SOWELLIAN,
    usage: "<id> yes|no <amount>",
    description: "Back the outcome succeeding (yes) or failing (no)",
    options: [
      { name: "id", description: "Proposal ID", required: true, type: "integer" },
      { name: "side", description: "yes = succeeds, no = fails", required: true, choices: ["yes", "no"] },
      { name: "amount", description: "Tokens to put behind it", required: true },
    ],
    async run(ctx) {
      const { address, adapter } = requireAdapterFn(ctx, "takePosition", "This DAO uses {model} governance, which has no positions market.");
      const [id, sideRaw, amount] = ctx.args;
      const side = sideRaw?.toLowerCase();
      if (!id || !/^\d+$/.test(id) || (side !== "yes" && side !== "no") || !(Number(amount) > 0)) {
        throw new UserError(`Usage: \`${ctx.cmd("takeposition")} <id> yes|no <amount>\` — positions can only grow, never shrink.`);
      }
      const { client } = await userClient(ctx);
      await adapter.takePosition(client, address, id, side === "yes" ? 0 : 1, amount);
      return reply(`✅ Backed *${side}* on proposal #${id} with ${amount} tokens.`);
    },
  },

  resolveviaoracle: adapterWrite({
    section: "Sowellian",
    models: SOWELLIAN,
    description: "Oracle track: read the oracle and settle",
    fn: "resolveViaOracle",
    notSupported: "This DAO uses {model} governance, which has no oracle-track resolution.",
    idLabel: "Proposal ID",
    done: (ctx, id, { priceUpdate }) =>
      `✅ Proposal #${id} resolved via oracle.${priceUpdate?.price != null ? ` Posted Pyth's latest price first: ${priceUpdate.price}.` : ""} Use \`${ctx.cmd("claimposition")} ${id}\` to collect a winning position.`,
  }),

  proposeresolution: outcomeVote({
    name: "proposeresolution",
    fn: "proposeResolution",
    description: "Human track: state the real outcome (posts a bond)",
    notSupported: "This DAO uses {model} governance, which has no human-track resolution.",
    doneLabel: (ctx, id, outcome) => `✅ Proposed *${outcome}* for proposal #${id}. If unchallenged, run \`${ctx.cmd("finalizeunchallenged")} ${id}\` once the window closes.`,
  }),

  challengeresolution: adapterWrite({
    section: "Sowellian",
    models: SOWELLIAN,
    description: "Dispute a proposed resolution (posts a bond)",
    fn: "challengeResolution",
    notSupported: "This DAO uses {model} governance, which has no resolution to dispute.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Resolution challenged for proposal #${id}. Adjudication is open - use \`${ctx.cmd("castadjudicationvote")} ${id} success|failure\`.`,
  }),

  finalizeunchallenged: adapterWrite({
    section: "Sowellian",
    models: SOWELLIAN,
    description: "Lock in an undisputed resolution",
    fn: "finalizeUnchallenged",
    notSupported: "This DAO uses {model} governance - for optimistic proposals use queue, which handles this automatically.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Proposal #${id} finalized as originally proposed.`,
  }),

  castadjudicationvote: outcomeVote({
    name: "castadjudicationvote",
    fn: "castAdjudicationVote",
    description: "Vote on the true outcome of a disputed resolution",
    notSupported: "This DAO uses {model} governance, which has no adjudication vote.",
    snapshotWhat: "this proposal's adjudication snapshot block",
    doneLabel: (ctx, id, outcome) => `✅ Voted *${outcome}* on proposal #${id}'s adjudication.`,
  }),

  finalizeadjudication: adapterWrite({
    section: "Sowellian",
    models: SOWELLIAN,
    description: "Close adjudication and settle the bonds",
    fn: "finalizeAdjudication",
    notSupported: "This DAO uses {model} governance, which has no adjudication vote.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Adjudication finalized for proposal #${id}. Use \`${ctx.cmd("claimposition")} ${id}\` to collect a winning position.`,
  }),

  claimposition: adapterWrite({
    section: "Sowellian",
    models: SOWELLIAN,
    description: "Collect your payout if your side won",
    fn: "claimPosition",
    notSupported: "This DAO uses {model} governance, which has no positions to claim.",
    idLabel: "Proposal ID",
    done: (ctx, id) => `✅ Position claimed for proposal #${id}.`,
  }),
};
