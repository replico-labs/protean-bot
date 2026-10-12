// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal interface into a DAO's StakedGovernanceToken.
interface IVotesToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title QuadraticGovernance
/// @author Marvin Sunday
/// @notice A quadratic-weighted governance model: voting power on a
///         proposal is the square root of a holder's staked balance, not
///         their raw balance. Same propose/vote/queue/execute lifecycle as
///         the token-weighted model - only the weight calculation changes.
/// @dev Design note on which "quadratic voting" this is: classic textbook
///      quadratic voting has voters spend a per-round credit budget where
///      casting N votes on one option costs N^2 credits, letting a single
///      voter concentrate strength on issues they care most about. That
///      requires redesigning vote-casting into numeric credit allocation
///      instead of a single For/Against/Abstain choice, and deciding how
///      credits replenish between rounds. This contract implements the
///      other common on-chain variant instead: weight = sqrt(balance),
///      applied once per vote. A holder with 100x the stake gets only 10x
///      the voting power, not 100x - diminishing returns for large
///      holders, without changing the vote-casting interface at all.
///      `proposalThreshold` eligibility is checked against raw balance,
///      not the square root - it's a spam gate, not a voting-power
///      calculation, so it isn't quadratically transformed.
///
///      Drops into the same trusted-`governance` slot on Treasury as every
///      other implementation in this system, and reuses the DAO's
///      existing StakedGovernanceToken - switching from token-weighted to
///      quadratic governance requires no new token.
contract QuadraticGovernance is Initializable {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum ProposalState {
        Pending,
        Active,
        Succeeded,
        Queued,
        Defeated,
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
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes; // sum of sqrt-weighted votes
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
    }

    struct VoteReceipt {
        bool hasVoted;
        VoteType support;
        uint256 weight; // sqrt-weighted, not raw balance
    }

    struct QuadraticGovernanceConfig {
        uint16 quorumBps; // of sqrt(totalSupply)
        uint16 approvalThresholdBps;
        uint32 votingDelay; // blocks
        uint32 votingPeriod; // blocks
        uint32 timelockDelay; // seconds
        uint32 executionPeriod; // seconds
        uint256 proposalThreshold; // raw balance, not sqrt-transformed
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
    error ProposalNotActive();
    error AlreadyVoted();
    error VotingNotStarted();
    error QuorumNotReached();
    error ApprovalThresholdNotMet();
    error ProposalAlreadyQueued();
    error ProposalNotExecutable();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCancelled();
    error ProposalExpired();
    error ExecutionFailed();
    error InvalidValue();
    error Unauthorized();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI);
    event VoteCast(address indexed voter, uint256 indexed proposalId, VoteType support, uint256 weight);
    event ProposalCancelled(uint256 indexed proposalId, address indexed caller);
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
    QuadraticGovernanceConfig internal _config;

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

    /// @dev Clone-compatible conversion, same pattern as Governance.sol -
    ///      no immutables here (confirmed from source), so this is a
    ///      direct, faithful port of the original constructor.
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory daoName_,
        address creator_,
        address governanceToken_,
        address treasury_,
        QuadraticGovernanceConfig memory config_
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
        p.startBlock = block.number + _config.votingDelay;
        p.endBlock = p.startBlock + _config.votingPeriod;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI);
    }

    /*//////////////////////////////////////////////////////////////
                            VOTE CASTING
    //////////////////////////////////////////////////////////////*/

    function castVote(
        uint256 proposalId,
        VoteType support
    ) external proposalExists(proposalId) returns (uint256 weight) {
        weight = _castVote(proposalId, msg.sender, support);
    }

    function _castVote(uint256 proposalId, address voter, VoteType support) internal returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];

        if (block.number < p.startBlock || block.number > p.endBlock || p.cancelled || p.executed) {
            revert ProposalNotActive();
        }

        VoteReceipt storage receipt = _voteReceipts[proposalId][voter];
        if (receipt.hasVoted) revert AlreadyVoted();

        receipt.hasVoted = true;
        receipt.support = support;

        uint256 rawBalance = IVotesToken(governanceToken).getPastVotes(voter, p.snapshotBlock);
        weight = _sqrt(rawBalance);
        receipt.weight = weight;

        if (support == VoteType.For) p.forVotes += weight;
        else if (support == VoteType.Against) p.againstVotes += weight;
        else p.abstainVotes += weight;


        emit VoteCast(voter, proposalId, support, weight);
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
                        PROPOSAL QUEUEING
    //////////////////////////////////////////////////////////////*/

    function queueProposal(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (p.queuedAt != 0) revert ProposalAlreadyQueued();
        if (block.number <= p.endBlock) revert VotingNotStarted();

        uint256 sqrtTotalSupply = _sqrt(IVotesToken(governanceToken).getPastTotalSupply(p.snapshotBlock));
        uint256 participation = p.forVotes + p.againstVotes + p.abstainVotes;

        if (sqrtTotalSupply == 0 || (participation * 10_000) / sqrtTotalSupply < _config.quorumBps) {
            revert QuorumNotReached();
        }

        uint256 decisive = p.forVotes + p.againstVotes;
        if (decisive == 0 || (p.forVotes * 10_000) / decisive < _config.approvalThresholdBps) {
            revert ApprovalThresholdNotMet();
        }

        p.queuedAt = block.timestamp;
        emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
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

    function updateGovernanceConfig(QuadraticGovernanceConfig calldata newConfig) external onlyGovernance {
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

    function config() external view returns (QuadraticGovernanceConfig memory) {
        return _config;
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVoteReceipt(uint256 proposalId, address voter) external view returns (VoteReceipt memory) {
        return _voteReceipts[proposalId][voter];
    }

    /// @notice Returns what a voter's weight WOULD be right now, given
    ///         their current (not historical) balance - useful for a
    ///         frontend to preview voting power before a proposal exists.
    function previewWeight(address account) external view returns (uint256) {
        return _sqrt(IVotesToken(governanceToken).balanceOf(account));
    }

    function state(uint256 proposalId) public view proposalExists(proposalId) returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];

        if (p.cancelled) return ProposalState.Cancelled;
        if (p.executed) return ProposalState.Executed;
        if (block.number < p.startBlock) return ProposalState.Pending;
        if (block.number <= p.endBlock) return ProposalState.Active;

        if (p.queuedAt != 0) {
            if (block.timestamp > p.queuedAt + _config.timelockDelay + _config.executionPeriod) {
                return ProposalState.Expired;
            }
            return ProposalState.Queued;
        }

        uint256 sqrtTotalSupply = _sqrt(IVotesToken(governanceToken).getPastTotalSupply(p.snapshotBlock));
        uint256 participation = p.forVotes + p.againstVotes + p.abstainVotes;
        uint256 decisive = p.forVotes + p.againstVotes;

        bool succeeded = sqrtTotalSupply != 0 &&
            (participation * 10_000) / sqrtTotalSupply >= _config.quorumBps &&
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

        uint256 rawBalance = IVotesToken(governanceToken).getPastVotes(proposer, block.number - 1);
        if (rawBalance < threshold) revert ProposalThresholdNotMet();
    }

    function _validateConfig(QuadraticGovernanceConfig memory c) internal pure {
        if (c.quorumBps == 0 || c.quorumBps > 10_000) revert InvalidConfiguration();
        if (c.approvalThresholdBps == 0 || c.approvalThresholdBps > 10_000) revert InvalidConfiguration();
        if (c.votingPeriod == 0) revert InvalidConfiguration();
    }

    /// @dev Integer square root via the Babylonian method (Newton's
    ///      method), the standard approach used by e.g. OpenZeppelin's
    ///      Math.sqrt - reimplemented here to keep this contract free of
    ///      external dependencies. Rounds down, which is the conservative
    ///      direction for voting weight (never overstates power).
    function _sqrt(uint256 x) internal pure returns (uint256 result) {
        if (x == 0) return 0;

        uint256 z = (x + 1) / 2;
        result = x;
        while (z < result) {
            result = z;
            z = (x / z + z) / 2;
        }
    }
}
