import { formatEther } from "viem";

/**
 * Display helpers shared by every chat platform (Telegram's index.js and
 * the Discord/Slack command core), so each model's config reads the
 * same wherever it's shown. Moved verbatim out of index.js.
 */

export function hoursFrom(seconds) {
  return (Number(seconds) / 3600).toFixed(1);
}

export const STANDARD_CONFIG_LINES = (c) => [
  `Quorum: ${Number(c.quorumBps) / 100}%`,
  `Approval threshold: ${Number(c.approvalThresholdBps) / 100}%`,
  `Voting delay: ${c.votingDelay} blocks`,
  `Voting period: ${c.votingPeriod} blocks`,
  `Timelock: ${hoursFrom(c.timelockDelay)}h`,
  `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
];

export const CONFIG_DISPLAY_BY_MODEL = {
  tokenWeighted: STANDARD_CONFIG_LINES,
  quadratic: STANDARD_CONFIG_LINES,
  liquid: STANDARD_CONFIG_LINES,
  optimistic: (c) => [
    `Challenge period: ${hoursFrom(c.challengePeriod)}h`,
    `Challenge bond: ${formatEther(c.challengeBond)} tokens`,
    `Quorum (if challenged): ${Number(c.quorumBps) / 100}%`,
    `Approval threshold (if challenged): ${Number(c.approvalThresholdBps) / 100}%`,
    `Voting period (if challenged): ${c.votingPeriod} blocks`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
    `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
  ],
  delegate: (c) => [
    `Council size: ${c.councilSize}`,
    `Term length: ${(Number(c.termLength) / 86400).toFixed(1)} days`,
    `Candidacy threshold: ${formatEther(c.candidacyThreshold)} tokens`,
    `Candidacy period: ${c.candidacyPeriod} blocks`,
    `Election voting period: ${c.electionVotingPeriod} blocks`,
    `Council quorum: ${c.councilQuorum}`,
    `Council approval threshold: ${Number(c.councilApprovalThresholdBps) / 100}%`,
    `Voting delay: ${c.votingDelay} blocks`,
    `Voting period: ${c.votingPeriod} blocks`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
    `Recall quorum: ${Number(c.recallQuorumBps) / 100}%`,
    `Recall approval threshold: ${Number(c.recallApprovalThresholdBps) / 100}%`,
    `Recall voting period: ${c.recallVotingPeriod} blocks`,
  ],
  board: (c) => [
    `Required approvals: ${c.requiredApprovals}`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
  sortition: (c) => [
    `Council size: ${c.councilSize}`,
    `Term length: ${(Number(c.termLength) / 86400).toFixed(1)} days`,
    `Eligibility threshold: ${formatEther(c.eligibilityThreshold)} tokens`,
    `Council quorum: ${c.councilQuorum}`,
    `Council approval threshold: ${Number(c.councilApprovalThresholdBps) / 100}%`,
    `Voting delay: ${c.votingDelay} blocks`,
    `Voting period: ${c.votingPeriod} blocks`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
  conviction: (c) => [
    `Conviction growth rate: ${c.convictionGrowthRate} per block`,
    `Min threshold conviction: ${formatEther(c.minThresholdConviction)}`,
    `Threshold multiplier: ${c.thresholdMultiplier} per token requested`,
    `Proposal threshold: ${formatEther(c.proposalThreshold)} tokens`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
  sowellian: (c) => [
    `Proposal bond: ${formatEther(c.proposalBondAmount)} tokens`,
    `Approval voting delay: ${c.approvalVotingDelay} blocks`,
    `Approval voting period: ${c.approvalVotingPeriod} blocks`,
    `Approval quorum: ${Number(c.approvalQuorumBps) / 100}%`,
    `Approval threshold: ${Number(c.approvalThresholdBps) / 100}%`,
    `Positions window: ${hoursFrom(c.positionsWindow)}h`,
    `Execution timelock: ${hoursFrom(c.executionTimelockDelay)}h`,
    `Resolution bond: ${formatEther(c.resolutionBondAmount)} tokens`,
    `Challenge period: ${hoursFrom(c.challengePeriod)}h`,
    `Challenge bond: ${formatEther(c.challengeBondAmount)} tokens`,
    `Adjudication voting period: ${c.adjudicationVotingPeriod} blocks`,
    `Adjudication quorum: ${Number(c.adjudicationQuorumBps) / 100}%`,
    `Adjudication threshold: ${Number(c.adjudicationThresholdBps) / 100}%`,
    `Max oracle staleness: ${hoursFrom(c.maxOracleStaleness)}h`,
  ],
  decisionMarkets: (c) => [
    `Trading period: ${hoursFrom(c.tradingPeriod)}h`,
    `Pass must beat fail by: ${Number(c.thresholdBps) / 100}%`,
    `Timelock: ${hoursFrom(c.timelockDelay)}h`,
    `Execution window: ${hoursFrom(c.executionPeriod)}h`,
  ],
};

export const VOTE_CHOICES = { for: 1, against: 0, abstain: 2 };
