import { PublicKey } from "@solana/web3.js";
import { getAllSolanaChats } from "../db.js";
import { getSolanaNetwork } from "./config.js";
import { describeInstruction } from "./commands.js";
import * as v from "./vortex.js";

/**
 * The Solana side of proposal pages (src/proposalPages.js): a Vortexes
 * proposal's live data, in the same shape as an EVM one so the website
 * renders both. A page is addressed by the DAO's governance account (like
 * an EVM governance contract), so it stays right after a model switch,
 * when the DAO's new governance numbers its proposals from 1 again.
 */

const big = (x) => BigInt(x.toString());
const num = (x) => Number(x.toString());
const plain = (text) => String(text).replace(/`/g, "");

/**
 * The model and DAO behind a governance account, if it belongs to one of
 * the Vortexes programs and a chat on this bot is linked to that DAO.
 */
export async function findSolanaGovernance(networkId, governanceText) {
  let governance;
  try {
    governance = new PublicKey(governanceText);
  } catch {
    return null;
  }
  const network = getSolanaNetwork(networkId);
  const info = await network.connection.getAccountInfo(governance);
  const model = info ? v.modelOf(network, info.owner) : null;
  if (!model) return null;
  const g = await v.readGovernance(network, model, governance);
  const hubDao = g.hubDao.toBase58();
  const known = getAllSolanaChats().some((c) => c.link.network === networkId && c.link.dao === hubDao);
  if (!known) return null;
  return { network, model, governance, g, hubDao: g.hubDao };
}

/** Token amounts in whole tokens (quadratic votes on the token's square-root scale). */
async function tokenFormat(network, model, g) {
  if (!v.TOKEN_MODELS.includes(model)) return null;
  const { decimals } = await v.mintInfo(network, g.mint);
  const fmt = (raw) => v.formatUnits(big(raw), decimals);
  return { decimals, fmt, votes: model === "quadratic" && decimals % 2 === 0 ? (raw) => v.formatUnits(big(raw), decimals / 2) : fmt };
}

/** Everything /proposal shows for a Solana proposal, as the page's live data. Null if there's no such proposal. */
export async function solanaLiveProposal(networkId, governanceText, proposalId) {
  const found = await findSolanaGovernance(networkId, governanceText);
  if (!found) return null;
  const { network, model, governance, g, hubDao } = found;
  const a = v.addresses(network, hubDao, network.programs[model]);
  if (!a.governance.equals(governance)) return null;
  const p = await v.readProposal(network, model, a.proposal(proposalId));
  if (!p) return null;
  const [now, dao, tok] = await Promise.all([v.clusterNow(network), v.readDao(network, hubDao), tokenFormat(network, model, g)]);

  const facts = [];
  const times = [];
  let started = false;
  const tally = (t) => {
    facts.push({ label: "For", value: tok.votes(t.forVotes) }, { label: "Against", value: tok.votes(t.againstVotes) }, { label: "Abstain", value: tok.votes(t.abstainVotes) });
    return big(t.forVotes) + big(t.againstVotes) + big(t.abstainVotes) > 0n;
  };
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
    case "liquid":
      started = tally(p.tally);
      times.push({ label: "Voting closes", at: num(p.votingEndsAt) });
      break;
    case "optimistic":
      if (p.challenged) {
        facts.push({ label: "Challenged by", value: p.challenger.toBase58(), address: true });
        tally(p.tally);
        times.push({ label: "Vote closes", at: num(p.votingEndsAt) });
      } else {
        times.push({ label: "Challenge window closes", at: num(p.challengeDeadline) });
      }
      started = p.challenged;
      break;
    case "conviction": {
      facts.push({ label: "Conviction", value: tok.fmt(v.convictionAt(p, g.config.growthRate, now)) }, { label: "Needed", value: tok.fmt(p.requiredConviction) }, { label: "Backed by", value: tok.fmt(p.totalSupport) });
      if (p.budget.length) {
        const parts = [];
        for (const b of p.budget) {
          if (b.mint.equals(v.SOL_ASSET)) parts.push(`${v.formatUnits(big(b.amount), 9)} SOL`);
          else parts.push(`${v.formatUnits(big(b.amount), (await v.mintInfo(network, b.mint)).decimals)} of ${b.mint.toBase58()}`);
        }
        facts.push({ label: "May spend", value: parts.join(", ") });
      }
      if (p.weakensRules) facts.push({ label: "Note", value: "Changes the DAO's rules or control" });
      started = big(p.totalSupport) > 0n || big(p.conviction) > 0n;
      break;
    }
    case "delegate": {
      const t = v.councilTally(g, p);
      facts.push({ label: "Council for", value: String(t.for) }, { label: "Council against", value: String(t.against) }, { label: "Council abstain", value: String(t.abstain) }, { label: "Votes needed", value: String(g.config.councilQuorum) });
      times.push({ label: "Voting closes", at: num(p.votingEndsAt) });
      started = p.votes.length > 0;
      break;
    }
    case "sortition": {
      const t = v.sortitionTally(p);
      facts.push({ label: "Council for", value: String(t.for) }, { label: "Council against", value: String(t.against) }, { label: "Council abstain", value: String(t.abstain) }, { label: "Votes needed", value: String(v.sortitionQuorum(g)) });
      times.push({ label: "Voting closes", at: num(p.votingEndsAt) });
      started = p.votes.length > 0;
      break;
    }
    case "sowellian": {
      const phase = v.variant(p.phase);
      if (phase === "approvalVoting") {
        tally(p.approval);
        times.push({ label: "Approval vote closes", at: num(p.approvalEndsAt) });
      }
      facts.push({ label: "Resolved by", value: v.variant(p.criteria.method) === "oracle" ? `Pyth feed 0x${Buffer.from(p.criteria.feedId).toString("hex")}` : "people (challengeable)" });
      facts.push({ label: "YES pool", value: tok.fmt(p.yesPool) }, { label: "NO pool", value: tok.fmt(p.noPool) });
      if (phase === "positionsOpen") times.push({ label: "Positions close", at: num(p.positionsDeadline) });
      if (phase === "executed") times.push({ label: "Measured at", at: num(p.measurementDeadline) });
      if (phase === "resolutionProposed") times.push({ label: "Challenge window closes", at: num(p.challengeDeadline) });
      if (phase === "adjudicating") {
        facts.push({ label: "Adjudication: success", value: tok.fmt(p.successVotes) }, { label: "Adjudication: failure", value: tok.fmt(p.failureVotes) });
        times.push({ label: "Adjudication closes", at: num(p.adjudicationEndsAt) });
      }
      if (phase === "finalized") facts.push({ label: "Outcome", value: v.variant(p.finalOutcome) });
      started = phase !== "approvalVoting" || big(p.approval.forVotes) + big(p.approval.againstVotes) + big(p.approval.abstainVotes) > 0n;
      break;
    }
    case "decisionMarkets": {
      const quote = await v.mintInfo(network, g.quoteMint);
      const price = (pool) => v.poolPrice(pool, tok.decimals, quote.decimals).toPrecision(6);
      // Once settled, the averages that decided it (the pools may be emptied by then).
      const twap = (x) => v.twapPrice(x, tok.decimals, quote.decimals).toPrecision(6);
      if (p.finalized && !p.cancelled) {
        facts.push({ label: "Pass market average", value: twap(p.passTwap) }, { label: "Fail market average", value: twap(p.failTwap) }, { label: "Outcome", value: p.passed ? "passed" : "failed" });
      } else {
        facts.push({ label: "Pass market price", value: price(p.passPool) }, { label: "Fail market price", value: price(p.failPool) });
      }
      started = true;
      break;
    }
    case "board":
      facts.push({ label: "Confirmations", value: `${p.confirmations.length} of ${g.signers.length}` }, { label: "Needed", value: String(g.config.requiredApprovals) });
      // The proposer's own confirmation comes with proposing.
      started = p.confirmations.length > 1;
      break;
  }
  if (p.core.epoch !== dao.record.epoch) facts.push({ label: "Note", value: "Made under an earlier governance setup - it can no longer run" });
  // Sowellian has no queue step: it can run once positions close and the timelock passes.
  const queuedAt = model === "sowellian" ? (v.variant(p.phase) === "positionsOpen" && now >= num(p.positionsDeadline) ? num(p.positionsDeadline) : 0) : num(p.queuedAt ?? 0);
  const timelock = model === "sowellian" ? g.config.executionTimelock : num(g.config.timelock ?? 0);

  return {
    network: networkId,
    chain: network.name,
    chainId: null,
    explorer: "https://explorer.solana.com",
    explorerQuery: network.explorerCluster === "mainnet-beta" ? "" : `?cluster=${network.explorerCluster}`,
    nativeSymbol: "SOL",
    model,
    id: String(proposalId),
    state: v.proposalState(model, p, g, now),
    description: p.metadataUri ?? "",
    proposer: p.proposer.toBase58(),
    facts,
    times,
    voting: null,
    tradingDeadline: model === "decisionMarkets" ? num(p.tradingDeadline) : null,
    queuedAt: queuedAt || null,
    executableAfter: queuedAt ? queuedAt + timelock : null,
    actions: p.core.instructions
      .map((ix) => ({ ix, label: describeInstruction(network, ix) }))
      .filter((x) => x.label)
      .map(({ ix, label }) => ({ target: ix.programId.toBase58(), value: "0", data: "", label: plain(label) })),
    started,
  };
}
