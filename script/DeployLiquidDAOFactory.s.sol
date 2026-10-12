// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LiquidDAOFactory} from "../src/factory/LiquidDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {LiquidGovernance} from "../src/governance/liquid/LiquidGovernance.sol";

/// @title DeployLiquidDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, LiquidGovernance) and then
///         LiquidDAOFactory itself, wired to them.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///
/// Usage:
///   forge script script/DeployLiquidDAOFactory.s.sol:DeployLiquidDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployLiquidDAOFactory is Script {
    function run() external returns (LiquidDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        LiquidGovernance liquidGovernanceImplementation = new LiquidGovernance();

        factory = new LiquidDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(liquidGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("LiquidGovernance implementation deployed at:", address(liquidGovernanceImplementation));
        console.log("LiquidDAOFactory deployed at:", address(factory));
    }
}
