// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {OpportunityMarketFactory} from "../src/governance/opportunity-market/OpportunityMarketFactory.sol";
import {OpportunityMarket} from "../src/governance/opportunity-market/OpportunityMarket.sol";

/// @title CreateOpportunityMarket
/// @notice Calls `createMarket` on an already-deployed OpportunityMarketFactory.
///         Unlike the ten governance-model DAO factories, there is no
///         config struct here at all - reward pool funding, listing
///         opportunities, and everything else happens through separate,
///         later transactions directly on the deployed market, not at
///         creation time. The caller of this script becomes that
///         market's deployer - the address that later funds its reward
///         pool and resolves which opportunity won.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed OpportunityMarketFactory
///   UNDERLYING_TOKEN  - address of the real ERC20 backers will deposit and stake
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export UNDERLYING_TOKEN=0x...
///
///   forge script script/CreateOpportunityMarket.s.sol:CreateOpportunityMarket \
///     --rpc-url <SEPOLIA_RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateOpportunityMarket is Script {
    function run() external returns (address market) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        address underlyingToken = vm.envAddress("UNDERLYING_TOKEN");

        OpportunityMarketFactory factory = OpportunityMarketFactory(factoryAddress);

        vm.startBroadcast();

        market = factory.createMarket(underlyingToken);

        vm.stopBroadcast();

        console.log("OpportunityMarket deployed at:", market);
        console.log("Deployer:                     ", OpportunityMarket(market).deployer());
        console.log("Underlying token:             ", underlyingToken);
        require(factory.isMarket(market), "sanity check failed");
    }
}
