// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SowellianDAOFactory} from "../src/factory/SowellianDAOFactory.sol";
import {SowellianGovernance} from "../src/governance/sowellian/SowellianGovernance.sol";

/// @title CreateSowellianDAO
/// @notice Calls `createDAO` on an already-deployed SowellianDAOFactory.
///         Which oracle a proposal resolves against (if any) is chosen
///         per-proposal, through the deployed governance contract's own
///         propose() call - nothing oracle-specific is configured here.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed SowellianDAOFactory
///   DAO_NAME          - e.g. "Ark DAO"
///   DAO_SYMBOL        - e.g. "ARK"
///   INITIAL_SUPPLY    - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY        - in whole tokens, e.g. 10000000
///
/// Optional env vars (sensible defaults shown):
///   PROPOSAL_BOND_AMOUNT           - default 100 (whole tokens)
///   APPROVAL_VOTING_DELAY          - default 1 (blocks)
///   APPROVAL_VOTING_PERIOD         - default 50400 (blocks, ~1 week)
///   APPROVAL_QUORUM_BPS            - default 1000 (10%)
///   APPROVAL_THRESHOLD_BPS         - default 6000 (60%)
///   POSITIONS_WINDOW               - default 604800 (seconds, 7 days)
///   EXECUTION_TIMELOCK_DELAY       - default 86400 (seconds, 1 day)
///   RESOLUTION_BOND_AMOUNT         - default 100 (whole tokens)
///   CHALLENGE_PERIOD               - default 259200 (seconds, 3 days)
///   CHALLENGE_BOND_AMOUNT          - default 100 (whole tokens)
///   ADJUDICATION_VOTING_PERIOD     - default 50400 (blocks)
///   ADJUDICATION_QUORUM_BPS        - default 1000 (10%)
///   ADJUDICATION_THRESHOLD_BPS     - default 6000 (60%)
///   MAX_ORACLE_STALENESS           - default 3600 (seconds, 1 hour)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export DAO_SYMBOL="ARK"
///   export INITIAL_SUPPLY=1000000
///   export MAX_SUPPLY=10000000
///
///   forge script script/CreateSowellianDAO.s.sol:CreateSowellianDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateSowellianDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        SowellianGovernance.SowellianConfig memory config = SowellianGovernance.SowellianConfig({
            proposalBondAmount: vm.envOr("PROPOSAL_BOND_AMOUNT", uint256(100)) * 1e18,
            approvalVotingDelay: uint32(vm.envOr("APPROVAL_VOTING_DELAY", uint256(1))),
            approvalVotingPeriod: uint32(vm.envOr("APPROVAL_VOTING_PERIOD", uint256(50_400))),
            approvalQuorumBps: uint16(vm.envOr("APPROVAL_QUORUM_BPS", uint256(1_000))),
            approvalThresholdBps: uint16(vm.envOr("APPROVAL_THRESHOLD_BPS", uint256(6_000))),
            positionsWindow: uint32(vm.envOr("POSITIONS_WINDOW", uint256(7 days))),
            executionTimelockDelay: uint32(vm.envOr("EXECUTION_TIMELOCK_DELAY", uint256(1 days))),
            resolutionBondAmount: vm.envOr("RESOLUTION_BOND_AMOUNT", uint256(100)) * 1e18,
            challengePeriod: uint32(vm.envOr("CHALLENGE_PERIOD", uint256(3 days))),
            challengeBondAmount: vm.envOr("CHALLENGE_BOND_AMOUNT", uint256(100)) * 1e18,
            adjudicationVotingPeriod: uint32(vm.envOr("ADJUDICATION_VOTING_PERIOD", uint256(50_400))),
            adjudicationQuorumBps: uint16(vm.envOr("ADJUDICATION_QUORUM_BPS", uint256(1_000))),
            adjudicationThresholdBps: uint16(vm.envOr("ADJUDICATION_THRESHOLD_BPS", uint256(6_000))),
            maxOracleStaleness: uint32(vm.envOr("MAX_ORACLE_STALENESS", uint256(1 hours)))
        });

        SowellianDAOFactory factory = SowellianDAOFactory(factoryAddress);

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
