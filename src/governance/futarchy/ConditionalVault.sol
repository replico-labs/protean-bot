// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { ConditionalToken } from "./ConditionalToken.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title ConditionalVault
/// @author Marvin Sunday
/// @notice Splits a real token into a matched pair of conditional
///         (pass/fail) tokens, lets that pair be merged back pre-
///         resolution, and lets the winning side redeem 1:1 for real
///         tokens once resolved. One vault exists per (proposal,
///         underlying token) pair - a decision market needs two vaults,
///         one for the DAO's governance token and one for the quote
///         asset (WMON), both resolved together by the same oracle call.
/// @dev  Deployed as a minimal-proxy clone per proposal,
///       same pattern as ConditionalToken.

contract ConditionalVault {
    address public underlying;
    address public oracle; // the only address allowed to resolve this vault - the decision-market orchestrator
    ConditionalToken public passToken;
    ConditionalToken public failToken;

    bool public resolved;
    uint256 public payoutPassNumerator;
    uint256 public payoutFailNumerator;
    uint256 public payoutDenominator;

    bool private _initialized;
    address public conditionalTokenImplementation;

    event Split(address indexed account, uint256 amount);
    event Merged(address indexed account, uint256 amount);
    event Redeemed(address indexed account, uint256 payout);
    event Resolved(uint256 payoutPassNumerator, uint256 payoutFailNumerator);

    error AlreadyInitialized();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyResolved();
    error NotResolved();
    error Unauthorized();
    error TransferFailed();
    error InvalidPayoutNumerators();
    error NothingToRedeem();

    modifier onlyOracle() {
        if (msg.sender != oracle) revert Unauthorized();
        _;
    }

    /// @notice Called exactly once, immediately after cloning. Deploys and
    ///         initializes this vault's own pair of conditional tokens.
    function initialize(
        address underlying_,
        address oracle_,
        address conditionalTokenImplementation_,
        string calldata passName,
        string calldata passSymbol,
        string calldata failName,
        string calldata failSymbol
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        if (underlying_ == address(0) || oracle_ == address(0) || conditionalTokenImplementation_ == address(0)) {
            revert ZeroAddress();
        }

        underlying = underlying_;
        oracle = oracle_;
        conditionalTokenImplementation = conditionalTokenImplementation_;

        address passClone = Clones.clone(conditionalTokenImplementation_);
        address failClone = Clones.clone(conditionalTokenImplementation_);
        ConditionalToken(passClone).initialize(passName, passSymbol, address(this));
        ConditionalToken(failClone).initialize(failName, failSymbol, address(this));

        passToken = ConditionalToken(passClone);
        failToken = ConditionalToken(failClone);
    }

    /// @notice Deposits `amount` of the underlying token and mints an
    ///         equal amount of both the pass-token and fail-token.
    function splitTokens(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        // Deposit must succeed before minting - the natural order here,
        // not a checks-effects-interactions violation in practice, since
        // `underlying` is a fixed, DAO-configured token (the governance
        // token or WMON) with no callback hooks that could reenter.
        bool ok = IERC20Minimal(underlying).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();

        passToken.mint(msg.sender, amount);
        failToken.mint(msg.sender, amount);

        emit Split(msg.sender, amount);
    }

    /// @notice Burns an equal amount of both conditional tokens and
    ///         returns the underlying. Only available before resolution -
    ///         once resolved, only one side has any value, so merging back
    ///         to a matched pair no longer makes sense.
    function mergeTokens(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (resolved) revert AlreadyResolved();

        passToken.burn(msg.sender, amount);
        failToken.burn(msg.sender, amount);

        bool ok = IERC20Minimal(underlying).transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Merged(msg.sender, amount);
    }

    /// @notice Sets the final payout weights. Only callable once, only by
    ///         the designated oracle (the decision-market orchestrator,
    ///         after comparing the pass/fail market TWAPs).
    function resolve(uint256 payoutPassNumerator_, uint256 payoutFailNumerator_) external onlyOracle {
        if (resolved) revert AlreadyResolved();
        if (payoutPassNumerator_ + payoutFailNumerator_ == 0) revert InvalidPayoutNumerators();

        resolved = true;
        payoutPassNumerator = payoutPassNumerator_;
        payoutFailNumerator = payoutFailNumerator_;
        payoutDenominator = payoutPassNumerator_ + payoutFailNumerator_;

        emit Resolved(payoutPassNumerator_, payoutFailNumerator_);
    }

    /// @notice Redeems the caller's entire conditional token balance for
    ///         real underlying, weighted by the resolved payout. A clean
    ///         pass/fail resolution (numerators like [1,0] or [0,1]) means
    ///         only the winning side's tokens are worth anything - the
    ///         losing side burns for zero, same as MetaDAO's real system.
    function redeemTokens() external {
        if (!resolved) revert NotResolved();

        uint256 passBalance = passToken.balanceOf(msg.sender);
        uint256 failBalance = failToken.balanceOf(msg.sender);
        if (passBalance == 0 && failBalance == 0) revert NothingToRedeem();

        uint256 payout = (passBalance * payoutPassNumerator + failBalance * payoutFailNumerator) / payoutDenominator;

        if (passBalance > 0) passToken.burn(msg.sender, passBalance);
        if (failBalance > 0) failToken.burn(msg.sender, failBalance);

        if (payout > 0) {
            bool ok = IERC20Minimal(underlying).transfer(msg.sender, payout);
            if (!ok) revert TransferFailed();
        }

        emit Redeemed(msg.sender, payout);
    }
}
