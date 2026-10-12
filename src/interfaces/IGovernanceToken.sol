// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IGovernanceToken
/// @notice Interface for the governance voting token.
interface IGovernanceToken {

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error SnapshotBlockNotYetMined();

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the current total token supply.
    function totalSupply()
        external
        view
        returns (uint256);

    /// @notice Returns the current balance of an account.
    function balanceOf(
        address account
    )
        external
        view
        returns (uint256);

    /// @notice Returns the current voting power of an account.
    function getVotes(
        address account
    )
        external
        view
        returns (uint256);

    /// @notice Returns voting power at a snapshot block.
    function getPastVotes(
        address account,
        uint256 blockNumber
    )
        external
        view
        returns (uint256);

    /// @notice Returns total token supply at a snapshot block.
    function getPastTotalSupply(
        uint256 blockNumber
    )
        external
        view
        returns (uint256);

    /// @notice Returns the delegate of an account.
    function delegates(
        address account
    )
        external
        view
        returns (address);

    /*//////////////////////////////////////////////////////////////
                            DELEGATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Delegate voting power.
    function delegate(
        address delegatee
    )
        external;

    /// @notice Delegate using a signature.
    function delegateBySig(
        address delegatee,
        uint256 nonce,
        uint256 expiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    )
        external;

    /*//////////////////////////////////////////////////////////////
                            ERC20
    //////////////////////////////////////////////////////////////*/

    function transfer(
        address to,
        uint256 amount
    )
        external
        returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    )
        external
        returns (bool);

    function approve(
        address spender,
        uint256 amount
    )
        external
        returns (bool);

    function allowance(
        address owner,
        address spender
    )
        external
        view
        returns (uint256);
}