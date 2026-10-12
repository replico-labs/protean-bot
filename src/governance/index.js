import * as tokenWeighted from "./tokenWeighted.js";
import * as quadratic from "./quadratic.js";
import * as liquid from "./liquid.js";
import * as optimistic from "./optimistic.js";
import * as delegate from "./delegate.js";
import * as board from "./board.js";
import * as sortition from "./sortition.js";
import * as conviction from "./conviction.js";
import * as sowellian from "./sowellian.js";
import * as decisionMarkets from "./decisionMarkets.js";

/**
 * Every adapter module implements the same shared shape:
 *   propose(client, governanceAddress, actions, metadataURI) -> {hash, proposalId}
 *   vote(client, governanceAddress, proposalId, support, reason?) -> {hash}
 *   queue(client, governanceAddress, proposalId) -> {hash}
 *   execute(client, governanceAddress, proposalId, valueWhole?) -> {hash}
 *   cancel(client, governanceAddress, proposalId) -> {hash}
 *   getProposal(governanceAddress, proposalId) -> proposal data, read-only
 *
 * getProposal's return always includes stateIndex and a voteWeightUnit
 * flag ("token" or "sqrtWeight" so far) - check that flag before
 * formatting forVotes/againstVotes/abstainVotes for display. Not every
 * adapter's getProposal returns the same fields beyond that (e.g.
 * quadratic.js has no quorumVotes, since the contract itself doesn't
 * expose one) - see each adapter's own getProposal doc comment for its
 * exact shape.
 *
 * `reason` on vote() is optional everywhere - an adapter for a model
 * with no equivalent (like Quadratic) silently ignores it rather than
 * erroring, so callers never need to know which models support it.
 *
 * Adapters may also export model-specific extras beyond this shared
 * shape (e.g. quadratic.js's previewWeight) - those are only reachable
 * by importing that adapter directly, not through this registry, since
 * they have no equivalent to dispatch to for other models.
 *
 * This registry is what the rest of the bot should import from - never
 * import a specific adapter file directly from a command handler, or
 * the whole point of having one shared interface is lost.
 */
const ADAPTERS = {
  tokenWeighted,
  quadratic,
  liquid,
  optimistic, // queue() here is "smart" - see optimistic.js's own module-level note
  delegate, // propose()/vote() here only work for council members - see delegate.js's own note
  board, // vote()/queue() here throw explicitly - no token, no voting, no separate queue step - see board.js
  sortition, // propose() is open to anyone eligible; only vote() is council-restricted - see sortition.js
  conviction, // vote() throws explicitly - no discrete voting at all, use support()/withdrawSupport() - see conviction.js
  sowellian, // propose()/vote()/queue()/cancel() all throw explicitly - use the many real extras - see sowellian.js
  decisionMarkets, // propose()/vote()/queue() all throw explicitly - use trade()/proposeWithSeed() - see decisionMarkets.js
};

export const SUPPORTED_MODELS = Object.keys(ADAPTERS);

export function getAdapter(model) {
  const adapter = ADAPTERS[model];
  if (!adapter) {
    throw new Error(
      `No adapter registered for governance model "${model}". Supported: ${SUPPORTED_MODELS.join(", ")}`
    );
  }
  return adapter;
}
