// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRandomnessSource
/// @author Marvin Sunday
/// @notice A provider-agnostic interface for verifiable on-chain randomness.
///         Any contract that needs randomness (SortitionGovernance, for
///         example) depends only on this interface - which underlying
///         provider (Pyth Entropy today, see PythEntropyRandomnessAdapter)
///         is an implementation detail, swappable per DAO the same way
///         every governance model in this system is swappable.
/// @dev Request IDs are chosen by the caller (bytes32) and must be unique;
///      an adapter maps them to its provider's own request identifiers.
///      `requestRandomness` is payable because providers charge a fee per
///      request.
interface IRandomnessSource {
    /// @notice Requests randomness for a caller-chosen, unique request ID.
    ///         Reverts if this ID has already been used.
    function requestRandomness(bytes32 requestId) external payable;

    /// @notice Whether randomness for this request ID has been resolved.
    function isFulfilled(bytes32 requestId) external view returns (bool);

    /// @notice The resolved random value. Reverts if not yet fulfilled -
    ///         callers must check `isFulfilled` first.
    function getRandomness(bytes32 requestId) external view returns (uint256);
}
