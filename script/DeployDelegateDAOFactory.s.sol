// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DelegateDAOFactory} from "../src/factory/DelegateDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {DelegateGovernance} from "../src/governance/delegate/DelegateGovernance.sol";

/// @title DeployDelegateDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, DelegateGovernance) and then
///         DelegateDAOFactory itself, wired to them. Every delegate-
///         governed DAO after that is created by calling `createDAO` on
///         the deployed factory (see CreateDelegateDAO.s.sol) rather than
///         redeploying anything here again.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///      IMPORTANT: DelegateGovernance itself is too large a standalone
///      implementation to deploy without --via-ir (confirmed: 30,834
///      bytes without it, 14,831 with it, both against the 24,576-byte
///      limit) - this script MUST be run with --via-ir or the
///      DelegateGovernance deployment transaction here will revert.
///
/// Usage:
///   forge script script/DeployDelegateDAOFactory.s.sol:DeployDelegateDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --via-ir \
///     --verify
contract DeployDelegateDAOFactory is Script {
    function run() external returns (DelegateDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        DelegateGovernance delegateGovernanceImplementation = new DelegateGovernance();

        factory = new DelegateDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(delegateGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("DelegateGovernance implementation deployed at:", address(delegateGovernanceImplementation));
        console.log("DelegateDAOFactory deployed at:", address(factory));
    }
}
