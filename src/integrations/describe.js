import { integrationActionsFor, getIntegrationAction, integrationUsage } from "./index.js";
import { getNetwork } from "../networks.js";
import { getAction } from "../actionLibrary.js";
import { actionArgSpec } from "../proposalBuilder.js";
import { ACTION_HELP, fieldHelp, actionTargetText, actionAppliesText } from "../actionLibraryHelp.js";

/**
 * Chat text for external-protocol actions, shared by Telegram and the
 * Discord/Slack command core.
 */

/** The "External protocols" part of listactions for a chat on `networkId`. */
export function integrationListLines(networkId) {
  const actions = integrationActionsFor(networkId);
  const network = getNetwork(networkId);
  if (!actions.length) return ["", `*External protocols:* none set up on ${network.chain.name} yet.`];
  const lines = ["", `*External protocols (${network.chain.name}):*`];
  let current = null;
  for (const a of actions) {
    if (a.protocol.id !== current) {
      current = a.protocol.id;
      const warning = a.protocol.deployments[networkId].warning;
      lines.push(`${a.protocol.name}${warning ? " ⚠️" : ""}`);
    }
    lines.push(`\`${a.id}\` — ${a.label}`);
  }
  return lines;
}

/**
 * Full help for one native library action: what it does, what it calls,
 * who it applies to, and every argument with its units. `chat` (optional)
 * adds the chat's own model and wrapper addresses.
 */
function libraryActionInfoText(action, proposeCommand, chat = {}) {
  const { names } = actionArgSpec(action);
  const isTuple = action.params.length === 1 && action.params[0].type === "tuple";
  const model = Array.isArray(action.appliesTo) && action.appliesTo.length === 1 ? action.appliesTo[0] : chat.model;
  const lines = [
    `*${action.label}*`,
    "",
    `\`${proposeCommand} ${action.id} ${names.join(" ")} <description>\``,
    "",
    ACTION_HELP[action.id] ?? "",
    "",
    `Calls \`${action.functionName}\` on ${actionTargetText(action)}. Applies to ${actionAppliesText(action)}.`,
    "",
    isTuple ? "*Fields, in order:*" : "*Arguments:*",
  ];
  for (const name of names) lines.push(`• \`${name}\` — ${fieldHelp(model, name) ?? "see the contract"}`);
  const wrapper = action.appliesTo === "nftWrapper" ? chat.nftWrapperAddress : action.appliesTo === "guardWrapper" ? chat.guardWrapperAddress : null;
  if (wrapper) lines.push("", `This chat's ${action.appliesTo === "nftWrapper" ? "NFT" : "guard"} wrapper: \`${wrapper}\``);
  if (action.appliesTo === "treasury" || action.appliesTo === "token") {
    lines.push("", "After a GuardWrapper handover, the bot routes this through the wrapper for its signers to confirm.");
  }
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

/** Full help for any action - native library or external protocol. Null if unknown. */
export function actionInfoText(actionId, networkId, proposeCommand, chat) {
  const native = getAction(actionId);
  if (native) return libraryActionInfoText(native, proposeCommand, chat);
  const action = getIntegrationAction(actionId);
  if (!action) return null;
  const deployment = action.protocol.deployments[networkId];
  const network = getNetwork(networkId);
  const lines = [
    `*${action.label}*`,
    "",
    `\`${proposeCommand} ${action.id} ${integrationUsage(action)} <description>\``,
  ];
  if (action.options?.length) {
    lines.push("", "*Options* (name=value, after the arguments):");
    for (const o of action.options) lines.push(`• \`${o.name}\` — ${o.description}${o.default ? ` (default ${o.default})` : ""}`);
  }
  if (action.help) lines.push("", action.help);
  if (!deployment) {
    const where = Object.keys(action.protocol.deployments).map((id) => getNetwork(id).chain.name).join(", ");
    lines.push("", `Not available on ${network.chain.name} - only on ${where}.`);
    return lines.join("\n");
  }
  if (deployment.warning) lines.push("", `⚠️ ${deployment.warning}`);
  // Plain text: the source names contain underscores, which Telegram's
  // Markdown would read as italics.
  lines.push("", "Addresses checked against:", ...deployment.sources.map((src) => `• \`${src}\``));
  return lines.join("\n");
}
