import { formatEther } from "viem";
import { blocksToDuration } from "./networks.js";

/**
 * Display helpers shared by every chat platform (Telegram's index.js and
 * the Discord/Slack command core), so each model's config reads the
 * same wherever it's shown. Moved verbatim out of index.js.
 */

export function hoursFrom(seconds) {
  return (Number(seconds) / 3600).toFixed(1);
}

/** A length in seconds, readably: "45s", "2 min", "5.6h", "7.0 days". */
export function duration(seconds) {
  const s = Number(seconds);
  if (s < 120) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)} days`;
}

/** A block count with roughly how long it lasts on this chat's network: "600 blocks (~4m)". */
export function blocks(n) {
  return `${n} blocks (${blocksToDuration(n)})`;
}

export const STANDARD_CONFIG_LINES = (c) => [
  `Quorum: ${Number(c.quorumBps) / 100}%`,
  `Approval threshold: ${Number(c.approvalThresholdBps) / 100}%`,
  `Voting delay: ${blocks(c.votingDelay)}`,
  `Voting period: ${blocks(c.votingPeriod)}`,
  `Timelock: ${duration(c.timelockDelay)}`,
  `Execution window: ${duration(c.executionPeriod)}`,
  `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
];

export const CONFIG_DISPLAY_BY_MODEL = {
  tokenWeighted: STANDARD_CONFIG_LINES,
  quadratic: STANDARD_CONFIG_LINES,
  liquid: STANDARD_CONFIG_LINES,
  optimistic: (c) => [
    `Challenge period: ${blocks(c.challengePeriod)}`,
    `Challenge bond: ${formatEther(c.challengeBond)} tokens`,
    `Quorum (if challenged): ${Number(c.quorumBps) / 100}%`,
    `Approval threshold (if challenged): ${Number(c.approvalThresholdBps) / 100}%`,
    `Voting period (if challenged): ${blocks(c.votingPeriod)}`,
    `Timelock: ${duration(c.timelockDelay)}`,
    `Execution window: ${duration(c.executionPeriod)}`,
    `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
  ],
  delegate: (c) => [
    `Council size: ${c.councilSize}`,
    `Term length: ${duration(c.termLength)}`,
    `Candidacy threshold: ${formatEther(c.candidacyThreshold)} tokens`,
    `Candidacy period: ${blocks(c.candidacyPeriod)}`,
    `Election voting period: ${blocks(c.electionVotingPeriod)}`,
    `Council quorum: ${c.councilQuorum}`,
    `Council approval threshold: ${Number(c.councilApprovalThresholdBps) / 100}%`,
    `Voting delay: ${blocks(c.votingDelay)}`,
    `Voting period: ${blocks(c.votingPeriod)}`,
    `Timelock: ${duration(c.timelockDelay)}`,
    `Execution window: ${duration(c.executionPeriod)}`,
    `Recall quorum: ${Number(c.recallQuorumBps) / 100}%`,
    `Recall approval threshold: ${Number(c.recallApprovalThresholdBps) / 100}%`,
    `Recall voting period: ${blocks(c.recallVotingPeriod)}`,
  ],
  board: (c) => [
    `Required approvals: ${c.requiredApprovals}`,
    `Timelock: ${duration(c.timelockDelay)}`,
    `Execution window: ${duration(c.executionPeriod)}`,
  ],
  sortition: (c) => [
    `Council size: ${c.councilSize}`,
    `Term length: ${duration(c.termLength)}`,
    `Eligibility threshold: ${formatEther(c.eligibilityThreshold)} tokens`,
    `Council quorum: ${c.councilQuorum}`,
    `Council approval threshold: ${Number(c.councilApprovalThresholdBps) / 100}%`,
    `Voting delay: ${blocks(c.votingDelay)}`,
    `Voting period: ${blocks(c.votingPeriod)}`,
    `Timelock: ${duration(c.timelockDelay)}`,
    `Execution window: ${duration(c.executionPeriod)}`,
  ],
  conviction: (c) => [
    `Conviction growth rate: ${c.convictionGrowthRate} per block`,
    `Min threshold conviction: ${formatEther(c.minThresholdConviction)}`,
    `Threshold multiplier: ${c.thresholdMultiplier} per token requested`,
    `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
    `Timelock: ${duration(c.timelockDelay)}`,
    `Execution window: ${duration(c.executionPeriod)}`,
  ],
  sowellian: (c) => [
    `Proposal bond: ${formatEther(c.proposalBondAmount)} tokens`,
    `Approval voting delay: ${blocks(c.approvalVotingDelay)}`,
    `Approval voting period: ${blocks(c.approvalVotingPeriod)}`,
    `Approval quorum: ${Number(c.approvalQuorumBps) / 100}%`,
    `Approval threshold: ${Number(c.approvalThresholdBps) / 100}%`,
    `Positions window: ${duration(c.positionsWindow)}`,
    `Execution timelock: ${duration(c.executionTimelockDelay)}`,
    `Resolution bond: ${formatEther(c.resolutionBondAmount)} tokens`,
    `Challenge period: ${duration(c.challengePeriod)}`,
    `Challenge bond: ${formatEther(c.challengeBondAmount)} tokens`,
    `Adjudication voting period: ${blocks(c.adjudicationVotingPeriod)}`,
    `Adjudication quorum: ${Number(c.adjudicationQuorumBps) / 100}%`,
    `Adjudication threshold: ${Number(c.adjudicationThresholdBps) / 100}%`,
    `Max oracle staleness: ${duration(c.maxOracleStaleness)}`,
  ],
  decisionMarkets: (c) => [
    `Trading period: ${duration(c.tradingPeriod)}`,
    `Pass must beat fail by: ${Number(c.thresholdBps) / 100}%`,
    `Timelock: ${duration(c.timelockDelay)}`,
    `Execution window: ${duration(c.executionPeriod)}`,
  ],
};

export const VOTE_CHOICES = { for: 1, against: 0, abstain: 2 };
