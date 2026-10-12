// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {DecisionMarketsDAOFactory} from "../src/factory/DecisionMarketsDAOFactory.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {DecisionMarketsGovernance} from "../src/governance/futarchy/DecisionMarketsGovernance.sol";
import {ConditionalToken} from "../src/governance/futarchy/ConditionalToken.sol";
import {ConditionalVault} from "../src/governance/futarchy/ConditionalVault.sol";
import {DecisionMarketPair} from "../src/governance/futarchy/DecisionMarketPair.sol";

/// @title DeployDecisionMarketsDAOFactory
/// @notice Deploys all eight clone implementations this model needs - the
///         four standard ones (GovernanceToken, StakedGovernanceToken,
///         Treasury, DecisionMarketsGovernance) plus the three futarchy-
///         specific ones (ConditionalToken, ConditionalVault,
///         DecisionMarketPair) that DecisionMarketsGovernance itself
///         clones per-proposal - and then DecisionMarketsDAOFactory
///         itself, wired to all eight plus the chain's canonical WMON.
/// @dev Two-step deployment - see DeployDAOFactory.s.sol's own notes for
///      why. This factory previously deployed the three futarchy-
///      specific implementations from inside its OWN constructor, which
///      does not solve the bytecode-embedding problem either - made this
///      factory the worst offender of all ten in this system (99,290
///      bytes) for exactly that reason. All eight implementations must
///      now be deployed here, separately, before the factory.
///      IMPORTANT, two separate --via-ir requirements: (1)
///      DecisionMarketsDAOFactory's own createDAO() function hits a
///      genuine "stack too deep" compiler error without --via-ir - a
///      hard compile failure, meaning this whole script cannot even
///      compile without it; (2) once fixed, the factory itself deploys
///      tiny (4,490 bytes) - no separate concern for
///      DecisionMarketsGovernance's own standalone size the way Delegate/
///      Sortition/Sowellian have, since it compiles under the limit
///      (23,827 bytes) without --via-ir on its own. --via-ir is still
///      required for this whole script to compile at all, because of (1).
///
/// Required env vars:
///   WMON_ADDRESS - address of the chain's canonical Wrapped MON contract
///
/// Usage:
///   export WMON_ADDRESS=0x...
///   forge script script/DeployDecisionMarketsDAOFactory.s.sol:DeployDecisionMarketsDAOFactory \
///     --rpc-url <RPC_URL> \
///     --private-key $PRIVATE_KEY \
///     --broadcast \
///     --via-ir \
///     --verify
contract DeployDecisionMarketsDAOFactory is Script {
    function run() external returns (DecisionMarketsDAOFactory factory) {
        address wmon = vm.envAddress("WMON_ADDRESS");

        vm.startBroadcast();

        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        DecisionMarketsGovernance decisionMarketsGovernanceImplementation = new DecisionMarketsGovernance();

        ConditionalToken conditionalTokenImplementation = new ConditionalToken();
        ConditionalVault conditionalVaultImplementation = new ConditionalVault();
        DecisionMarketPair decisionMarketPairImplementation = new DecisionMarketPair();

        factory = new DecisionMarketsDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(decisionMarketsGovernanceImplementation),
            wmon,
            address(conditionalTokenImplementation),
            address(conditionalVaultImplementation),
            address(decisionMarketPairImplementation)
        );

        vm.stopBroadcast();

        console.log("GovernanceToken implementation deployed at:", address(governanceTokenImplementation));
        console.log("StakedGovernanceToken implementation deployed at:", address(stakedGovernanceTokenImplementation));
        console.log("Treasury implementation deployed at:", address(treasuryImplementation));
        console.log("DecisionMarketsGovernance implementation deployed at:", address(decisionMarketsGovernanceImplementation));
        console.log("ConditionalToken implementation deployed at:", address(conditionalTokenImplementation));
        console.log("ConditionalVault implementation deployed at:", address(conditionalVaultImplementation));
        console.log("DecisionMarketPair implementation deployed at:", address(decisionMarketPairImplementation));
        console.log("DecisionMarketsDAOFactory deployed at:", address(factory));
    }
}
