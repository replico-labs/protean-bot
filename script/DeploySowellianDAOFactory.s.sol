// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SowellianDAOFactory} from "../src/factory/SowellianDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {SowellianGovernance} from "../src/governance/sowellian/SowellianGovernance.sol";

/// @title DeploySowellianDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, SowellianGovernance) and then
///         SowellianDAOFactory itself, wired to them.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///      IMPORTANT: SowellianGovernance itself is too large a standalone
///      implementation to deploy without --via-ir (confirmed: 30,313
///      bytes without it, 14,626 with it, both against the 24,576-byte
///      limit) - this script MUST be run with --via-ir or the
///      SowellianGovernance deployment transaction here will revert.
///
/// Usage:
///   forge script script/DeploySowellianDAOFactory.s.sol:DeploySowellianDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --via-ir \
///     --verify
contract DeploySowellianDAOFactory is Script {
    function run() external returns (SowellianDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        SowellianGovernance sowellianGovernanceImplementation = new SowellianGovernance();

        factory = new SowellianDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(sowellianGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("SowellianGovernance implementation deployed at:", address(sowellianGovernanceImplementation));
        console.log("SowellianDAOFactory deployed at:", address(factory));
    }
}
