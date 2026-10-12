// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SortitionDAOFactory} from "../src/factory/SortitionDAOFactory.sol";
import {SortitionGovernance} from "../src/governance/sortition/SortitionGovernance.sol";

/// @title CreateSortitionDAO
/// @notice Calls `createDAO` on an already-deployed SortitionDAOFactory.
///         RANDOMNESS_SOURCE must point at a real, already-deployed
///         IRandomnessSource implementation (the chain's
///         PythEntropyRandomnessAdapter, from DeployPythEntropyAdapter) configured
///         for the target chain - there is no sensible default for this,
///         and the factory deliberately does not supply one itself.
///         councilSize is derived automatically from the initial
///         council's length, same pattern as CreateDelegateDAO. This is
///         the starting/bootstrap council only - the separate opt-in
///         eligible pool that future random draws pull from is built up
///         later, through the deployed contract itself, not here.
///
/// Required env vars:
///   FACTORY_ADDRESS     - address of the already-deployed SortitionDAOFactory
///   DAO_NAME            - e.g. "Ark DAO"
///   DAO_SYMBOL          - e.g. "ARK"
///   INITIAL_SUPPLY      - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY          - in whole tokens, e.g. 10000000
///   RANDOMNESS_SOURCE   - address of an already-deployed IRandomnessSource
///   INITIAL_COUNCIL     - comma-separated addresses, e.g. "0xAaa...,0xBbb...,0xCcc..."
///
/// Optional env vars (sensible defaults shown):
///   TERM_LENGTH                     - default 2592000 (seconds, 30 days)
///   ELIGIBILITY_THRESHOLD           - default 0 (whole tokens, min staked balance to register)
///   COUNCIL_QUORUM                  - default: majority of council, rounded up
///   COUNCIL_APPROVAL_THRESHOLD_BPS  - default 6000 (60%)
///   VOTING_DELAY                    - default 1 (blocks)
///   VOTING_PERIOD                   - default 50400 (blocks)
///   TIMELOCK_DELAY                  - default 86400 (seconds, 1 day)
///   EXECUTION_PERIOD                - default 604800 (seconds, 7 days)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export DAO_SYMBOL="ARK"
///   export INITIAL_SUPPLY=1000000
///   export MAX_SUPPLY=10000000
///   export RANDOMNESS_SOURCE=0x...
///   export INITIAL_COUNCIL="0xAaa...,0xBbb...,0xCcc..."
///
///   forge script script/CreateSortitionDAO.s.sol:CreateSortitionDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateSortitionDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        address randomnessSource = vm.envAddress("RANDOMNESS_SOURCE");
        address[] memory initialCouncil = vm.envAddress("INITIAL_COUNCIL", ",");
        uint16 councilSize = uint16(initialCouncil.length);
        uint16 defaultCouncilQuorum = uint16((councilSize + 1) / 2);

        SortitionGovernance.SortitionGovernanceConfig memory config = SortitionGovernance.SortitionGovernanceConfig({
            councilSize: councilSize,
            termLength: uint32(vm.envOr("TERM_LENGTH", uint256(30 days))),
            eligibilityThreshold: vm.envOr("ELIGIBILITY_THRESHOLD", uint256(0)) * 1e18,
            councilQuorum: uint16(vm.envOr("COUNCIL_QUORUM", uint256(defaultCouncilQuorum))),
            councilApprovalThresholdBps: uint16(vm.envOr("COUNCIL_APPROVAL_THRESHOLD_BPS", uint256(6_000))),
            votingDelay: uint32(vm.envOr("VOTING_DELAY", uint256(1))),
            votingPeriod: uint32(vm.envOr("VOTING_PERIOD", uint256(50_400))),
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days)))
        });

        SortitionDAOFactory factory = SortitionDAOFactory(factoryAddress);

        vm.startBroadcast();

        governance = factory.createDAO(name, symbol, initialSupply, maxSupply, randomnessSource, config, initialCouncil);

        vm.stopBroadcast();

        (, , address governanceToken, address underlyingToken, address governanceAddr, address treasury, ) =
            factory.daos(factory.daoCount());

        console.log("DAO name:          ", name);
        console.log("Governance:        ", governanceAddr);
        console.log("GovernanceToken:   ", governanceToken);
        console.log("UnderlyingToken:   ", underlyingToken);
        console.log("Treasury:          ", treasury);
        console.log("Council size:      ", councilSize);
        require(governanceAddr == governance, "sanity check failed");
    }
}
