// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PythEntropyRandomnessAdapter} from "../src/randomness/PythEntropyRandomnessAdapter.sol";

/// @title DeployPythEntropyAdapter
/// @notice Deploys the randomness source Sortition DAOs on this chain use.
///         One per network; every Sortition DAO shares it (each DAO's fee
///         credit is kept separately).
///
/// Required env vars:
///   PYTH_ENTROPY_ADDRESS        - Pyth's Entropy contract on this chain, copied
///                                  from docs.pyth.network/entropy/contract-addresses
///                                  (the constructor rejects anything that isn't one)
///
/// Optional env vars:
///   ENTROPY_CALLBACK_GAS_LIMIT  - callback gas, default 0 = the provider's default
///
/// Usage:
///   export PYTH_ENTROPY_ADDRESS=0x...
///   forge script script/DeployPythEntropyAdapter.s.sol:DeployPythEntropyAdapter \
///     --rpc-url https://testnet-rpc.monad.xyz --account monad-deployer --broadcast
///
/// Then set the bot's SORTITION_RANDOMNESS_SOURCE (or BASE_/HYPEREVM_ prefixed)
/// to the printed address.
contract DeployPythEntropyAdapter is Script {
    function run() external returns (PythEntropyRandomnessAdapter adapter) {
        address entropy = vm.envAddress("PYTH_ENTROPY_ADDRESS");
        uint32 gasLimit = uint32(vm.envOr("ENTROPY_CALLBACK_GAS_LIMIT", uint256(0)));

        vm.startBroadcast();
        adapter = new PythEntropyRandomnessAdapter(entropy, gasLimit);
        vm.stopBroadcast();

        console.log("PythEntropyRandomnessAdapter deployed at:", address(adapter));
        console.log("Current fee per request (wei):", adapter.requestFee());
    }
}
