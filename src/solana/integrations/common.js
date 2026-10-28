import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Shared pieces of the Solana protocol integrations: each protocol module
 * pins its addresses per cluster (from the protocol's own docs or SDK, and
 * checked on-chain by scripts/verify-solana-integrations.mjs) and adds
 * /proposeaction actions whose instructions the treasury signs through the
 * hub.
 */

export const fail = (msg) => {
  throw Object.assign(new Error(msg), { userFacing: true });
};

export function key(text, what) {
  try {
    return new PublicKey(text);
  } catch {
    return fail(`"${text}" isn't a Solana address (${what}).`);
  }
}

/** A protocol's pinned addresses on `network`, as PublicKeys, or a clear refusal. */
export function deployment(protocol, network) {
  const d = protocol.deployments[network.id];
  if (!d) fail(`${protocol.name} isn't available on ${network.name}${Object.keys(protocol.deployments).length ? ` (only ${Object.keys(protocol.deployments).join(", ")})` : ""}.`);
  return Object.fromEntries(Object.entries(d).map(([k, val]) => [k, typeof val === "string" && k !== "symbol" ? new PublicKey(val) : val]));
}

/** Refuses unless `address` is a deployed program on the network (a look-alike or a missing deployment never gets proposed). */
export async function requireProgram(network, address, label) {
  const info = await network.connection.getAccountInfo(address);
  if (!info?.executable) fail(`${label} (\`${address.toBase58()}\`) isn't deployed on ${network.name}.`);
}

/** Refuses unless `address` exists and is owned by `owner`. */
export async function requireOwned(network, address, owner, label) {
  const info = await network.connection.getAccountInfo(address);
  if (!info) fail(`${label} (\`${address.toBase58()}\`) doesn't exist on ${network.name}.`);
  if (!info.owner.equals(owner)) fail(`${label} (\`${address.toBase58()}\`) belongs to ${info.owner.toBase58()}, not ${owner.toBase58()}.`);
  return info;
}

/**
 * An instruction from a @solana/kit-based SDK ({ programAddress, accounts:
 * [{ address, role }], data }) as a web3.js TransactionInstruction, for
 * v.stored. kit's AccountRole: bit 0 writable, bit 1 signer.
 */
export function fromKit(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((a) => ({ pubkey: new PublicKey(a.address), isSigner: Boolean(a.role & 2), isWritable: Boolean(a.role & 1) })),
    data: Buffer.from(ix.data ?? []),
  });
}
