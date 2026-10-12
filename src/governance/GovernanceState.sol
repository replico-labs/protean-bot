// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Types.sol";
import "./GovernanceMath.sol";

/// @title GovernanceState
/// @notice Stateless helper library for determining proposal lifecycle.
library GovernanceState {
    function votingStarted(Proposal storage proposal) internal view returns (bool) {
        return block.number >= proposal.startBlock;
    }

    function votingEnded(Proposal storage proposal) internal view returns (bool) {
        return block.number > proposal.endBlock;
    }

    function votingActive(Proposal storage proposal) internal view returns (bool) {
        return votingStarted(proposal)
            && !votingEnded(proposal)
            && !proposal.cancelled
            && !proposal.executed;
    }

    function proposalSucceeded(
        Proposal storage proposal,
        GovernanceConfig memory config,
        uint256 totalSupply
    ) internal view returns (bool) {
        if (!votingEnded(proposal)) return false;

        return GovernanceMath.proposalPassed(
            proposal.forVotes,
            proposal.againstVotes,
            proposal.abstainVotes,
            totalSupply,
            config
        );
    }

    function isQueued(Proposal storage proposal) internal view returns (bool) {
        return proposal.queuedAt != 0 && !proposal.executed;
    }

    function timelockComplete(
        Proposal storage proposal,
        GovernanceConfig memory config
    ) internal view returns (bool) {
        if (proposal.queuedAt == 0) return false;
        return block.timestamp >= proposal.queuedAt + config.timelockDelay;
    }

    function executionExpired(
        Proposal storage proposal,
        GovernanceConfig memory config
    ) internal view returns (bool) {
        if (proposal.queuedAt == 0) return false;
        return block.timestamp >
            proposal.queuedAt +
            config.timelockDelay +
            config.executionPeriod;
    }

    function canQueue(
        Proposal storage proposal,
        GovernanceConfig memory config,
        uint256 totalSupply
    ) internal view returns (bool) {
        return proposalSucceeded(proposal, config, totalSupply)
            && proposal.queuedAt == 0
            && !proposal.executed
            && !proposal.cancelled;
    }

    function canExecute(
        Proposal storage proposal,
        GovernanceConfig memory config
    ) internal view returns (bool) {
        return isQueued(proposal)
            && timelockComplete(proposal, config)
            && !executionExpired(proposal, config)
            && !proposal.executed
            && !proposal.cancelled;
    }

    function proposalState(
        Proposal storage proposal,
        GovernanceConfig memory config,
        uint256 totalSupply
    ) internal view returns (ProposalState) {
        if (proposal.cancelled) return ProposalState.Cancelled;
        if (proposal.executed) return ProposalState.Executed;
        if (!votingStarted(proposal)) return ProposalState.Pending;
        if (votingActive(proposal)) return ProposalState.Active;

        if (!proposalSucceeded(proposal, config, totalSupply)) {
            return ProposalState.Defeated;
        }

        if (proposal.queuedAt == 0) {
            return ProposalState.Succeeded;
        }

        if (executionExpired(proposal, config)) {
            return ProposalState.Expired;
        }

        return ProposalState.Queued;
    }
}
