import { getAddress, isAddress, parseUnits, zeroAddress, zeroHash } from "viem";
import { pythPriceAdapter } from "./config.js";
import { getAdapter } from "./governance/index.js";
import { parseDuration } from "./integrations/common.js";

/**
 * /proposeaction for every model, Sowellian and Decision Markets included.
 *
 * Those two can't take a plain propose(actions, description): Sowellian
 * needs resolution criteria and Decision Markets needs both markets'
 * seed amounts. Before this, their only way in was /proposecriteria or
 * /proposemarket with a hand-typed target, value and raw calldata. Now the
 * library (or integration) builds and checks the calls as for any other
 * model, and the extra settings ride along as name=value words anywhere
 * after the action ID:
 *
 *   sowellian        track=human|oracle (default human)
 *                    oracle=pyth (default) | <adapter address> (oracle track)
 *                    feed=<Pyth price feed ID>               (oracle track)
 *                    goal=<price, e.g. 3000> (oracle track; sent as 18 decimals)
 *                    when=min|max (default min: success if >= goal)
 *                    measure=<duration> (default 7d)
 *   decisionMarkets  seed=<DAO tokens> quote=<native amount>  (both required)
 */

export class ProposalOptionError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

const KEYS = {
  sowellian: ["track", "oracle", "feed", "goal", "when", "measure"],
  decisionMarkets: ["seed", "quote"],
};

/** Usage text for a model's extra settings, or "" for models that need none. */
export function modelOptionsUsage(model) {
  if (model === "sowellian") return "[track=human|oracle] [feed=<Pyth feed ID>] [goal=<price>] [when=min|max] [measure=7d]";
  if (model === "decisionMarkets") return "seed=<DAO tokens> quote=<native amount>";
  return "";
}

/** /actioninfo lines explaining a model's extra settings (empty for other models). */
export function modelOptionsHelp(model) {
  if (model === "sowellian") {
    return [
      "*Sowellian settings* (name=value, anywhere after the action ID):",
      "• `track` — human (people resolve it) or oracle (an on-chain metric does) (default human)",
      "• `feed` — oracle track: the Pyth price feed ID (0x + 64 hex, from Pyth's price feed list), e.g. ETH/USD",
      "• `goal` — oracle track: the price it's compared against, e.g. 3000 or 0.95",
      "• `oracle` — optional: `pyth` (default, this network's Pyth adapter) or an adapter address",
      "• `when` — min: success if the result is at least goal; max: at most (default min)",
      "• `measure` — how long after execution it's measured, e.g. 7d or 12h (default 7d)",
      "The proposal bond is taken from your wallet when it's submitted. At resolution the bot posts Pyth's latest price first (a small Pyth fee, from the resolver's wallet).",
    ];
  }
  if (model === "decisionMarkets") {
    return [
      "*Decision Markets settings* (name=value, anywhere after the action ID, both required):",
      "• `seed` — DAO tokens from your wallet seeding both markets' base side",
      "• `quote` — native currency from your wallet seeding both markets' quote side",
    ];
  }
  return [];
}

/**
 * Pulls this model's name=value settings out of the words, wherever they
 * are, and returns the remaining words for the action's own parsing.
 */
export function takeModelOptions(model, words) {
  const keys = KEYS[model];
  if (!keys) return { options: {}, rest: words };
  const options = {};
  const rest = [];
  for (const word of words) {
    const m = /^([A-Za-z]+)=(.+)$/.exec(word);
    if (m && keys.includes(m[1].toLowerCase())) options[m[1].toLowerCase()] = m[2];
    else rest.push(word);
  }
  return { options, rest };
}

function positiveAmount(text, what) {
  if (text === undefined || !(Number(text) > 0)) throw new ProposalOptionError(`${what} is required: a positive number.`);
  return text;
}

/**
 * The oracle a proposal resolves against: "pyth" (the default) means
 * this network's PythPriceFeedAdapter (PYTH_PRICE_ADAPTER); an address is
 * taken as given.
 */
export function resolveOracleWord(word) {
  if (word === undefined || String(word).toLowerCase() === "pyth") {
    const adapter = pythPriceAdapter();
    if (!adapter) throw new ProposalOptionError("No Pyth price adapter is configured on this bot for this network - ask an admin to set PYTH_PRICE_ADAPTER, or pass oracle=<adapter address>.");
    return getAddress(adapter);
  }
  if (!isAddress(word)) throw new ProposalOptionError("oracle= must be pyth or an adapter address.");
  return getAddress(word);
}

/**
 * An oracle-track goal as the adapter reports values: 18-decimal fixed
 * point. "3000" or "3000.5" (dollars, for a USD feed) -> 3000.5e18.
 */
export function oracleGoalValue(text) {
  if (!/^-?\d+(\.\d{1,18})?$/.test(String(text))) throw new ProposalOptionError("goal= must be a number, e.g. 3000 or 0.95 (the feed's price; up to 18 decimals).");
  const negative = String(text).startsWith("-");
  const value = parseUnits(String(text).replace(/^-/, ""), 18);
  return negative ? -value : value;
}

/** The resolution criteria Sowellian's propose() takes, from the settings words. */
export function sowellianCriteria(options) {
  const track = (options.track ?? "human").toLowerCase();
  if (track !== "human" && track !== "oracle") throw new ProposalOptionError("track= must be human or oracle.");
  const when = (options.when ?? "min").toLowerCase();
  if (when !== "min" && when !== "max") throw new ProposalOptionError("when= must be min (success if the result is at least goal) or max (at most goal).");
  let measurementPeriod;
  try {
    measurementPeriod = parseDuration(options.measure, 7 * 86400);
  } catch (err) {
    throw new ProposalOptionError(`measure=: ${err.message}`);
  }
  if (measurementPeriod <= 0) throw new ProposalOptionError("measure= must be longer than zero.");

  if (track === "human") {
    if (options.oracle || options.feed) throw new ProposalOptionError("oracle= and feed= only apply with track=oracle.");
    if (options.goal !== undefined && !/^-?\d+$/.test(options.goal)) throw new ProposalOptionError("On the human track goal= is a whole number (it's only recorded; people decide the outcome).");
    return { resolutionMethod: 1, oracle: zeroAddress, oracleSelector: zeroHash, targetValue: options.goal ?? "0", targetIsMinimum: when === "min", measurementPeriod };
  }

  if (!options.feed) throw new ProposalOptionError("The oracle track needs feed=<Pyth price feed ID> (0x + 64 hex, from Pyth's price feed list, e.g. ETH/USD).");
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.feed)) throw new ProposalOptionError("feed= must be a Pyth price feed ID: 0x followed by 64 hex characters.");
  if (options.goal === undefined) throw new ProposalOptionError("The oracle track needs goal=<price> - what the feed's price is compared against, e.g. goal=3000.");
  return {
    resolutionMethod: 0,
    oracle: resolveOracleWord(options.oracle),
    oracleSelector: options.feed,
    targetValue: oracleGoalValue(options.goal),
    targetIsMinimum: when === "min",
    measurementPeriod,
  };
}

/**
 * Checks the settings before anything is built or sent, so a missing seed
 * or oracle is reported before the action's own (slower) checks run.
 */
export function checkModelOptions(model, options) {
  if (model === "sowellian") sowellianCriteria(options);
  if (model === "decisionMarkets") {
    positiveAmount(options.seed, "seed= (DAO tokens seeding both markets' base side)");
    positiveAmount(options.quote, "quote= (native currency seeding both markets' quote side)");
  }
}

/** Submits `actions` the way this model proposes. Returns { proposalId }. */
export async function proposeForModel({ model, client, governanceAddress, actions, description, options = {} }) {
  const adapter = getAdapter(model);
  if (model === "sowellian") {
    const c = sowellianCriteria(options);
    return adapter.proposeWithCriteria(client, governanceAddress, actions, description, c.resolutionMethod, c.oracle, c.oracleSelector, c.targetValue, c.targetIsMinimum, c.measurementPeriod);
  }
  if (model === "decisionMarkets") {
    checkModelOptions(model, options);
    return adapter.proposeWithSeed(client, governanceAddress, actions, description, options.seed, options.quote);
  }
  return adapter.propose(client, governanceAddress, actions, description);
}

/** What to do next with a new proposal, by model. `cmd(name)` renders a command. */
export function proposalNextStep(model, proposalId, cmd) {
  if (model === "sowellian") return `Next: the approval vote - \`${cmd("castapprovalvote")} ${proposalId} for|against|abstain\`. Follow it with \`${cmd("proposal")} ${proposalId}\`.`;
  if (model === "decisionMarkets") return `Both markets are live - split tokens with \`${cmd("split")}\`, then back Pass or Fail with \`${cmd("trade")}\`. Follow it with \`${cmd("proposal")} ${proposalId}\`.`;
  return `Use \`${cmd("proposal")} ${proposalId}\` to check on it, or \`${cmd("vote")} ${proposalId} for|against|abstain\` once voting opens.`;
}
