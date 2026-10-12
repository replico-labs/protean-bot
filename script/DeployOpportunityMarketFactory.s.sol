// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {OpportunityMarket} from "../src/governance/opportunity-market/OpportunityMarket.sol";
import {OpportunityMarketFactory} from "../src/governance/opportunity-market/OpportunityMarketFactory.sol";

/// @title DeployOpportunityMarketFactory
/// @notice Deploys the OpportunityMarket implementation and the factory
///         that clones it, in that order - the factory's constructor
///         takes the implementation's address directly, so it must exist
///         first. Every market created afterward (see
///         CreateOpportunityMarket.s.sol) is a cheap clone of this one
///         implementation, not a fresh full deployment.
///
/// IMPORTANT: OpportunityMarket depends on Zama's fhEVM confidential-
///         computing infrastructure, which - as of this writing - is
///         only genuinely deployed on Ethereum Sepolia (and Ethereum
///         mainnet for production use), not on Monad. Point --rpc-url at
///         Sepolia when running this, not the Monad RPC used for every
///         other deploy script in this repository.
///
/// Usage:
///   forge script script/DeployOpportunityMarketFactory.s.sol:DeployOpportunityMarketFactory \
///     --rpc-url https://rpc.sepolia.org \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployOpportunityMarketFactory is Script {
    function run() external returns (OpportunityMarket implementation, OpportunityMarketFactory factory) {
        vm.startBroadcast();

        implementation = new OpportunityMarket();
        factory = new OpportunityMarketFactory(address(implementation));

        vm.stopBroadcast();

        console.log("OpportunityMarket implementation deployed at:", address(implementation));
        console.log("OpportunityMarketFactory deployed at:         ", address(factory));
    }
}
