// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {QuadraticDAOFactory} from "../src/factory/QuadraticDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {QuadraticGovernance} from "../src/governance/quadratic/QuadraticGovernance.sol";

/// @title DeployQuadraticDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, QuadraticGovernance) and then
///         QuadraticDAOFactory itself, wired to them. Every DAO after
///         that is created by calling `createDAO` on the deployed
///         factory rather than redeploying anything here again.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes for
///      why the implementations must be deployed separately, before the
///      factory, rather than by the factory's own constructor.
///
/// Usage:
///   forge script script/DeployQuadraticDAOFactory.s.sol:DeployQuadraticDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployQuadraticDAOFactory is Script {
    function run() external returns (QuadraticDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        QuadraticGovernance quadraticGovernanceImplementation = new QuadraticGovernance();

        factory = new QuadraticDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(quadraticGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("QuadraticGovernance implementation deployed at:", address(quadraticGovernanceImplementation));
        console.log("QuadraticDAOFactory deployed at:", address(factory));
    }
}
