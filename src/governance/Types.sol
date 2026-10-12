// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            ENUMS
//////////////////////////////////////////////////////////////*/

/// @notice Current lifecycle state of a proposal.
enum ProposalState {
    Pending,      // Created but voting has not started.
    Active,       // Voting is currently open.
    Succeeded,    // Passed quorum and approval threshold.
    Queued,       // Proposal is queued for execution.
    Defeated,     // Failed quorum or approval threshold.
    Executed,     // Proposal has been executed.
    Cancelled,    // Proposal was cancelled.
    Expired       // Proposal execution window expired.
}

/// @notice Available voting options.
enum VoteType {
    Against,
    For,
    Abstain
}

/*//////////////////////////////////////////////////////////////
                    GOVERNANCE SETTINGS
//////////////////////////////////////////////////////////////*/

/// @notice Configuration for a DAO.
struct GovernanceConfig {

    /// Minimum participation required.
    /// Example:
    /// 1000 = 10%
    uint16 quorumBps;

    /// Percentage of FOR votes required.
    /// Example:
    /// 6000 = 60%
    uint16 approvalThresholdBps;

    /// Delay before voting starts.
    uint32 votingDelay;

    /// Voting duration.
    uint32 votingPeriod;

    /// Delay before proposal execution.
    uint32 timelockDelay;

    /// Duration before a proposal can be executed.
    uint32 executionPeriod;

    /// Minimum voting power required
    /// to create a proposal.
    uint256 proposalThreshold;
}


/*//////////////////////////////////////////////////////////////
                    EXECUTION ACTION
//////////////////////////////////////////////////////////////*/

/// @notice A proposal may execute
/// multiple actions.
struct ProposalAction {

    address target;

    uint256 value;

    bytes data;
}

/*//////////////////////////////////////////////////////////////
                        PROPOSALS
//////////////////////////////////////////////////////////////*/

struct Proposal {

    // Proposal ID.
    uint256 id;

    // Proposal Actions.
    ProposalAction[] actions;

    // Creator.
    address proposer;


    // IPFS CID, HTTP or markdown.
    string metadataURI;

    uint256 createdBlock;
    
    // Snapshot block.
    uint256 snapshotBlock;

    // Voting starts.
    uint256 startBlock;

    // Voting ends.
    uint256 endBlock;

    /// Block at which the proposal was queued.
    uint256 queuedAt;

    // Vote totals.
    uint256 forVotes;

    // Against votes.
    uint256 againstVotes;

    // Abstain votes.
    uint256 abstainVotes;

    // Proposal execution status.
    bool executed;

    bool cancelled;
}

/*//////////////////////////////////////////////////////////////
                        DAO INFO
//////////////////////////////////////////////////////////////*/

struct DAOInfo {

    string name;

    address creator;

    // The staking wrapper Governance reads voting power from.
    address governanceToken;

    // The raw, transferable token that must be staked into
    // governanceToken to receive voting power.
    address underlyingToken;

    address governance;

    address treasury;

    uint256 createdAt;
}



/*//////////////////////////////////////////////////////////////
                        VOTE RECEIPT
//////////////////////////////////////////////////////////////*/

struct VoteReceipt {

    bool hasVoted;

    VoteType support;

    uint256 weight;
}

