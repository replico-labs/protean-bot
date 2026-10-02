import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { fitGasLimit, contractTx } from "../gasLimit.js";
import { sepolia } from "viem/chains";
import { SepoliaConfig } from "@zama-fhe/relayer-sdk/node";

/**
 * Opportunity Markets targets Ethereum Sepolia, not Monad - Zama's FHE
 * coprocessor infrastructure is only genuinely deployed there (and on
 * Ethereum mainnet) as of this writing, confirmed directly from Zama's
 * own docs, not assumed. This whole folder is deliberately self-
 * contained and never imports from the main src/config.js, since that
 * file is Monad-specific throughout.
 */

const SEPOLIA_RPC_URL = process.env.OPPORTUNITY_MARKET_RPC_URL || sepolia.rpcUrls.default.http[0];

export const opportunityMarketChain = sepolia;

export const opportunityPublicClient = createPublicClient({
  chain: opportunityMarketChain,
  transport: http(SEPOLIA_RPC_URL),
});

/**
 * Sepolia counterpart to contracts.js's walletClientFor - same pattern,
 * different chain. Opportunity Market's every write action needs a
 * client built against opportunityMarketChain (Sepolia) specifically,
 * not monadTestnet, since it's a genuinely separate network from
 * everything else this bot does. This was called throughout index.js's
 * Opportunity Market commands but never actually defined here - the
 * cause of a hard crash on startup (a named import that doesn't exist
 * is a SyntaxError in ESM, not a runtime error, so it took the whole
 * process down immediately rather than failing only when a command
 * that needed it was actually used).
 */
export function opportunityWalletClientFor(account) {
  return createWalletClient({ account, chain: opportunityMarketChain, transport: http(SEPOLIA_RPC_URL) });
}

/**
 * DELIBERATELY sourced from the installed @zama-fhe/relayer-sdk package
 * itself (SepoliaConfig), not hand-copied from documentation - a real,
 * concrete lesson learned while building this: values transcribed from
 * Zama's own docs page (dated Dec 2025) turned out to already differ
 * from this package's actual current constant (v0.4.4, confirmed by
 * inspecting it directly) - different ACL/KMS/input-verifier addresses,
 * a different gateway chain id, even a different relayer URL. Importing
 * the package's own export instead means this always matches whatever
 * that package version considers current, and simply stays correct
 * across `npm update` rather than needing to be manually re-verified
 * and edited by hand again later.
 */
export const ZAMA_FHE_CONFIG = {
  ...SepoliaConfig,
  network: SEPOLIA_RPC_URL,
};

export function isOpportunityMarketConfigured() {
  return Boolean(SEPOLIA_RPC_URL);
}

/** A refusal shown to the user as is (no Sepolia ETH for gas, etc.). */
export class SepoliaGasError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

/**
 * Sepolia gas isn't sponsored, so the wallet pays its own: check it can
 * before signing, so an empty wallet gets a reason and its address
 * instead of a node error.
 */
export async function requireSepoliaGas(address, gas, value = 0n) {
  const [fees, balance] = await Promise.all([
    opportunityPublicClient.estimateFeesPerGas(),
    opportunityPublicClient.getBalance({ address, blockTag: "latest" }),
  ]);
  const need = gas * fees.maxFeePerGas + value;
  if (balance < need) {
    throw new SepoliaGasError(
      `Your wallet has ${formatEther(balance)} Sepolia ETH and this needs up to ${formatEther(need)} (Sepolia gas isn't sponsored). ` +
        `Send some Sepolia ETH to ${address} and try again.`
    );
  }
  return fees;
}

/**
 * Sepolia-side equivalent of the main config.js's writeWithGasBuffer -
 * can't reuse that one directly, since it's bound to Monad's
 * publicClient, not this file's own opportunityPublicClient. Same gas
 * limit rule (gasLimit.js): what the call really uses plus 15-20%,
 * proven by simulating at that limit.
 */
const unaffordable = (err) => /insufficient funds|exceeds the balance|exceeds allowance|insufficient balance/i.test(`${err.shortMessage || ""} ${err.details || ""} ${err.message}`);

/** The node's estimate; a wallet too empty to even estimate gets the same clear message as requireSepoliaGas. */
async function estimateOrExplain(address, estimateFn) {
  try {
    return await estimateFn();
  } catch (err) {
    if (unaffordable(err)) await requireSepoliaGas(address, 100_000n);
    throw err;
  }
}

export async function writeWithGasBuffer(client, contractParams) {
  const params = { ...contractParams, account: client.account };
  const estimate = await estimateOrExplain(client.account.address, () => opportunityPublicClient.estimateContractGas(params));
  const gas = await fitGasLimit(opportunityPublicClient, contractTx(client.account, contractParams), estimate);
  const fees = await requireSepoliaGas(client.account.address, gas, contractParams.value ?? 0n);
  return client.writeContract({ ...contractParams, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
}

/** Sends Sepolia ETH with the same proven gas limit and up-front balance check. */
export async function sendNativeWithGasLimit(client, to, value) {
  const tx = { account: client.account, to, value };
  const estimate = await estimateOrExplain(client.account.address, () => opportunityPublicClient.estimateGas(tx));
  const gas = await fitGasLimit(opportunityPublicClient, tx, estimate);
  const fees = await requireSepoliaGas(client.account.address, gas, value);
  return client.sendTransaction({ to, value, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
}
