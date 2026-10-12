// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IRandomnessSource } from "../../randomness/IRandomnessSource.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev Minimal interface into a DAO's StakedGovernanceToken.
interface IBalanceToken {
    function balanceOf(address account) external view returns (uint256);
}

/// @title SortitionGovernance
/// @author Marvin Sunday
/// @notice A sortition-based governance model: council seats are filled by
///         a verifiably random draw from a pool of holders who opted in as
///         eligible - not by election (DelegateGovernance) or fixed
///         appointment (BoardGovernance). Resists both plutocratic capture
///         (can't buy a seat) and popularity capture (can't campaign for
///         one). Once seated, the council governs with the same
///         equal-weight, one-seat-one-vote mechanics as
///         DelegateGovernance - the only thing sortition changes is HOW
///         the council gets chosen, not how it governs once chosen.
/// @dev Depends only on IRandomnessSource, not any specific oracle -
///      PythEntropyRandomnessAdapter satisfies it, and any other provider
///      can be swapped in via `setRandomnessSource`. Genuine on-chain
///      randomness (not block-hash manipulation) requires an external
///      randomness provider, which means sortition rounds are inherently
///      asynchronous: start a round (paying the provider's fee), wait for
///      the randomness request to be fulfilled (Pyth Entropy calls back
///      by itself, usually within seconds), then finalize it as a
///      separate transaction.
///
///      Eligibility is opt-in, not automatic for all holders - standard
///      ERC20/ERC20Votes provides no enumerable holder list, so there is
///      no cheap on-chain way to know "everyone who holds tokens" without
///      registration. This mirrors real-world sortition systems (jury
///      duty draws from a registered pool, not literally every resident).
///
///      Deliberately has no recall mechanism, unlike DelegateGovernance -
///      short terms are the intended check on a bad-actor seat here,
///      the same way jury duty relies on a short term rather than a
///      recall process.
contract SortitionGovernance is Initializable {
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
        uint256 startBlock;
        uint256 endBlock;
        uint16 forVotes;
        uint16 againstVotes;
        uint16 abstainVotes;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
    }

    struct VoteReceipt {
        bool hasVoted;
        VoteType support;
    }

    struct SortitionGovernanceConfig {
        uint16 councilSize;
        uint32 termLength; // seconds
        uint256 eligibilityThreshold; // min staked balance to register
        uint16 councilQuorum;
        uint16 councilApprovalThresholdBps;
        uint32 votingDelay; // blocks
        uint32 votingPeriod; // blocks
        uint32 timelockDelay; // seconds
        uint32 executionPeriod; // seconds
    }

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error InvalidConfiguration();
    error NotCouncilMember();
    error AlreadyEligible();
    error NotEligible();
    error EligibilityThresholdNotMet();
    error EmptyProposalActions();
    error EmptyMetadataURI();
    error InvalidProposalAction();
    error ProposalNotFound();
    error ProposalNotActive();
    error AlreadyVoted();
    error CouncilQuorumNotReached();
    error CouncilApprovalNotMet();
    error ProposalAlreadyQueued();
    error ProposalNotExecutable();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCancelled();
    error ProposalExpired();
    error ExecutionFailed();
    error InvalidValue();
    error Unauthorized();
    error TooEarlyForSortition();
    error SortitionAlreadyActive();
    error NoActiveSortitionRound();
    error SortitionAlreadyFinalized();
    error RandomnessNotYetFulfilled();
    error EmptyEligiblePool();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event EligibilityRegistered(address indexed account);
    event EligibilityWithdrawn(address indexed account);
    event SortitionStarted(uint256 indexed round, bytes32 requestId);
    event SortitionFinalized(uint256 indexed round, address[] newCouncil);
    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI);
    event VoteCast(address indexed delegate, uint256 indexed proposalId, VoteType support);
    event ProposalCancelled(uint256 indexed proposalId, address indexed caller);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event ConfigUpdated();
    event GovernanceTokenUpdated(address indexed previousToken, address indexed newToken);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event RandomnessSourceUpdated(address indexed previousSource, address indexed newSource);
    event SortitionRoundAbandoned(uint256 indexed round);

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    string public daoName;
    address public creator;
    address public governanceToken;
    address public treasury;
    IRandomnessSource public randomnessSource;
    SortitionGovernanceConfig internal _config;

    address[] public eligiblePool;
    mapping(address => bool) public isEligible;
    mapping(address => uint256) internal _eligiblePoolIndex;

    address[] public council;
    mapping(address => bool) public isCouncilMember;
    uint256 public currentTermEnd;

    uint256 public sortitionRound;
    mapping(uint256 => bytes32) public requestIdOfRound;
    mapping(uint256 => bool) public roundFinalized;
    bool internal _roundActive;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => VoteReceipt)) internal _voteReceipts;

    /*//////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyCouncilMember() {
        if (!isCouncilMember[msg.sender]) revert NotCouncilMember();
        _;
    }

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
        address randomnessSource_,
        SortitionGovernanceConfig memory config_,
        address[] memory initialCouncil_
    ) external initializer {
        if (
            creator_ == address(0) ||
            governanceToken_ == address(0) ||
            treasury_ == address(0) ||
            randomnessSource_ == address(0)
        ) {
            revert ZeroAddress();
        }
        _validateConfig(config_);
        if (initialCouncil_.length != config_.councilSize) revert InvalidConfiguration();

        daoName = daoName_;
        creator = creator_;
        governanceToken = governanceToken_;
        treasury = treasury_;
        randomnessSource = IRandomnessSource(randomnessSource_);
        _config = config_;

        for (uint256 i = 0; i < initialCouncil_.length; i++) {
            address member = initialCouncil_[i];
            if (member == address(0)) revert ZeroAddress();
            council.push(member);
            isCouncilMember[member] = true;
        }
        currentTermEnd = block.timestamp + config_.termLength;
    }

    /*//////////////////////////////////////////////////////////////
                    ELIGIBILITY (OPT-IN POOL)
    //////////////////////////////////////////////////////////////*/

    /// @notice Registers the caller as eligible for future sortition draws.
    ///         Requires meeting the configured staked-balance threshold.
    function registerEligible() external {
        if (isEligible[msg.sender]) revert AlreadyEligible();

        uint256 balance = IBalanceToken(governanceToken).balanceOf(msg.sender);
        if (balance < _config.eligibilityThreshold) revert EligibilityThresholdNotMet();

        isEligible[msg.sender] = true;
        _eligiblePoolIndex[msg.sender] = eligiblePool.length;
        eligiblePool.push(msg.sender);

        emit EligibilityRegistered(msg.sender);
    }

    /// @notice Withdraws the caller from future sortition draws. Does not
    ///         remove them from a council they're already serving on.
    function withdrawEligibility() external {
        if (!isEligible[msg.sender]) revert NotEligible();

        isEligible[msg.sender] = false;
        uint256 index = _eligiblePoolIndex[msg.sender];
        uint256 lastIndex = eligiblePool.length - 1;

        if (index != lastIndex) {
            address lastAccount = eligiblePool[lastIndex];
            eligiblePool[index] = lastAccount;
            _eligiblePoolIndex[lastAccount] = index;
        }
        eligiblePool.pop();
        delete _eligiblePoolIndex[msg.sender];

        emit EligibilityWithdrawn(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                            SORTITION ROUNDS
    //////////////////////////////////////////////////////////////*/

    /// @notice Starts a new sortition round: requests randomness for the
    ///         next council draw. Callable by anyone once the current term
    ///         has ended. Any native currency sent is forwarded to the
    ///         randomness source to pay its fee (Pyth Entropy charges one
    ///         per request; see PythEntropyRandomnessAdapter.requestFee).
    function startSortition() external payable returns (uint256 round) {
        if (block.timestamp < currentTermEnd) revert TooEarlyForSortition();
        if (_roundActive) revert SortitionAlreadyActive();
        if (eligiblePool.length == 0) revert EmptyEligiblePool();

        sortitionRound++;
        round = sortitionRound;
        _roundActive = true;

        bytes32 requestId = keccak256(abi.encode(address(this), round, block.timestamp));
        requestIdOfRound[round] = requestId;

        randomnessSource.requestRandomness{value: msg.value}(requestId);

        emit SortitionStarted(round, requestId);
    }

    /// @notice Finalizes the active sortition round once its randomness
    ///         request has been fulfilled: draws `councilSize` distinct
    ///         members from the eligible pool via an unbiased partial
    ///         Fisher-Yates shuffle seeded by the verified random value.
    function finalizeSortition() external {
        uint256 round = sortitionRound;
        if (!_roundActive) revert NoActiveSortitionRound();
        if (roundFinalized[round]) revert SortitionAlreadyFinalized();

        bytes32 requestId = requestIdOfRound[round];
        if (!randomnessSource.isFulfilled(requestId)) revert RandomnessNotYetFulfilled();

        uint256 seed = randomnessSource.getRandomness(requestId);

        uint256 poolSize = eligiblePool.length;
        uint256 seats = _config.councilSize;
        uint256 drawCount = seats < poolSize ? seats : poolSize;

        for (uint256 i = 0; i < drawCount; i++) {
            uint256 remaining = poolSize - i;
            uint256 randIndex = i + (uint256(keccak256(abi.encode(seed, i))) % remaining);

            address temp = eligiblePool[i];
            eligiblePool[i] = eligiblePool[randIndex];
            eligiblePool[randIndex] = temp;
            _eligiblePoolIndex[eligiblePool[i]] = i;
            _eligiblePoolIndex[eligiblePool[randIndex]] = randIndex;
        }

        for (uint256 i = 0; i < council.length; i++) {
            isCouncilMember[council[i]] = false;
        }
        delete council;

        for (uint256 i = 0; i < drawCount; i++) {
            address member = eligiblePool[i];
            council.push(member);
            isCouncilMember[member] = true;
        }

        roundFinalized[round] = true;
        _roundActive = false;
        currentTermEnd = block.timestamp + _config.termLength;

        emit SortitionFinalized(round, council);
    }

    /*//////////////////////////////////////////////////////////////
                COUNCIL PROPOSALS & VOTING (same shape as
                DelegateGovernance - only selection differs)
    //////////////////////////////////////////////////////////////*/

    function proposeCouncilAction(
        ProposalAction[] calldata actions,
        string calldata metadataURI
    ) external returns (uint256 proposalId) {
        uint256 balance = IBalanceToken(governanceToken).balanceOf(msg.sender);
        if (balance < _config.eligibilityThreshold) revert EligibilityThresholdNotMet();
        
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
        p.startBlock = block.number + _config.votingDelay;
        p.endBlock = p.startBlock + _config.votingPeriod;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI);
    }

    function castCouncilVote(
        uint256 proposalId,
        VoteType support
    ) external onlyCouncilMember proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (block.number < p.startBlock || block.number > p.endBlock) revert ProposalNotActive();

        VoteReceipt storage receipt = _voteReceipts[proposalId][msg.sender];
        if (receipt.hasVoted) revert AlreadyVoted();
        receipt.hasVoted = true;
        receipt.support = support;

        if (support == VoteType.For) p.forVotes++;
        else if (support == VoteType.Against) p.againstVotes++;
        else p.abstainVotes++;

        emit VoteCast(msg.sender, proposalId, support);
    }

    function cancelProposal(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (msg.sender != p.proposer && msg.sender != address(this)) revert Unauthorized();

        p.cancelled = true;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    function queueProposal(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (p.queuedAt != 0) revert ProposalAlreadyQueued();
        if (block.number <= p.endBlock) revert ProposalNotActive();

        uint256 participants = uint256(p.forVotes) + p.againstVotes + p.abstainVotes;
        if (participants < _config.councilQuorum) revert CouncilQuorumNotReached();

        uint256 decisive = uint256(p.forVotes) + p.againstVotes;
        if (decisive == 0 || (p.forVotes * 10_000) / decisive < _config.councilApprovalThresholdBps) {
            revert CouncilApprovalNotMet();
        }

        p.queuedAt = block.timestamp;
        emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
    }

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

    function updateConfig(SortitionGovernanceConfig calldata newConfig) external onlyGovernance {
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

    /// @notice Swaps the randomness provider without touching council
    ///         membership or proposal history. A round still waiting on the
    ///         old provider is abandoned (its request would never be
    ///         answered by the new one), so the next startSortition requests
    ///         fresh randomness instead of the DAO being stuck. The council
    ///         keeps serving until a later round is finalized.
    function setRandomnessSource(address newSource) external onlyGovernance {
        if (newSource == address(0)) revert ZeroAddress();
        emit RandomnessSourceUpdated(address(randomnessSource), newSource);
        randomnessSource = IRandomnessSource(newSource);
        if (_roundActive) {
            _roundActive = false;
            emit SortitionRoundAbandoned(sortitionRound);
        }
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function config() external view returns (SortitionGovernanceConfig memory) {
        return _config;
    }

    function getCouncil() external view returns (address[] memory) {
        return council;
    }

    function getEligiblePool() external view returns (address[] memory) {
        return eligiblePool;
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function getVoteReceipt(uint256 proposalId, address delegate) external view returns (VoteReceipt memory) {
        return _voteReceipts[proposalId][delegate];
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

        uint256 participants = uint256(p.forVotes) + p.againstVotes + p.abstainVotes;
        uint256 decisive = uint256(p.forVotes) + p.againstVotes;
        bool succeeded = participants >= _config.councilQuorum &&
            decisive != 0 &&
            (p.forVotes * 10_000) / decisive >= _config.councilApprovalThresholdBps;

        return succeeded ? ProposalState.Succeeded : ProposalState.Defeated;
    }

    function executableAfter(uint256 proposalId) external view proposalExists(proposalId) returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        if (p.queuedAt == 0) return 0;
        return p.queuedAt + _config.timelockDelay;
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _validateConfig(SortitionGovernanceConfig memory c) internal pure {
        if (c.councilSize == 0) revert InvalidConfiguration();
        if (c.termLength == 0) revert InvalidConfiguration();
        if (c.councilQuorum == 0 || c.councilQuorum > c.councilSize) revert InvalidConfiguration();
        if (c.councilApprovalThresholdBps == 0 || c.councilApprovalThresholdBps > 10_000) {
            revert InvalidConfiguration();
        }
        if (c.votingPeriod == 0) revert InvalidConfiguration();
    }
}
