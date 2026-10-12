// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DelegateDAOFactory} from "../src/factory/DelegateDAOFactory.sol";
import {DelegateGovernance} from "../src/governance/delegate/DelegateGovernance.sol";

/// @title CreateDelegateDAO
/// @notice Calls `createDAO` on an already-deployed DelegateDAOFactory.
///         councilSize is derived automatically from INITIAL_COUNCIL's
///         length, rather than being a separately-entered number that
///         could drift out of sync with the actual list.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed DelegateDAOFactory
///   DAO_NAME          - e.g. "Ark DAO"
///   DAO_SYMBOL        - e.g. "ARK"
///   INITIAL_SUPPLY    - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY        - in whole tokens, e.g. 10000000
///   INITIAL_COUNCIL   - comma-separated addresses, e.g. "0xAaa...,0xBbb...,0xCcc..."
///
/// Optional env vars (sensible defaults shown):
///   TERM_LENGTH                     - default 2592000 (seconds, 30 days)
///   CANDIDACY_THRESHOLD             - default 0 (whole tokens)
///   CANDIDACY_PERIOD                - default 50400 (blocks, ~1 week)
///   ELECTION_VOTING_PERIOD          - default 50400 (blocks)
///   COUNCIL_QUORUM                  - default half the council, rounded up
///   COUNCIL_APPROVAL_THRESHOLD_BPS  - default 6000 (60%)
///   VOTING_DELAY                    - default 1 (blocks)
///   VOTING_PERIOD                   - default 50400 (blocks)
///   TIMELOCK_DELAY                  - default 86400 (seconds, 1 day)
///   EXECUTION_PERIOD                - default 604800 (seconds, 7 days)
///   RECALL_QUORUM_BPS               - default 1000 (10% of total supply)
///   RECALL_APPROVAL_THRESHOLD_BPS   - default 6000 (60%)
///   RECALL_VOTING_PERIOD            - default 50400 (blocks)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export DAO_SYMBOL="ARK"
///   export INITIAL_SUPPLY=1000000
///   export MAX_SUPPLY=10000000
///   export INITIAL_COUNCIL="0xAaa...,0xBbb...,0xCcc..."
///
///   forge script script/CreateDelegateDAO.s.sol:CreateDelegateDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateDelegateDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        address[] memory initialCouncil = vm.envAddress("INITIAL_COUNCIL", ",");
        uint16 councilSize = uint16(initialCouncil.length);
        uint16 defaultCouncilQuorum = uint16((councilSize + 1) / 2); // majority, rounded up

        DelegateGovernance.DelegateGovernanceConfig memory config = DelegateGovernance.DelegateGovernanceConfig({
            councilSize: councilSize,
            termLength: uint32(vm.envOr("TERM_LENGTH", uint256(30 days))),
            candidacyThreshold: vm.envOr("CANDIDACY_THRESHOLD", uint256(0)) * 1e18,
            candidacyPeriod: uint32(vm.envOr("CANDIDACY_PERIOD", uint256(50_400))),
            electionVotingPeriod: uint32(vm.envOr("ELECTION_VOTING_PERIOD", uint256(50_400))),
            councilQuorum: uint16(vm.envOr("COUNCIL_QUORUM", uint256(defaultCouncilQuorum))),
            councilApprovalThresholdBps: uint16(vm.envOr("COUNCIL_APPROVAL_THRESHOLD_BPS", uint256(6_000))),
            votingDelay: uint32(vm.envOr("VOTING_DELAY", uint256(1))),
            votingPeriod: uint32(vm.envOr("VOTING_PERIOD", uint256(50_400))),
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days))),
            recallQuorumBps: uint16(vm.envOr("RECALL_QUORUM_BPS", uint256(1_000))),
            recallApprovalThresholdBps: uint16(vm.envOr("RECALL_APPROVAL_THRESHOLD_BPS", uint256(6_000))),
            recallVotingPeriod: uint32(vm.envOr("RECALL_VOTING_PERIOD", uint256(50_400)))
        });

        DelegateDAOFactory factory = DelegateDAOFactory(factoryAddress);

        vm.startBroadcast();

        governance = factory.createDAO(name, symbol, initialSupply, maxSupply, config, initialCouncil);

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
