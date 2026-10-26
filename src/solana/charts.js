import { proposalImage } from "../charts.js";
import * as v from "./vortex.js";

/**
 * Vote charts for Solana proposals: the same pictures as EVM (src/charts.js
 * draws both), from a Vortexes proposal turned into the shape the EVM
 * adapters' getProposal returns. Token amounts are rescaled to 18 decimals,
 * which is what charts.js reads EVM amounts in.
 */

const big = (x) => BigInt(x.toString());

/** Raw amount at `decimals` as an 18-decimal amount. */
const to18 = (raw, decimals) => (decimals <= 18 ? big(raw) * 10n ** BigInt(18 - decimals) : big(raw) / 10n ** BigInt(decimals - 18));

/** Token votes: quadratic ones are on the square-root scale, so half the decimals (as on the proposal page). */
const voteDecimals = (model, decimals) => (model === "quadratic" && decimals % 2 === 0 ? decimals / 2 : decimals);

const tokenTally = (t, decimals) => ({
  forVotes: to18(t.forVotes, decimals),
  againstVotes: to18(t.againstVotes, decimals),
  abstainVotes: to18(t.abstainVotes, decimals),
  voteWeightUnit: "token",
});

const seatTally = (t) => ({ forVotes: BigInt(t.for), againstVotes: BigInt(t.against), abstainVotes: BigInt(t.abstain), voteWeightUnit: "councilVoteCount" });

/** What charts.js draws for proposal `id`, or null when its model has no chart (board, an unchallenged optimistic proposal). */
export async function chartShape(network, model, id, p, g, now) {
  const decimals = v.TOKEN_MODELS.includes(model) ? (await v.mintInfo(network, g.mint)).decimals : 0;
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
    case "liquid":
      return { id, ...tokenTally(p.tally, voteDecimals(model, decimals)) };
    case "optimistic":
      return p.challenged ? { id, ...tokenTally(p.tally, decimals) } : null;
    case "delegate":
      return { id, ...seatTally(v.councilTally(g, p)) };
    case "sortition":
      return { id, ...seatTally(v.sortitionTally(p)) };
    case "sowellian":
      return {
        id,
        approvalForVotes: to18(p.approval.forVotes, decimals),
        approvalAgainstVotes: to18(p.approval.againstVotes, decimals),
        approvalAbstainVotes: to18(p.approval.abstainVotes, decimals),
        yesPool: to18(p.yesPool, decimals),
        noPool: to18(p.noPool, decimals),
        adjudicateSuccessVotes: to18(p.successVotes, decimals),
        adjudicateFailureVotes: to18(p.failureVotes, decimals),
      };
    case "decisionMarkets": {
      const quote = (await v.mintInfo(network, g.quoteMint)).decimals;
      const settled = p.finalized && !p.cancelled;
      // Before settlement, the average so far as the program's finalize will
      // compute it: the accumulators brought up to now (at most the deadline),
      // over the time since the markets opened.
      const until = Math.min(now, Number(p.tradingDeadline));
      const elapsed = Math.max(1, until - Number(p.createdAt));
      const dt = BigInt(Math.max(0, until - Number(p.lastUpdate)));
      const running = (cumulative, pool) => (big(cumulative) + v.rawPrice(pool) * dt) / BigInt(elapsed);
      const side = (pool, cumulative, twap) => ({ spot: v.poolPrice(pool, decimals, quote), twap: v.twapPrice(settled ? twap : running(cumulative, pool), decimals, quote) });
      return {
        id,
        markets: { pass: side(p.passPool, p.passCumulative, p.passTwap), fail: side(p.failPool, p.failCumulative, p.failTwap), thresholdBps: Number(g.config.thresholdBps), settled },
      };
    }
    case "conviction":
      return { id, currentConviction: to18(v.convictionAt(p, g.config.growthRate, now), decimals), requiredConviction: to18(p.requiredConviction, decimals) };
    default:
      return null;
  }
}

/**
 * The image to send with a Solana proposal message, { png, name } or null.
 * `networkId` and the governance account address the proposal's page, so
 * the chart is titled with the details written there.
 */
export async function solanaProposalImage({ network, networkId, model, governance, id, p, g, now, state, skipEmpty = false }) {
  try {
    const shape = await chartShape(network, model, String(id), p, g, now);
    if (!shape) return null;
    return await proposalImage({ network: networkId, chainName: network.name, model, dao: governance.toBase58(), p: shape, state, skipEmpty });
  } catch (err) {
    console.error("[solana] chart failed:", err.message);
    return null;
  }
}
