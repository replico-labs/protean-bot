// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {WelcomeDistributor} from "../src/distribution/WelcomeDistributor.sol";

/// @title DeployWelcomeDistributor
/// @notice Deploys a WelcomeDistributor for an existing DAO. Run this once
///         per DAO that wants automatic new-member token distribution -
///         it's optional, not part of DeployDAOFactory/CreateDAO.
///
/// Required env vars:
///   TOKEN_ADDRESS         - the DAO's raw GovernanceToken (the
///                            underlyingToken from CreateDAO's output, NOT
///                            the staking wrapper)
///   GOVERNANCE_ADDRESS    - the DAO's Governance contract (admin control)
///   OPERATOR_ADDRESS      - the bot's operator wallet, authorized to call
///                            distribute()
///
/// Optional env vars:
///   AMOUNT_PER_CLAIM      - whole tokens per new member, default 100
///   DISTRIBUTION_CAP      - whole tokens total budget, default 10000
///
/// Usage:
///   export TOKEN_ADDRESS=0x...
///   export GOVERNANCE_ADDRESS=0x...
///   export OPERATOR_ADDRESS=0x...
///
///   forge script script/DeployWelcomeDistributor.s.sol:DeployWelcomeDistributor \
///     --rpc-url https://testnet-rpc.monad.xyz \
///     --account monad-deployer \
///     --broadcast
///
/// After deploying, fund it with a plain token transfer - no governance
/// proposal required:
///   cast send <TOKEN_ADDRESS> "transfer(address,uint256)" <DISTRIBUTOR_ADDRESS> <AMOUNT> \
///     --rpc-url https://testnet-rpc.monad.xyz --account monad-deployer
contract DeployWelcomeDistributor is Script {
    function run() external returns (WelcomeDistributor distributor) {
        address token = vm.envAddress("TOKEN_ADDRESS");
        address governance = vm.envAddress("GOVERNANCE_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");

        uint256 amountPerClaim = vm.envOr("AMOUNT_PER_CLAIM", uint256(100)) * 1e18;
        uint256 distributionCap = vm.envOr("DISTRIBUTION_CAP", uint256(10_000)) * 1e18;

        vm.startBroadcast();

        distributor = new WelcomeDistributor(
            token,
            governance,
            operator,
            amountPerClaim,
            distributionCap
        );

        vm.stopBroadcast();

        console.log("WelcomeDistributor deployed at:", address(distributor));
        console.log("Fund it with a transfer of the raw token to this address.");
    }
}
