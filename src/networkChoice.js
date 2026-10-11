import { ENABLED_NETWORKS, getNetwork, takeNetworkArg } from "./networks.js";
import { SOLANA_ENABLED, SOLANA_NETWORK_IDS, getSolanaNetwork } from "./solana/config.js";

/**
 * Creating a DAO always names its network - the bot never picks one.
 * (Existing chats keep the network they were linked on; this is only for
 * /createdao and /createboarddao.)
 */

/** Network codes the bot accepts for a new DAO: the enabled EVM networks, plus Solana when it's on. */
export function networkCodes() {
  const evm = ENABLED_NETWORKS.map((id) => ({ code: id, name: getNetwork(id).chain.name }));
  const solana = SOLANA_ENABLED ? SOLANA_NETWORK_IDS.map((id) => ({ code: id === "solana-devnet" ? "solana" : id, name: getSolanaNetwork(id).name })) : [];
  return [...evm, ...solana];
}

/** A network code for examples in usage text: the first enabled EVM network. */
export function exampleNetwork() {
  return ENABLED_NETWORKS[0];
}

/** "`monad-testnet` (Monad Testnet), `base-sepolia` (Base Sepolia), `solana` (Solana devnet)". */
export function networkCodesText() {
  return networkCodes()
    .map((n) => `\`${n.code}\` (${n.name})`)
    .join(", ");
}

/** The error shown when a create command names no network. */
export function missingNetworkMessage(example) {
  return [`Which network? Add its code to the command, e.g. \`${example}\`.`, `Networks: ${networkCodesText()}.`].join("\n");
}

/**
 * The EVM network named among `args` (and the args without it). Throws a
 * user-facing error listing the network codes when none is named, or the
 * one named isn't enabled. Solana words never get here: src/solana
 * handles a create command that names one first.
 */
export function requireNetworkArg(args, example) {
  let taken;
  try {
    taken = takeNetworkArg(args, null);
  } catch (err) {
    throw Object.assign(new Error(`${err.message.replace(/ Available:.*$/, "")}\nNetworks: ${networkCodesText()}.`), { userFacing: true });
  }
  if (!taken.network) throw Object.assign(new Error(missingNetworkMessage(example)), { userFacing: true });
  return taken;
}
