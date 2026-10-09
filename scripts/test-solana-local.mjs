// Runs the Solana commands (src/solana/commands.js) and notifications (src/solana/listener.js)
// end to end against a local validator, for all six Vortexes models. Wallet storage
// (Supabase/KMS) is stood in for in memory; everything else - the commands, db.js and the
// Vortexes programs - is real. Writes to data/chats.json (back it up first) and
// data/solanaListenerState.test.json.
//
// 1. In the Vortexes repo: anchor build, then start a fresh validator with the programs at
//    the IDs in their declare_id!, e.g.
//      solana-test-validator --reset --bpf-program <hub id> target/deploy/vortex_hub.so ...
//    This test sets the hub up itself (its throwaway operator becomes the hub admin).
// 2. node --experimental-test-module-mocks --test scripts/test-solana-local.mjs
//    About 15 minutes: the model flows run side by side, and the delegate flow waits out a
//    10-minute council term to hold an election.
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

const anchor = (await import("@coral-xyz/anchor")).default;
const { runSolanaCommand } = await import("../src/solana/commands.js");
const { startSolanaListener } = await import("../src/solana/listener.js");
const { getSolanaNetwork, IDLS } = await import("../src/solana/config.js");
const { tokenBalance } = await import("../src/solana/vortex.js");
const net = getSolanaNetwork("solana-devnet");
const conn = net.connection;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = async () => (await conn.getBlockTime(await conn.getSlot())) ?? 0;
/** Waits until the cluster clock has moved `seconds` past `from`. */
const waitPast = async (from, seconds) => {
  while ((await clock()) < from + seconds) await sleep(2000);
};

const run = async (chatId, userId, line) => {
  const [name, ...args] = line.split(" ");
  const r = await runSolanaCommand(name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}` });
  console.log(`\n> /${line}  [chat ${chatId}, user ${userId}]\n${r ? r.text : "(not a Solana matter - falls through)"}`);
  return r?.text ?? null;
};
const addressIn = (text) => text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/)[1];
const field = (text, label) => text.match(new RegExp(`${label}: \`([^\`]+)\``))[1];
const fund = async (to, sol) =>
  sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: new PublicKey(to), lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [op]);
const solOf = async (k) => conn.getBalance(new PublicKey(k));

/** Sets the hub up on a fresh validator and approves all six models, as the hub admin does on devnet. */
async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  const hubPda = pda([Buffer.from("hub")]);
  if (!(await conn.getAccountInfo(hubPda))) await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: hubPda, systemProgram: SystemProgram.programId }).rpc();
  const names = { tokenWeighted: "token-weighted", quadratic: "quadratic", optimistic: "optimistic", board: "board", conviction: "conviction", delegate: "delegate" };
  for (const [m, name] of Object.entries(names)) {
    const gp = net.programs[m];
    await hub.methods.setModel(gp, name, true).accountsStrict({ admin: op.publicKey, hub: hubPda, model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
  }
}

test("Solana commands and notifications end to end, all six models", { timeout: 1_800_000 }, async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();
  // Everyone's Solana wallet (alice = user 1, bob = 2, carol = 3), via a throwaway board link.
  await run(-9, 1, `createboarddao Wallets ${Keypair.generate().publicKey.toBase58()} solana`);
  const A = addressIn(await run(-9, 1, "wallet"));
  const B = addressIn(await run(-9, 2, "wallet"));
  const C = addressIn(await run(-9, 3, "wallet"));
  const pay = () => Keypair.generate().publicKey.toBase58();

  // Notifications: the listener on its own platform name, collecting what it would post.
  const posted = [];
  const flows = [];

  // ---------------- token-weighted, with a model switch ----------------
  flows.push(
    (async () => {
      const T = -100;
      let out = await run(T, 1, "createdao Smoke SMK 1000 2000 solana");
      assert.match(out, /\(token-weighted\) created/);
      const treasury = field(out, "Treasury");
      assert.match(await run(T, 2, `tip 5 ${A}`), /Only the person who created/);
      assert.match(await run(T, 1, `tip 600 ${A}`), /Sent 600 SMK/);
      assert.match(await run(T, 1, "stake 600"), /Staked 600 SMK/);
      await fund(treasury, 0.2);
      const to = pay();
      assert.match(await run(T, 1, `propose ${to} 0.002 SOL Pay the designer`), /Proposal \*#1\*/);
      assert.match(await run(T, 1, `proposeaction switchboard ${A},${B} Move to a board`), /Proposal \*#2\*: switch this DAO to board/);
      assert.match(await run(T, 1, "proposal 2"), /switch the DAO to board governance.*set up board governance/s);
      assert.match(await run(T, 1, "vote 1 for"), /Voted \*for\*/);
      assert.match(await run(T, 1, "vote 2 for"), /Voted \*for\*/);
      assert.match(await run(T, 1, "vote 1 for"), /already voted/);
      assert.match(await run(T, 1, "queue 1"), /Voting hasn't ended yet/);
      const t0 = await clock();
      await waitPast(t0, 122);
      assert.match(await run(T, 1, "queue 1"), /Queued #1/);
      assert.match(await run(T, 1, "queue 2"), /Queued #2/);
      await waitPast(await clock(), 31);
      assert.match(await run(T, 1, "execute 1"), /executed/);
      assert.strictEqual(await solOf(to), 2_000_000);
      assert.match(await run(T, 1, "execute 2"), /executed/);
      out = await run(T, 1, "dao");
      assert.match(out, /Switching to board in (48\.0h|2\.0d)/);
      assert.match(await run(T, 1, "proposals"), /#1\* — Executed/);
      assert.match(await run(T, 1, "listactions"), /switchconviction/);
      assert.match(await run(T, 1, "delegate"), /isn't available for Solana DAOs/);
      assert.strictEqual(await run(T, 1, "mybet"), null, "Opportunity Market commands pass through");
      assert.match(await run(T, 1, "confirm 1"), /only applies to board DAOs/);
    })()
  );

  // ---------------- quadratic ----------------
  flows.push(
    (async () => {
      const Q = -200;
      const out = await run(Q, 1, "createdao Quad QDR 1000 2000 quadratic solana");
      assert.match(out, /\(quadratic\) created/);
      await fund(field(out, "Treasury"), 0.1);
      await run(Q, 1, `tip 400 ${A}`);
      await run(Q, 1, "stake 400");
      const to = pay();
      assert.match(await run(Q, 1, `propose ${to} 0.003 SOL Quadratic payment`), /Proposal \*#1\*/);
      assert.match(await run(Q, 1, "vote 1 for"), /with 20 votes \(√ of your 400 staked\)/);
      assert.match(await run(Q, 1, "proposal 1"), /For 20 · Against 0 · Abstain 0 votes/);
      assert.match(await run(Q, 1, "dao"), /square root of their stake/);
      await waitPast(await clock(), 122);
      assert.match(await run(Q, 1, "queue 1"), /Queued #1/);
      await waitPast(await clock(), 31);
      assert.match(await run(Q, 1, "execute 1"), /executed/);
      assert.strictEqual(await solOf(to), 3_000_000);
    })()
  );

  // ---------------- optimistic ----------------
  flows.push(
    (async () => {
      const O = -300;
      const out = await run(O, 1, "createdao Opti OPT 1000 2000 optimistic solana");
      assert.match(out, /\(optimistic\) created/);
      const treasury = field(out, "Treasury");
      const mint = field(out, "Token");
      await fund(treasury, 0.1);
      await run(O, 1, `tip 500 ${A}`);
      await run(O, 1, `tip 250 ${B}`);
      await run(O, 1, "stake 500");
      const to1 = pay();
      const to2 = pay();
      assert.match(await run(O, 1, `propose ${to1} 0.002 SOL Unchallenged payment`), /passes unless someone challenges it/);
      assert.match(await run(O, 1, `propose ${to2} 0.002 SOL Disputed payment`), /Proposal \*#2\*/);
      assert.match(await run(O, 1, "proposal 1"), /ChallengeWindow/);
      assert.match(await run(O, 1, "vote 1 for"), /only take votes once challenged/);
      assert.match(await run(O, 1, "queue 1"), /challenge window|ChallengeWindowOpen/i);
      assert.match(await run(O, 2, "challenge 2"), /Challenged #2, posting 100 OPT/);
      assert.match(await run(O, 2, "vote 2 against"), /nothing staked/);
      assert.match(await run(O, 1, "vote 2 for"), /Voted \*for\*/);
      // A cancelled, challenged proposal returns the bond.
      assert.match(await run(O, 1, `propose ${to2} 0.002 SOL To be cancelled`), /#3/);
      assert.match(await run(O, 2, "challenge 3"), /Challenged #3/);
      assert.strictEqual(await tokenBalance(net, new PublicKey(mint), new PublicKey(B)), 50_000_000n);
      assert.match(await run(O, 1, "cancel 3"), /returned the challenger's bond/);
      assert.strictEqual(await tokenBalance(net, new PublicKey(mint), new PublicKey(B)), 150_000_000n);
      await waitPast(await clock(), 122);
      assert.match(await run(O, 1, "queue 1"), /Queued #1/);
      assert.match(await run(O, 1, "queue 2"), /Queued #2\. The challenge failed, so the bond went to the treasury/);
      assert.strictEqual(await tokenBalance(net, new PublicKey(mint), new PublicKey(treasury)), 100_000_000n);
      await waitPast(await clock(), 31);
      assert.match(await run(O, 1, "execute 1"), /executed/);
      assert.match(await run(O, 1, "execute 2"), /executed/);
      assert.strictEqual(await solOf(to1), 2_000_000);
      assert.strictEqual(await solOf(to2), 2_000_000);
    })()
  );

  // ---------------- conviction, with budgets ----------------
  flows.push(
    (async () => {
      const V = -400;
      const out = await run(V, 1, "createdao Conv CNV 1000 2000 conviction solana");
      assert.match(out, /\(conviction\) created/);
      const treasury = field(out, "Treasury");
      await fund(treasury, 0.1);
      await run(V, 1, `tip 600 ${A}`);
      await run(V, 1, "tip 50 treasury");
      await run(V, 1, "stake 600");
      assert.match(await run(V, 1, "assets"), /SOL: weight 250, treasury holds 0\.1 SOL.*CNV: weight 250, treasury holds 50 CNV/s);
      const to = pay();
      assert.match(await run(V, 1, `propose ${to} 0.002 SOL Small payment`), /Back it with `\/support 1`/);
      assert.match(await run(V, 1, `propose ${B} 10 token Pay Bob in tokens`), /Proposal \*#2\*/);
      assert.match(await run(V, 1, "proposal 2"), /Budget: at most 10 CNV, 0\.00\d+ SOL/);
      assert.match(await run(V, 1, "vote 1 for"), /don't vote/);
      assert.match(await run(V, 1, "support 1"), /Backing #1 with 600 CNV.*reaches its bar/);
      assert.match(await run(V, 1, "queue 1"), /Not enough conviction yet/);
      assert.match(await run(V, 1, "mysupport"), /backing proposal #1/);
      let p = await run(V, 1, "proposal 1");
      const need = Number(p.match(/of ([\d,.]+) needed/)[1].replace(/,/g, ""));
      await waitPast(await clock(), Math.ceil(need / 1.6667) + 2);
      assert.match(await run(V, 1, "queue 1"), /Queued #1/);
      // Move the stake to #2 while #1 waits out its timelock.
      assert.match(await run(V, 1, "support 2"), /Backing #2/);
      await waitPast(await clock(), 31);
      assert.match(await run(V, 1, "execute 1"), /executed/);
      assert.strictEqual(await solOf(to), 2_000_000);
      p = await run(V, 1, "proposal 2");
      const need2 = Number(p.match(/of ([\d,.]+) needed/)[1].replace(/,/g, ""));
      await waitPast(await clock(), Math.ceil(need2 / 1.6667) + 2);
      assert.match(await run(V, 1, "queue 2"), /Queued #2/);
      await waitPast(await clock(), 31);
      assert.match(await run(V, 1, "execute 2"), /executed/);
      assert.match(await run(V, 2, "balance"), /CNV in your wallet: 10/);
      assert.match(await run(V, 1, "withdrawsupport"), /Support withdrawn/);
      assert.match(await run(V, 1, "unstake 600"), /Unstaked 600/);
    })()
  );

  // ---------------- board, with an action ----------------
  flows.push(
    (async () => {
      const Bd = -500;
      const out = await run(Bd, 1, `createboarddao Council ${A} ${B} solana`);
      assert.match(out, /2 of 2 signers/);
      const treasury = field(out, "Treasury");
      await fund(treasury, 0.1);
      assert.match(await run(Bd, 3, `propose ${C} 0.003 SOL Not a signer`), /not a signer/);
      assert.match(await run(Bd, 1, `proposeaction addsigner ${C} Add Carol`), /Proposal \*#1\*: add `.*` as a signer/);
      assert.match(await run(Bd, 1, `propose ${C} 0.003 SOL Pay Carol`), /Your confirmation counts already/);
      assert.match(await run(Bd, 3, "confirm 1"), /not a signer/);
      assert.match(await run(Bd, 2, "confirm 1"), /2 of 2 needed\).*queued/);
      assert.match(await run(Bd, 2, "confirm 2"), /queued/);
      await waitPast(await clock(), 31);
      assert.match(await run(Bd, 1, "execute 1"), /executed/);
      assert.match(await run(Bd, 1, "execute 2"), /executed/);
      assert.match(await run(Bd, 1, "dao"), /of 3 must confirm/);
      assert.match(await run(Bd, 1, "vote 1 for"), /Board DAOs don't vote/);
      // Linking an existing DAO.
      const dao = field(await run(Bd, 1, "dao"), "DAO");
      assert.match(await run(-501, 1, `register ${dao} solana`), /Linked \*Council\*/);
      assert.match(await run(-501, 1, "unregister"), /Unlinked/);
      assert.strictEqual(await run(-501, 1, "dao"), null);
    })()
  );

  // ---------------- delegate: council votes, a recall, an election ----------------
  flows.push(
    (async () => {
      const D = -600;
      const out = await run(D, 1, `createdao Deleg DLG 1000 2000 delegate solana ${A} ${B}`);
      assert.match(out, /\(delegate\) created/);
      const created = await clock();
      await fund(field(out, "Treasury"), 0.1);
      await run(D, 1, `tip 100 ${C}`);
      await run(D, 1, `tip 50 ${A}`);
      const to = pay();
      assert.match(await run(D, 3, `propose ${to} 0.002 SOL Not council`), /Only council members/);
      assert.match(await run(D, 1, `propose ${to} 0.002 SOL Council payment`), /Council members vote/);
      assert.match(await run(D, 1, "vote 1 for"), /Voted \*for\*/);
      assert.match(await run(D, 2, "vote 1 for"), /Voted \*for\*/);
      assert.match(await run(D, 3, "vote 1 for"), /Only council members/);
      assert.match(await run(D, 1, "startelection"), /term ends in/);
      // Carol stakes and recalls Alice.
      assert.match(await run(D, 3, "stake 100"), /Staked 100 DLG/);
      const r = await run(D, 3, `initiaterecall ${A}`);
      assert.match(r, /Recall #1 of/);
      assert.match(await run(D, 3, "voterecall 1 for"), /Voted \*for\* on recall #1/);
      await waitPast(await clock(), 122);
      assert.match(await run(D, 1, "proposal 1"), /Succeeded/);
      assert.match(await run(D, 1, "queue 1"), /Queued #1/);
      assert.match(await run(D, 1, "finalizerecall 1"), /is off the council/);
      assert.match(await run(D, 1, "council"), /1 of 2 seats/);
      await waitPast(await clock(), 31);
      // Recalling Alice drops her vote: one council vote is under the quorum of 2.
      assert.match(await run(D, 1, "execute 1"), /QuorumNotReached|ProposalNotExecutable|not/i);
      // The election, once the 10-minute term is over.
      await waitPast(created, 602);
      assert.match(await run(D, 2, "startelection"), /Election #1 is open/);
      assert.match(await run(D, 3, "declarecandidacy"), /standing in election #1/);
      assert.match(await run(D, 1, "stake 50"), /Staked 50/);
      assert.match(await run(D, 1, "declarecandidacy 1"), /standing in election #1/);
      assert.match(await run(D, 1, "council"), /candidacy open/);
      await waitPast(await clock(), 122);
      assert.match(await run(D, 3, `voteinelection 1 ${C} ${A}`), /Voted for 2 candidate/);
      await waitPast(await clock(), 122);
      const fin = await run(D, 1, "finalizeelection");
      assert.match(fin, /new council/);
      assert.ok(fin.includes(C) && fin.includes(A));
    })()
  );

  // ---------------- notifications ----------------
  const statePath = new URL("../data/solanaListenerState.test.json", import.meta.url).pathname;
  const stopListener = startSolanaListener({ platform: "telegram", notify: async (chatId, text) => posted.push({ chatId, text }) }, 5_000, statePath);
  try {
    await Promise.all(flows);
    await sleep(12_000);
  } finally {
    stopListener();
  }
  console.log("\nNotifications posted:\n" + posted.map((p) => `[${p.chatId}] ${p.text}`).join("\n"));
  const at = (chat) => posted.filter((p) => p.chatId === String(chat)).map((p) => p.text).join("\n");
  assert.match(at(-100), /Proposal #1 in \*Smoke\* is queued/);
  assert.match(at(-100), /Proposal #2 in \*Smoke\* has run/);
  assert.match(at(-300), /Proposal #3 in \*Opti\* was challenged/);
  assert.match(at(-300), /challenge to proposal #2 in \*Opti\* failed - the proposal passes/);
  assert.match(at(-300), /Proposal #3 in \*Opti\* was cancelled/);
  assert.match(at(-400), /Proposal #2 in \*Conv\* has run/);
  assert.match(at(-600), /recalled/);
  assert.match(at(-600), /Election #1 in \*Deleg\* is decided/);
});
