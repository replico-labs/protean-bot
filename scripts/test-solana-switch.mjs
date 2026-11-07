// Token changes, the converter, the security council and a switch, end to end against a local
// validator, through the bot's own Solana commands (wallet storage stood in for in memory, as in
// test-solana-local.mjs). Writes to data/chats.json (back it up first).
//
// A token-weighted DAO is created (its token and stake pool go on record at the hub), moves to
// a new token with a 2-for-1 converter in one proposal - same governance, members convert or
// unstake their old stake - then, in one round of votes, turns a security council on, pays
// someone with the council's confirmation, turns the council off (the council confirms), and
// starts a switch to quadratic set up for the next epoch on the current token. The hub's 2-day
// switch delay can't pass on a local validator, so the switch is left pending.
//
// 1. In the Vortexes repo: build the programs, then start a fresh validator with the thirteen
//    programs (vortex-stake included) at their declare_id! addresses.
// 2. node --experimental-test-module-mocks --test scripts/test-solana-switch.mjs   (~7 minutes)
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
    // The trading desk's agent keys (deskHypercore.js); unused here.
    createAgentKey: async () => null,
    getAgentAccount: async () => null,
    deleteAgentKey: async () => {},
    // Phoenix's agent keys (deskPhoenix.js); unused here.
    PHOENIX_AGENT_PLATFORM: "phoenix-agent",
    deletePhoenixAgentKey: async () => {},
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
const addressIn = (text) => text.match(/(?:^|[\s`])([1-9A-HJ-NP-Za-km-z]{32,44})(?=[\s`]|$)/)[1];

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

test("a token change with a converter, the security council, and a switch that keeps everyone's stake", { timeout: 1_200_000 }, async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();
  const T = -300;

  let out = await run(T, 1, "createdao Switcher SWT 1000 2000 solana");
  assert.match(out, /\(token-weighted\) created/);
  const link = getChatSolana(T, "telegram");
  const dao = new PublicKey(link.dao);
  let d = await v.readDao(net, dao);
  const oldMint = d.mint;
  // The treasury pays for new accounts (the new pool, the converter, the next model's setup).
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: d.treasury, lamports: LAMPORTS_PER_SOL })), [op]);
  assert.ok(oldMint, "the token goes on record (with its stake pool) when the DAO is created");

  const A = addressIn(await run(T, 1, "wallet"));
  const B = addressIn(await run(T, 2, "wallet"));
  assert.match(await run(T, 1, `tip 600 ${A}`), /Sent 600 SWT/);
  assert.match(await run(T, 1, "stake 300"), /Staked 300 SWT/);
  assert.match(await run(T, 1, "migrate"), /nothing to move/);
  assert.match(await run(T, 1, `proposeaction settoken ${oldMint.toBase58()} Same token`), /already the DAO's token/);

  // A token change and its converter fit one legacy transaction only with a short description: the bot says so up front.
  out = await run(T, 1, `proposeaction settoken new:5000 rate=2 fund=1000 ${"A rather long description of why this DAO is moving to a new token. ".repeat(2)}`);
  assert.match(out, /don't fit in one Solana transaction with that description: keep it under \d+ characters[\s\S]*openconverter/);

  // 1. A new token, with a 2-for-1 converter funded from the treasury, in one proposal.
  out = await run(T, 1, "proposeaction settoken new:5000 rate=2 fund=1000 Move to a new token");
  assert.match(out, /change the DAO's token from `.*` to `.*` \(a new token; its supply is already in the treasury\); opens a converter \(2:1\) funded with 1,?000 new tokens/);
  let id = Number(out.match(/Proposal \*#(\d+)\*/)[1]);
  assert.match(await run(T, 1, `vote ${id} for`), /Voted \*for\*/);
  await waitPast(await clock(), 122);
  assert.match(await run(T, 1, `queue ${id}`), new RegExp(`Queued #${id}`));
  await waitPast(await clock(), 31);
  assert.match(await run(T, 1, `execute ${id}`), /executed/);
  d = await v.readDao(net, dao);
  assert.ok(!d.mint.equals(oldMint), "the hub's record points at the new token");
  assert.strictEqual(d.record.epoch, 1, "the same governance");

  out = await run(T, 1, "balance");
  assert.match(out, /Staked here: 0\b/);
  assert.match(out, /Also staked in an old token's pool/);
  assert.match(await run(T, 1, "convert 100"), /Converted 100 old stake into 200 SWT/);
  assert.match(await run(T, 1, "balance"), /Staked here: 200\b/);
  assert.match(await run(T, 1, "migrate"), /still have stake in a pool for a token this DAO used before:[\s\S]*200/);
  assert.match(await run(T, 1, `unstake 50 ${oldMint.toBase58()}`), /Unstaked 50 of the old token/);
  assert.match(await run(T, 1, "convert 600"), /free to convert/);
  assert.match(await run(T, 1, `proposeaction openconverter ${oldMint.toBase58()} rate=1:1 Another`), /already a converter from that token/);

  // 2. A council, a payment it must confirm, a converter top-up and a switch; then the council off.
  out = await run(T, 1, `council on ${A},${B} 1 0 Council on`);
  assert.match(out, /turn on a security council of 2 \(1 must confirm each passed proposal/);
  const on = Number(out.match(/Proposal \*#(\d+)\*/)[1]);
  const pay = Number((await run(T, 1, `propose ${B} 0.002 SOL Paid under the council`)).match(/Proposal \*#(\d+)\*/)[1]);
  assert.match(await run(T, 1, "council off Council off"), /no security council/);
  out = await run(T, 1, "proposeaction switchquadratic Move to quadratic");
  assert.match(out, /switch this DAO to quadratic governance \(same treasury, token `.*` and everyone's stake\)/);
  const sw = Number(out.match(/Proposal \*#(\d+)\*/)[1]);
  out = await run(T, 1, `proposeaction fundconverter ${oldMint.toBase58()} 100 Top up the converter`);
  assert.match(out, /add 100 to the converter from/);
  const topUp = Number(out.match(/Proposal \*#(\d+)\*/)[1]);
  const passAll = async (ids) => {
    for (const p of ids) assert.match(await run(T, 1, `vote ${p} for`), /Voted \*for\*/);
    await waitPast(await clock(), 122);
    for (const p of ids) assert.match(await run(T, 1, `queue ${p}`), new RegExp(`Queued #${p}`));
    await waitPast(await clock(), 31);
  };
  await passAll([on, pay, sw, topUp]);

  const before = (await v.readConverter(net, d, oldMint, d.mint)).funded;
  assert.match(await run(T, 1, `execute ${topUp}`), /executed/);
  assert.strictEqual((await v.readConverter(net, d, oldMint, d.mint)).funded - before, 100_000_000n, "the top-up lands in the converter");
  assert.match(await run(T, 1, `execute ${on}`), /executed/);
  assert.match(await run(T, 1, "council"), /Security council\*: 1 of 2 confirm each passed proposal/);
  assert.match(await run(T, 1, `execute ${pay}`), /waits for the security council/);
  assert.match(await run(T, 3, `council confirm ${pay}`), /Only security council signers/);
  assert.match(await run(T, 2, `council confirm ${pay}`), /has the 1 confirmations it needs/);
  assert.match(await run(T, 1, `execute ${pay}`), /security council confirmed it/);

  const off = Number((await run(T, 1, "council off Council off")).match(/Proposal \*#(\d+)\*/)[1]);
  await passAll([off]);
  assert.match(await run(T, 1, `execute ${off}`), /waits for the security council/);
  await run(T, 1, `council confirm ${off}`);
  assert.match(await run(T, 1, `execute ${off}`), /executed/);
  assert.match(await run(T, 1, "council"), /No security council/);

  assert.match(await run(T, 1, `execute ${sw}`), /executed/);
  d = await v.readDao(net, dao);
  assert.ok(d.record.pendingSwitch?.program.equals(net.programs.quadratic), "the switch waits out its 2-day delay");
  // Set up for the next epoch on the DAO's token: stake never moves.
  const qv = v.addresses(net, dao, net.programs.quadratic, d.record.epoch + 1);
  const qg = await v.readGovernance(net, "quadratic", qv.governance);
  assert.ok(qg.mint.equals(d.mint) && qg.epoch === d.record.epoch + 1, "quadratic is set up for the next epoch, on the current token");
  assert.match(await run(T, 1, "dao"), /Switching to quadratic/i);
});
