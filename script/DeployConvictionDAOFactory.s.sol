// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ConvictionDAOFactory} from "../src/factory/ConvictionDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {ConvictionGovernance} from "../src/governance/conviction/ConvictionGovernance.sol";

/// @title DeployConvictionDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, ConvictionGovernance) and
///         then ConvictionDAOFactory itself, wired to them.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///
/// Usage:
///   forge script script/DeployConvictionDAOFactory.s.sol:DeployConvictionDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployConvictionDAOFactory is Script {
    function run() external returns (ConvictionDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        ConvictionGovernance convictionGovernanceImplementation = new ConvictionGovernance();

        factory = new ConvictionDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(convictionGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("ConvictionGovernance implementation deployed at:", address(convictionGovernanceImplementation));
        console.log("ConvictionDAOFactory deployed at:", address(factory));
    }
}
