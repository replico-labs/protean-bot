// The DAO token record and /migrate, end to end against a local validator, through the bot's
// own Solana commands (wallet storage stood in for in memory, as in test-solana-local.mjs).
// Writes to data/chats.json (back it up first).
//
// A token-weighted DAO is created (its token goes on record at the hub in the same
// transaction), passes a switch to quadratic (set up on the recorded token), and a member's
// stake sitting in a vault the DAO isn't using is moved by /migrate into the one it is.
// The hub's 2-day switch delay can't pass on a local validator, so the stake to move is put
// straight into quadratic's vault while token-weighted still runs the DAO - /migrate treats
// every model but the current one the same way.
//
// 1. In the Vortexes repo: anchor build, then start a fresh validator with the eleven programs
//    at their declare_id! addresses.
// 2. node --experimental-test-module-mocks --test scripts/test-solana-switch.mjs   (~4 minutes)
import { test, mock } from "node:test";
import assert from "node:assert";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

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
    createWalletRecord: async () => null,
    getWalletAccount: async () => null,
    recordGasTopup: async () => 0,
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
    isKmsWalletConfigured: () => true,
    createEncryptedWallet: async () => null,
    decryptWallet: async () => null,
    encryptSecret: async (plain) => ({ ciphertext: plain, encryptedDataKey: "x", iv: "x", authTag: "x" }),
    decryptSecret: async (rec) => rec.ciphertext,
  },
});
mock.module(new URL("../src/walletResolver.js", import.meta.url).href, {
  namedExports: { getOrCreateUserAccount: async (u, p) => rows.set(keyOf(p, u), { address: "0xevm" }), getUserAddress: async () => null },
});

const anchor = (await import("@coral-xyz/anchor")).default;
const { runSolanaCommand } = await import("../src/solana/commands.js");
const { getSolanaNetwork, IDLS } = await import("../src/solana/config.js");
const { getOrCreateSolanaKeypair } = await import("../src/solana/wallets.js");
const { getChatSolana } = await import("../src/db.js");
const v = await import("../src/solana/vortex.js");
const net = getSolanaNetwork("solana-devnet");
const conn = net.connection;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = async () => (await conn.getBlockTime(await conn.getSlot())) ?? 0;
const waitPast = async (from, seconds) => {
  while ((await clock()) < from + seconds) await sleep(2000);
};

const run = async (chatId, userId, line) => {
  const [name, ...args] = line.split(" ");
  const r = await runSolanaCommand(name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}` });
  console.log(`\n> /${line}  [chat ${chatId}, user ${userId}]\n${r ? r.text : "(falls through)"}`);
  return r?.text ?? null;
};
const addressIn = (text) => text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/)[1];

async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  const hubPda = pda([Buffer.from("hub")]);
  if (!(await conn.getAccountInfo(hubPda))) await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: hubPda, systemProgram: SystemProgram.programId }).rpc();
  for (const [m, name] of Object.entries({ tokenWeighted: "token-weighted", quadratic: "quadratic", board: "board" })) {
    const gp = net.programs[m];
    await hub.methods.setModel(gp, name, true).accountsStrict({ admin: op.publicKey, hub: hubPda, model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
  }
}

test("the DAO's token on record, a switch that keeps it, and /migrate", { timeout: 900_000 }, async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();
  const T = -300;

  let out = await run(T, 1, "createdao Switcher SWT 1000 2000 solana");
  assert.match(out, /\(token-weighted\) created/);
  const link = getChatSolana(T, "telegram");
  const dao = new PublicKey(link.dao);
  const d = await v.readDao(net, dao);
  const g = await v.readGovernance(net, "tokenWeighted", d.governance);
  // The treasury pays the new model's rent when the switch runs.
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: d.treasury, lamports: LAMPORTS_PER_SOL / 2 })), [op]);
  const recorded = await v.readDaoToken(net, dao);
  assert.ok(recorded?.equals(g.mint), "the token goes on record when the DAO is created");

  const A = addressIn(await run(T, 1, "wallet"));
  assert.match(await run(T, 1, `tip 600 ${A}`), /Sent 600 SWT/);
  assert.match(await run(T, 1, "stake 300"), /Staked 300 SWT/);
  assert.match(await run(T, 1, "migrate"), /nothing to move/);

  // A switch to quadratic: set up on the recorded token.
  out = await run(T, 1, "proposeaction switchquadratic Move to quadratic");
  assert.match(out, /switch this DAO to quadratic governance \(same treasury and token `/);
  assert.doesNotMatch(out, /records that token/, "already on record");
  const id = Number(out.match(/Proposal \*#(\d+)\*/)[1]);
  // A deliberate change of token is its own action.
  const other = Keypair.generate().publicKey;
  assert.match(await run(T, 1, `proposeaction settoken ${g.mint.toBase58()} Same token`), /already the DAO's token/);
  assert.match(await run(T, 1, `proposeaction settoken ${other.toBase58()} x`), /mint|token/i);

  assert.match(await run(T, 1, `vote ${id} for`), /Voted \*for\*/);
  await waitPast(await clock(), 122);
  assert.match(await run(T, 1, `queue ${id}`), new RegExp(`Queued #${id}`));
  await waitPast(await clock(), 31);
  assert.match(await run(T, 1, `execute ${id}`), /executed/);
  const qv = v.addresses(net, dao, net.programs.quadratic);
  const qg = await v.readGovernance(net, "quadratic", qv.governance);
  assert.ok(qg.mint.equals(g.mint), "quadratic is set up on the same token");
  assert.ok((await v.readDao(net, dao)).record.pendingSwitch, "the switch waits out its delay");

  // Stake in a vault the DAO isn't using now: /migrate brings it over.
  const alice = await getOrCreateSolanaKeypair(1, "telegram");
  await v.deposit(net, "quadratic", alice, qv, qg, 100n * 10n ** 6n);
  out = await run(T, 1, "migrate");
  assert.match(out, /Quadratic: took out 100 SWT/i);
  assert.match(out, /Staked 100 SWT in Token-weighted/i);
  const voter = await v.readVoter(net, "tokenWeighted", d.voter(alice.publicKey));
  assert.strictEqual(BigInt(voter.amount.toString()), 400n * 10n ** 6n);
  assert.strictEqual(BigInt((await v.readVoter(net, "quadratic", qv.voter(alice.publicKey))).amount.toString()), 0n);
  assert.match(await run(T, 1, "migrate"), /nothing to move/);
});
