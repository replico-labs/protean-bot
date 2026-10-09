// Runs the Solana commands (src/solana/commands.js) end to end against a local validator.
// Wallet storage (Supabase/KMS) is stood in for in memory; everything else - the commands,
// db.js and the Vortexes programs - is real. Writes to data/chats.json (back it up first).
//
// 1. In the Vortexes repo: anchor build, then start a validator with the programs at the
//    IDs in their declare_id!, e.g.
//      solana-test-validator --reset --bpf-program <hub id> target/deploy/vortex_hub.so ...
// 2. Set the hub up and approve token-weighted and board (the Vortexes smoke test does it:
//      cargo run -p vortex-smoke -- run --url localhost --keypair <a funded keypair>).
// 3. node --experimental-test-module-mocks --test scripts/test-solana-local.mjs
import { test, mock } from "node:test";
import assert from "node:assert";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, PublicKey } from "@solana/web3.js";

const op = Keypair.generate();
process.env.SOLANA_ENABLED = "true";
process.env.SOLANA_DEVNET_RPC_URL = "http://127.0.0.1:8899";
process.env.SOLANA_DEVNET_FAST_TIMINGS = "true";
process.env.SOLANA_OPERATOR_KEY = JSON.stringify(Array.from(op.secretKey));

const rows = new Map();
const keyOf = (p, u) => `${p}:${u}`;
mock.module(new URL("../src/walletStore.js", import.meta.url).href, {
  namedExports: {
    isWalletStoreConfigured: () => true,
    findWalletRecord: async (p, u) => rows.get(keyOf(p, u)) ?? null,
    findSolanaWallet: async (p, u) => rows.get(keyOf(p, u))?.solana ?? null,
    storeSolanaWallet: async (p, u, solana) => {
      const r = rows.get(keyOf(p, u));
      if (!r.solana) r.solana = solana;
      return r.solana;
    },
    recordSolanaTopup: async (p, u) => {
      const r = rows.get(keyOf(p, u));
      r.solana.topups = (r.solana.topups ?? 0) + 1;
      return r.solana.topups;
    },
  },
});
mock.module(new URL("../src/kmsWallet.js", import.meta.url).href, {
  namedExports: {
    encryptSecret: async (plain) => ({ ciphertext: plain, encryptedDataKey: "x", iv: "x", authTag: "x" }),
    decryptSecret: async (rec) => rec.ciphertext,
  },
});
mock.module(new URL("../src/walletResolver.js", import.meta.url).href, {
  namedExports: { getOrCreateUserAccount: async (u, p) => rows.set(keyOf(p, u), { address: "0xevm" }) },
});

const { runSolanaCommand } = await import("../src/solana/commands.js");
const { getSolanaNetwork } = await import("../src/solana/config.js");
const net = getSolanaNetwork("solana-devnet");
const conn = net.connection;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = async () => (await conn.getBlockTime(await conn.getSlot())) ?? 0;

const ctxFor = (chatId, userId, line) => {
  const [name, ...args] = line.split(" ");
  return [name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}` }];
};
const run = async (chatId, userId, line) => {
  const [name, ctx] = ctxFor(chatId, userId, line);
  const r = await runSolanaCommand(name, ctx);
  console.log(`\n> /${line}  [user ${userId}]\n${r ? r.text : "(not a Solana matter - falls through)"}`);
  return r?.text ?? null;
};
const addressIn = (text) => text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/)[1];
const fund = async (to, sol) =>
  sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: new PublicKey(to), lamports: sol * LAMPORTS_PER_SOL })), [op]);

test("Solana commands end to end", { timeout: 600_000 }, async () => {
  const s = await conn.requestAirdrop(op.publicKey, 50 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(s, "confirmed");
  const T = -100, B = -200, R = -300;

  // A token-weighted DAO.
  let out = await run(T, 1, "createdao Smoke SMK 1000 2000 solana");
  assert.match(out, /created on Solana devnet/);
  const treasury = out.match(/Treasury: `([^`]+)`/)[1];
  const alice = addressIn(await run(T, 1, "wallet"));
  assert.match(await run(T, 2, `tip 5 ${alice}`), /Only the person who created/);
  assert.match(await run(T, 1, `tip 600 ${alice}`), /Sent 600 SMK/);
  assert.match(await run(T, 1, "stake 600"), /Staked 600 SMK/);
  await fund(treasury, 0.1);
  const recipient = Keypair.generate().publicKey.toBase58();
  assert.match(await run(T, 1, `propose ${recipient} 0.002 SOL Pay the designer`), /Proposal \*#1\*/);
  assert.match(await run(T, 1, "vote 1 for"), /Voted \*for\*/);
  assert.match(await run(T, 1, "vote 1 for"), /already voted/);
  assert.match(await run(T, 1, "proposal 1"), /Active/);
  assert.match(await run(T, 1, "queue 1"), /Voting hasn't ended yet/);
  console.log("\n(waiting for the 120 s vote and 30 s timelock)");
  await sleep(125_000);
  assert.match(await run(T, 1, "queue 1"), /Queued #1/);
  await sleep(32_000);
  assert.match(await run(T, 1, "execute 1"), /executed/);
  assert.strictEqual(await conn.getBalance(new PublicKey(recipient)), 2_000_000);
  assert.match(await run(T, 1, "proposals"), /#1\* — Executed/);
  assert.match(await run(T, 1, "dao"), /10% quorum, 60% approval/);
  assert.match(await run(T, 1, "balance"), /Staked here: 600/);
  assert.match(await run(T, 1, "delegate"), /isn't available for Solana DAOs yet/);
  assert.strictEqual(await run(T, 1, "mybet"), null, "Opportunity Market commands pass through");
  assert.match(await run(T, 1, "confirm 1"), /only applies to board DAOs/);

  // A board DAO.
  const bob = addressIn(await run(T, 2, "wallet"));
  out = await run(B, 1, `createboarddao Council ${alice} ${bob} solana`);
  assert.match(out, /2 of 2 signers/);
  const boardTreasury = out.match(/Treasury: `([^`]+)`/)[1];
  await fund(boardTreasury, 0.1);
  assert.match(await run(B, 1, `propose ${recipient} 0.003 SOL Second payment`), /Your confirmation counts already/);
  assert.match(await run(B, 3, "confirm 1"), /not a signer/);
  assert.match(await run(B, 2, "confirm 1"), /2 of 2 needed\).*queued/);
  await sleep(32_000);
  assert.match(await run(B, 1, "execute 1"), /executed/);
  assert.strictEqual(await conn.getBalance(new PublicKey(recipient)), 5_000_000);
  assert.match(await run(B, 1, "vote 1 for"), /Board DAOs don't vote/);

  // Linking an existing DAO, and leaving EVM commands alone.
  const boardDao = (await run(B, 1, "dao")).match(/DAO: `([^`]+)`/)[1];
  assert.match(await run(R, 1, `register ${boardDao} solana`), /Linked \*Council\*/);
  assert.strictEqual(await run(-400, 1, "createdao Evm EVM 1 2"), null, "no Solana word: the EVM handler takes it");
  assert.strictEqual(await run(-400, 1, "dao"), null, "an unlinked chat isn't a Solana matter");
  assert.match(await run(R, 1, "unregister"), /Unlinked/);
  assert.strictEqual(await run(R, 1, "dao"), null);
});
