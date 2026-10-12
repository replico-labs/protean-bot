// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev Minimal interface into a DAO's StakedGovernanceToken - covers
///      voting-power reads and standard ERC20 transfer methods, since this
///      contract uses the same token both for governance weight and as
///      the currency for bonds and market positions (same pattern already
///      used by OptimisticGovernance for its challenge bond).
interface IVotesToken {
    function getPastVotes(address account, uint256 timepoint) external view returns (uint256);
    function getPastTotalSupply(uint256 timepoint) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @dev Minimal interface into an objective metric oracle - deliberately
///      generic (a single int256 reading plus when it was published)
///      rather than tied to one vendor, so a DAO can point this at
///      whatever feed exists on its chain. PythPriceFeedAdapter is the
///      one built here: `selector` is the Pyth price feed ID, so one
///      adapter per network serves every feed, and values are 18-decimal
///      fixed point. updatedAt lets resolveViaOracle reject stale data
///      (maxOracleStaleness) rather than trust a frozen feed. Pyth is
///      pull-based: post a fresh price update to the Pyth contract right
///      before resolving.
interface IMetricOracle {
    function latestValue(bytes32 selector) external view returns (int256 value, uint256 updatedAt);
}

/// @title SowellianGovernance
/// @author Marvin Sunday
/// @notice Outcome-based governance: the DAO approves a proposal's success
///         criteria up front (fixed, immutable once approved), a
///         pari-mutuel YES/NO market lets participants back their
///         prediction with real capital, the proposal executes, and after
///         a measurement period the outcome is resolved - either
///         automatically via an oracle, or through a human resolver
///         subject to an optimistic challenge window and, only if
///         disputed, a bounded token-weighted adjudication vote. Four
///         separate economic commitments - proposal bond, YES/NO
///         positions, resolution bond, challenge bond - each answer a
///         different question and settle independently.
/// @dev SCOPE AND HONESTY NOTES - read before deploying this anywhere real:
///
///      This is the highest-stakes contract in this governance library.
///      Every other model governs decisions; this one pools and
///      redistributes real capital based on a measured outcome. It has
///      NOT been run through a test suite in this build session (no
///      `forge` available in this environment) - it is compiled and
///      type-checked, not executed. Treat this as a first draft to
///      iterate on, not a finished, audited artifact - test thoroughly,
///      including adversarial cases, before any real funds touch it.
///
///      ADJUDICATION VOTING WEIGHT COMES FROM BEFORE THE MARKET OPENS, NOT
///      FROM CHALLENGE TIME. This is a deliberate choice, not an
///      oversight: takePosition() genuinely transfers tokens out of a
///      bettor's wallet into this contract, so any snapshot taken AFTER
///      positions are taken would show reduced balances for exactly the
///      people with the most direct stake in the outcome - someone who
///      bet their entire balance would show zero adjudication voting
///      power, backwards from what's intended. `positionsOpenSnapshotBlock`
///      is set the moment a proposal enters PositionsOpen (right after
///      approval passes, strictly before any bet can possibly be placed),
///      and both the individual vote weight and the quorum calculation
///      read from that same block - so participating in the market can
///      never shrink a holder's adjudication voice.
///
///      Deliberate scope cuts for this first version:
///      - No resolver/challenger reward distribution beyond bond
///        return/forfeiture - a resolver who is correct gets their bond
///        back, not an additional reward; a real deployment may want to
///        add one, funded from a slashed bond or the treasury.
///      - Adjudication is a single embedded token-weighted vote, not a
///        delegated external governance body - see the design discussion
///        this was built from for why.
///      - The oracle interface is intentionally generic and unverified
///        against any specific vendor - wiring a real price feed behind
///        it is separate, scoped work.

///      - The oracle interface is intentionally generic and unverified
///        against any specific vendor - wiring a real price feed behind
///        it is separate, scoped work.
///      - claimPosition's pari-mutuel division always rounds down, so a
///        tiny amount of dust (bounded by roughly the number of winning
///        positions, in the token's smallest unit) can be left unclaimed
///        in the contract's own balance after everyone settles. This is
///        accepted rather than swept automatically - since the contract
///        already holds that balance, an ordinary governance proposal
///        targeting governanceToken directly (transfer(treasury, dust))
///        can recover it at any time with no additional code needed.

contract SowellianGovernance is Initializable {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum Phase {
        ApprovalVoting,
        Rejected,
        PositionsOpen,
        Executed,
        ResolutionPending,
        ResolutionProposed,
        Adjudicating,
        Finalized,
        Cancelled
    }

    enum Outcome {
        Unresolved,
        Success,
        Failure
    }

    enum ResolutionMethod {
        Oracle,
        Human
    }

    enum Side {
        Yes,
        No
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
        address proposer;
        ProposalAction[] actions;
        string metadataURI;
        Phase phase;

        // Success criteria - fixed once approval passes.
        ResolutionMethod resolutionMethod;
        address oracle; // used only if resolutionMethod == Oracle
        bytes32 oracleSelector; // which feed on `oracle` - the Pyth price feed ID for PythPriceFeedAdapter
        int256 targetValue;
        bool targetIsMinimum; // true: success if metric >= targetValue; false: success if metric <= targetValue
        uint256 measurementPeriod; // seconds, counted from execution

        // Timing.
        uint256 approvalSnapshotBlock;
        uint256 approvalStartBlock;
        uint256 approvalEndBlock;
        uint256 positionsDeadline;
        uint256 executedAt;
        uint256 measurementDeadline;
        uint256 challengeDeadline;
        uint256 positionsOpenSnapshotBlock;
        uint256 adjudicationEndBlock;

        // Approval vote tally.
        uint256 approvalForVotes;
        uint256 approvalAgainstVotes;
        uint256 approvalAbstainVotes;

        // Bonds and market.
        uint256 proposalBond;
        uint256 yesPool;
        uint256 noPool;

        address resolver;
        uint256 resolutionBond;
        Outcome proposedOutcome;

        address challenger;
        uint256 challengeBond;

        // Adjudication vote tally (only used if challenged).
        uint256 adjudicateSuccessVotes;
        uint256 adjudicateFailureVotes;

        Outcome finalOutcome;
    }

    struct SowellianConfig {
        uint256 proposalBondAmount;
        uint32 approvalVotingDelay; // blocks
        uint32 approvalVotingPeriod; // blocks
        uint16 approvalQuorumBps;
        uint16 approvalThresholdBps;
        uint32 positionsWindow; // seconds, after approval passes
        uint32 executionTimelockDelay; // seconds, after positions window closes
        uint256 resolutionBondAmount;
        uint32 challengePeriod; // seconds
        uint256 challengeBondAmount;
        uint32 adjudicationVotingPeriod; // blocks
        uint16 adjudicationQuorumBps;
        uint16 adjudicationThresholdBps;
        uint32 maxOracleStaleness; // seconds - resolveViaOracle rejects data older than this
    }

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error InvalidConfiguration();
    error EmptyProposalActions();
    error EmptyMetadataURI();
    error InvalidProposalAction();
    error InvalidResolutionCriteria();
    error ProposalNotFound();
    error WrongPhase();
    error AlreadyVoted();
    error VotingNotStarted();
    error VotingNotEnded();
    error QuorumNotReached();
    error ApprovalNotMet();
    error PositionsWindowClosed();
    error PositionsWindowStillOpen();
    error ZeroAmount();
    error TransferFailed();
    error ExecutionFailed();
    error InvalidValue();
    error MeasurementPeriodNotEnded();
    error NotOracleTrack();
    error StaleOracleData();
    error NotHumanTrack();
    error AlreadyResolved();
    error ChallengeWindowClosed();
    error ChallengeWindowStillOpen();
    error AlreadyChallenged();
    error NotChallenged();
    error AdjudicationNotEnded();
    error NotFinalized();
    error NothingToClaim();
    error AlreadyClaimed();
    error Unauthorized();
    error Reentrant();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI);
    event ApprovalVoteCast(address indexed voter, uint256 indexed proposalId, VoteType support, uint256 weight);
    event ApprovalFinalized(uint256 indexed proposalId, bool approved);
    event PositionTaken(uint256 indexed proposalId, address indexed account, Side side, uint256 amount);
    event ProposalExecuted(uint256 indexed proposalId);
    event ResolvedViaOracle(uint256 indexed proposalId, int256 observedValue, Outcome outcome);
    event ResolutionProposed(uint256 indexed proposalId, address indexed resolver, Outcome outcome);
    event ResolutionFinalizedUnchallenged(uint256 indexed proposalId, Outcome outcome);
    event ResolutionChallenged(uint256 indexed proposalId, address indexed challenger);
    event AdjudicationVoteCast(address indexed voter, uint256 indexed proposalId, Outcome vote, uint256 weight);
    event AdjudicationFinalized(uint256 indexed proposalId, Outcome finalOutcome);
    event PositionClaimed(uint256 indexed proposalId, address indexed account, uint256 payout);
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
    SowellianConfig internal _config;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => bool)) internal _hasVotedApproval;
    mapping(uint256 => mapping(address => bool)) internal _hasVotedAdjudication;
    mapping(uint256 => mapping(address => uint256)) public yesPosition;
    mapping(uint256 => mapping(address => uint256)) public noPosition;
    mapping(uint256 => mapping(address => bool)) public positionClaimed;

    /// @dev Guards resolveViaOracle specifically - that function calls an
    ///      external `oracle` address chosen by whoever created the
    ///      proposal, unlike every other external call in this contract
    ///      (all of which go to the single, DAO-configured
    ///      governanceToken). A malicious proposer could point `oracle` at
    ///      a contract designed to reenter during the read, before any
    ///      state has changed yet - this lock closes that specific gap.
    bool internal _resolvingOracle;

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

    modifier nonReentrant() {
        if (_resolvingOracle) revert Reentrant();
        _resolvingOracle = true;
        _;
        _resolvingOracle = false;
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
        SowellianConfig memory config_
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
                        1. PROPOSAL CREATION
    //////////////////////////////////////////////////////////////*/

    function propose(
        ProposalAction[] calldata actions,
        string calldata metadataURI,
        ResolutionMethod resolutionMethod,
        address oracle,
        bytes32 oracleSelector,
        int256 targetValue,
        bool targetIsMinimum,
        uint256 measurementPeriod
    ) external returns (uint256 proposalId) {
        if (actions.length == 0) revert EmptyProposalActions();
        for (uint256 i = 0; i < actions.length; i++) {
            if (actions[i].target == address(0)) revert InvalidProposalAction();
        }
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();
        if (resolutionMethod == ResolutionMethod.Oracle && oracle == address(0)) revert InvalidResolutionCriteria();
        if (measurementPeriod == 0) revert InvalidResolutionCriteria();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.metadataURI = metadataURI;
        p.phase = Phase.ApprovalVoting;

        p.resolutionMethod = resolutionMethod;
        p.oracle = oracle;
        p.oracleSelector = oracleSelector;
        p.targetValue = targetValue;
        p.targetIsMinimum = targetIsMinimum;
        p.measurementPeriod = measurementPeriod;

        p.approvalSnapshotBlock = block.number - 1;
        p.approvalStartBlock = block.number + _config.approvalVotingDelay;
        p.approvalEndBlock = p.approvalStartBlock + _config.approvalVotingPeriod;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }

        p.proposalBond = _config.proposalBondAmount;
        if (p.proposalBond > 0) {
            bool ok = IVotesToken(governanceToken).transferFrom(msg.sender, address(this), p.proposalBond);
            if (!ok) revert TransferFailed();
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI);
    }

    /*//////////////////////////////////////////////////////////////
                2. GOVERNANCE APPROVES SUCCESS CRITERIA
    //////////////////////////////////////////////////////////////*/

    function castApprovalVote(
        uint256 proposalId,
        VoteType support
    ) external proposalExists(proposalId) returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.ApprovalVoting) revert WrongPhase();
        if (block.number < p.approvalStartBlock || block.number > p.approvalEndBlock) revert VotingNotStarted();

        if (_hasVotedApproval[proposalId][msg.sender]) revert AlreadyVoted();
        _hasVotedApproval[proposalId][msg.sender] = true;

        weight = IVotesToken(governanceToken).getPastVotes(msg.sender, p.approvalSnapshotBlock);

        if (support == VoteType.For) p.approvalForVotes += weight;
        else if (support == VoteType.Against) p.approvalAgainstVotes += weight;
        else p.approvalAbstainVotes += weight;

        emit ApprovalVoteCast(msg.sender, proposalId, support, weight);
    }

    /// @notice Finalizes the approval vote once its window has closed.
    ///         Success criteria become fixed the moment this passes - they
    ///         can never change afterward. On rejection, the proposal bond
    ///         is forfeited to the treasury.
    function finalizeApproval(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.ApprovalVoting) revert WrongPhase();
        if (block.number <= p.approvalEndBlock) revert VotingNotEnded();

        uint256 totalSupply = IVotesToken(governanceToken).getPastTotalSupply(p.approvalSnapshotBlock);
        uint256 participation = p.approvalForVotes + p.approvalAgainstVotes + p.approvalAbstainVotes;
        bool quorumMet = totalSupply != 0 && (participation * 10_000) / totalSupply >= _config.approvalQuorumBps;

        uint256 decisive = p.approvalForVotes + p.approvalAgainstVotes;
        bool approvalMet = decisive != 0 && (p.approvalForVotes * 10_000) / decisive >= _config.approvalThresholdBps;

        if (quorumMet && approvalMet) {
            p.phase = Phase.PositionsOpen;
            p.positionsDeadline = block.timestamp + _config.positionsWindow;
            p.positionsOpenSnapshotBlock = block.number - 1;
        } else {
            p.phase = Phase.Rejected;
            if (p.proposalBond > 0) {
                bool ok = IVotesToken(governanceToken).transfer(treasury, p.proposalBond);
                if (!ok) revert TransferFailed();
            }
        }

        emit ApprovalFinalized(proposalId, p.phase == Phase.PositionsOpen);
    }

    /*//////////////////////////////////////////////////////////////
                    3. PARTICIPANTS TAKE POSITIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deposits `amount` onto the given side of the outcome
    ///         market. Positions may be increased but never withdrawn or
    ///         reduced once taken - this capital is directly exposed to
    ///         the eventual outcome, unlike the proposal bond.
    function takePosition(uint256 proposalId, Side side, uint256 amount) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.PositionsOpen) revert WrongPhase();
        if (block.timestamp > p.positionsDeadline) revert PositionsWindowClosed();
        if (amount == 0) revert ZeroAmount();

        bool ok = IVotesToken(governanceToken).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        if (side == Side.Yes) {
            yesPosition[proposalId][msg.sender] += amount;
            p.yesPool += amount;
        } else {
            noPosition[proposalId][msg.sender] += amount;
            p.noPool += amount;
        }

        emit PositionTaken(proposalId, msg.sender, side, amount);
    }

    /*//////////////////////////////////////////////////////////////
                        4. PROPOSAL EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Executes the proposal's actions once the positions window
    ///         has closed, starting the measurement period.
    function executeProposal(uint256 proposalId) external payable proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.PositionsOpen) revert WrongPhase();
        if (block.timestamp <= p.positionsDeadline) revert PositionsWindowStillOpen();

        uint256 totalValue;
        uint256 len = p.actions.length;
        for (uint256 i = 0; i < len; i++) totalValue += p.actions[i].value;
        if (msg.value != totalValue) revert InvalidValue();

        p.phase = Phase.Executed;
        p.executedAt = block.timestamp;
        p.measurementDeadline = block.timestamp + p.measurementPeriod;

        for (uint256 i = 0; i < len; i++) {
            ProposalAction storage action = p.actions[i];
            (bool ok, ) = action.target.call{value: action.value}(action.data);
            if (!ok) revert ExecutionFailed();
        }

        emit ProposalExecuted(proposalId);
    }

    /*//////////////////////////////////////////////////////////////
                5/6. ORACLE-TRACK RESOLUTION (automatic)
    //////////////////////////////////////////////////////////////*/

    /// @notice For oracle-track proposals only: reads the oracle directly
    ///         and finalizes the outcome in one transaction - no resolver,
    ///         no bond, no challenge window. Nothing to dispute when the
    ///         comparison is deterministic and publicly verifiable
    ///         on-chain in the same call.
    function resolveViaOracle(uint256 proposalId) external proposalExists(proposalId) nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.Executed) revert WrongPhase();
        if (p.resolutionMethod != ResolutionMethod.Oracle) revert NotOracleTrack();
        if (block.timestamp < p.measurementDeadline) revert MeasurementPeriodNotEnded();

        (int256 observed, uint256 updatedAt) = IMetricOracle(p.oracle).latestValue(p.oracleSelector);
        if (block.timestamp > updatedAt + _config.maxOracleStaleness) revert StaleOracleData();

        bool success = p.targetIsMinimum ? observed >= p.targetValue : observed <= p.targetValue;

        p.finalOutcome = success ? Outcome.Success : Outcome.Failure;
        p.phase = Phase.Finalized;

        // Oracle track never took a resolution bond, so the proposal bond
        // is simply returned to the proposer here - it already survived
        // the approval stage, which is all the proposal bond was ever
        // meant to attest to.
        if (p.proposalBond > 0) {
            bool ok = IVotesToken(governanceToken).transfer(p.proposer, p.proposalBond);
            if (!ok) revert TransferFailed();
        }

        emit ResolvedViaOracle(proposalId, observed, p.finalOutcome);
    }

    /*//////////////////////////////////////////////////////////////
            5/7/8/9. HUMAN-TRACK RESOLUTION (optimistic)
    //////////////////////////////////////////////////////////////*/

    /// @notice For human-track proposals: proposes an outcome, backed by a
    ///         resolution bond, and opens a challenge window.
    function proposeResolution(uint256 proposalId, Outcome outcome) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.Executed) revert WrongPhase();
        if (p.resolutionMethod != ResolutionMethod.Human) revert NotHumanTrack();
        if (block.timestamp < p.measurementDeadline) revert MeasurementPeriodNotEnded();
        if (outcome == Outcome.Unresolved) revert InvalidResolutionCriteria();

        p.resolver = msg.sender;
        p.proposedOutcome = outcome;
        p.resolutionBond = _config.resolutionBondAmount;
        p.challengeDeadline = block.timestamp + _config.challengePeriod;
        p.phase = Phase.ResolutionProposed;

        if (p.resolutionBond > 0) {
            bool ok = IVotesToken(governanceToken).transferFrom(msg.sender, address(this), p.resolutionBond);
            if (!ok) revert TransferFailed();
        }

        emit ResolutionProposed(proposalId, msg.sender, outcome);
    }

    /// @notice Challenges a proposed resolution within its window, posting
    ///         a challenge bond. Opens the adjudication vote.
    function challengeResolution(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.ResolutionProposed) revert WrongPhase();
        if (block.timestamp > p.challengeDeadline) revert ChallengeWindowClosed();
        if (p.challenger != address(0)) revert AlreadyChallenged();

        p.challenger = msg.sender;
        p.challengeBond = _config.challengeBondAmount;
        p.adjudicationEndBlock = block.number + _config.adjudicationVotingPeriod;
        p.phase = Phase.Adjudicating;

        if (p.challengeBond > 0) {
            bool ok = IVotesToken(governanceToken).transferFrom(msg.sender, address(this), p.challengeBond);
            if (!ok) revert TransferFailed();
        }

        emit ResolutionChallenged(proposalId, msg.sender);
    }

    /// @notice Finalizes an unchallenged human-track resolution once its
    ///         challenge window has passed: the proposed outcome becomes
    ///         final, and the resolver's bond (plus the proposal bond) is
    ///         returned.
    function finalizeUnchallenged(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.ResolutionProposed) revert WrongPhase();
        if (block.timestamp <= p.challengeDeadline) revert ChallengeWindowStillOpen();

        p.finalOutcome = p.proposedOutcome;
        p.phase = Phase.Finalized;

        uint256 refund = p.resolutionBond + p.proposalBond;
        if (refund > 0) {
            bool ok = IVotesToken(governanceToken).transfer(p.resolver, p.resolutionBond);
            if (!ok) revert TransferFailed();
            if (p.proposalBond > 0) {
                ok = IVotesToken(governanceToken).transfer(p.proposer, p.proposalBond);
                if (!ok) revert TransferFailed();
            }
        }

        emit ResolutionFinalizedUnchallenged(proposalId, p.finalOutcome);
    }

    /*//////////////////////////////////////////////////////////////
            10. ADJUDICATION (single embedded token-weighted vote)
    //////////////////////////////////////////////////////////////*/

    /// @notice Votes on the true outcome of a challenged resolution -
    ///         NOT on whether the resolver or challenger "wins" directly;
    ///         bond outcomes are derived afterward by comparing the final
    ///         outcome to what the resolver originally proposed.
    function castAdjudicationVote(
        uint256 proposalId,
        Outcome vote
    ) external proposalExists(proposalId) returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.Adjudicating) revert WrongPhase();
        if (block.number > p.adjudicationEndBlock) revert VotingNotEnded();
        if (vote == Outcome.Unresolved) revert InvalidResolutionCriteria();

        if (_hasVotedAdjudication[proposalId][msg.sender]) revert AlreadyVoted();
        _hasVotedAdjudication[proposalId][msg.sender] = true;

        weight = IVotesToken(governanceToken).getPastVotes(msg.sender, p.positionsOpenSnapshotBlock);

        if (vote == Outcome.Success) p.adjudicateSuccessVotes += weight;
        else p.adjudicateFailureVotes += weight;

        emit AdjudicationVoteCast(msg.sender, proposalId, vote, weight);
    }

    /// @notice Finalizes adjudication once its voting window closes:
    ///         determines the true outcome by majority, then settles the
    ///         resolution and challenge bonds based on who was right.
    function finalizeAdjudication(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.Adjudicating) revert WrongPhase();
        if (block.number <= p.adjudicationEndBlock) revert AdjudicationNotEnded();

        uint256 totalSupply = IVotesToken(governanceToken).getPastTotalSupply(p.positionsOpenSnapshotBlock);
        uint256 participation = p.adjudicateSuccessVotes + p.adjudicateFailureVotes;
        bool quorumMet = totalSupply != 0 && (participation * 10_000) / totalSupply >= _config.adjudicationQuorumBps;

        // Success requires both quorum AND the configured share of
        // decisive votes - ties or unmet quorum default to Failure, the
        // more conservative outcome, consistent with "success must be
        // demonstrated."
        bool thresholdMet = participation != 0 &&
            (p.adjudicateSuccessVotes * 10_000) / participation >= _config.adjudicationThresholdBps;
        bool success = quorumMet && thresholdMet;
        p.finalOutcome = success ? Outcome.Success : Outcome.Failure;
        p.phase = Phase.Finalized;

        bool resolverWasRight = p.finalOutcome == p.proposedOutcome;

        if (resolverWasRight) {
            if (p.resolutionBond > 0) {
                bool ok = IVotesToken(governanceToken).transfer(p.resolver, p.resolutionBond);
                if (!ok) revert TransferFailed();
            }
            if (p.challengeBond > 0) {
                bool ok = IVotesToken(governanceToken).transfer(treasury, p.challengeBond);
                if (!ok) revert TransferFailed();
            }
        } else {
            if (p.resolutionBond > 0) {
                bool ok = IVotesToken(governanceToken).transfer(treasury, p.resolutionBond);
                if (!ok) revert TransferFailed();
            }
            if (p.challengeBond > 0) {
                bool ok = IVotesToken(governanceToken).transfer(p.challenger, p.challengeBond);
                if (!ok) revert TransferFailed();
            }
        }

        if (p.proposalBond > 0) {
            bool ok = IVotesToken(governanceToken).transfer(p.proposer, p.proposalBond);
            if (!ok) revert TransferFailed();
        }

        emit AdjudicationFinalized(proposalId, p.finalOutcome);
    }

    /*//////////////////////////////////////////////////////////////
                        11. FINAL SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Claims a position's payout once the proposal is finalized.
    ///         Winning positions receive their proportional share of the
    ///         entire pool (both sides combined); losing positions receive
    ///         nothing - their capital was already transferred into the
    ///         pool at stake time and is not separately withdrawable.
    function claimPosition(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.phase != Phase.Finalized) revert NotFinalized();
        if (positionClaimed[proposalId][msg.sender]) revert AlreadyClaimed();

        uint256 stake;
        uint256 winningPool;
        if (p.finalOutcome == Outcome.Success) {
            stake = yesPosition[proposalId][msg.sender];
            winningPool = p.yesPool;
        } else {
            stake = noPosition[proposalId][msg.sender];
            winningPool = p.noPool;
        }

        if (stake == 0) revert NothingToClaim();
        positionClaimed[proposalId][msg.sender] = true;

        uint256 totalPool = p.yesPool + p.noPool;
        uint256 payout = winningPool == 0 ? 0 : (stake * totalPool) / winningPool;

        if (payout > 0) {
            bool ok = IVotesToken(governanceToken).transfer(msg.sender, payout);
            if (!ok) revert TransferFailed();
        }

        emit PositionClaimed(proposalId, msg.sender, payout);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function updateConfig(SowellianConfig calldata newConfig) external onlyGovernance {
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

    function config() external view returns (SowellianConfig memory) {
        return _config;
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _validateConfig(SowellianConfig memory c) internal pure {
        if (c.approvalVotingPeriod == 0) revert InvalidConfiguration();
        if (c.approvalQuorumBps == 0 || c.approvalQuorumBps > 10_000) revert InvalidConfiguration();
        if (c.approvalThresholdBps == 0 || c.approvalThresholdBps > 10_000) revert InvalidConfiguration();
        if (c.positionsWindow == 0) revert InvalidConfiguration();
        if (c.challengePeriod == 0) revert InvalidConfiguration();
        if (c.adjudicationVotingPeriod == 0) revert InvalidConfiguration();
        if (c.adjudicationQuorumBps == 0 || c.adjudicationQuorumBps > 10_000) revert InvalidConfiguration();
        if (c.adjudicationThresholdBps == 0 || c.adjudicationThresholdBps > 10_000) revert InvalidConfiguration();
        if (c.maxOracleStaleness == 0) revert InvalidConfiguration();
    }
}
