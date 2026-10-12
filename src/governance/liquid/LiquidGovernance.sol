// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev Minimal interface into a DAO's StakedGovernanceToken.
interface IVotesToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @title LiquidGovernance
/// @author Marvin Sunday
/// @notice A liquid-democracy governance model: every holder retains the
///         right to vote directly at any time, and can also delegate to
///         any other address - fully revocable, changeable whenever they
///         want. Delegation chains resolve transitively, up to a bounded
///         depth.
/// @dev IMPORTANT DESIGN NOTE - the delegation graph here is entirely
///      separate from StakedGovernanceToken's own built-in ERC20Votes
///      delegate() mechanism. That token-level delegation still needs to
///      be set (even self-delegation) for `getPastVotes` to return a
///      non-zero checkpointed balance at all - see StakedGovernanceToken's
///      own docs. This contract's `delegate()` is a second, independent
///      layer on top: it decides WHO CASTS a proposal vote using that
///      already-checkpointed weight, not whether the weight exists.
///
///      TRANSITIVE RESOLUTION IS BOUNDED AND NOT AUTOMATIC - read this
///      before assuming it works like a simple "vote inheritance":
///
///      Full automatic transitivity (instantly re-routing every follower
///      whenever anyone mid-chain changes their delegate) is a genuinely
///      unbounded problem on-chain - the set of people "downstream" of a
///      popular delegate can be arbitrarily large, so there is no way to
///      guarantee fixed gas for that kind of update. This contract avoids
///      that by never doing reverse lookups. Instead:
///
///      1. A delegate votes directly via `castVote` - this only ever
///         uses their own weight, exactly like any other voter.
///      2. Anyone (the delegator, the delegate, or a bot acting on
///         either's behalf) can then call `resolveDelegatedVote` for a
///         specific delegator. That walks the delegator's OWN chain
///         forward - never backward - up to MAX_CHAIN_DEPTH hops, looking
///         for the first address in the chain that has already voted on
///         this proposal, and pulls the delegator's weight onto whatever
///         that address voted.
///      3. This has to be called once per delegator, explicitly. There is
///         no automatic sweep - if nobody calls it, that delegator's
///         weight is simply not counted, even if they genuinely delegated
///         and their delegate genuinely voted. A bot is the practical way
///         to make this feel automatic; nothing in the contract requires
///         one - resolution is fully permissionless.
///
///      A cycle in the delegation graph (A -> B -> A) cannot cause an
///      infinite loop - the hard MAX_CHAIN_DEPTH cap bounds every walk
///      regardless, it just means resolution fails to find a voter and
///      reverts.
contract LiquidGovernance is Initializable {
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
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
    }

    struct VoteReceipt {
        bool hasVoted;
        bool viaDelegation;
        VoteType support;
        uint256 weight;
        address resolvedVia; // the address whose direct vote this weight was attached to, if delegated
    }

    struct LiquidGovernanceConfig {
        uint16 quorumBps;
        uint16 approvalThresholdBps;
        uint32 votingDelay; // blocks
        uint32 votingPeriod; // blocks
        uint32 timelockDelay; // seconds
        uint32 executionPeriod; // seconds
        uint256 proposalThreshold; // raw balance required to propose
    }

    /// @notice Hard cap on delegation chain length walked per resolution -
    ///         keeps every resolution call's gas bounded regardless of how
    ///         large or tangled the overall delegation graph is.
    uint256 public constant MAX_CHAIN_DEPTH = 5;

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
    error CannotDelegateToSelf();
    error NotDelegated();
    error DelegateHasNotVoted();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event DelegateChanged(address indexed account, address indexed previousDelegate, address indexed newDelegate);
    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI);
    event VoteCast(address indexed voter, uint256 indexed proposalId, VoteType support, uint256 weight);
    event DelegatedVoteResolved(
        uint256 indexed proposalId,
        address indexed delegator,
        address indexed resolvedVia,
        VoteType support,
        uint256 weight
    );
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
    LiquidGovernanceConfig internal _config;

    /// @notice Who each address currently delegates to. address(0) means
    ///         "not delegated - votes only directly."
    mapping(address => address) public delegatedTo;

    /// @notice Direct (one-hop) delegators of each address - what a bot or
    ///         UI actually needs to know who to call resolveDelegatedVote
    ///         for. This is safe to maintain on-chain because it's a flat
    ///         list with O(1) add/remove per delegate() call, never a
    ///         cascading update - it only tracks direct delegators, not
    ///         the full transitive set. To find everyone transitively
    ///         behind an address, a caller walks this outward themselves
    ///         (get direct delegators, then get their direct delegators,
    ///         etc.), off-chain, up to the same depth the contract itself
    ///         honors.
    mapping(address => address[]) internal _directDelegators;
    mapping(address => uint256) internal _directDelegatorIndex;

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
        LiquidGovernanceConfig memory config_
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
                            DELEGATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Delegates the caller's future vote resolution to `to`.
    ///         Fully revocable and changeable at any time. Does not affect
    ///         the caller's own ability to vote directly on any proposal -
    ///         see `castVote`.
    function delegate(address to) external {
        if (to == msg.sender) revert CannotDelegateToSelf();
        address previous = delegatedTo[msg.sender];

        if (previous != address(0)) {
            _removeDirectDelegator(previous, msg.sender);
        }

        delegatedTo[msg.sender] = to;
        _directDelegators[to].push(msg.sender);
        _directDelegatorIndex[msg.sender] = _directDelegators[to].length - 1;

        emit DelegateChanged(msg.sender, previous, to);
    }

    /// @notice Clears the caller's delegation - future resolutions for
    ///         them will find nothing until they delegate again.
    function undelegate() external {
        address previous = delegatedTo[msg.sender];
        if (previous == address(0)) revert NotDelegated();

        _removeDirectDelegator(previous, msg.sender);
        delegatedTo[msg.sender] = address(0);

        emit DelegateChanged(msg.sender, previous, address(0));
    }

    /// @dev Swap-and-pop removal from a delegate's direct-delegators list -
    ///      O(1), same pattern already used elsewhere in this codebase
    ///      (BoardGovernance.removeSigner, SortitionGovernance's pool
    ///      removal). Never touches any other delegate's list.
    function _removeDirectDelegator(address delegateAddr, address delegator) internal {
        uint256 index = _directDelegatorIndex[delegator];
        address[] storage arr = _directDelegators[delegateAddr];
        uint256 lastIndex = arr.length - 1;

        if (index != lastIndex) {
            address lastDelegator = arr[lastIndex];
            arr[index] = lastDelegator;
            _directDelegatorIndex[lastDelegator] = index;
        }
        arr.pop();
        delete _directDelegatorIndex[delegator];
    }

    /// @notice Returns everyone who directly (one-hop) delegates to
    ///         `account` right now - what a bot needs to know who to call
    ///         resolveDelegatedVote for once `account` votes. For the full
    ///         transitive set behind a popular delegate, call this
    ///         recursively on each returned address, off-chain, up to
    ///         MAX_CHAIN_DEPTH levels deep.
    function getDirectDelegators(address account) external view returns (address[] memory) {
        return _directDelegators[account];
    }

    /// @notice Read-only helper for UIs: walks an account's delegation
    ///         chain as far as it currently goes (up to MAX_CHAIN_DEPTH),
    ///         without requiring a specific proposal. Returns the final
    ///         address in the chain and how many hops it took.
    function delegateChainTip(address account) external view returns (address tip, uint256 hops) {
        tip = account;
        for (uint256 i = 0; i < MAX_CHAIN_DEPTH; i++) {
            address next = delegatedTo[tip];
            if (next == address(0)) break;
            tip = next;
            hops++;
        }
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

    /// @notice Votes directly, using only the caller's own weight -
    ///         always available regardless of whether the caller has a
    ///         delegate set. This is the core liquid-democracy property:
    ///         delegation is a fallback, never a lock-out.
    function castVote(
        uint256 proposalId,
        VoteType support
    ) external proposalExists(proposalId) returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];
        if (block.number < p.startBlock || block.number > p.endBlock || p.cancelled || p.executed) {
            revert ProposalNotActive();
        }

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

    /// @notice Resolves `delegator`'s vote by walking their delegation
    ///         chain forward (up to MAX_CHAIN_DEPTH hops) for the first
    ///         address that has already voted on this proposal, and
    ///         attaches the delegator's own weight to that choice.
    ///         Permissionless - callable by the delegator, their delegate,
    ///         or anyone else (e.g. a bot) on their behalf.
    function resolveDelegatedVote(uint256 proposalId, address delegator) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (block.number < p.startBlock || block.number > p.endBlock || p.cancelled || p.executed) {
            revert ProposalNotActive();
        }

        VoteReceipt storage delegatorReceipt = _voteReceipts[proposalId][delegator];
        if (delegatorReceipt.hasVoted) revert AlreadyVoted();

        address current = delegatedTo[delegator];
        if (current == address(0)) revert NotDelegated();

        bool found = false;
        VoteType foundSupport;
        address resolvedVia;

        for (uint256 i = 0; i < MAX_CHAIN_DEPTH; i++) {
            VoteReceipt storage candidate = _voteReceipts[proposalId][current];
            if (candidate.hasVoted) {
                found = true;
                foundSupport = candidate.support;
                resolvedVia = current;
                break;
            }
            address next = delegatedTo[current];
            if (next == address(0)) break;
            current = next;
        }

        if (!found) revert DelegateHasNotVoted();

        // Effects before the external call below.
        delegatorReceipt.hasVoted = true;
        delegatorReceipt.viaDelegation = true;
        delegatorReceipt.support = foundSupport;
        delegatorReceipt.resolvedVia = resolvedVia;

        uint256 weight = IVotesToken(governanceToken).getPastVotes(delegator, p.snapshotBlock);
        delegatorReceipt.weight = weight;

        if (foundSupport == VoteType.For) p.forVotes += weight;
        else if (foundSupport == VoteType.Against) p.againstVotes += weight;
        else p.abstainVotes += weight;

        emit DelegatedVoteResolved(proposalId, delegator, resolvedVia, foundSupport, weight);
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

        uint256 totalSupply = IVotesToken(governanceToken).getPastTotalSupply(p.snapshotBlock);
        uint256 participation = p.forVotes + p.againstVotes + p.abstainVotes;

        if (totalSupply == 0 || (participation * 10_000) / totalSupply < _config.quorumBps) {
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

    function updateGovernanceConfig(LiquidGovernanceConfig calldata newConfig) external onlyGovernance {
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

    function config() external view returns (LiquidGovernanceConfig memory) {
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
        if (block.number < p.startBlock) return ProposalState.Pending;
        if (block.number <= p.endBlock) return ProposalState.Active;

        if (p.queuedAt != 0) {
            if (block.timestamp > p.queuedAt + _config.timelockDelay + _config.executionPeriod) {
                return ProposalState.Expired;
            }
            return ProposalState.Queued;
        }

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

        uint256 rawBalance = IVotesToken(governanceToken).getPastVotes(proposer, block.number - 1);
        if (rawBalance < threshold) revert ProposalThresholdNotMet();
    }

    function _validateConfig(LiquidGovernanceConfig memory c) internal pure {
        if (c.quorumBps == 0 || c.quorumBps > 10_000) revert InvalidConfiguration();
        if (c.approvalThresholdBps == 0 || c.approvalThresholdBps > 10_000) revert InvalidConfiguration();
        if (c.votingPeriod == 0) revert InvalidConfiguration();
    }
}
