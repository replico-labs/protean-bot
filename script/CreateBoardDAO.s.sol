// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BoardDAOFactory} from "../src/factory/BoardDAOFactory.sol";
import {BoardGovernance} from "../src/governance/board/BoardGovernance.sol";

/// @title CreateBoardDAO
/// @notice Calls `createDAO` on an already-deployed BoardDAOFactory.
///         BoardGovernance is tokenless - no GovernanceToken or
///         StakedGovernanceToken gets deployed, so there are no
///         token-related env vars here at all, unlike every other
///         Create*.s.sol script in this system.
///
/// Required env vars:
///   FACTORY_ADDRESS     - address of the already-deployed BoardDAOFactory
///   DAO_NAME            - e.g. "Ark DAO"
///   INITIAL_SIGNERS     - comma-separated addresses, e.g. "0xAaa...,0xBbb...,0xCcc..."
///
/// Optional env vars (sensible defaults shown):
///   REQUIRED_APPROVALS  - default: majority of signers, rounded up
///   TIMELOCK_DELAY      - default 86400 (seconds, 1 day)
///   EXECUTION_PERIOD    - default 604800 (seconds, 7 days)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export INITIAL_SIGNERS="0xAaa...,0xBbb...,0xCcc..."
///
///   forge script script/CreateBoardDAO.s.sol:CreateBoardDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateBoardDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        address[] memory initialSigners = vm.envAddress("INITIAL_SIGNERS", ",");

        uint16 defaultRequiredApprovals = uint16((initialSigners.length + 1) / 2); // majority, rounded up

        BoardGovernance.BoardGovernanceConfig memory config = BoardGovernance.BoardGovernanceConfig({
            requiredApprovals: uint16(vm.envOr("REQUIRED_APPROVALS", uint256(defaultRequiredApprovals))),
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days)))
        });

        BoardDAOFactory factory = BoardDAOFactory(factoryAddress);

        vm.startBroadcast();

        governance = factory.createDAO(name, config, initialSigners);

        vm.stopBroadcast();

        (, , , , address governanceAddr, address treasury, ) = factory.daos(factory.daoCount());

        console.log("DAO name:          ", name);
        console.log("Governance:        ", governanceAddr);
        console.log("Treasury:          ", treasury);
        console.log("Signer count:      ", initialSigners.length);
        require(governanceAddr == governance, "sanity check failed");
    }
}
