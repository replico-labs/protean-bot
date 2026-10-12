// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITreasury
/// @notice Interface for the DAO Treasury.
interface ITreasury {

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ETHReceived(
        address indexed sender,
        uint256 amount
    );

    event ETHTransferred(
        address indexed recipient,
        uint256 amount
    );

    event ERC20Transferred(
        address indexed token,
        address indexed recipient,
        uint256 amount
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error Unauthorized();
    error ZeroAddress();
    error TransferFailed();
    error InsufficientBalance();

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the governance contract.
    function governance()
        external
        view
        returns (address);

    /// @notice Returns the ETH balance.
    function ethBalance()
        external
        view
        returns (uint256);

    /// @notice Returns the balance of an ERC20 token.
    function tokenBalance(
        address token
    )
        external
        view
        returns (uint256);

    /*//////////////////////////////////////////////////////////////
                            EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Transfers ETH.
    function transferETH(
        address payable recipient,
        uint256 amount
    )
        external;

    /// @notice Transfers ERC20 tokens.
    function transferERC20(
        address token,
        address recipient,
        uint256 amount
    )
        external;

    /// @notice Executes an arbitrary call.
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    )
        external
        returns (bytes memory);

    /*//////////////////////////////////////////////////////////////
                            ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Transfers treasury ownership.
    function transferGovernance(
        address newGovernance
    )
        external;
}