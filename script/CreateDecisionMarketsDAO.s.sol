// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DecisionMarketsDAOFactory} from "../src/factory/DecisionMarketsDAOFactory.sol";
import {DecisionMarketsGovernance} from "../src/governance/futarchy/DecisionMarketsGovernance.sol";

/// @title CreateDecisionMarketsDAO
/// @notice Calls `createDAO` on an already-deployed DecisionMarketsDAOFactory.
///         WMON and the shared clone implementations were already fixed
///         at factory-deployment time (see DeployDecisionMarketsDAOFactory.s.sol)
///         and are reused automatically here - nothing further to supply
///         for those.
///
/// Required env vars:
///   FACTORY_ADDRESS   - address of the already-deployed DecisionMarketsDAOFactory
///   DAO_NAME          - e.g. "Ark DAO"
///   DAO_SYMBOL        - e.g. "ARK"
///   INITIAL_SUPPLY    - in whole tokens (18 decimals assumed), e.g. 1000000
///   MAX_SUPPLY        - in whole tokens, e.g. 10000000
///
/// Optional env vars (sensible defaults shown):
///   TRADING_PERIOD    - default 259200 (seconds, 3 days)
///   THRESHOLD_BPS     - default 300 (3% - pass must beat fail's TWAP by this much)
///   TIMELOCK_DELAY    - default 86400 (seconds, 1 day)
///   EXECUTION_PERIOD  - default 604800 (seconds, 7 days)
///
/// Usage:
///   export FACTORY_ADDRESS=0x...
///   export DAO_NAME="Ark DAO"
///   export DAO_SYMBOL="ARK"
///   export INITIAL_SUPPLY=1000000
///   export MAX_SUPPLY=10000000
///
///   forge script script/CreateDecisionMarketsDAO.s.sol:CreateDecisionMarketsDAO \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast
contract CreateDecisionMarketsDAO is Script {
    function run() external returns (address governance) {
        address factoryAddress = vm.envAddress("FACTORY_ADDRESS");
        string memory name = vm.envString("DAO_NAME");
        string memory symbol = vm.envString("DAO_SYMBOL");

        uint256 initialSupply = vm.envUint("INITIAL_SUPPLY") * 1e18;
        uint256 maxSupply = vm.envUint("MAX_SUPPLY") * 1e18;

        DecisionMarketsGovernance.DecisionMarketsConfig memory config = DecisionMarketsGovernance.DecisionMarketsConfig({
            tradingPeriod: uint32(vm.envOr("TRADING_PERIOD", uint256(3 days))),
            thresholdBps: uint16(vm.envOr("THRESHOLD_BPS", uint256(300))),
            timelockDelay: uint32(vm.envOr("TIMELOCK_DELAY", uint256(1 days))),
            executionPeriod: uint32(vm.envOr("EXECUTION_PERIOD", uint256(7 days)))
        });

        DecisionMarketsDAOFactory factory = DecisionMarketsDAOFactory(factoryAddress);

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
        console.log("WMON:              ", factory.wmon());
        require(governanceAddr == governance, "sanity check failed");
    }
}
