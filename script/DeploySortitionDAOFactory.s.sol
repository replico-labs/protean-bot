// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SortitionDAOFactory} from "../src/factory/SortitionDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {SortitionGovernance} from "../src/governance/sortition/SortitionGovernance.sol";

/// @title DeploySortitionDAOFactory
/// @notice Deploys the four clone implementations (GovernanceToken,
///         StakedGovernanceToken, Treasury, SortitionGovernance) and then
///         SortitionDAOFactory itself, wired to them.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///      IMPORTANT, two separate --via-ir requirements here, not one:
///      (1) SortitionGovernance itself is too large a standalone
///      implementation to deploy without --via-ir (25,645 bytes without
///      it, 12,384 with it, against the 24,576-byte limit); (2)
///      SortitionDAOFactory's own createDAO() function hits a genuine
///      "stack too deep" compiler error without --via-ir - a hard
///      compile failure, not just a size warning, meaning this whole
///      script cannot even compile without it, let alone deploy.
///
/// Usage:
///   forge script script/DeploySortitionDAOFactory.s.sol:DeploySortitionDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --via-ir \
///     --verify
contract DeploySortitionDAOFactory is Script {
    function run() external returns (SortitionDAOFactory factory) {
        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        SortitionGovernance sortitionGovernanceImplementation = new SortitionGovernance();

        factory = new SortitionDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(sortitionGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("SortitionGovernance implementation deployed at:", address(sortitionGovernanceImplementation));
        console.log("SortitionDAOFactory deployed at:", address(factory));
    }
}
