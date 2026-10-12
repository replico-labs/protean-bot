// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PythPriceFeedAdapter} from "../src/oracles/PythPriceFeedAdapter.sol";

/// @title DeployPythPriceFeedAdapter
/// @notice Deploys the oracle Sowellian proposals on this chain resolve
///         against. One per network serves every Pyth feed: a proposal's
///         oracleSelector is the Pyth price feed ID.
///
/// Required env vars:
///   PYTH_ADDRESS - Pyth's price feed contract on this chain, copied from
///                  docs.pyth.network/price-feeds/contract-addresses/evm
///                  (the constructor rejects anything that isn't one)
///
/// Usage:
///   export PYTH_ADDRESS=0x...
///   forge script script/DeployPythPriceFeedAdapter.s.sol:DeployPythPriceFeedAdapter \
///     --rpc-url https://testnet-rpc.monad.xyz --account monad-deployer --broadcast
///
/// Then set the bot's PYTH_PRICE_ADAPTER (or BASE_/HYPEREVM_ prefixed) to the
/// printed address, and PYTH_ADDRESS to the Pyth contract itself.
contract DeployPythPriceFeedAdapter is Script {
    function run() external returns (PythPriceFeedAdapter adapter) {
        address pyth = vm.envAddress("PYTH_ADDRESS");

        vm.startBroadcast();
        adapter = new PythPriceFeedAdapter(pyth);
        vm.stopBroadcast();

        console.log("PythPriceFeedAdapter deployed at:", address(adapter));
    }
}
