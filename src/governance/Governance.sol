// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/*//////////////////////////////////////////////////////////////
                            IMPORTS
//////////////////////////////////////////////////////////////*/

import "./Types.sol";
import "./GovernanceStorage.sol";
import "./GovernanceMath.sol";
import "./GovernanceState.sol";
import "./GovernanceErrors.sol";
import "./GovernanceEvents.sol";

import "../interfaces/IGovernanceToken.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title Governance
/// @author Marvin Sunday
/// @notice Orchestration contract for a modular DAO governance system.
/// @dev This contract holds no independent state beyond what it inherits from
///      GovernanceStorage. All proposal storage, vote receipts and governance
///      configuration live in GovernanceStorage; all quorum/approval/expiry math
///      lives in GovernanceMath; all lifecycle derivation lives in GovernanceState.
///      Governance is only responsible for wiring these modules together and
///      enforcing access control around proposal creation, voting, queueing,
///      and execution.
contract Governance is Initializable, GovernanceStorage {
    /*//////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Restricts a function to governance-approved execution only.
    /// @dev Satisfied when a proposal action targets this contract directly -
    ///      the call frame's msg.sender is then address(this).
    modifier onlyGovernance() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @dev Locks initializers on the implementation contract itself -
    ///      standard OpenZeppelin upgradeable-contracts practice, so
    ///      nobody can call initialize() directly on the implementation
    ///      (only on clones, which get their own independent storage).
    ///      Clone-compatible conversion: this is the reference pattern
    ///      for the other nine governance models - GovernanceStorage's
    ///      fields are all regular storage already (confirmed from
    ///      source, no immutables here), so this is a direct, faithful
    ///      port of the original constructor's own logic and validation,
    ///      nothing more.
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory daoName_,
        address creator_,
        address governanceToken_,
        address treasury_,
        GovernanceConfig memory config_
    ) external initializer {
        if (
            creator_ == address(0) ||
            governanceToken_ == address(0) ||
            treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }

        GovernanceMath.validateConfig(config_);

        daoName = daoName_;
        creator = creator_;

        governanceToken = governanceToken_;
        treasury = treasury_;

        _config = config_;
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Creates a new proposal.
    /// @param actions The actions to execute if the proposal passes.
    /// @param metadataURI Off-chain proposal description (IPFS CID, URL, etc).
    /// @return proposalId The ID of the newly created proposal.
    function propose(
        ProposalAction[] calldata actions,
        string calldata metadataURI
    ) external returns (uint256 proposalId) {
        _requireProposalThreshold(msg.sender);
        _validateActions(actions);

        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();

        proposalId = ++_proposalCount;

        Proposal storage proposal = _proposals[proposalId];
        proposal.id = proposalId;
        proposal.proposer = msg.sender;
        proposal.metadataURI = metadataURI;
        proposal.createdBlock = block.number;
        proposal.snapshotBlock = block.number - 1;
        proposal.startBlock = block.number + _config.votingDelay;
        proposal.endBlock = proposal.startBlock + _config.votingPeriod;

        for (uint256 i = 0; i < actions.length; ++i) {
            proposal.actions.push(actions[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI);
    }

    /*//////////////////////////////////////////////////////////////
                            VOTE CASTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Casts a vote on a proposal.
    function castVote(
        uint256 proposalId,
        VoteType support
    ) external proposalExists(proposalId) returns (uint256 weight) {
        weight = _castVote(proposalId, msg.sender, support, "");
    }

    /// @notice Casts a vote on a proposal with a reason.
    function castVoteWithReason(
        uint256 proposalId,
        VoteType support,
        string calldata reason
    ) external proposalExists(proposalId) returns (uint256 weight) {
        weight = _castVote(proposalId, msg.sender, support, reason);
    }

    /// @dev Internal vote-casting logic shared by both external entry points.
    function _castVote(
        uint256 proposalId,
        address voter,
        VoteType support,
        string memory reason
    ) internal returns (uint256 weight) {
        Proposal storage proposal = _proposals[proposalId];

        if (!GovernanceState.votingActive(proposal)) {
            revert ProposalNotActive();
        }

        
        VoteReceipt storage receipt = _voteReceipts[proposalId][voter];
        if (receipt.hasVoted) revert AlreadyVoted();

        receipt.hasVoted = true;
        receipt.support = support;

        weight = IGovernanceToken(governanceToken).getPastVotes(
            voter,
            proposal.snapshotBlock
        );
        receipt.weight = weight;

        if (support == VoteType.For) {
            proposal.forVotes += weight;
        } else if (support == VoteType.Against) {
            proposal.againstVotes += weight;
        } else {
            proposal.abstainVotes += weight;
        }


        emit VoteCast(voter, proposalId, support, weight, reason);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CANCELLATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Cancels a proposal.
    /// @dev Callable by the original proposer at any point before execution,
    ///      or by governance itself (as an action within another executed
    ///      proposal) for administrative cancellation.
    function cancelProposal(
        uint256 proposalId
    ) external proposalExists(proposalId) {
        Proposal storage proposal = _proposals[proposalId];

        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.cancelled) revert ProposalAlreadyCancelled();

        if (msg.sender != proposal.proposer && msg.sender != address(this)) {
            revert Unauthorized();
        }

        proposal.cancelled = true;

        emit ProposalCancelled(proposalId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL QUEUEING
    //////////////////////////////////////////////////////////////*/

    /// @notice Queues a succeeded proposal for execution after the timelock.
    function queueProposal(
        uint256 proposalId
    ) external proposalExists(proposalId) {
        Proposal storage proposal = _proposals[proposalId];

        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.cancelled) revert ProposalAlreadyCancelled();
        if (proposal.queuedAt != 0) revert ProposalAlreadyQueued();

        if (!GovernanceState.votingEnded(proposal)) {
            revert VotingNotStarted();
        }

        uint256 totalSupply = IGovernanceToken(governanceToken)
            .getPastTotalSupply(proposal.snapshotBlock);

        uint256 totalParticipation = GovernanceMath.participation(proposal);

        if (
            !GovernanceMath.hasQuorum(
                totalParticipation,
                totalSupply,
                _config.quorumBps
            )
        ) {
            revert QuorumNotReached();
        }

        if (
            !GovernanceMath.hasApproval(
                proposal.forVotes,
                proposal.againstVotes,
                _config.approvalThresholdBps
            )
        ) {
            revert ApprovalThresholdNotMet();
        }

        proposal.queuedAt = block.timestamp;

        emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Executes a queued proposal once its timelock has elapsed.
    /// @dev Payable: the caller must supply exactly the total ETH value
    ///      required by the proposal's actions. Actions that need to move
    ///      DAO-owned funds should target the Treasury (which holds the
    ///      balance) with a value of 0, rather than requiring the executor
    ///      to front funds.
    function executeProposal(
        uint256 proposalId
    ) external payable proposalExists(proposalId) {
        Proposal storage proposal = _proposals[proposalId];

        if (proposal.executed) revert ProposalAlreadyExecuted();
        if (proposal.cancelled) revert ProposalAlreadyCancelled();
        if (proposal.queuedAt == 0) revert ProposalNotExecutable();

        if (!GovernanceState.timelockComplete(proposal, _config)) {
            revert ProposalNotExecutable();
        }

        if (GovernanceState.executionExpired(proposal, _config)) {
            revert ProposalExpired();
        }

        uint256 totalValue;
        uint256 actionsLength = proposal.actions.length;
        for (uint256 i = 0; i < actionsLength; ++i) {
            totalValue += proposal.actions[i].value;
        }
        if (msg.value != totalValue) revert InvalidValue();

        // Effects before interactions.
        proposal.executed = true;

        for (uint256 i = 0; i < actionsLength; ++i) {
            ProposalAction storage action = proposal.actions[i];

            (bool ok, ) = action.target.call{value: action.value}(action.data);
            if (!ok) revert ExecutionFailed();
        }

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE CONFIGURATION UPDATES
    //////////////////////////////////////////////////////////////*/

    /// @notice Updates the governance configuration.
    /// @dev Only callable through an executed governance proposal that
    ///      targets this contract.
    function updateGovernanceConfig(
        GovernanceConfig calldata newConfig
    ) external onlyGovernance {
        GovernanceMath.validateConfig(newConfig);

        _config = newConfig;

        emit GovernanceConfigUpdated(
            newConfig.quorumBps,
            newConfig.approvalThresholdBps,
            newConfig.votingDelay,
            newConfig.votingPeriod,
            newConfig.proposalThreshold
        );
    }

    /*//////////////////////////////////////////////////////////////
                        GOVERNANCE TOKEN UPDATES
    //////////////////////////////////////////////////////////////*/

    /// @notice Points governance at a new voting token.
    /// @dev Only callable through an executed governance proposal.
    function setGovernanceToken(address newToken) external onlyGovernance {
        if (newToken == address(0)) revert ZeroAddress();

        address previousToken = governanceToken;
        governanceToken = newToken;

        emit GovernanceTokenUpdated(previousToken, newToken);
    }

    /*//////////////////////////////////////////////////////////////
                            TREASURY UPDATES
    //////////////////////////////////////////////////////////////*/

    /// @notice Points governance at a new treasury.
    /// @dev Only callable through an executed governance proposal. The new
    ///      treasury must already recognize this contract as its governance
    ///      (see Treasury.transferGovernance), otherwise governance would be
    ///      unable to execute any further treasury-bound actions.
    function setTreasury(address newTreasury) external onlyGovernance {
        if (newTreasury == address(0)) revert ZeroAddress();

        address previousTreasury = treasury;
        treasury = newTreasury;

        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the current lifecycle state of a proposal.
    function state(
        uint256 proposalId
    ) public view proposalExists(proposalId) returns (ProposalState) {
        Proposal storage proposal = _proposals[proposalId];

        uint256 totalSupply = IGovernanceToken(governanceToken)
            .getPastTotalSupply(proposal.snapshotBlock);

        return GovernanceState.proposalState(proposal, _config, totalSupply);
    }

    /// @notice Returns the voting power required to create a proposal.
    function proposalThreshold() external view returns (uint256) {
        return _config.proposalThreshold;
    }

    /// @notice Returns the number of votes required to reach quorum for a
    ///         given proposal, based on its snapshot total supply.
    function quorumVotes(
        uint256 proposalId
    ) external view proposalExists(proposalId) returns (uint256) {
        Proposal storage proposal = _proposals[proposalId];

        uint256 totalSupply = IGovernanceToken(governanceToken)
            .getPastTotalSupply(proposal.snapshotBlock);

        return GovernanceMath.quorumVotes(totalSupply, _config.quorumBps);
    }

    /// @notice Returns the timestamp after which a queued proposal may be
    ///         executed, or 0 if the proposal is not queued.
    function executableAfter(
        uint256 proposalId
    ) external view proposalExists(proposalId) returns (uint256) {
        Proposal storage proposal = _proposals[proposalId];
        if (proposal.queuedAt == 0) return 0;
        return proposal.queuedAt + _config.timelockDelay;
    }

    /*//////////////////////////////////////////////////////////////
                    INTERNAL VALIDATION HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Reverts if the caller does not hold enough voting power to
    ///         create a proposal.
    function _requireProposalThreshold(address proposer) internal view {
        uint256 threshold = _config.proposalThreshold;
        if (threshold == 0) return;

        uint256 votingPower = IGovernanceToken(governanceToken).getPastVotes(
            proposer,
            block.number - 1
        );

        if (votingPower < threshold) revert ProposalThresholdNotMet();
    }

    /// @notice Validates a set of proposal actions.
    function _validateActions(ProposalAction[] calldata actions) internal pure {
        if (actions.length == 0) revert EmptyProposalActions();

        for (uint256 i = 0; i < actions.length; ++i) {
            if (actions[i].target == address(0)) revert InvalidProposalAction();
        }
    }
}
