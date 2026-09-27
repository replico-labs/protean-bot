import { isAddress, getAddress, zeroHash } from "viem";
import { SWITCHBOARD_ORACLE_ADAPTER } from "../../config.js";
import { getAdapter } from "../../governance/index.js";
import { deployChainlinkOracle } from "../../governance/sowellian.js";
import { VOTE_CHOICES } from "../../display.js";
import { short } from "../../format.js";
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
  deploychainlinkoracle: {
    section: "Sowellian",
    models: SOWELLIAN,
    usage: "<chainlinkFeedAddress>",
    description: "Wrap a Chainlink feed so proposals can use it as an oracle",
    options: [{ name: "feed", description: "Chainlink Data Feed address on this chain", required: true }],
    async run(ctx) {
      const feedAddress = ctx.args[0];
      if (!feedAddress || !isAddress(feedAddress)) {
        throw new UserError(`Usage: \`${ctx.cmd("deploychainlinkoracle")} <chainlinkFeedAddress>\` — confirm the feed really exists on this chain first; a wrong address deploys fine but fails at resolution.`);
      }
      const { client } = await userClient(ctx);
      const { adapterAddress } = await deployChainlinkOracle(client, feedAddress);
      return reply(`✅ Adapter deployed at \`${short(adapterAddress)}\`. Use it as the oracle in \`${ctx.cmd("proposecriteria")}\`, with \`-\` for the selector.`);
    },
  },

  proposecriteria: {
    section: "Sowellian",
    models: SOWELLIAN,
    usage: "<target> <value> <data> <oracle|human> <oracle|switchboard|-> <selector|-> <targetValue> <min|max> <measurementSeconds> <description>",
    description: "Propose with an upfront success condition",
    options: [
      { name: "target", description: "Target contract address", required: true },
      { name: "value", description: "Native value in wei", required: true },
      { name: "data", description: "Hex calldata, or 0x", required: true },
      { name: "method", description: "How the outcome is resolved", required: true, choices: ["oracle", "human"] },
      { name: "oracle", description: "Oracle adapter address, 'switchboard', or - for human", required: true },
      { name: "selector", description: "Switchboard feedId (0x + 64 hex), or -", required: true },
      { name: "target_value", description: "Value the metric is compared against", required: true },
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

      let oracleRaw = oracleInput;
      if (method === "oracle" && oracleInput?.toLowerCase() === "switchboard") {
        if (!SWITCHBOARD_ORACLE_ADAPTER) throw new UserError("No Switchboard oracle adapter is configured on this bot - ask an admin to set SWITCHBOARD_ORACLE_ADAPTER, or pass an adapter address.");
        oracleRaw = SWITCHBOARD_ORACLE_ADAPTER;
      }
      const valid =
        target && isAddress(target) && value && data &&
        (method === "oracle" || method === "human") &&
        targetValue !== undefined && !Number.isNaN(Number(targetValue)) &&
        (direction === "min" || direction === "max") &&
        measurementPeriod && /^\d+$/.test(measurementPeriod) &&
        description &&
        (method !== "oracle" || (oracleRaw && isAddress(oracleRaw))) &&
        (method !== "oracle" || selectorRaw === "-" || /^0x[0-9a-fA-F]{64}$/.test(selectorRaw ?? ""));
      if (!valid) {
        throw new UserError(
          [
            `Usage: \`${ctx.cmd("proposecriteria")} <target> <value> <data> <oracle|human> <oracleAddress|switchboard|-> <selector|-> <targetValue> <min|max> <measurementSeconds> <description>\``,
            "",
            `Example (human track, resolves 7 days after execution): \`${ctx.cmd("proposecriteria")} 0xRecipient 0 0x human - - 0 min 604800 Fund the community grant\``,
          ].join("\n")
        );
      }
      const { client } = await userClient(ctx, { forceFullTopup: true });
      const { proposalId } = await getAdapter("sowellian").proposeWithCriteria(
        client,
        address,
        [{ target: getAddress(target), value: BigInt(value || 0), data: data || "0x" }],
        description,
        method === "oracle" ? 0 : 1,
        method === "oracle" ? oracleRaw : ZERO_ADDRESS,
        !selectorRaw || selectorRaw === "-" ? zeroHash : selectorRaw,
        targetValue,
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
    done: (ctx, id) => `✅ Proposal #${id} resolved via oracle. Use \`${ctx.cmd("claimposition")} ${id}\` to collect a winning position.`,
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
