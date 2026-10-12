// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title WelcomeDistributor
/// @author Marvin Sunday
/// @notice Distributes a fixed amount of a DAO's raw GovernanceToken to new
///         members, one claim per address, up to a hard cap.
/// @dev Deliberately NOT wired into DAOFactory - this is optional, per-DAO
///      configuration (operator address, amount, cap), not a required part
///      of the governance core. Any raw-token holder can fund it with a
///      plain transfer; no governance proposal or minting allowance is
///      required to set it up. Governance retains admin control (operator,
///      amountPerClaim, withdraw) so a DAO can reconfigure or shut down
///      distribution without redeploying.
///
///      Trust model: `operator` is a single authorized address (in
///      practice, the Telegram bot's backend wallet) that decides who gets
///      a distribution and when - it is the bot's job to verify a claimant
///      is a genuine new group member before calling `distribute`. This
///      contract cannot verify Telegram membership itself; it only
///      enforces the on-chain invariants (one claim per address, total
///      cap). Sybil resistance is therefore a property of the operator's
///      off-chain checks, not of this contract - see the bot's join
///      handling for whatever mitigations are actually in place.
contract WelcomeDistributor {
    using SafeERC20 for IERC20;

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice The raw GovernanceToken being distributed.
    address public immutable token;

    /// @notice The DAO's Governance contract - has admin control here.
    address public governance;

    /// @notice The address authorized to trigger distributions (the bot's
    ///         operator wallet, in practice).
    address public operator;

    /// @notice Amount of `token` sent per successful claim.
    uint256 public amountPerClaim;

    /// @notice Hard cap on total tokens this contract will ever distribute.
    uint256 public distributionCap;

    /// @notice Running total already distributed.
    uint256 public totalDistributed;

    /// @notice Tracks whether an address has already claimed.
    mapping(address => bool) public hasClaimed;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event Distributed(address indexed member, uint256 amount);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event AmountPerClaimUpdated(uint256 previousAmount, uint256 newAmount);
    event DistributionCapUpdated(uint256 previousCap, uint256 newCap);
    event GovernanceUpdated(address indexed previousGovernance, address indexed newGovernance);
    event Withdrawn(address indexed to, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyClaimed();
    error DistributionCapExceeded();

    /*//////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address token_,
        address governance_,
        address operator_,
        uint256 amountPerClaim_,
        uint256 distributionCap_
    ) {
        if (token_ == address(0) || governance_ == address(0) || operator_ == address(0)) {
            revert ZeroAddress();
        }
        if (amountPerClaim_ == 0) revert ZeroAmount();

        token = token_;
        governance = governance_;
        operator = operator_;
        amountPerClaim = amountPerClaim_;
        distributionCap = distributionCap_;
    }

    /*//////////////////////////////////////////////////////////////
                            DISTRIBUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Sends `amountPerClaim` of `token` to `member`. Callable only
    ///         by the operator; one successful claim per address, ever.
    function distribute(address member) external onlyOperator {
        if (member == address(0)) revert ZeroAddress();
        if (hasClaimed[member]) revert AlreadyClaimed();
        if (totalDistributed + amountPerClaim > distributionCap) revert DistributionCapExceeded();

        hasClaimed[member] = true;
        totalDistributed += amountPerClaim;

        IERC20(token).safeTransfer(member, amountPerClaim);

        emit Distributed(member, amountPerClaim);
    }

    /*//////////////////////////////////////////////////////////////
                        GOVERNANCE-ONLY ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Updates which address is authorized to trigger distributions.
    function setOperator(address newOperator) external onlyGovernance {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Updates the amount sent per claim. Does not affect claims
    ///         already made.
    function setAmountPerClaim(uint256 newAmount) external onlyGovernance {
        if (newAmount == 0) revert ZeroAmount();
        emit AmountPerClaimUpdated(amountPerClaim, newAmount);
        amountPerClaim = newAmount;
    }

    /// @notice Raises or lowers the total distribution cap. Lowering it
    ///         below `totalDistributed` simply halts further distribution
    ///         (distribute() reverts) without affecting past claims.
    function setDistributionCap(uint256 newCap) external onlyGovernance {
        emit DistributionCapUpdated(distributionCap, newCap);
        distributionCap = newCap;
    }

    /// @notice Points this contract at a new Governance contract, mirroring
    ///         the same admin-handoff pattern used by Treasury and
    ///         Governance itself elsewhere in this system.
    function setGovernance(address newGovernance) external onlyGovernance {
        if (newGovernance == address(0)) revert ZeroAddress();
        emit GovernanceUpdated(governance, newGovernance);
        governance = newGovernance;
    }

    /// @notice Pulls tokens back out - e.g. to wind down distribution and
    ///         return unclaimed funds to the treasury.
    function withdraw(address to, uint256 amount) external onlyGovernance {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Current token balance held by this contract.
    function balance() external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Remaining budget before the distribution cap is hit.
    function remainingCapacity() external view returns (uint256) {
        if (totalDistributed >= distributionCap) return 0;
        return distributionCap - totalDistributed;
    }
}
