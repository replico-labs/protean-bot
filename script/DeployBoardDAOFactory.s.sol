// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BoardDAOFactory} from "../src/factory/BoardDAOFactory.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {BoardGovernance} from "../src/governance/board/BoardGovernance.sol";

/// @title DeployBoardDAOFactory
/// @notice Deploys the two clone implementations Board needs (Treasury,
///         BoardGovernance - no token at all for this model) and then
///         BoardDAOFactory itself, wired to them.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes.
///
/// Usage:
///   forge script script/DeployBoardDAOFactory.s.sol:DeployBoardDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --verify
contract DeployBoardDAOFactory is Script {
    function run() external returns (BoardDAOFactory factory) {
        vm.startBroadcast();

        Treasury treasuryImplementation = new Treasury();
        BoardGovernance boardGovernanceImplementation = new BoardGovernance();

        factory = new BoardDAOFactory(
            address(treasuryImplementation),
            address(boardGovernanceImplementation)
        );

        vm.stopBroadcast();

        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("BoardGovernance implementation deployed at:", address(boardGovernanceImplementation));
        console.log("BoardDAOFactory deployed at:", address(factory));
    }
}
