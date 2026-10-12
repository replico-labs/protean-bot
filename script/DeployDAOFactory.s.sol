// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DAOFactory} from "../src/factory/DAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {Governance} from "../src/governance/Governance.sol";

/// @title DeployDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, Governance) and then
///         DAOFactory itself, wired to them. Every DAO after that is
///         created by calling `createDAO` on the deployed factory (see
///         CreateDAO.s.sol) rather than redeploying anything here again.
/// @dev Two-step deployment, not one: the four implementations must be
///      deployed as their own separate transactions before the factory -
///      DAOFactory's own constructor deploying them itself would embed
///      each one's full creation bytecode in the factory's bytecode,
///      exactly the bug this clone-based redesign exists to fix. See
///      DAOFactory.sol's own notes for the full explanation.
///
/// Usage:
///   forge script script/DeployDAOFactory.s.sol:DeployDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployDAOFactory is Script {
    function run() external returns (DAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        Governance governanceImplementation = new Governance();

        factory = new DAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(governanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("Governance implementation deployed at:", address(governanceImplementation));
        console.log("DAOFactory deployed at:", address(factory));
    }
}
