// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Types.sol";

/*//////////////////////////////////////////////////////////////
                        GOVERNANCE EVENTS
//////////////////////////////////////////////////////////////*/

/// @notice Emitted when a DAO is created.
event DAOCreated(
    address indexed creator,
    address indexed governance,
    address indexed treasury,
    string name
);

/// @notice Emitted when a proposal is created.
event ProposalCreated(
    uint256 indexed proposalId,
    address indexed proposer,
    string metadataURI
);

/// @notice Emitted when a vote is cast.
event VoteCast(
    address indexed voter,
    uint256 indexed proposalId,
    VoteType support,
    uint256 weight,
    string reason
);

/// @notice Emitted when a proposal is cancelled.
event ProposalCancelled(
    uint256 indexed proposalId,
    address indexed cancelledBy
);

/// @notice Emitted when a proposal is queued.
event ProposalQueued(
    uint256 indexed proposalId,
    uint256 executeAfter
);

/// @notice Emitted when a proposal is executed.
event ProposalExecuted(
    uint256 indexed proposalId,
    address indexed executor
);

/// @notice Emitted when governance settings are updated.
event GovernanceConfigUpdated(
    uint16 quorumBps,
    uint16 approvalThresholdBps,
    uint32 votingDelay,
    uint32 votingPeriod,
    uint256 proposalThreshold
);

/// @notice Emitted when treasury is changed.
event TreasuryUpdated(
    address indexed previousTreasury,
    address indexed newTreasury
);

/// @notice Emitted when governance token is changed.
event GovernanceTokenUpdated(
    address indexed previousToken,
    address indexed newToken
);