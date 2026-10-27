import { PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { FILL_IDL, getSolanaOperator } from "./config.js";

const { AnchorProvider, Program, BN } = anchor;

/**
 * Vortexes' fill program (Vortexes programs/fill): how a DAO swaps without
 * calling a router from a proposal. A passed proposal opens an order (the
 * treasury's `amount` of one token for at least `min_out` of another, by a
 * deadline); a keeper fills it in its own transaction (take, swap, settle),
 * which only lands if the minimum reached the order's output vault, and
 * the output goes to the treasury. Past the deadline anyone can cancel it,
 * returning the input. The keeper is src/solana/fillKeeper.js.
 *
 * Only where the network sets its program (network.fillProgram).
 */

export const ORDER_SEED = "order";
// The Order account: 8-byte discriminator, then `owner` (memcmp offset for listing a treasury's orders).
const OWNER_OFFSET = 8;

const programs = new WeakMap();

/** The fill program's Anchor client on `network`. */
export function fillProgram(network) {
  if (!network.fillProgram) throw Object.assign(new Error(`Swaps aren't available on ${network.name} yet (Vortexes' fill program isn't set: ${network.envPrefix}_FILL_PROGRAM_ID).`), { userFacing: true });
  if (programs.has(network)) return programs.get(network);
  const wallet = {
    publicKey: getSolanaOperator()?.publicKey ?? PublicKey.default,
    signTransaction: () => Promise.reject(new Error("not used")),
    signAllTransactions: () => Promise.reject(new Error("not used")),
  };
  const program = new Program({ ...FILL_IDL, address: network.fillProgram.toBase58() }, new AnchorProvider(network.connection, wallet, { commitment: "confirmed" }));
  programs.set(network, program);
  return program;
}

const u64le = (n) => new BN(n.toString()).toArrayLike(Buffer, "le", 8);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/** An order's address and its two vaults. */
export function orderAddresses(network, owner, id) {
  const programId = network.fillProgram;
  const order = pda([Buffer.from(ORDER_SEED), owner.toBuffer(), u64le(id)], programId);
  return {
    order,
    inputVault: pda([Buffer.from("input"), order.toBuffer()], programId),
    outputVault: pda([Buffer.from("output"), order.toBuffer()], programId),
  };
}

/** A fresh order id: random, so two proposals written at once don't collide. */
export function newOrderId() {
  return BigInt.asUintN(64, BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`));
}

/**
 * The treasury opens an order: `amount` of `mintIn` from `source` for at
 * least `minOut` of `mintOut` into `receive`, until `deadline` (unix
 * seconds). The treasury signs (through the hub) and pays the rent.
 */
export async function openOrderIx(network, { owner, id, mintIn, mintOut, tokenProgramIn, tokenProgramOut, source, receive, amount, minOut, deadline }) {
  const a = orderAddresses(network, owner, id);
  return fillProgram(network)
    .methods.openOrder(new BN(id.toString()), new BN(amount.toString()), new BN(minOut.toString()), new BN(deadline))
    .accountsStrict({ owner, mintIn, mintOut, source, receive, order: a.order, inputVault: a.inputVault, outputVault: a.outputVault, tokenProgramIn, tokenProgramOut, systemProgram: SystemProgram.programId })
    .instruction();
}

/** Accounts settle and cancel share, from an order account. */
function closing(network, orderKey, o, programs) {
  const a = orderAddresses(network, o.owner, o.id);
  return {
    order: orderKey,
    owner: o.owner,
    inputVault: a.inputVault,
    outputVault: a.outputVault,
    mintIn: o.mintIn,
    mintOut: o.mintOut,
    refund: o.refund,
    receive: o.receive,
    tokenProgramIn: programs.in,
    tokenProgramOut: programs.out,
  };
}

/** The keeper takes the order's input into `keeperAccount`. */
export async function takeIx(network, orderKey, o, keeper, keeperAccount, tokenProgramIn) {
  const a = orderAddresses(network, o.owner, o.id);
  return fillProgram(network)
    .methods.take()
    .accountsStrict({ keeper, order: orderKey, inputVault: a.inputVault, outputVault: a.outputVault, mintIn: o.mintIn, keeperAccount, tokenProgramIn, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
}

/** Ends a fill: checks the minimum arrived and pays the treasury. `programs` = { in, out } token programs. */
export async function settleIx(network, orderKey, o, programs) {
  return fillProgram(network).methods.settle().accountsStrict(closing(network, orderKey, o, programs)).instruction();
}

/** Cancels an order: the owner any time (a proposal), anyone past its deadline. */
export async function cancelIx(network, orderKey, o, caller, programs) {
  return fillProgram(network)
    .methods.cancel()
    .accountsStrict({ caller, ...closing(network, orderKey, o, programs) })
    .instruction();
}

/** One order, decoded ({ owner, id, mintIn, mintOut, amountIn, minOut, deadline, refund, receive, ... }), or null. */
export async function readOrder(network, orderKey) {
  return fillProgram(network).account.order.fetchNullable(orderKey);
}

/** Every open order, or only `owner`'s: [{ publicKey, account }]. */
export async function listOrders(network, owner) {
  const filters = owner ? [{ memcmp: { offset: OWNER_OFFSET, bytes: owner.toBase58() } }] : [];
  return fillProgram(network).account.order.all(filters);
}
