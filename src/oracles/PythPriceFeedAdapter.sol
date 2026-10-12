// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IPyth } from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import { PythStructs } from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @dev Matches SowellianGovernance's IMetricOracle interface exactly -
///      not imported, to keep oracles/ free of a governance dependency.
interface IMetricOracle {
    function latestValue(bytes32 selector) external view returns (int256 value, uint256 updatedAt);
}

/// @title PythPriceFeedAdapter
/// @notice Serves any Pyth price feed to SowellianGovernance's oracle
///         track. One adapter per network covers every feed: a proposal's
///         `oracleSelector` is the Pyth price feed ID (e.g. ETH/USD).
/// @dev Values are returned as 18-decimal fixed point whatever the feed's
///      own exponent, so a proposal's targetValue is always "price x 1e18"
///      ($2,500.50 -> 2500500000000000000000).
///
///      Pyth is pull-based: a price is only on-chain once someone posts a
///      signed update (from Pyth's Hermes service) with
///      IPyth.updatePriceFeeds, paying its small fee. Post one right
///      before resolveViaOracle. This adapter reads the stored price with
///      getPriceUnsafe and returns its publishTime, so SowellianGovernance's
///      own maxOracleStaleness check decides what's too old (and reverts
///      StaleOracleData) rather than Pyth's getPriceNoOlderThan.
contract PythPriceFeedAdapter is IMetricOracle {
    IPyth public immutable pyth;
    uint8 public constant DECIMALS = 18;

    error ZeroAddress();
    error NotPyth();
    error UnsupportedExponent(int32 expo);

    /// @param pyth_ Pyth's price feed contract on this chain (docs.pyth.network/price-feeds/contract-addresses/evm).
    constructor(address pyth_) {
        if (pyth_ == address(0)) revert ZeroAddress();
        // A wrong address fails here rather than at the first resolution:
        // anything that isn't a Pyth contract can't answer getUpdateFee.
        if (pyth_.code.length == 0) revert NotPyth();
        IPyth(pyth_).getUpdateFee(new bytes[](0));
        pyth = IPyth(pyth_);
    }

    /// @inheritdoc IMetricOracle
    function latestValue(bytes32 priceId) external view returns (int256 value, uint256 updatedAt) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(priceId);
        return (toDecimals18(p.price, p.expo), p.publishTime);
    }

    /// @notice price x 10^expo, as 18-decimal fixed point.
    function toDecimals18(int64 price, int32 expo) public pure returns (int256) {
        int256 shift = int256(uint256(DECIMALS)) + expo;
        // Pyth exponents are small (typically -12..0); refuse anything that could overflow.
        if (shift > 50 || shift < -50) revert UnsupportedExponent(expo);
        int256 v = int256(price);
        return shift >= 0 ? v * int256(10 ** uint256(shift)) : v / int256(10 ** uint256(-shift));
    }
}
