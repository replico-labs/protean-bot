// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                        GOVERNANCE ERRORS
//////////////////////////////////////////////////////////////*/

/// @notice Proposal does not exist.
error ProposalNotFound();

/// @notice Proposal has already been executed.
error ProposalAlreadyExecuted();

/// @notice Proposal has been cancelled.
error ProposalAlreadyCancelled();

/// @notice Voting has not started.
error VotingNotStarted();

/// @notice Voting has already ended.
error VotingClosed();

/// @notice Proposal is not currently active.
error ProposalNotActive();

/// @notice Caller has already voted.
error AlreadyVoted();

/// @notice Caller does not have enough voting power.
error ProposalThresholdNotMet();

/// @notice Proposal failed to reach quorum.
error QuorumNotReached();

/// @notice Proposal failed the approval threshold.
error ApprovalThresholdNotMet();

/// @notice Invalid governance configuration.
error InvalidConfiguration();

/// @notice Invalid proposal action.
error InvalidProposalAction();

/// @notice Invalid proposal identifier.
error InvalidProposalId();

/// @notice Proposal cannot be executed.
error ProposalNotExecutable();

/// @notice Proposal has already been queued.
error ProposalAlreadyQueued();

/// @notice Proposal execution has expired.
error ProposalExpired();

/// @notice Unauthorized caller.
error Unauthorized();

/// @notice Zero address supplied.
error ZeroAddress();

/// @notice Invalid voting period.
error InvalidVotingPeriod();

/// @notice Invalid voting delay.
error InvalidVotingDelay();

/// @notice Invalid quorum percentage.
error InvalidQuorum();

/// @notice Invalid approval threshold.
error InvalidApprovalThreshold();

/// @notice Treasury execution failed.
error ExecutionFailed();

/// @notice ETH value does not match.
error InvalidValue();

/// @notice Empty proposal actions.
error EmptyProposalActions();

/// @notice Metadata URI cannot be empty.
error EmptyMetadataURI();