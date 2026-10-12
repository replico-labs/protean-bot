// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";
import { OpportunityMarket } from "./OpportunityMarket.sol";

/// @title OpportunityMarketFactory
/// @author Marvin Sunday
/// @notice The DAO-style entry point: anyone can come here and deploy a
///         fresh, fully independent OpportunityMarket - their own
///         opportunity list, their own stakes, their own reward pool.
///         Deploying costs only clone-proxy gas, not a full contract
///         deployment, same pattern used for every other cloneable piece
///         in this codebase (ConditionalToken, ConditionalVault,
///         DecisionMarketPair).
/// @dev The caller of createMarket becomes that specific market's
///      deployer/resolver - the factory itself has no ongoing authority
///      over markets it creates once deployed.
contract OpportunityMarketFactory {
    address public immutable marketImplementation;

    address[] public allMarkets;
    mapping(address => bool) public isMarket;

    event MarketCreated(address indexed market, address indexed deployer, address indexed underlyingToken);

    error ZeroAddress();

    constructor(address marketImplementation_) {
        if (marketImplementation_ == address(0)) revert ZeroAddress();
        marketImplementation = marketImplementation_;
    }

    /// @notice Deploys a new OpportunityMarket. The caller becomes its
    ///         deployer - the address that later funds its reward pool
    ///         and resolves which opportunity won.
    function createMarket(address underlyingToken) external returns (address market) {
        if (underlyingToken == address(0)) revert ZeroAddress();

        market = Clones.clone(marketImplementation);
        OpportunityMarket(market).initialize(underlyingToken, msg.sender);

        allMarkets.push(market);
        isMarket[market] = true;

        emit MarketCreated(market, msg.sender, underlyingToken);
    }

    function marketCount() external view returns (uint256) {
        return allMarkets.length;
    }

    function getMarkets(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = allMarkets.length;
        if (offset >= total) return new address[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = allMarkets[i];
        }
    }
}
