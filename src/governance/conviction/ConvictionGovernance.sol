// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev Minimal interface into a DAO's StakedGovernanceToken - only the
///      current balance is needed here (see the design note below on why
///      this model has no fixed snapshot block).
interface IBalanceToken {
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Interface into StakedGovernanceToken's optional lock capability.
///      This contract must be set as the token's `authorizedLocker` for
///      these calls to succeed - see StakedGovernanceToken.setAuthorizedLocker.
interface ILockableToken {
    function lock(address account, uint256 amount) external;
    function unlock(address account, uint256 amount) external;
}

/// @dev The pieces of the Treasury, ERC20s and Permit2 the spending
///      budget needs: reading balances and allowances, and revoking an
///      approval a proposal left behind.
interface IBudgetTreasury {
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory);
    function transferGovernance(address newGovernance) external;
}

interface IBudgetERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function increaseAllowance(address spender, uint256 addedValue) external returns (bool);
}

interface IBudgetPermit2 {
    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48);
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IStakedUnderlying {
    function underlying() external view returns (address);
}

/// @title ConvictionGovernance
/// @author Marvin Sunday
/// @notice A conviction-voting governance model: holders continuously 
///         signal support for a proposal (one at a time) rather than
///         casting a single vote in a fixed window. Support accumulates
///         into "conviction" the longer it's sustained; a proposal becomes
///         executable once its conviction crosses a threshold that scales
///         with how much it's requesting.
/// @dev IMPORTANT DESIGN NOTE - read before assuming this matches the
///      academic/1Hive model of conviction voting:
///
///      1. LINEAR RAMP, NOT EXPONENTIAL DECAY. The canonical model computes
///         conviction via fixed-point exponentiation (conviction_new =
///         alpha^n * conviction_old + support * (1 - alpha^n)), giving a
///         smooth compound-decay curve. That formula is a real source of
///         subtle on-chain bugs (precision loss compounding over many
///         updates, overflow at extreme block gaps) and needs fuzz/
///         invariant testing to trust - infrastructure this build could
///         not run. This contract instead moves conviction linearly toward
///         current total support, at a fixed rate per block, clamped so it
///         never overshoots. Same behavioral properties - sustained
///         support outweighs a quick spike, withdrawn support decays back
///         down - verifiable by inspection rather than by fuzzing.
///
///      2. (Superseded for Treasury spending by note 5; still applies to
///         native value sent directly with actions.) THRESHOLD IS LINEAR
///         IN REQUESTED AMOUNT, NOT A RATIO TO POOL SIZE. The canonical model's required-conviction curve grows
///         nonlinearly as the request approaches the treasury's total
///         balance (division by a shrinking denominator). This contract
///         uses `minThresholdConviction + requestedAmount * thresholdMultiplier`
///         instead - still strictly harder for bigger asks, but without a
///         division that could blow up or divide by zero, and without an
///         external treasury-balance read on every check.
///
///      3. SUPPORT WEIGHT IS FIXED AT THE TIME OF SUPPORTING, AND LOCKED.
///         A holder's contribution to a proposal's support is set to
///         whatever their balance was when they called `support()` - if
///         they acquire more tokens afterward, that extra amount does not
///         automatically join their existing support; they'd need to
///         withdraw and re-support to pick up a larger balance. What IS
///         enforced automatically: the committed amount is locked via
///         StakedGovernanceToken's lock()/unlock() (see
///         setAuthorizedLocker) for as long as it's backing a proposal -
///         it cannot be transferred or unstaked out from under a
///         proposal's conviction while committed, closing the "sell after
///         voting" gap that a pure balance snapshot alone would leave
///         open. This governance contract must be set as the token's
///         authorizedLocker for support()/withdrawSupport() to work -
///         see the deployment notes on StakedGovernanceToken.
///
///      4. ONE ACTIVE SUPPORT PER HOLDER, DAO-WIDE. Supporting a new
///         proposal automatically withdraws support from whatever a
///         holder was previously backing - this is not a simplification,
///         it's the actual anti-gaming rule the real model relies on
///         (without it, one holder could back every proposal at once with
///         full weight each).
///
///      5. SPENDING BUDGETS (version 2). The Treasury spends through
///         `Treasury.execute` calls whose amounts are buried in protocol
///         calldata, so a request's size can't be read off the actions.
///         Instead the DAO keeps a list of assets (native = address(0)),
///         each with a weight the community sets by proposal, and every
///         proposal declares a budget: how much of each listed asset it
///         may spend. The required conviction grows by
///         `weight x amount / Treasury's holding` per asset, fixed when the
///         proposal is created. At execution the Treasury's balance of
///         every listed asset is read before and after the actions; any
///         asset that dropped by more than its budget (zero if it wasn't
///         declared) reverts the whole execution, and token approvals the
///         actions granted are revoked afterwards. Proposals that weaken
///         these rules - lowering or removing a weight, changing the
///         config, treasury or staking token, handing over the Treasury or
///         any ownership - need the conviction of spending everything, and
///         a weight cut only takes effect WEIGHT_CUT_DELAY later.
///         Only listed assets are checked: anything the DAO hasn't listed
///         is invisible to the budget.
///
///      Drops into the same trusted-`governance` slot on Treasury as every
///      other implementation here, and reuses the DAO's existing
///      StakedGovernanceToken.
contract ConvictionGovernance is Initializable {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum ProposalState {
        Active, // accumulating conviction, not yet queued
        Queued,
        Executed,
        Cancelled,
        Expired
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
        uint256 requestedAmount; // sum of ETH values across actions
        uint256 conviction; // settled as of lastConvictionUpdateBlock
        uint256 lastConvictionUpdateBlock;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
    }

    /// @notice One entry of a proposal's spending budget.
    struct AssetAmount {
        address asset; // address(0) = the chain's native currency
        uint256 amount;
    }

    /// @notice A weight cut or removal waiting out WEIGHT_CUT_DELAY.
    struct PendingAssetChange {
        uint256 weight;
        uint64 effectiveAt; // 0 = nothing pending
        bool remove;
    }

    struct ConvictionGovernanceConfig {
        uint256 convictionGrowthRate; // conviction units gained/lost per block, capped at target
        uint256 minThresholdConviction; // floor required conviction for near-zero requests
        uint256 thresholdMultiplier; // additional required conviction per wei requested
        uint256 proposalThreshold; // raw balance required to propose
        uint32 timelockDelay; // seconds
        uint32 executionPeriod; // seconds
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
    error AlreadySupportingThisProposal();
    error NotCurrentlySupporting();
    error ConvictionThresholdNotMet();
    error ProposalAlreadyQueued();
    error ProposalNotExecutable();
    error ProposalExpired();
    error ExecutionFailed();
    error InvalidValue();
    error Unauthorized();
    error AssetNotListed(address asset);
    error AssetAlreadyListed(address asset);
    error TooManyAssets();
    error DuplicateBudgetAsset(address asset);
    error ZeroBudgetAmount();
    error BudgetExceeded(address asset, uint256 allowed, uint256 spent);
    error NoPendingAssetChange();
    error AssetChangeNotDue(uint256 effectiveAt);
    error Reentrancy();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI, uint256 requestedAmount);
    event Supported(uint256 indexed proposalId, address indexed supporter, uint256 weight);
    event SupportWithdrawn(uint256 indexed proposalId, address indexed supporter, uint256 weight);
    event ProposalCancelled(uint256 indexed proposalId, address indexed caller);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event ConfigUpdated();
    event GovernanceTokenUpdated(address indexed previousToken, address indexed newToken);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ProposalBudget(uint256 indexed proposalId, AssetAmount[] budget, uint256 requiredConviction, bool weakensRules);
    event AssetListed(address indexed asset, uint256 weight);
    event AssetWeightUpdated(address indexed asset, uint256 previousWeight, uint256 newWeight);
    event AssetChangeScheduled(address indexed asset, uint256 newWeight, bool remove, uint256 effectiveAt);
    event AssetRemoved(address indexed asset);
    event ApprovalRevoked(uint256 indexed proposalId, address indexed token, address indexed spender);

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    string public daoName;
    address public creator;
    address public governanceToken;
    address public treasury;
    ConvictionGovernanceConfig internal _config;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;

    /// @notice Live total support currently backing a proposal.
    mapping(uint256 => uint256) public totalSupport;
    /// @notice Which proposal (0 = none) a holder currently supports.
    mapping(address => uint256) public currentSupportProposal;
    /// @notice A holder's fixed contribution to whichever proposal they support.
    mapping(uint256 => mapping(address => uint256)) public supporterWeight;

    /// @notice Version of the spending-budget rules (see design note 5).
    uint256 public constant BUDGET_VERSION = 2;
    /// @notice How long a weight cut or removal waits before it applies.
    uint256 public constant WEIGHT_CUT_DELAY = 7 days;
    /// @notice Listed assets are all read twice per execution; this caps that cost.
    uint256 public constant MAX_ASSETS = 20;
    /// @notice Weight given to native currency and the DAO's own token at creation:
    ///         spending all of either adds this much required conviction.
    uint256 public constant DEFAULT_ASSET_WEIGHT = 900 ether;
    address internal constant NATIVE = address(0);

    address[] internal _assets;
    mapping(address => bool) public isListedAsset;
    mapping(address => uint256) public assetWeight;
    mapping(address => PendingAssetChange) public pendingAssetChange;

    mapping(uint256 => AssetAmount[]) internal _budgets;
    mapping(uint256 => uint256) internal _requiredConviction;
    /// @notice Whether a proposal weakens the budget rules (see design note 5).
    mapping(uint256 => bool) public weakensRules;

    bool internal _executing;

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
        ConvictionGovernanceConfig memory config_
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

        // Native currency and the DAO's own token start listed; the DAO
        // adds or reweights anything else by proposal.
        _listAsset(NATIVE, DEFAULT_ASSET_WEIGHT);
        try IStakedUnderlying(governanceToken_).underlying() returns (address token) {
            if (token != address(0) && token.code.length > 0) _listAsset(token, DEFAULT_ASSET_WEIGHT);
        } catch {}
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice A proposal that spends no listed asset (its budget is empty,
    ///         so execution reverts if any listed asset leaves the Treasury).
    function propose(
        ProposalAction[] calldata actions,
        string calldata metadataURI
    ) external returns (uint256 proposalId) {
        return _propose(actions, metadataURI, new AssetAmount[](0));
    }

    /// @notice A proposal with a spending budget: how much of each listed
    ///         asset the Treasury may lose when it executes.
    function proposeWithBudget(
        ProposalAction[] calldata actions,
        string calldata metadataURI,
        AssetAmount[] calldata budget
    ) external returns (uint256 proposalId) {
        return _propose(actions, metadataURI, budget);
    }

    function _propose(
        ProposalAction[] calldata actions,
        string calldata metadataURI,
        AssetAmount[] memory budget
    ) internal returns (uint256 proposalId) {
        _requireProposalThreshold(msg.sender);

        if (actions.length == 0) revert EmptyProposalActions();
        uint256 requestedAmount;
        for (uint256 i = 0; i < actions.length; i++) {
            if (actions[i].target == address(0)) revert InvalidProposalAction();
            requestedAmount += actions[i].value;
        }
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.metadataURI = metadataURI;
        p.createdBlock = block.number;
        p.requestedAmount = requestedAmount;
        p.lastConvictionUpdateBlock = block.number;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI, requestedAmount);
        _setRequirement(proposalId, actions, budget, requestedAmount);
    }

    /// @dev The bar is fixed at creation, from today's weights and
    ///      holdings, so later weight changes can't move it either way.
    function _setRequirement(
        uint256 proposalId,
        ProposalAction[] calldata actions,
        AssetAmount[] memory budget,
        uint256 requestedAmount
    ) internal {
        bool weakens = _weakensRules(actions);
        uint256 required = _config.minThresholdConviction + requestedAmount * _config.thresholdMultiplier;
        required += weakens ? _totalWeight() : _budgetCost(budget);
        for (uint256 i = 0; i < budget.length; i++) {
            _budgets[proposalId].push(budget[i]);
        }
        _requiredConviction[proposalId] = required;
        weakensRules[proposalId] = weakens;
        emit ProposalBudget(proposalId, budget, required, weakens);
    }

    /*//////////////////////////////////////////////////////////////
                        SUPPORT / WITHDRAWAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Backs a proposal with the caller's current staked balance.
    ///         Automatically withdraws support from any other proposal the
    ///         caller was previously backing - only one active support per
    ///         holder DAO-wide.
    function support(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();

        uint256 previous = currentSupportProposal[msg.sender];
        if (previous == proposalId) revert AlreadySupportingThisProposal();

        uint256 oldWeight;
        bool hadPrevious = previous != 0;

        if (hadPrevious) {
            _settleConviction(previous);
            oldWeight = supporterWeight[previous][msg.sender];
            totalSupport[previous] -= oldWeight;
            supporterWeight[previous][msg.sender] = 0;
            emit SupportWithdrawn(previous, msg.sender, oldWeight);
        }

        _settleConviction(proposalId);

        uint256 weight = IBalanceToken(governanceToken).balanceOf(msg.sender);
        supporterWeight[proposalId][msg.sender] = weight;
        totalSupport[proposalId] += weight;
        currentSupportProposal[msg.sender] = proposalId;

        // External calls after all local state effects above.
        if (hadPrevious) {
            ILockableToken(governanceToken).unlock(msg.sender, oldWeight);
        }
        ILockableToken(governanceToken).lock(msg.sender, weight);

        emit Supported(proposalId, msg.sender, weight);
    }

    /// @notice Withdraws the caller's support from whatever proposal they
    ///         currently back, freeing their weight to support elsewhere.
    function withdrawSupport() external {
        uint256 current = currentSupportProposal[msg.sender];
        if (current == 0) revert NotCurrentlySupporting();

        _settleConviction(current);
        uint256 weight = supporterWeight[current][msg.sender];
        totalSupport[current] -= weight;
        supporterWeight[current][msg.sender] = 0;
        currentSupportProposal[msg.sender] = 0;

        ILockableToken(governanceToken).unlock(msg.sender, weight);

        emit SupportWithdrawn(current, msg.sender, weight);
    }

    /*//////////////////////////////////////////////////////////////
                        CONVICTION ACCOUNTING
    //////////////////////////////////////////////////////////////*/

    /// @dev Settles a proposal's conviction up to the current block, moving
    ///      it linearly toward `totalSupport`, clamped so it never
    ///      overshoots. Must be called before `totalSupport` changes, so
    ///      the elapsed-block gap is always settled against the support
    ///      level that was actually in effect during that gap.
    function _settleConviction(uint256 proposalId) internal {
        Proposal storage p = _proposals[proposalId];
        uint256 blocksElapsed = block.number - p.lastConvictionUpdateBlock;
        if (blocksElapsed == 0) return;

        uint256 target = totalSupport[proposalId];
        uint256 maxDelta = _config.convictionGrowthRate * blocksElapsed;

        if (p.conviction < target) {
            uint256 gap = target - p.conviction;
            p.conviction += (maxDelta < gap) ? maxDelta : gap;
        } else if (p.conviction > target) {
            uint256 gap = p.conviction - target;
            p.conviction -= (maxDelta < gap) ? maxDelta : gap;
        }

        p.lastConvictionUpdateBlock = block.number;
    }

    /// @notice Previews what a proposal's conviction would settle to right
    ///         now, without writing state - safe to call from a frontend
    ///         at any time.
    function previewConviction(uint256 proposalId) public view proposalExists(proposalId) returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        uint256 blocksElapsed = block.number - p.lastConvictionUpdateBlock;
        if (blocksElapsed == 0) return p.conviction;

        uint256 target = totalSupport[proposalId];
        uint256 maxDelta = _config.convictionGrowthRate * blocksElapsed;

        if (p.conviction < target) {
            uint256 gap = target - p.conviction;
            return p.conviction + ((maxDelta < gap) ? maxDelta : gap);
        } else if (p.conviction > target) {
            uint256 gap = p.conviction - target;
            return p.conviction - ((maxDelta < gap) ? maxDelta : gap);
        }
        return p.conviction;
    }

    /// @notice The conviction a proposal must reach before it can queue -
    ///         fixed when it was created (see design note 5).
    function requiredConviction(uint256 proposalId) public view proposalExists(proposalId) returns (uint256) {
        return _requiredConviction[proposalId];
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

        _settleConviction(proposalId);

        if (p.conviction < requiredConviction(proposalId)) revert ConvictionThresholdNotMet();

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

        if (msg.value != p.requestedAmount) revert InvalidValue();
        if (_executing) revert Reentrancy();
        _executing = true;

        p.executed = true;

        // Every listed asset's Treasury balance, before the actions run.
        address treasury_ = treasury;
        (address[] memory assets, uint256[] memory before) = _snapshotHoldings(treasury_);

        _runActions(p.actions);

        _revokeApprovals(proposalId, treasury_);
        _checkBudget(proposalId, assets, before, treasury_);

        _executing = false;
        emit ProposalExecuted(proposalId, msg.sender);
    }

    function _runActions(ProposalAction[] storage actions) internal {
        uint256 len = actions.length;
        for (uint256 i = 0; i < len; i++) {
            ProposalAction storage action = actions[i];
            (bool ok, ) = action.target.call{value: action.value}(action.data);
            if (!ok) revert ExecutionFailed();
        }
    }

    /*//////////////////////////////////////////////////////////////
                        SPENDING BUDGET
    //////////////////////////////////////////////////////////////*/

    function _snapshotHoldings(address treasury_) internal view returns (address[] memory assets, uint256[] memory holdings) {
        assets = _assets;
        holdings = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            holdings[i] = _holding(assets[i], treasury_);
        }
    }

    function _budgetFor(uint256 proposalId, address asset) internal view returns (uint256) {
        AssetAmount[] storage budget = _budgets[proposalId];
        for (uint256 j = 0; j < budget.length; j++) {
            if (budget[j].asset == asset) return budget[j].amount;
        }
        return 0;
    }

    /// @dev Reverts if any listed asset left the Treasury beyond the
    ///      proposal's budget for it (zero when it wasn't declared).
    function _checkBudget(uint256 proposalId, address[] memory assets, uint256[] memory before, address treasury_) internal view {
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 afterBalance = _holding(assets[i], treasury_);
            if (afterBalance >= before[i]) continue;
            uint256 allowed = _budgetFor(proposalId, assets[i]);
            if (before[i] - afterBalance > allowed) revert BudgetExceeded(assets[i], allowed, before[i] - afterBalance);
        }
    }

    /// @dev Approvals a proposal's Treasury.execute steps granted on a
    ///      listed token (ERC20 approve/increaseAllowance, or Permit2's
    ///      approve) are set back to zero, so nothing can be pulled from
    ///      the Treasury later that the balance check didn't see.
    function _revokeApprovals(uint256 proposalId, address treasury_) internal {
        ProposalAction[] storage actions = _proposals[proposalId].actions;
        for (uint256 i = 0; i < actions.length; i++) {
            (bool viaTreasury, address target, bytes memory inner) = _treasuryCall(actions[i], treasury_);
            if (viaTreasury && inner.length >= 4) _revokeApproval(proposalId, treasury_, target, inner);
        }
    }

    function _revokeApproval(uint256 proposalId, address treasury_, address target, bytes memory inner) internal {
        bytes4 sel = bytes4(inner);
        if (sel == IBudgetERC20.approve.selector || sel == IBudgetERC20.increaseAllowance.selector) {
            (address spender, ) = abi.decode(_args(inner), (address, uint256));
            if (!isListedAsset[target] || IBudgetERC20(target).allowance(treasury_, spender) == 0) return;
            IBudgetTreasury(treasury_).execute(target, 0, abi.encodeCall(IBudgetERC20.approve, (spender, 0)));
            emit ApprovalRevoked(proposalId, target, spender);
        } else if (sel == IBudgetPermit2.approve.selector) {
            (address token, address spender, , ) = abi.decode(_args(inner), (address, address, uint160, uint48));
            if (!isListedAsset[token]) return;
            (uint160 amount, , ) = IBudgetPermit2(target).allowance(treasury_, token, spender);
            if (amount == 0) return;
            IBudgetTreasury(treasury_).execute(target, 0, abi.encodeCall(IBudgetPermit2.approve, (token, spender, 0, 0)));
            emit ApprovalRevoked(proposalId, token, spender);
        }
    }

    /// @dev For an action that is `Treasury.execute(target, value, data)`,
    ///      the inner call's target and data.
    function _treasuryCall(ProposalAction storage action, address treasury_)
        internal
        view
        returns (bool, address, bytes memory)
    {
        bytes memory data = action.data;
        if (action.target != treasury_ || data.length < 4 || bytes4(data) != IBudgetTreasury.execute.selector) {
            return (false, address(0), "");
        }
        (address target, , bytes memory inner) = abi.decode(_args(data), (address, uint256, bytes));
        return (true, target, inner);
    }

    /// @dev Required conviction a budget adds: per asset, its weight times
    ///      the share of the Treasury's current holding requested (capped
    ///      at all of it; an empty holding counts as all of it).
    function _budgetCost(AssetAmount[] memory budget) internal view returns (uint256 cost) {
        for (uint256 i = 0; i < budget.length; i++) {
            address asset = budget[i].asset;
            if (!isListedAsset[asset]) revert AssetNotListed(asset);
            if (budget[i].amount == 0) revert ZeroBudgetAmount();
            for (uint256 j = 0; j < i; j++) {
                if (budget[j].asset == asset) revert DuplicateBudgetAsset(asset);
            }
            uint256 holding = _holding(asset, treasury);
            uint256 weight = assetWeight[asset];
            cost += (holding == 0 || budget[i].amount >= holding) ? weight : (weight * budget[i].amount) / holding;
        }
    }

    /// @dev Whether a proposal weakens the budget rules: anything it calls
    ///      on this contract other than listing an asset, raising a weight
    ///      or cancelling; handing over the Treasury; or transferring any
    ///      ownership (directly or through Treasury.execute).
    function _weakensRules(ProposalAction[] calldata actions) internal view returns (bool) {
        for (uint256 i = 0; i < actions.length; i++) {
            bytes calldata data = actions[i].data;
            if (data.length < 4) continue;
            bytes4 sel = bytes4(data[:4]);
            address target = actions[i].target;
            if (sel == bytes4(keccak256("transferOwnership(address)"))) return true;
            if (target == address(this)) {
                if (sel == this.addAsset.selector || sel == this.cancelProposal.selector) continue;
                if (sel == this.setAssetWeight.selector) {
                    (address asset, uint256 weight) = abi.decode(data[4:], (address, uint256));
                    if (isListedAsset[asset] && weight >= assetWeight[asset]) continue;
                }
                return true;
            }
            if (target == treasury) {
                if (sel == IBudgetTreasury.transferGovernance.selector) return true;
                if (sel == IBudgetTreasury.execute.selector) {
                    (, , bytes memory inner) = abi.decode(data[4:], (address, uint256, bytes));
                    if (inner.length >= 4 && bytes4(inner) == bytes4(keccak256("transferOwnership(address)"))) return true;
                }
            }
        }
        return false;
    }

    function _holding(address asset, address holder) internal view returns (uint256) {
        return asset == NATIVE ? holder.balance : IBudgetERC20(asset).balanceOf(holder);
    }

    function _totalWeight() internal view returns (uint256 total) {
        for (uint256 i = 0; i < _assets.length; i++) {
            total += assetWeight[_assets[i]];
        }
    }

    /// @dev Calldata after the 4-byte selector.
    function _args(bytes memory data) internal pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = data[i + 4];
        }
    }

    function _listAsset(address asset, uint256 weight) internal {
        if (isListedAsset[asset]) revert AssetAlreadyListed(asset);
        if (_assets.length >= MAX_ASSETS) revert TooManyAssets();
        _assets.push(asset);
        isListedAsset[asset] = true;
        assetWeight[asset] = weight;
        emit AssetListed(asset, weight);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function updateGovernanceConfig(ConvictionGovernanceConfig calldata newConfig) external onlyGovernance {
        _validateConfig(newConfig);
        _config = newConfig;
        emit ConfigUpdated();
    }

    function setGovernanceToken(address newToken) external onlyGovernance {
        if (newToken == address(0)) revert ZeroAddress();
        emit GovernanceTokenUpdated(governanceToken, newToken);
        governanceToken = newToken;
    }

    /// @notice Lists an asset so proposals must budget for it.
    function addAsset(address asset, uint256 weight) external onlyGovernance {
        _listAsset(asset, weight);
    }

    /// @notice Raises a weight at once; a cut waits WEIGHT_CUT_DELAY
    ///         (and the proposal making it needs the highest conviction).
    function setAssetWeight(address asset, uint256 weight) external onlyGovernance {
        if (!isListedAsset[asset]) revert AssetNotListed(asset);
        uint256 previous = assetWeight[asset];
        if (weight >= previous) {
            assetWeight[asset] = weight;
            delete pendingAssetChange[asset];
            emit AssetWeightUpdated(asset, previous, weight);
        } else {
            _scheduleAssetChange(asset, weight, false);
        }
    }

    /// @notice Unlists an asset after WEIGHT_CUT_DELAY - it is no longer
    ///         checked at all once removed.
    function removeAsset(address asset) external onlyGovernance {
        if (!isListedAsset[asset]) revert AssetNotListed(asset);
        _scheduleAssetChange(asset, 0, true);
    }

    /// @notice Applies a weight cut or removal once its delay has passed.
    ///         Anyone may call it.
    function applyAssetChange(address asset) external {
        PendingAssetChange memory change = pendingAssetChange[asset];
        if (change.effectiveAt == 0) revert NoPendingAssetChange();
        if (block.timestamp < change.effectiveAt) revert AssetChangeNotDue(change.effectiveAt);
        delete pendingAssetChange[asset];
        if (change.remove) {
            for (uint256 i = 0; i < _assets.length; i++) {
                if (_assets[i] == asset) {
                    _assets[i] = _assets[_assets.length - 1];
                    _assets.pop();
                    break;
                }
            }
            isListedAsset[asset] = false;
            assetWeight[asset] = 0;
            emit AssetRemoved(asset);
        } else {
            emit AssetWeightUpdated(asset, assetWeight[asset], change.weight);
            assetWeight[asset] = change.weight;
        }
    }

    function _scheduleAssetChange(address asset, uint256 weight, bool remove) internal {
        uint64 effectiveAt = uint64(block.timestamp + WEIGHT_CUT_DELAY);
        pendingAssetChange[asset] = PendingAssetChange(weight, effectiveAt, remove);
        emit AssetChangeScheduled(asset, weight, remove, effectiveAt);
    }

    function setTreasury(address newTreasury) external onlyGovernance {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function config() external view returns (ConvictionGovernanceConfig memory) {
        return _config;
    }

    /// @notice Every listed asset and its weight.
    function listedAssets() external view returns (address[] memory assets, uint256[] memory weights) {
        assets = _assets;
        weights = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            weights[i] = assetWeight[assets[i]];
        }
    }

    /// @notice What a proposal declared it may spend.
    function proposalBudget(uint256 proposalId) external view proposalExists(proposalId) returns (AssetAmount[] memory) {
        return _budgets[proposalId];
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
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

        return ProposalState.Active;
    }

    function executableAfter(uint256 proposalId) external view proposalExists(proposalId) returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        if (p.queuedAt == 0) return 0;
        return p.queuedAt + _config.timelockDelay;
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _requireProposalThreshold(address proposer) internal view {
        uint256 threshold = _config.proposalThreshold;
        if (threshold == 0) return;

        uint256 balance = IBalanceToken(governanceToken).balanceOf(proposer);
        if (balance < threshold) revert ProposalThresholdNotMet();
    }

    function _validateConfig(ConvictionGovernanceConfig memory c) internal pure {
        if (c.convictionGrowthRate == 0) revert InvalidConfiguration();
    }
}
