import { erc20Abi, getAddress } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import { IntegrationError, requireCode } from "./common.js";
import { makeAaveModule } from "./aaveV3.js";

/**
 * HyperLend Core (HyperEVM) - an Aave v3.6 fork, driven by the same
 * supply/withdraw/borrow/repay/collateral actions as Aave (its Pool
 * signatures were checked against hyperlend-core's IPool).
 *
 * Only one address is pinned: the PoolAddressesProviderRegistry. HyperLend
 * publishes no address list this environment could reach, so it comes from
 * DefiLlama's Aave-fork registry (third-party - hence the warning). The Pool
 * and its reserves are read from the chain through the standard Aave chain
 * registry -> provider -> getPool() -> getReservesList() at build time, so
 * nothing else is hand-copied. `npm run verify:integrations` checks the
 * chain end to end. Reserves are named by their on-chain symbol; HYPE
 * itself isn't wrapped automatically - supply WHYPE.
 */

const ABIS = loadIntegrationAbi("hyperlend");
const AAVE = loadIntegrationAbi("aaveV3");

const deployments = {
  hyperevm: {
    registry: "0x24e301bcba5c098b3b41ea61a52bfe95cb728b20",
    sources: ["DefiLlama/DefiLlama-Adapters registries/aave.js ('hyperlend' -> hyperliquid addressesProviderRegistry)"],
    warning: "HyperLend's registry address is from DefiLlama, not a HyperLend source - run verify:integrations before relying on it.",
  },
};

async function market(publicClient, registry) {
  const providers = await publicClient.readContract({ address: registry, abi: ABIS.registry, functionName: "getAddressesProvidersList" });
  if (providers.length !== 1) {
    throw new IntegrationError(`HyperLend's registry lists ${providers.length} markets; the bot expects exactly one (Core) - pin the one to use before proposing.`);
  }
  const addressesProvider = getAddress(providers[0]);
  const pool = getAddress(await publicClient.readContract({ address: addressesProvider, abi: AAVE.addressesProvider, functionName: "getPool" }));
  return { addressesProvider, pool };
}

async function resolve(ctx, d) {
  await requireCode(ctx, { "HyperLend registry": d.registry });
  const { addressesProvider, pool } = await market(ctx.publicClient, d.registry);
  await requireCode(ctx, { "HyperLend Pool": pool });
  const reserves = await ctx.publicClient.readContract({ address: pool, abi: ABIS.pool, functionName: "getReservesList" });
  const tokens = {};
  for (const asset of reserves) {
    const symbol = await ctx.publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }).catch(() => null);
    if (symbol) tokens[symbol] = getAddress(asset);
  }
  return { ...d, addressesProvider, pool, tokens };
}

/** verify-integrations: one market in the registry, and its Pool points back at its provider. */
export async function verify(publicClient, d) {
  const { addressesProvider, pool } = await market(publicClient, getAddress(d.registry));
  const code = await publicClient.getCode({ address: pool });
  if (!code || code === "0x") return [`Pool ${pool} has no code`];
  const back = getAddress(await publicClient.readContract({ address: pool, abi: AAVE.pool, functionName: "ADDRESSES_PROVIDER" }));
  return back === addressesProvider ? [] : [`Pool.ADDRESSES_PROVIDER() is ${back}, expected ${addressesProvider}`];
}

const hyperlend = makeAaveModule({ id: "hyperlend", name: "HyperLend", prefix: "hyperlend", deployments, resolve });

export const protocol = hyperlend.protocol;
export const actions = hyperlend.actions;
