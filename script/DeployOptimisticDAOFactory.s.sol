// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {OptimisticDAOFactory} from "../src/factory/OptimisticDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {OptimisticGovernance} from "../src/governance/optimistic/OptimisticGovernance.sol";

/// @title DeployOptimisticDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, OptimisticGovernance) and
///         then OptimisticDAOFactory itself, wired to them.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///
/// Usage:
///   forge script script/DeployOptimisticDAOFactory.s.sol:DeployOptimisticDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployOptimisticDAOFactory is Script {
    function run() external returns (OptimisticDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        OptimisticGovernance optimisticGovernanceImplementation = new OptimisticGovernance();

        factory = new OptimisticDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(optimisticGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("OptimisticGovernance implementation deployed at:", address(optimisticGovernanceImplementation));
        console.log("OptimisticDAOFactory deployed at:", address(factory));
    }
}
