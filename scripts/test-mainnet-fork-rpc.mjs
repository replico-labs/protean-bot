#!/usr/bin/env node
/**
 * Checks scripts/lib/mainnetFork.mjs (the mainnet fork the hub test runs
 * on) offline, against a stub "mainnet" serving a program (a copy of SPL
 * Token at a new address, with its program data), an oracle-owned account
 * and the Clock: sending legacy and v1 transactions, confirmation over the
 * websocket, logs from getTransaction, a program loaded from mainnet,
 * getProgramAccounts filters, preflight failures with logs, kit's RPC,
 * oracle refreshes, the clock, and sends without signature checks.
 *
 *   node scripts/test-mainnet-fork-rpc.mjs
 */
import http from "node:http";
import { LiteSVM } from "litesvm";
import { address, createSolanaRpc } from "@solana/kit";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, TransactionInstruction } from "@solana/web3.js";
import { createInitializeMint2Instruction, MINT_SIZE, getMint } from "@solana/spl-token";
import { startFork } from "./lib/mainnetFork.mjs";
import { sendV1 } from "../src/solana/v1.js";

const UP = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ref = new LiteSVM();
const pdOf = (p) => PublicKey.findProgramAddressSync([p.toBuffer()], UP)[0];
const tokenPd = ref.getAccount(address(pdOf(TOKEN).toBase58()));
const X = Keypair.generate().publicKey; // "mainnet" program: a copy of SPL Token
const xPd = pdOf(X);
const progData = new Uint8Array(36); progData[0] = 2; progData.set(xPd.toBytes(), 4);
const enc = (owner, data, lamports = 1e9, executable = false) => ({ data: [Buffer.from(data).toString("base64"), "base64"], executable, lamports, owner, rentEpoch: 0, space: data.length });
const clock = Buffer.alloc(40); clock.writeBigUInt64LE(300_000_000n, 0); clock.writeBigInt64LE(1_760_000_000n, 8); clock.writeBigUInt64LE(700n, 16); clock.writeBigUInt64LE(701n, 24); clock.writeBigInt64LE(1_761_000_000n, 32);
const oracle = Keypair.generate().publicKey;
let oracleVersion = 1;
const remoteAccounts = () => ({
  [X.toBase58()]: enc(UP.toBase58(), progData, 1e9, true),
  [xPd.toBase58()]: enc(UP.toBase58(), tokenPd.data),
  [oracle.toBase58()]: enc("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", Buffer.from([oracleVersion])),
  SysvarC1ock11111111111111111111111111111111: enc("Sysvar1111111111111111111111111111111111111", clock),
});
let calls = {};
const stub = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
  const { id, method, params } = JSON.parse(b); calls[method] = (calls[method] ?? 0) + 1;
  const A = remoteAccounts();
  const result = method === "getAccountInfo" ? { context: { slot: 1 }, value: A[params[0]] ?? null }
    : method === "getMultipleAccounts" ? { context: { slot: 1 }, value: params[0].map((k) => A[k] ?? null) }
    : method === "getEpochSchedule" ? { slotsPerEpoch: 432000, leaderScheduleSlotOffset: 432000, warmup: false, firstNormalEpoch: 0, firstNormalSlot: 0 }
    : method === "getProgramAccounts" ? []
    : method === "getTokenAccountsByOwner" ? { context: { slot: 1 }, value: [] } : null;
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}); }).listen(18990);

let fails = 0; const check = (ok, what, d = "") => { console.log(`${ok ? "  ✓" : "  ✗"} ${what} ${ok ? "" : d}`); if (!ok) fails++; };
const fork = await startFork({ remoteUrl: "http://127.0.0.1:18990", port: 18999, log: console.log });
const conn = new Connection(fork.url, "confirmed");
const rpc = createSolanaRpc(fork.url);
const me = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(me.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");
check((await conn.getBalance(me.publicKey)) === 10 * LAMPORTS_PER_SOL, "airdrop + confirm");
const to = Keypair.generate().publicKey;
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: to, lamports: 1_000_000_000 })), [me], { commitment: "confirmed" });
check((await conn.getBalance(to)) === 1e9, "legacy transfer, sendAndConfirmTransaction");
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: to, lamports: 1_000_000_000 })), [me], { commitment: "confirmed" });
check((await conn.getBalance(to)) === 2e9, "an identical second transfer isn't refused as a duplicate");
const sig = await sendV1(conn, [SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: to, lamports: 10 })], [me]);
check((await conn.getBalance(to)) === 2e9 + 10, "v1 transfer via sendV1");
const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 });
check(t?.meta?.logMessages?.some((l) => l.includes("11111111111111111111111111111111 success")), "getTransaction returns the logs", JSON.stringify(t?.meta));
// A program fetched from "mainnet": InitializeMint2 on a copy of SPL Token at X.
const mint = Keypair.generate();
const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.createAccount({ fromPubkey: me.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: X }), createInitializeMint2Instruction(mint.publicKey, 6, me.publicKey, null, X)), [me, mint], { commitment: "confirmed" });
const mi = await conn.getAccountInfo(mint.publicKey);
check(mi?.owner.equals(X) && mi.data[44] === 6, "program loaded from mainnet (with its program data) runs");
const gpa = await conn.getProgramAccounts(X, { filters: [{ dataSize: MINT_SIZE }, { memcmp: { offset: 4, bytes: me.publicKey.toBase58() } }] });
check(gpa.length === 1 && gpa[0].pubkey.equals(mint.publicKey), "getProgramAccounts with filters sees the fork's accounts");
// Failure: preflight error with logs.
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(createInitializeMint2Instruction(mint.publicKey, 6, me.publicKey, null, X)), [me], { commitment: "confirmed" });
  check(false, "a failing transaction is refused");
} catch (e) { check(/simulation failed/i.test(e.message) && (e.logs ?? e.transactionLogs)?.length > 0, "a failing transaction is refused with its logs", e.message); }
// Token balances via a set account.
const ata = Keypair.generate().publicKey;
await fork.setTokenAccount(ata.toBase58(), me.publicKey.toBase58(), mint.publicKey.toBase58(), 5_000_000n, X.toBase58());
// getTokenAccountBalance requires Token/Token-2022 owners; X isn't, so check the raw data instead.
const ta = await conn.getAccountInfo(ata);
check(ta.data.readBigUInt64LE(64) === 5_000_000n, "setTokenAccount writes the balance");
const held = Keypair.generate().publicKey;
await fork.setTokenAccount(held.toBase58(), me.publicKey.toBase58(), mint.publicKey.toBase58(), 1n);
const owned = await conn.getTokenAccountsByOwner(me.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
check(owned.value.length === 1 && owned.value[0].pubkey.equals(held) && owned.value[0].account.data.readBigUInt64LE(64) === 1n, "getTokenAccountsByOwner includes the fork's own token accounts", JSON.stringify(owned.value.map((x) => x.pubkey.toBase58())));
// Kit RPC.
const slot = await rpc.getSlot().send();
const bt = await rpc.getBlockTime(slot).send();
check(slot >= 300_000_000n && Math.abs(Number(bt) - 1_761_000_000) < 10, "kit getSlot/getBlockTime follow mainnet's clock", `${slot} ${bt}`);
const ka = await rpc.getAccountInfo(address(mint.publicKey.toBase58()), { encoding: "base64" }).send();
check(ka.value?.owner === X.toBase58(), "kit getAccountInfo");
// Oracle refresh: re-fetched after 10s if nothing here wrote it.
await conn.getAccountInfo(oracle);
oracleVersion = 2;
check((await conn.getAccountInfo(oracle)).data[0] === 1, "oracle copy kept within 10s");
await new Promise((r) => setTimeout(r, 10_500));
check((await conn.getAccountInfo(oracle)).data[0] === 2, "oracle copy refreshed after 10s");
const cs = await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"));
check(cs.data.readBigUInt64LE(16) === 700n && cs.data.readBigInt64LE(32) >= 1_761_000_010n, "Clock sysvar: mainnet's epoch, time running");
// Unverified send: a co-signer that doesn't sign.
const co = Keypair.generate();
const ix = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [{ pubkey: co.publicKey, isSigner: true, isWritable: false }], data: Buffer.from("hi") });
const { blockhash } = await conn.getLatestBlockhash();
const tx = new Transaction({ feePayer: me.publicKey, recentBlockhash: blockhash }).add(ix);
tx.partialSign(me);
const r = await fork.sendUnverified(tx.serialize({ requireAllSignatures: false }));
check(r.err === null, "sendUnverified runs a transaction missing a co-signature", JSON.stringify(r.err));
console.log(fork.stats(), calls);
await fork.close(); stub.close();
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
