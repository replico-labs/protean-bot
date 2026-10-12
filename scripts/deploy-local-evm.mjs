#!/usr/bin/env node
/**
 * Deploys all ten governance factories (plus WMON, a stand-in Pyth Entropy,
 * the Entropy randomness adapter, and MockPyth under the price adapter) to
 * a local anvil chain, from Spaces' compiled artifacts, and prints the env
 * lines the bot needs - so scripts/test-evm-models.mjs can run against a
 * throwaway chain first.
 *
 *   anvil --chain-id 10143 --block-time 1
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol)
 *   node scripts/deploy-local-evm.mjs [--spaces ../Spaces] [--rpc http://127.0.0.1:8545] > .env.local-evm
 *
 * The deployer is anvil's first default account unless DEPLOYER_KEY is set.
 * Same deploy order and constructor arguments as Spaces' script/Deploy*.s.sol.
 */
import fs from "fs";
import path from "path";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const spaces = path.resolve(arg("spaces", "../Spaces"));
const rpc = arg("rpc", "http://127.0.0.1:8545");
// anvil's well-known first account - only ever funded on a local chain.
const key = process.env.DEPLOYER_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ transport: http(rpc) });
const chainId = await publicClient.getChainId();
const chain = { id: chainId, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } };
const wallet = createWalletClient({ account, chain, transport: http(rpc) });

function artifact(name, file = `${name}.sol`) {
  const p = path.join(spaces, "out", file, `${name}.json`);
  if (!fs.existsSync(p)) throw new Error(`${p} is missing - build Spaces first (see this script's header).`);
  const json = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}

async function deploy(name, args = [], file) {
  const { abi, bytecode } = artifact(name, file);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Deploying ${name} reverted`);
  return receipt.contractAddress;
}

async function tokenImpls() {
  return [await deploy("GovernanceToken"), await deploy("StakedGovernanceToken"), await deploy("Treasury")];
}

const env = {};
const tokenModel = async (envName, governance, factory) => {
  const [token, staked, treasury] = await tokenImpls();
  env[envName] = await deploy(factory, [token, staked, treasury, await deploy(governance)]);
};

await tokenModel("FACTORY_ADDRESS", "Governance", "DAOFactory");
await tokenModel("QUADRATIC_FACTORY_ADDRESS", "QuadraticGovernance", "QuadraticDAOFactory");
await tokenModel("LIQUID_FACTORY_ADDRESS", "LiquidGovernance", "LiquidDAOFactory");
await tokenModel("OPTIMISTIC_FACTORY_ADDRESS", "OptimisticGovernance", "OptimisticDAOFactory");
await tokenModel("DELEGATE_FACTORY_ADDRESS", "DelegateGovernance", "DelegateDAOFactory");
await tokenModel("SORTITION_FACTORY_ADDRESS", "SortitionGovernance", "SortitionDAOFactory");
await tokenModel("CONVICTION_FACTORY_ADDRESS", "ConvictionGovernance", "ConvictionDAOFactory");
await tokenModel("SOWELLIAN_FACTORY_ADDRESS", "SowellianGovernance", "SowellianDAOFactory");
env.BOARD_FACTORY_ADDRESS = await deploy("BoardDAOFactory", [await deploy("Treasury"), await deploy("BoardGovernance")]);

const wmon = await deploy("WMON");
{
  const [token, staked, treasury] = await tokenImpls();
  const governance = await deploy("DecisionMarketsGovernance");
  const conditionalToken = await deploy("ConditionalToken");
  const conditionalVault = await deploy("ConditionalVault");
  const pair = await deploy("DecisionMarketPair");
  env.DECISION_MARKETS_FACTORY_ADDRESS = await deploy("DecisionMarketsDAOFactory", [token, staked, treasury, governance, wmon, conditionalToken, conditionalVault, pair]);
}

// Pyth Entropy stand-in (Spaces' test/PythAdapters.t.sol): the test script
// reveals its numbers itself, the way Entropy's keeper does on a real chain.
const entropy = await deploy("FeeEntropy", [], "PythAdapters.t.sol");
env.SORTITION_RANDOMNESS_SOURCE = await deploy("PythEntropyRandomnessAdapter", [entropy, 200_000], "PythEntropyRandomnessAdapter.sol");
env.LOCAL_FEE_ENTROPY = entropy;

// Pyth's MockPyth (prices valid an hour, 1 wei per update) under the real
// PythPriceFeedAdapter, for Sowellian's oracle track. A stand-in Hermes has
// to serve its updates (PYTH_HERMES_URL); LOCAL_MOCK_PYTH encodes them.
const mockPyth = await deploy("MockPyth", [3600, 1]);
env.PYTH_PRICE_ADAPTER = await deploy("PythPriceFeedAdapter", [mockPyth], "PythPriceFeedAdapter.sol");
env.LOCAL_MOCK_PYTH = mockPyth;

console.log(`# Local chain ${chainId} at ${rpc}, deployed by ${account.address}`);
console.log(`RPC_URL=${rpc}`);
for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
