import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import { getAllSolanaChats } from "../db.js";
import { SOLANA_ENABLED, SOLANA_NETWORK_IDS, getSolanaNetwork, getSolanaOperator, explorerUrl } from "./config.js";
import * as v from "./vortex.js";
import * as fill from "./fill.js";
import * as jupiter from "./jupiterApi.js";
import { link } from "../links.js";

/**
 * The fill keeper: fills DAOs' swap orders (Vortexes' fill program,
 * src/solana/fill.js) through Jupiter, and cancels expired ones so their
 * tokens go back to the treasury. Runs on networks that set
 * <PREFIX>_FILL_KEEPER=true, paying fees with the operator key.
 *
 * Each poll quotes every open order. Once Jupiter's route pays at least the
 * order's minimum, one transaction takes the input, swaps it with all the
 * output sent to the order's output vault, and settles (which pays the
 * treasury, or reverts the whole transaction if the minimum didn't
 * arrive). It's simulated first, so a route that moved costs nothing.
 * The keeper keeps nothing: the treasury gets the full output.
 */

const POLL_MS = 30_000;
// Compute for take + settle and the keeper's account, on top of Jupiter's own estimate for the swap.
const OVERHEAD_UNITS = 150_000;
const MAX_UNITS = 1_400_000;
// ComputeBudget instruction tags: 2 = SetComputeUnitLimit (u32 after it), 3 = SetComputeUnitPrice.
const SET_LIMIT = 2;

let started = false;
// Every platform this process serves: { platform, notify }.
const notifiers = [];

/**
 * Starts the keeper once per process, for every network that asks for it.
 * Each platform's call adds its `notify(chatId, text)`, which tells its
 * chats linked to a DAO about that DAO's orders. Returns a stop function.
 */
export function startFillKeeper({ platform, notify }) {
  if (!SOLANA_ENABLED) return () => {};
  notifiers.push({ platform, notify });
  if (started) return () => {};
  const networks = SOLANA_NETWORK_IDS.map(getSolanaNetwork).filter((n) => n.fillKeeper && n.fillProgram);
  if (!networks.length) return () => {};
  const operator = getSolanaOperator();
  if (!operator) {
    console.error("[fill keeper] FILL_KEEPER is on but SOLANA_OPERATOR_KEY isn't set; not starting.");
    return () => {};
  }
  started = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const network of networks) await pollNetwork(network, operator, (owner, text) => tell(network, owner, text));
    } catch (err) {
      console.error("[fill keeper] poll failed:", err.message);
    } finally {
      running = false;
    }
  };
  console.log(`Fill keeper starting on ${networks.map((n) => n.name).join(", ")} - polling every ${POLL_MS / 1000}s`);
  tick();
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}

/** Tells the chats linked to the DAO whose treasury is `owner`, on every platform this process serves. */
async function tell(network, owner, text) {
  for (const chat of getAllSolanaChats()) {
    const to = notifiers.find((n) => n.platform === chat.platform);
    if (!to || chat.link.network !== network.id) continue;
    const treasury = v.addresses(network, new PublicKey(chat.link.dao), network.programs.hub).treasury;
    if (treasury.equals(owner)) await to.notify(chat.chatId, text).catch((err) => console.error(`[fill keeper] couldn't notify ${chat.chatId}:`, err.message));
  }
}

async function pollNetwork(network, operator, report) {
  const orders = await fill.listOrders(network);
  if (!orders.length) return;
  const now = await v.clusterNow(network);
  for (const { publicKey, account: o } of orders) {
    try {
      const programs = { in: (await v.mintInfo(network, o.mintIn)).programId, out: (await v.mintInfo(network, o.mintOut)).programId };
      if (now > Number(o.deadline)) {
        await cancelExpired(network, operator, publicKey, o, programs, report);
        continue;
      }
      const q = await jupiter.quote(o.mintIn, o.mintOut, BigInt(o.amountIn.toString()));
      if (BigInt(q.outAmount) < BigInt(o.minOut.toString())) continue;
      await fillOrder(network, operator, publicKey, o, programs, q, report);
    } catch (err) {
      console.error(`[fill keeper] order ${publicKey.toBase58()}:`, err.message);
    }
  }
}

async function cancelExpired(network, operator, orderKey, o, programs, report) {
  const sig = await v.send(network, [await fill.cancelIx(network, orderKey, o, operator.publicKey, programs)], [operator]);
  console.log(`[fill keeper] cancelled expired order ${orderKey.toBase58()}: ${sig}`);
  await report(o.owner, `⌛ Swap order \`${orderKey.toBase58()}\` reached its deadline without a fill, so it's cancelled: its tokens are back in the treasury.\n🔗 ${link("View transaction", explorerUrl(network, "tx", sig))}`);
}

async function fillOrder(network, operator, orderKey, o, programs, q, report) {
  const conn = network.connection;
  const keeper = operator.publicKey;
  const keeperAccount = v.tokenAccount(o.mintIn, keeper, programs.in);
  const { outputVault } = fill.orderAddresses(network, o.owner, o.id);
  const route = await jupiter.swapInstructions(q, keeper, outputVault);

  // Jupiter's compute limit covers the swap; add room for the fill around it. Its price instruction stays as is.
  const limit = route.computeBudget.find((ix) => ix.data[0] === SET_LIMIT);
  const units = Math.min(MAX_UNITS, (limit ? limit.data.readUInt32LE(1) : 1_000_000) + OVERHEAD_UNITS);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ...route.computeBudget.filter((ix) => ix.data[0] !== SET_LIMIT),
    createAssociatedTokenAccountIdempotentInstruction(keeper, keeperAccount, keeper, o.mintIn, programs.in),
    await fill.takeIx(network, orderKey, o, keeper, keeperAccount, programs.in),
    ...route.setup,
    route.swap,
    ...route.cleanup,
    await fill.settleIx(network, orderKey, o, programs),
  ];
  const tables = (await Promise.all(route.lookupTables.map((t) => conn.getAddressLookupTable(t)))).map((r) => r.value).filter(Boolean);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: keeper, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables));
  tx.sign([operator]);

  // A route that moved, or output short of the minimum, fails here for free.
  const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });
  if (sim.value.err) {
    console.log(`[fill keeper] order ${orderKey.toBase58()} not filled this round: ${JSON.stringify(sim.value.err)}`);
    return;
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const { value } = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (value.err) throw new Error(`fill ${sig} failed: ${JSON.stringify(value.err)}`);

  const [mintIn, mintOut] = await Promise.all([v.mintInfo(network, o.mintIn), v.mintInfo(network, o.mintOut)]);
  const got = await filledAmount(network, conn, sig);
  console.log(`[fill keeper] filled order ${orderKey.toBase58()}: ${sig}`);
  await report(
    o.owner,
    `🔁 Swap order \`${orderKey.toBase58()}\` filled through Jupiter: ${v.formatUnits(BigInt(o.amountIn.toString()), mintIn.decimals)} sold` +
      `${got !== null ? ` for ${v.formatUnits(got, mintOut.decimals)}` : ""} (minimum ${v.formatUnits(BigInt(o.minOut.toString()), mintOut.decimals)}), paid to the treasury.\n` +
      `🔗 ${link("View transaction", explorerUrl(network, "tx", sig))}`
  );
}

/** What the fill paid the treasury: the OrderFilled event's amount_out in the transaction's logs (null if the RPC doesn't return them). */
async function filledAmount(network, conn, sig) {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 }).catch(() => null);
  const program = fill.fillProgram(network);
  for (const ev of new anchor.EventParser(program.programId, program.coder).parseLogs(tx?.meta?.logMessages ?? [])) {
    if (ev.name === "orderFilled") return BigInt(ev.data.amountOut.toString());
  }
  return null;
}
