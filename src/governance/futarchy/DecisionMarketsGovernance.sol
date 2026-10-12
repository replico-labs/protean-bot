// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ConditionalVault } from "./ConditionalVault.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ConditionalToken } from "./ConditionalToken.sol";
import { DecisionMarketPair } from "./DecisionMarketPair.sol";
import { WMON } from "./WMON.sol";

interface IERC20Orchestrator {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}
/// @title DecisionMarketsGovernance
/// @author Marvin Sunday
/// @notice Pure futarchy: a proposal's two conditional markets (pass and
///         fail) trade against each other over a fixed window, and
///         whichever market prices its outcome token higher - by TWAP,
///         not vote count - decides whether the proposal executes. No
///         oracle, no human resolver, no challenge window - the market's
///         own price comparison IS the verdict, which is what makes this
///         genuinely different from SowellianGovernance's bet-then-verify
///         model, even though both trade under the "decision market"
///         umbrella.
///
/// @dev HONESTY NOTE: this is, along with SowellianGovernance, one of the
///      two highest-stakes contracts in this library - it moves real
///      capital based on market-driven resolution. It has not been run
///      through a test executor in this build (no `forge` available in
///      this environment) - compiled and type-checked, not executed. The
///      underlying AMM math (DecisionMarketPair) and vault mechanics
///      (ConditionalVault) were each independently hand-verified and
///      tested on their own; this orchestrator wires them together, and
///      that wiring is the newest, least-tested part of the whole system.
///
///      TWO STEPS TO OPEN A PROPOSAL. propose() takes the seed and splits
///      it into pass/fail tokens; openMarkets() deploys and seeds the two
///      pools and starts the trading clock. Together they cost ~2.3M gas -
///      more than HyperEVM's 2M small blocks take in one transaction - so
///      they are separate. openMarkets() is permissionless (anyone can
///      finish a proposal someone else started), and until it runs the
///      proposal can't be traded, finalized or executed; cancelling it
///      first gives the proposer the seed back.
///
///      SEED LIQUIDITY IS NOT AUTOMATICALLY RECLAIMED. The LP tokens
///      minted when a proposal's pools are seeded stay held by this
///      contract indefinitely - not burned, not returned to the
///      proposer. A future governance action (or feature) could recover
///      or redistribute them; v1 deliberately doesn't decide that
///      question, same as SowellianGovernance's rounding-dust note.
contract DecisionMarketsGovernance is Initializable {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

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
        uint256 createdAt; // when the markets opened - the start of the TWAP window
        uint256 tradingDeadline;
        address baseVault; // ConditionalVault for the DAO's governance token
        address quoteVault; // ConditionalVault for WMON
        address passPool; // DecisionMarketPair: pass-base / pass-quote
        address failPool; // DecisionMarketPair: fail-base / fail-quote
        bool finalized;
        bool passed;
        uint256 passTWAP;
        uint256 failTWAP;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
        bool liquidityReclaimed;
    }

    enum Market {
        Pass,
        Fail
    }

    enum Side {
        Base,
        Quote
    }

    /// @dev A proposal's seed between propose() and openMarkets().
    struct PendingSeed {
        uint256 base;
        uint256 quote;
    }

    struct DecisionMarketsConfig {
        uint32 tradingPeriod; // seconds
        uint16 thresholdBps; // pass must exceed fail's TWAP by this many bps
        uint32 timelockDelay; // seconds, after finalization, before execution
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
    error ZeroSeedAmount();
    error ProposalNotFound();
    error TradingWindowStillOpen();
    error TradingWindowClosed();
    error AlreadyFinalized();
    error NotFinalized();
    error ProposalDidNotPass();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCancelled();
    error ProposalNotExecutable();
    error ProposalExpired();
    error InvalidValue();
    error ExecutionFailed();
    error TransferFailed();
    error NativeTransferFailed();
    error Unauthorized();
    error AlreadyReclaimed();
    error MarketsNotOpen();
    error MarketsAlreadyOpen();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalSeeded(uint256 indexed proposalId, address indexed proposer, uint256 baseSeed, uint256 quoteSeed);
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        string metadataURI,
        address passPool,
        address failPool
    );
    event Traded(
        uint256 indexed proposalId,
        address indexed trader,
        Market market,
        Side sideIn,
        uint256 amountIn,
        uint256 amountOut
    );
    event ProposalFinalized(uint256 indexed proposalId, bool passed, uint256 passTWAP, uint256 failTWAP);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId, address indexed caller);
    event ConfigUpdated();
    event GovernanceTokenUpdated(address indexed previousToken, address indexed newToken);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event LiquidityReclaimed(uint256 indexed proposalId, uint256 baseRecovered, uint256 quoteRecovered);
    event SeedRefunded(uint256 indexed proposalId, uint256 baseRefunded, uint256 quoteRefunded);

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    string public daoName;
    address public creator;
    address public governanceToken;
    address public treasury;
    address public wmon;
    address public conditionalTokenImplementation;
    address public conditionalVaultImplementation;
    address public decisionMarketPairImplementation;
    DecisionMarketsConfig internal _config;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => PendingSeed) internal _pendingSeeds;

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

    modifier marketsOpen(uint256 proposalId) {
        if (_proposals[proposalId].passPool == address(0)) revert MarketsNotOpen();
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
        address wmon_,
        address conditionalTokenImplementation_,
        address conditionalVaultImplementation_,
        address decisionMarketPairImplementation_,
        DecisionMarketsConfig memory config_
    ) external initializer {
        if (
            creator_ == address(0) ||
            governanceToken_ == address(0) ||
            treasury_ == address(0) ||
            wmon_ == address(0) ||
            conditionalTokenImplementation_ == address(0) ||
            conditionalVaultImplementation_ == address(0) ||
            decisionMarketPairImplementation_ == address(0)
        ) {
            revert ZeroAddress();
        }
        _validateConfig(config_);

        daoName = daoName_;
        creator = creator_;
        governanceToken = governanceToken_;
        treasury = treasury_;
        wmon = wmon_;
        conditionalTokenImplementation = conditionalTokenImplementation_;
        conditionalVaultImplementation = conditionalVaultImplementation_;
        decisionMarketPairImplementation = decisionMarketPairImplementation_;
        _config = config_;
    }

    /*//////////////////////////////////////////////////////////////
                    PROPOSAL CREATION & MARKET SEEDING
    //////////////////////////////////////////////////////////////*/

    /// @notice Creates a proposal and takes its seed: the proposer deposits
    ///         `baseSeedAmount` of the governance token (pulled via
    ///         transferFrom) and sends native coin as `msg.value` (wrapped
    ///         into WMON), and each is split into a matched pass/fail pair -
    ///         one deposit seeds BOTH markets, since a split always produces
    ///         both sides at once. The markets themselves open with
    ///         openMarkets(), a second transaction (see the contract note).
    function propose(
        ProposalAction[] calldata actions,
        string calldata metadataURI,
        uint256 baseSeedAmount
    ) external payable returns (uint256 proposalId) {
        if (actions.length == 0) revert EmptyProposalActions();
        for (uint256 i = 0; i < actions.length; i++) {
            if (actions[i].target == address(0)) revert InvalidProposalAction();
        }
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();
        if (baseSeedAmount == 0 || msg.value == 0) revert ZeroSeedAmount();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.metadataURI = metadataURI;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }
        _pendingSeeds[proposalId] = PendingSeed({ base: baseSeedAmount, quote: msg.value });

        // Pull the base-token seed from the proposer, and wrap the
        // native coin sent as msg.value into WMON.
        bool ok = IERC20Orchestrator(governanceToken).transferFrom(msg.sender, address(this), baseSeedAmount);
        if (!ok) revert TransferFailed();
        WMON(payable(wmon)).deposit{value: msg.value}();

        address baseVault = _deployVault(governanceToken, "Base");
        address quoteVault = _deployVault(wmon, "Quote");
        p.baseVault = baseVault;
        p.quoteVault = quoteVault;

        _approveAndSplit(governanceToken, baseVault, baseSeedAmount);
        _approveAndSplit(wmon, quoteVault, msg.value);

        emit ProposalSeeded(proposalId, msg.sender, baseSeedAmount, msg.value);
    }

    /// @notice Opens a seeded proposal's two markets: deploys the pass and
    ///         fail pools, seeds each with the proposal's pass (or fail)
    ///         tokens, and starts the trading window. Permissionless, once
    ///         per proposal; not after the proposal is cancelled.
    function openMarkets(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.passPool != address(0)) revert MarketsAlreadyOpen();
        if (p.cancelled) revert ProposalAlreadyCancelled();

        PendingSeed memory seed = _pendingSeeds[proposalId];
        delete _pendingSeeds[proposalId];
        p.createdAt = block.timestamp;
        p.tradingDeadline = block.timestamp + _config.tradingPeriod;

        ConditionalVault bv = ConditionalVault(p.baseVault);
        ConditionalVault qv = ConditionalVault(p.quoteVault);
        address passPool = _deployAndSeedPool(address(bv.passToken()), address(qv.passToken()), seed.base, seed.quote);
        address failPool = _deployAndSeedPool(address(bv.failToken()), address(qv.failToken()), seed.base, seed.quote);
        p.passPool = passPool;
        p.failPool = failPool;

        emit ProposalCreated(proposalId, p.proposer, p.metadataURI, passPool, failPool);
    }

    function _deployVault(address underlying, string memory label) internal returns (address vault) {
        vault = Clones.clone(conditionalVaultImplementation);
        ConditionalVault(vault).initialize(
            underlying,
            address(this),
            conditionalTokenImplementation,
            string.concat("Pass ", label),
            string.concat("p", label),
            string.concat("Fail ", label),
            string.concat("f", label)
        );
    }

    function _approveAndSplit(address underlying, address vault, uint256 amount) internal {
        // ConditionalVault.splitTokens uses transferFrom, so it needs an
        // allowance from this contract, not a push transfer.
        IERC20Orchestrator(underlying).approve(vault, amount);
        ConditionalVault(vault).splitTokens(amount);
    }

    function _deployAndSeedPool(
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint256 quoteAmount
    ) internal returns (address pool) {
        pool = Clones.clone(decisionMarketPairImplementation);
        DecisionMarketPair(pool).initialize(baseToken, quoteToken);

        IERC20Orchestrator(baseToken).transfer(pool, baseAmount);
        IERC20Orchestrator(quoteToken).transfer(pool, quoteAmount);
        DecisionMarketPair(pool).mint(address(this)); // resulting LP stays held by this contract - see contract-level note
    }

    /*//////////////////////////////////////////////////////////////
                                TRADING
    //////////////////////////////////////////////////////////////*/

    /// @notice A minimal trade entry point - transfers `amountIn` of
    ///         whichever conditional token `sideIn` names, into the
    ///         chosen market's pool, and executes the swap for the
    ///         opposite token. The caller must already hold the
    ///         conditional token being sold - see ConditionalVault.
    function trade(
        uint256 proposalId,
        Market market,
        Side sideIn,
        uint256 amountIn,
        uint256 minAmountOut
    ) external proposalExists(proposalId) marketsOpen(proposalId) returns (uint256 amountOut) {
        Proposal storage p = _proposals[proposalId];
        if (block.timestamp >= p.tradingDeadline) revert TradingWindowClosed();

        DecisionMarketPair pool = DecisionMarketPair(market == Market.Pass ? p.passPool : p.failPool);
        bool zeroForOne = sideIn == Side.Base;
        amountOut = pool.getAmountOut(amountIn, zeroForOne);
        if (amountOut < minAmountOut) revert InvalidValue();

        address tokenIn = zeroForOne ? pool.token0() : pool.token1();
        bool ok = IERC20Orchestrator(tokenIn).transferFrom(msg.sender, address(pool), amountIn);
        if (!ok) revert TransferFailed();

        if (zeroForOne) {
            pool.swap(0, amountOut, msg.sender);
        } else {
            pool.swap(amountOut, 0, msg.sender);
        }

        emit Traded(proposalId, msg.sender, market, sideIn, amountIn, amountOut);
    }

    /*//////////////////////////////////////////////////////////////
                    FINALIZATION - THE ACTUAL VERDICT
    //////////////////////////////////////////////////////////////*/

    /// @notice Reads both markets' TWAP (the full window since each pool
    ///         was seeded, since every pool is freshly created per
    ///         proposal), compares pass against fail plus the configured
    ///         threshold, and resolves both conditional vaults
    ///         accordingly. No oracle, no resolver, no challenge - the
    ///         comparison itself is the verdict.
    function finalizeProposal(uint256 proposalId) external proposalExists(proposalId) marketsOpen(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.finalized) revert AlreadyFinalized();
        if (block.timestamp < p.tradingDeadline) revert TradingWindowStillOpen();

        uint256 elapsed = block.timestamp - p.createdAt;

        // price0CumulativeLast only advances when _update() actually runs
        // (mint/burn/swap/sync) - a pool nobody traded near the end of the
        // window would otherwise return a stale accumulator value here,
        // not one reflecting the price up through this exact moment.
        DecisionMarketPair(p.passPool).sync();
        DecisionMarketPair(p.failPool).sync();

        uint256 passTWAP = DecisionMarketPair(p.passPool).price0CumulativeLast() / elapsed;
        uint256 failTWAP = DecisionMarketPair(p.failPool).price0CumulativeLast() / elapsed;

        uint256 threshold = (failTWAP * (10_000 + _config.thresholdBps)) / 10_000;
        bool passed = passTWAP > threshold;

        p.finalized = true;
        p.passed = passed;
        p.passTWAP = passTWAP;
        p.failTWAP = failTWAP;

        ConditionalVault(p.baseVault).resolve(passed ? 1 : 0, passed ? 0 : 1);
        ConditionalVault(p.quoteVault).resolve(passed ? 1 : 0, passed ? 0 : 1);

        if (passed) {
            p.queuedAt = block.timestamp;
            emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
        }

        emit ProposalFinalized(proposalId, passed, passTWAP, failTWAP);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL EXECUTION
    //////////////////////////////////////////////////////////////*/

    function executeProposal(uint256 proposalId) external payable proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (!p.finalized) revert NotFinalized();
        if (!p.passed) revert ProposalDidNotPass();
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
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

        emit ProposalExecuted(proposalId);
    }

    function cancelProposal(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (msg.sender != p.proposer && msg.sender != address(this)) revert Unauthorized();

        p.cancelled = true;
        emit ProposalCancelled(proposalId, msg.sender);

        // Cancelled before its markets opened: the seed is still whole in
        // the two vaults - merge it back and return it to the proposer.
        PendingSeed memory seed = _pendingSeeds[proposalId];
        if (p.passPool == address(0) && seed.base != 0) {
            delete _pendingSeeds[proposalId];
            ConditionalVault(p.baseVault).mergeTokens(seed.base);
            ConditionalVault(p.quoteVault).mergeTokens(seed.quote);
            if (!IERC20Orchestrator(governanceToken).transfer(p.proposer, seed.base)) revert TransferFailed();
            if (!IERC20Orchestrator(wmon).transfer(p.proposer, seed.quote)) revert TransferFailed();
            emit SeedRefunded(proposalId, seed.base, seed.quote);
        }
    }
    /*//////////////////////////////////////////////////////////////
                        LIQUIDITY RECLAMATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Recovers the seed liquidity this contract holds for a
    ///         finalized proposal's two pools, converts it back to real
    ///         underlying via the now-resolved vaults, and sends it to
    ///         the treasury. Permissionless, callable once per proposal,
    ///         any time after finalization - deliberately not available
    ///         during trading, since pulling liquidity mid-market would
    ///         distort the very TWAP the resolution depends on. Works
    ///         the same regardless of whether the proposal passed,
    ///         failed, or was ever executed - this only recovers the
    ///         seed capital, unrelated to the proposal's own actions.
    function reclaimLiquidity(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (!p.finalized) revert NotFinalized();
        if (p.liquidityReclaimed) revert AlreadyReclaimed();
        p.liquidityReclaimed = true;

        _burnPoolLiquidity(p.passPool);
        _burnPoolLiquidity(p.failPool);

        // Both vaults are already resolved by finalizeProposal - this
        // pays out only the winning side, same mechanism any real trader
        // uses, burning the losing side's conditional tokens for nothing.
        ConditionalVault(p.baseVault).redeemTokens();
        ConditionalVault(p.quoteVault).redeemTokens();

        uint256 baseRecovered = IERC20Orchestrator(governanceToken).balanceOf(address(this));
        uint256 quoteRecovered = IERC20Orchestrator(wmon).balanceOf(address(this));

        if (baseRecovered > 0) IERC20Orchestrator(governanceToken).transfer(p.proposer, baseRecovered);
        if (quoteRecovered > 0) IERC20Orchestrator(wmon).transfer(p.proposer, quoteRecovered);

        emit LiquidityReclaimed(proposalId, baseRecovered, quoteRecovered);
    }

    function _burnPoolLiquidity(address poolAddr) internal {
        DecisionMarketPair pool = DecisionMarketPair(poolAddr);
        uint256 lpBalance = pool.balanceOf(address(this));
        if (lpBalance == 0) return;
        pool.transfer(poolAddr, lpBalance);
        pool.burn(address(this));
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function updateConfig(DecisionMarketsConfig calldata newConfig) external onlyGovernance {
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

    function config() external view returns (DecisionMarketsConfig memory) {
        return _config;
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _validateConfig(DecisionMarketsConfig memory c) internal pure {
        if (c.tradingPeriod == 0) revert InvalidConfiguration();
        if (c.thresholdBps == 0) revert InvalidConfiguration();
    }

    receive() external payable {}
}
