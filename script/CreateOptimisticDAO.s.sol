// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {OptimisticDAOFactory} from "../src/factory/OptimisticDAOFactory.sol";
import {OptimisticGovernance} from "../src/governance/optimistic/OptimisticGovernance.sol";

/// @title CreateOptimisticDAO
/// @notice Calls `createDAO` on an already-deployed OptimisticDAOFactory.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed OptimisticDAOFactory
///   DAO_NAME          - e.g. "Ark DAO"
///   DAO_SYMBOL        - e.g. "ARK"
///   INITIAL_SUPPLY    - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY        - in whole tokens, e.g. 10000000
///
/// Optional env vars (sensible defaults shown):
///   CHALLENGE_PERIOD        - default 50400 (blocks, ~1 week)
///   CHALLENGE_BOND          - default 100 (whole tokens, required to challenge)
///   QUORUM_BPS              - default 1000  (10%, used only if challenged)
///   APPROVAL_THRESHOLD_BPS  - default 6000  (60%, used only if challenged)
///   VOTING_PERIOD           - default 50400 (blocks, used only if challenged)
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
///   forge script script/CreateOptimisticDAO.s.sol:CreateOptimisticDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateOptimisticDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        OptimisticGovernance.OptimisticGovernanceConfig memory config = OptimisticGovernance.OptimisticGovernanceConfig({
            challengePeriod: uint32(vm.envOr("CHALLENGE_PERIOD", uint256(50_400))),
            challengeBond: vm.envOr("CHALLENGE_BOND", uint256(100)) * 1e18,
            quorumBps: uint16(vm.envOr("QUORUM_BPS", uint256(1_000))),
            approvalThresholdBps: uint16(vm.envOr("APPROVAL_THRESHOLD_BPS", uint256(6_000))),
            votingPeriod: uint32(vm.envOr("VOTING_PERIOD", uint256(50_400))),
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days))),
            proposalThreshold: vm.envOr("PROPOSAL_THRESHOLD", uint256(0)) * 1e18
        });

        OptimisticDAOFactory factory = OptimisticDAOFactory(factoryAddress);

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
