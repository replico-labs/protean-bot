import * as uniswapV4 from "./uniswapV4.js";
import * as aaveV3 from "./aaveV3.js";
import * as shmonad from "./shmonad.js";
import * as nadfun from "./nadfun.js";
import * as perpl from "./perpl.js";
import * as opensea from "./opensea.js";
import * as aerodrome from "./aerodrome.js";
import * as lido from "./lido.js";
import * as flaunch from "./flaunch.js";
import * as hyperlend from "./hyperlend.js";
import * as hypercore from "./hypercore.js";
import * as hyperswap from "./hyperswap.js";
import * as kinetiq from "./kinetiq.js";
import { IntegrationError } from "./common.js";

/**
 * Registry of external-protocol integrations. Each module exports
 * `protocol` ({ id, name, category, deployments: { <networkId>: {...} } })
 * and `actions` ({ id, label, usage, options, build(ctx) }). An action is
 * offered only on networks where its protocol has a deployment entry -
 * each entry lists the sources its addresses were checked against.
 */
const MODULES = [uniswapV4, aaveV3, shmonad, nadfun, perpl, opensea, aerodrome, lido, flaunch, hyperlend, hypercore, hyperswap, kinetiq];

export { IntegrationError };

export function integrationActionsFor(networkId) {
  return MODULES.filter((m) => m.protocol.deployments[networkId]).flatMap((m) => m.actions.map((action) => ({ ...action, protocol: m.protocol })));
}

export function getIntegrationAction(actionId) {
  for (const m of MODULES) {
    const action = m.actions.find((a) => a.id === actionId);
    if (action) return { ...action, protocol: m.protocol };
  }
  return null;
}

export function allProtocols() {
  return MODULES.map((m) => m.protocol);
}

/** Every integration module (protocol, actions, verifyLinks) - for scripts/verify-integrations.js. */
export function allIntegrationModules() {
  return MODULES;
}

/** "tokenIn tokenOut amountIn minOut|slippage% [fee=3000] [deadline=30d]" */
export function integrationUsage(action) {
  const opts = (action.options ?? []).map((o) => `[${o.name}=${o.default ?? "…"}]`);
  return [...action.usage, ...opts].join(" ");
}

/**
 * Splits command words into the action's positional args, its
 * name=value options (anywhere after the positional args, before the
 * description) and the description. Unknown option names are rejected
 * so a typo can't silently fall back to a default.
 */
export function parseIntegrationWords(action, words) {
  const args = words.slice(0, action.usage.length);
  const options = {};
  let i = action.usage.length;
  const known = new Set((action.options ?? []).map((o) => o.name.toLowerCase()));
  for (; i < words.length; i++) {
    const m = /^([A-Za-z][A-Za-z0-9]*)=(.+)$/.exec(words[i]);
    if (!m) break;
    const name = [...known].find((k) => k === m[1].toLowerCase());
    if (!name) throw new IntegrationError(`Unknown option "${m[1]}" for ${action.id}. Options: ${[...known].join(", ") || "none"}.`);
    options[(action.options ?? []).find((o) => o.name.toLowerCase() === name).name] = m[2];
  }
  return { args, options, description: words.slice(i).join(" ") };
}
