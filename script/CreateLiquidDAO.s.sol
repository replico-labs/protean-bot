// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {LiquidDAOFactory} from "../src/factory/LiquidDAOFactory.sol";
import {LiquidGovernance} from "../src/governance/liquid/LiquidGovernance.sol";

/// @title CreateLiquidDAO
/// @notice Calls `createDAO` on an already-deployed LiquidDAOFactory.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed LiquidDAOFactory
///   DAO_NAME          - e.g. "Ark DAO"
///   DAO_SYMBOL        - e.g. "ARK"
///   INITIAL_SUPPLY    - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY        - in whole tokens, e.g. 10000000
///
/// Optional env vars (sensible defaults shown):
///   QUORUM_BPS              - default 1000  (10%)
///   APPROVAL_THRESHOLD_BPS  - default 6000  (60%)
///   VOTING_DELAY            - default 1     (blocks)
///   VOTING_PERIOD           - default 50400 (blocks, ~1 week)
///   TIMELOCK_DELAY          - default 86400 (seconds, 1 day)
///   EXECUTION_PERIOD        - default 604800 (seconds, 7 days)
///   PROPOSAL_THRESHOLD      - default 0 (whole tokens)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export DAO_SYMBOL="ARK"
///   export INITIAL_SUPPLY=1000000
///   export MAX_SUPPLY=10000000
///
///   forge script script/CreateLiquidDAO.s.sol:CreateLiquidDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateLiquidDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        LiquidGovernance.LiquidGovernanceConfig memory config = LiquidGovernance.LiquidGovernanceConfig({
            quorumBps: uint16(vm.envOr("QUORUM_BPS", uint256(1_000))),
            approvalThresholdBps: uint16(vm.envOr("APPROVAL_THRESHOLD_BPS", uint256(6_000))),
            votingDelay: uint32(vm.envOr("VOTING_DELAY", uint256(1))),
            votingPeriod: uint32(vm.envOr("VOTING_PERIOD", uint256(50_400))),
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days))),
            proposalThreshold: vm.envOr("PROPOSAL_THRESHOLD", uint256(0)) * 1e18
        });

        LiquidDAOFactory factory = LiquidDAOFactory(factoryAddress);

        vm.startBroadcast();

        governance = factory.createDAO(name, symbol, initialSupply, maxSupply, config);

        vm.stopBroadcast();

        (, , address governanceToken, address underlyingToken, address governanceAddr, address treasury, ) =
            factory.daos(factory.daoCount());

        console.log("DAO name:          ", name);
        console.log("Governance:        ", governanceAddr);
        console.log("GovernanceToken:   ", governanceToken);
        console.log("UnderlyingToken:   ", underlyingToken);
        console.log("Treasury:          ", treasury);
        require(governanceAddr == governance, "sanity check failed");
    }
}
