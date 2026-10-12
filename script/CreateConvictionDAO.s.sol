// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ConvictionDAOFactory} from "../src/factory/ConvictionDAOFactory.sol";
import {ConvictionGovernance} from "../src/governance/conviction/ConvictionGovernance.sol";

/// @title CreateConvictionDAO
/// @notice Calls `createDAO` on an already-deployed ConvictionDAOFactory.
///         The factory also authorizes the new governance contract as the
///         staking wrapper's locker in the same transaction - nothing
///         extra to configure here for that part.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed ConvictionDAOFactory
///   DAO_NAME          - e.g. "Ark DAO"
///   DAO_SYMBOL        - e.g. "ARK"
///   INITIAL_SUPPLY    - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY        - in whole tokens, e.g. 10000000
///
/// Optional env vars (sensible defaults shown):
///   CONVICTION_GROWTH_RATE     - default 1e15 (conviction units/block, capped at target)
///   MIN_THRESHOLD_CONVICTION   - default 100 (whole-token-equivalent floor)
///   THRESHOLD_MULTIPLIER       - default 10 (additional required conviction per whole token requested)
///   PROPOSAL_THRESHOLD         - default 0 (whole tokens)
///   TIMELOCK_DELAY             - default 86400 (seconds, 1 day)
///   EXECUTION_PERIOD           - default 604800 (seconds, 7 days)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export DAO_SYMBOL="ARK"
///   export INITIAL_SUPPLY=1000000
///   export MAX_SUPPLY=10000000
///
///   forge script script/CreateConvictionDAO.s.sol:CreateConvictionDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateConvictionDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        ConvictionGovernance.ConvictionGovernanceConfig memory config = ConvictionGovernance.ConvictionGovernanceConfig({
            convictionGrowthRate: vm.envOr("CONVICTION_GROWTH_RATE", uint256(1e15)),
            minThresholdConviction: vm.envOr("MIN_THRESHOLD_CONVICTION", uint256(100)) * 1e18,
            thresholdMultiplier: vm.envOr("THRESHOLD_MULTIPLIER", uint256(10)),
            proposalThreshold: vm.envOr("PROPOSAL_THRESHOLD", uint256(0)) * 1e18,
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days)))
        });

        ConvictionDAOFactory factory = ConvictionDAOFactory(factoryAddress);

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
