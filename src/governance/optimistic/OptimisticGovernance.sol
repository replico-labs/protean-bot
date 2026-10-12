// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev Minimal interface into a DAO's StakedGovernanceToken - covers both
///      voting power reads (for the fallback vote) and standard ERC20
///      transfer methods (for handling challenge bonds in the same token).
interface IVotesToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title OptimisticGovernance
/// @author Marvin Sunday
/// @notice An optimistic governance model: proposals pass automatically
///         after a challenge window unless someone posts a bond to dispute
///         them, in which case they fall back to a real token-weighted
///         vote. Routine, uncontroversial actions become cheap and fast;
///         only genuinely contested proposals need active voting.
/// @dev Drops into the same trusted-`governance` slot on Treasury as every
///      other implementation in this system, and reuses the DAO's
///      existing StakedGovernanceToken for both voting weight and as the
///      currency for challenge bonds (bonding a challenge is itself a
///      standard token transfer into this contract - it also temporarily
///      removes the challenger's own voting power, since the tokens leave
///      their wallet, which is a deliberate "real skin in the game" side
///      effect, not an oversight).
///
///      Bond outcome logic: if a challenged proposal still passes its
///      fallback vote, the challenge failed to stop a legitimate proposal
///      and the bond is forfeited to the treasury. If the vote defeats it,
///      the challenge correctly caught a bad proposal and the bond is
///      returned to the challenger. Only one challenge is allowed per
///      proposal - the first challenger locks in the dispute.
contract OptimisticGovernance is Initializable {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum ProposalState {
        ChallengeWindow, // unchallenged so far, still within the window
        Active, // challenged, fallback vote in progress
        Succeeded, // ready to queue (window passed unchallenged, or vote passed)
        Queued,
        Defeated, // challenge vote struck the proposal down
        Executed,
        Cancelled,
        Expired
    }

    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct ProposalAction {
        address target;
        uint256 value;
        bytes data;
    }

    struct Proposal {
        uint256 id;
        ProposalAction[] actions;
        address proposer;
        string metadataURI;
        uint256 createdBlock;
        uint256 snapshotBlock;
        uint256 challengeDeadline; // block
        bool challenged;
        address challenger;
        uint256 votingEndBlock; // block, only meaningful if challenged
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
        bool bondResolved;
    }

    struct VoteReceipt {
        bool hasVoted;
        VoteType support;
        uint256 weight;
    }

    struct OptimisticGovernanceConfig {
        uint32 challengePeriod; // blocks
        uint256 challengeBond; // amount of governanceToken required to challenge
        uint16 quorumBps; // of total supply, used only if challenged
        uint16 approvalThresholdBps; // used only if challenged
        uint32 votingPeriod; // blocks, used only if challenged
        uint32 timelockDelay; // seconds
        uint32 executionPeriod; // seconds
        uint256 proposalThreshold; // raw balance required to propose
    }

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error InvalidConfiguration();
    error EmptyProposalActions();
    error EmptyMetadataURI();
    error InvalidProposalAction();
    error ProposalThresholdNotMet();
    error ProposalNotFound();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCancelled();
    error ChallengeWindowClosed();
    error AlreadyChallenged();
    error NotChallenged();
    error ChallengeWindowStillOpen();
    error VotingClosed();
    error VotingNotEnded();
    error AlreadyVoted();
    error ProposalNotActive();
    error QuorumNotReached();
    error ApprovalThresholdNotMet();
    error ProposalAlreadyQueued();
    error ProposalNotExecutable();
    error ProposalExpired();
    error ExecutionFailed();
    error InvalidValue();
    error Unauthorized();
    error BondTransferFailed();
    error BondAlreadyResolved();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI);
    event Challenged(uint256 indexed proposalId, address indexed challenger, uint256 bond);
    event VoteCast(address indexed voter, uint256 indexed proposalId, VoteType support, uint256 weight);
    event ProposalCancelled(uint256 indexed proposalId, address indexed caller);
    event ProposalFinalizedUnchallenged(uint256 indexed proposalId);
    event ProposalFinalizedAfterChallenge(uint256 indexed proposalId, bool succeeded);
    event BondReturned(uint256 indexed proposalId, address indexed challenger, uint256 amount);
    event BondForfeited(uint256 indexed proposalId, address indexed challenger, uint256 amount);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event ConfigUpdated();
    event GovernanceTokenUpdated(address indexed previousToken, address indexed newToken);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    string public daoName;
    address public creator;
    address public governanceToken;
    address public treasury;
    OptimisticGovernanceConfig internal _config;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => VoteReceipt)) internal _voteReceipts;

    /*//////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyGovernance() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    modifier proposalExists(uint256 proposalId) {
        if (proposalId == 0 || proposalId > proposalCount) revert ProposalNotFound();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory daoName_,
        address creator_,
        address governanceToken_,
        address treasury_,
        OptimisticGovernanceConfig memory config_
    ) external initializer {
        if (creator_ == address(0) || governanceToken_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        _validateConfig(config_);

        daoName = daoName_;
        creator = creator_;
        governanceToken = governanceToken_;
        treasury = treasury_;
        _config = config_;
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CREATION
    //////////////////////////////////////////////////////////////*/

    function propose(
        ProposalAction[] calldata actions,
        string calldata metadataURI
    ) external returns (uint256 proposalId) {
        _requireProposalThreshold(msg.sender);

        if (actions.length == 0) revert EmptyProposalActions();
        for (uint256 i = 0; i < actions.length; i++) {
            if (actions[i].target == address(0)) revert InvalidProposalAction();
        }
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.metadataURI = metadataURI;
        p.createdBlock = block.number;
        p.snapshotBlock = block.number - 1;
        p.challengeDeadline = block.number + _config.challengePeriod;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI);
    }

    /*//////////////////////////////////////////////////////////////
                            CHALLENGING
    //////////////////////////////////////////////////////////////*/

    /// @notice Challenges a proposal within its challenge window, posting
    ///         the configured bond. Opens a fallback vote.
    function challenge(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (block.number > p.challengeDeadline) revert ChallengeWindowClosed();
        if (p.challenged) revert AlreadyChallenged();

        p.challenged = true;
        p.challenger = msg.sender;
        p.votingEndBlock = block.number + _config.votingPeriod;

        bool ok = IVotesToken(governanceToken).transferFrom(msg.sender, address(this), _config.challengeBond);
        if (!ok) revert BondTransferFailed();

        emit Challenged(proposalId, msg.sender, _config.challengeBond);
    }

    /*//////////////////////////////////////////////////////////////
                            VOTE CASTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Votes in the fallback vote, only available once a proposal
    ///         has been challenged.
    function castVote(
        uint256 proposalId,
        VoteType support
    ) external proposalExists(proposalId) returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];
        if (!p.challenged) revert ProposalNotActive();
        if (block.number > p.votingEndBlock) revert VotingClosed();
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();

        VoteReceipt storage receipt = _voteReceipts[proposalId][msg.sender];
        if (receipt.hasVoted) revert AlreadyVoted();

        // Effects before the external call below.
        receipt.hasVoted = true;
        receipt.support = support;

        weight = IVotesToken(governanceToken).getPastVotes(msg.sender, p.snapshotBlock);
        receipt.weight = weight;

        if (support == VoteType.For) p.forVotes += weight;
        else if (support == VoteType.Against) p.againstVotes += weight;
        else p.abstainVotes += weight;

        emit VoteCast(msg.sender, proposalId, support, weight);
    }

    /*//////////////////////////////////////////////////////////////
                        FINALIZATION & QUEUEING
    //////////////////////////////////////////////////////////////*/

    /// @notice Finalizes a proposal that was never challenged: once its
    ///         challenge window has passed, anyone can queue it.
    function finalizeUnchallenged(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (p.challenged) revert AlreadyChallenged();
        if (block.number <= p.challengeDeadline) revert ChallengeWindowStillOpen();
        if (p.queuedAt != 0) revert ProposalAlreadyQueued();

        p.queuedAt = block.timestamp;
        emit ProposalFinalizedUnchallenged(proposalId);
        emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
    }

    /// @notice Finalizes a challenged proposal once its fallback vote has
    ///         closed: resolves the bond and queues the proposal if the
    ///         vote upheld it.
    function finalizeChallenge(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (!p.challenged) revert NotChallenged();
        if (block.number <= p.votingEndBlock) revert VotingNotEnded();
        if (p.queuedAt != 0) revert ProposalAlreadyQueued();
        if (p.bondResolved) revert BondAlreadyResolved();

        uint256 totalSupply = IVotesToken(governanceToken).getPastTotalSupply(p.snapshotBlock);
        uint256 participation = p.forVotes + p.againstVotes + p.abstainVotes;
        bool quorumMet = totalSupply != 0 && (participation * 10_000) / totalSupply >= _config.quorumBps;

        uint256 decisive = p.forVotes + p.againstVotes;
        bool approvalMet = decisive != 0 && (p.forVotes * 10_000) / decisive >= _config.approvalThresholdBps;

        bool succeeded = quorumMet && approvalMet;
        p.bondResolved = true;

        if (succeeded) {
            p.queuedAt = block.timestamp;
            // Challenge failed to stop a proposal that passed anyway -
            // bond is forfeited to the treasury.
            bool ok = IVotesToken(governanceToken).transfer(treasury, _config.challengeBond);
            if (!ok) revert BondTransferFailed();
            emit BondForfeited(proposalId, p.challenger, _config.challengeBond);
            emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
        } else {
            // Challenge correctly caught a proposal that didn't have
            // support - bond is returned.
            bool ok = IVotesToken(governanceToken).transfer(p.challenger, _config.challengeBond);
            if (!ok) revert BondTransferFailed();
            emit BondReturned(proposalId, p.challenger, _config.challengeBond);
        }

        emit ProposalFinalizedAfterChallenge(proposalId, succeeded);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CANCELLATION
    //////////////////////////////////////////////////////////////*/

    function cancelProposal(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (msg.sender != p.proposer && msg.sender != address(this)) revert Unauthorized();

        p.cancelled = true;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL EXECUTION
    //////////////////////////////////////////////////////////////*/

    function executeProposal(uint256 proposalId) external payable proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (p.queuedAt == 0) revert ProposalNotExecutable();
        if (block.timestamp < p.queuedAt + _config.timelockDelay) revert ProposalNotExecutable();
        if (block.timestamp > p.queuedAt + _config.timelockDelay + _config.executionPeriod) {
            revert ProposalExpired();
        }

        uint256 totalValue;
        uint256 len = p.actions.length;
        for (uint256 i = 0; i < len; i++) totalValue += p.actions[i].value;
        if (msg.value != totalValue) revert InvalidValue();

        p.executed = true;

        for (uint256 i = 0; i < len; i++) {
            ProposalAction storage action = p.actions[i];
            (bool ok, ) = action.target.call{value: action.value}(action.data);
            if (!ok) revert ExecutionFailed();
        }

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function updateGovernanceConfig(OptimisticGovernanceConfig calldata newConfig) external onlyGovernance {
        _validateConfig(newConfig);
        _config = newConfig;
        emit ConfigUpdated();
    }

    function setGovernanceToken(address newToken) external onlyGovernance {
        if (newToken == address(0)) revert ZeroAddress();
        emit GovernanceTokenUpdated(governanceToken, newToken);
        governanceToken = newToken;
    }

    function setTreasury(address newTreasury) external onlyGovernance {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function config() external view returns (OptimisticGovernanceConfig memory) {
        return _config;
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVoteReceipt(uint256 proposalId, address voter) external view returns (VoteReceipt memory) {
        return _voteReceipts[proposalId][voter];
    }

    function state(uint256 proposalId) public view proposalExists(proposalId) returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];

        if (p.cancelled) return ProposalState.Cancelled;
        if (p.executed) return ProposalState.Executed;

        if (p.queuedAt != 0) {
            if (block.timestamp > p.queuedAt + _config.timelockDelay + _config.executionPeriod) {
                return ProposalState.Expired;
            }
            return ProposalState.Queued;
        }

        if (!p.challenged) {
            if (block.number <= p.challengeDeadline) return ProposalState.ChallengeWindow;
            return ProposalState.Succeeded; // window passed unchallenged, ready to finalize
        }

        if (block.number <= p.votingEndBlock) return ProposalState.Active;

        uint256 totalSupply = IVotesToken(governanceToken).getPastTotalSupply(p.snapshotBlock);
        uint256 participation = p.forVotes + p.againstVotes + p.abstainVotes;
        uint256 decisive = p.forVotes + p.againstVotes;

        bool succeeded = totalSupply != 0 &&
            (participation * 10_000) / totalSupply >= _config.quorumBps &&
            decisive != 0 &&
            (p.forVotes * 10_000) / decisive >= _config.approvalThresholdBps;

        return succeeded ? ProposalState.Succeeded : ProposalState.Defeated;
    }

    function executableAfter(uint256 proposalId) external view proposalExists(proposalId) returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        if (p.queuedAt == 0) return 0;
        return p.queuedAt + _config.timelockDelay;
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    function _requireProposalThreshold(address proposer) internal view {
        uint256 threshold = _config.proposalThreshold;
        if (threshold == 0) return;

        uint256 balance = IVotesToken(governanceToken).balanceOf(proposer);
        if (balance < threshold) revert ProposalThresholdNotMet();
    }

    function _validateConfig(OptimisticGovernanceConfig memory c) internal pure {
        if (c.challengePeriod == 0) revert InvalidConfiguration();
        if (c.quorumBps == 0 || c.quorumBps > 10_000) revert InvalidConfiguration();
        if (c.approvalThresholdBps == 0 || c.approvalThresholdBps > 10_000) revert InvalidConfiguration();
        if (c.votingPeriod == 0) revert InvalidConfiguration();
    }
}
