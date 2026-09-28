import { integrationActionsFor, getIntegrationAction, integrationUsage } from "./index.js";
import { getNetwork } from "../networks.js";

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

/** Full help for one external action: usage, options, where its addresses came from. Null if unknown. */
export function actionInfoText(actionId, networkId, proposeCommand) {
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
