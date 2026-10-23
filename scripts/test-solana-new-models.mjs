// Runs the Solana commands end to end against a local validator for the four newer Vortexes
// models - liquid, sortition, Sowellian and decision markets - with notifications. Like
// test-solana-local.mjs, wallet storage is stood in for in memory and everything else is real.
// Writes to data/chats.json (back it up first) and data/solanaListenerState.test-new.json.
//
// Sortition draws need ORAO VRF and Sowellian's oracle track needs a Pyth price account, so the
// validator also loads a stand-in for ORAO (the Vortexes repo's scripts/orao-stub: ORAO's own
// instructions and account layouts; the orao_vrf.so in ORAO's npm package predates request_v2)
// and a PriceUpdateV2 account for SOL/USD. This test sets ORAO's network up itself and answers
// its randomness requests as the fulfillment authority, as real ORAO's nodes do (an ed25519
// signature of the seed, which the stand-in doesn't check).
//
// 1. In the Vortexes repo: anchor build, and cargo build-sbf --manifest-path scripts/orao-stub/Cargo.toml.
//    Write the price account (feed SOL/USD, price 150,
//    published 30 minutes from now): node scripts/test-solana-new-models.mjs --price-account <file>
// 2. Start a fresh validator with the eleven programs at their declare_id! addresses, plus
//      --bpf-program VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y target/deploy/orao_stub.so
//      --account 7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE <file>
// 3. node --experimental-test-module-mocks --test scripts/test-solana-new-models.mjs
//    About 12 minutes: the flows run side by side, and sortition waits out a 10-minute term.
import { test, mock } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

const SOL_USD = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** A Pyth PriceUpdateV2 account (Full verification) for the validator's --account. */
function writePriceAccount(file) {
  const feed = Buffer.from(SOL_USD, "hex");
  const [address] = PublicKey.findProgramAddressSync([Buffer.alloc(2), feed], new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT"));
  const b = Buffer.alloc(8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8);
  let o = 0;
  Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]).copy(b, o);
  o += 8 + 32;
  b[o++] = 1; // VerificationLevel::Full
  feed.copy(b, o);
  o += 32;
  b.writeBigInt64LE(15_000_000_000n, o); // 150.00000000
  o += 8;
  b.writeBigUInt64LE(1_000_000n, o);
  o += 8;
  b.writeInt32LE(-8, o);
  o += 4;
  const publish = BigInt(Math.floor(Date.now() / 1000) + 1800);
  b.writeBigInt64LE(publish, o);
  b.writeBigInt64LE(publish, o + 8);
  const account = { lamports: 10_000_000, data: [b.toString("base64"), "base64"], owner: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", executable: false, rentEpoch: 0, space: b.length };
  fs.writeFileSync(file, JSON.stringify({ pubkey: address.toBase58(), account }));
  console.log(`${address.toBase58()} written to ${file}`);
}
if (process.argv[2] === "--price-account") {
  writePriceAccount(process.argv[3]);
  process.exit(0);
}

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
    // The EVM side's, loaded alongside but never used here.
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
const { startSolanaListener } = await import("../src/solana/listener.js");
const { getSolanaNetwork, IDLS } = await import("../src/solana/config.js");
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
  console.log(`\n> /${line}  [chat ${chatId}, user ${userId}]\n${r ? r.text : "(not a Solana matter - falls through)"}`);
  return r?.text ?? null;
};
const addressIn = (text) => text.match(/(?:^|[\s`])([1-9A-HJ-NP-Za-km-z]{32,44})(?=[\s`]|$)/)[1];
const field = (text, label) => text.match(new RegExp(`${label}: \`?([^\`\\s]+)`))[1];
const fund = async (to, sol) =>
  sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: new PublicKey(to), lamports: Math.round(sol * LAMPORTS_PER_SOL) })), [op]);
const solOf = async (k) => conn.getBalance(new PublicKey(k));

async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  const hubPda = pda([Buffer.from("hub")]);
  if (!(await conn.getAccountInfo(hubPda))) await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: hubPda, systemProgram: SystemProgram.programId }).rpc();
  for (const m of ["board", "liquid", "sortition", "sowellian", "decisionMarkets"]) {
    const gp = net.programs[m];
    await hub.methods.setModel(gp, m, true).accountsStrict({ admin: op.publicKey, hub: hubPda, model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
  }
}

// ORAO VRF, from its IDL (@orao-network/solana-vrf 0.8.0): init_network and fulfill_v2.
const ORAO = v.ORAO_VRF;
const oraoState = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-network-configuration")], ORAO)[0];
const fulfiller = ed25519.utils.randomPrivateKey();
const fulfillerKey = new PublicKey(ed25519.getPublicKey(fulfiller));

async function setUpOrao() {
  const fee = Buffer.alloc(8);
  fee.writeBigUInt64LE(10_000n);
  const data = Buffer.concat([Buffer.from([104, 231, 73, 121, 240, 0, 5, 148]), fee, op.publicKey.toBuffer(), Buffer.from([2, 0, 0, 0]), fulfillerKey.toBuffer(), op.publicKey.toBuffer(), Buffer.from([0])]);
  const ix = {
    programId: ORAO,
    keys: [
      { pubkey: op.publicKey, isSigner: true, isWritable: true },
      { pubkey: oraoState, isSigner: false, isWritable: true },
      { pubkey: op.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
  await sendAndConfirmTransaction(conn, new Transaction().add(ix), [op]);
}

/** Answers ORAO's request for `seed`, as its fulfillment authority does: the randomness is the authority's signature of the seed. */
async function fulfill(seed) {
  const request = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-randomness-request"), Buffer.from(seed)], ORAO)[0];
  const info = await conn.getAccountInfo(request);
  const client = new PublicKey(info.data.subarray(9, 41));
  const signature = ed25519.sign(Buffer.from(seed), fulfiller);
  const ix = {
    programId: ORAO,
    keys: [
      { pubkey: op.publicKey, isSigner: true, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: oraoState, isSigner: false, isWritable: true },
      { pubkey: request, isSigner: false, isWritable: true },
      { pubkey: client, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([164, 227, 237, 84, 112, 111, 147, 196]),
  };
  const verify = Ed25519Program.createInstructionWithPublicKey({ publicKey: fulfillerKey.toBytes(), message: Buffer.from(seed), signature });
  await sendAndConfirmTransaction(conn, new Transaction().add(verify, ix), [op]);
}

test("Solana commands end to end: liquid, sortition, Sowellian, decision markets", { timeout: 1_800_000 }, async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();
  await setUpOrao();
  await run(-9, 1, `createboarddao Wallets ${Keypair.generate().publicKey.toBase58()} solana`);
  const A = addressIn(await run(-9, 1, "wallet"));
  const B = addressIn(await run(-9, 2, "wallet"));
  const C = addressIn(await run(-9, 3, "wallet"));
  const pay = () => Keypair.generate().publicKey.toBase58();
  const posted = [];
  const flows = [];

  // ---------------- liquid ----------------
  flows.push(
    (async () => {
      const L = -200;
      const out = await run(L, 1, "createdao Liq LIQ 1000 2000 liquid solana");
      assert.match(out, /\(liquid\) created/);
      await fund(field(out, "Treasury"), 0.1);
      for (const [who, n] of [[A, 300], [B, 200], [C, 100]]) await run(L, 1, `tip ${n} ${who}`);
      for (const [u, n] of [[1, 300], [2, 200], [3, 100]]) assert.match(await run(L, u, `stake ${n}`), new RegExp(`Staked ${n} LIQ`));
      assert.match(await run(L, 2, `delegate ${A}`), /now votes with/);
      assert.match(await run(L, 3, `delegate ${B}`), /has delegated their own vote/);
      assert.match(await run(L, 1, `delegate ${C}`), /Members delegate to you/);
      assert.match(await run(L, 1, "balance"), /1 member\(s\) delegate 200 LIQ to you/);
      assert.match(await run(L, 3, `delegate ${A}`), /now votes with/);
      const to = pay();
      assert.match(await run(L, 1, `propose ${to} 0.002 SOL Liquid payment`), /delegate's vote carries/);
      assert.match(await run(L, 1, "vote 1 for"), /with 300 staked plus 300 delegated to you/);
      assert.match(await run(L, 2, "vote 1 against"), /overriding your delegate/);
      // Bob's override moved his 200 from Alice's "for"; Carol's 100 stays with Alice.
      assert.match(await run(L, 1, "proposal 1"), /For 400 · Against 200 · Abstain 0 LIQ/);
      assert.match(await run(L, 2, "undelegate"), /A vote you cast yourself is still open/);
      assert.match(await run(L, 3, "undelegate"), /A vote your delegate cast with your stake is still open/);
      assert.match(await run(L, 3, "balance"), /can't change for/);
      await waitPast(await clock(), 122);
      assert.match(await run(L, 1, "queue 1"), /Queued #1/);
      await waitPast(await clock(), 31);
      assert.match(await run(L, 1, "execute 1"), /executed/);
      assert.strictEqual(await solOf(to), 2_000_000);
      assert.match(await run(L, 2, "undelegate"), /no longer delegate/);
      assert.match(await run(L, 2, "unstake 50"), /Unstaked 50 LIQ/);
    })()
  );

  // ---------------- sortition ----------------
  flows.push(
    (async () => {
      const S = -300;
      const out = await run(S, 1, `createdao Sort SRT 1000 2000 sortition solana ${A}`);
      assert.match(out, /\(sortition\) created/);
      const created = await clock();
      await fund(field(out, "Treasury"), 0.1);
      await run(S, 1, `tip 100 ${B}`);
      await run(S, 1, `tip 100 ${A}`);
      const to = pay();
      assert.match(await run(S, 2, `propose ${to} 0.002 SOL Not council`), /Only council members/);
      assert.match(await run(S, 1, `propose ${to} 0.002 SOL Council payment`), /Council members vote/);
      assert.match(await run(S, 1, "vote 1 for"), /Voted \*for\*/);
      assert.match(await run(S, 2, "vote 1 for"), /Only council members/);
      assert.match(await run(S, 2, "registereligible"), /Stake some tokens first/);
      assert.match(await run(S, 2, "stake 100"), /next council draw/);
      assert.match(await run(S, 2, "registereligible"), /in the pool for the next council draw \(1 member/);
      assert.match(await run(S, 1, "startsortition"), /term ends in/);
      await waitPast(await clock(), 122);
      assert.match(await run(S, 1, "queue 1"), /Queued #1/);
      await waitPast(await clock(), 31);
      assert.match(await run(S, 1, "execute 1"), /executed/);
      await waitPast(created, 602);
      assert.match(await run(S, 1, "startsortition"), /Draw #1 started: 1 seat\(s\) from 1 member/);
      assert.match(await run(S, 1, "finalizesortition"), /hasn't arrived yet/);
      assert.match(await run(S, 2, "withdraweligibility"), /pool is frozen/);
      const g = await v.readGovernance(net, "sortition", (await v.readDao(net, new PublicKey(field(out, "DAO")))).governance);
      await fulfill(g.drawSeed);
      const fin = await run(S, 3, "finalizesortition");
      assert.match(fin, /Draw #1 is done/);
      assert.ok(fin.includes(B) && !fin.includes(A));
      assert.match(await run(S, 1, "council"), /Draw pool \(1\)/);
      assert.match(await run(S, 1, `propose ${pay()} 0.001 SOL Old council`), /Only council members/);
      assert.match(await run(S, 2, `propose ${pay()} 0.001 SOL New council`), /Proposal \*#2\*/);
    })()
  );

  // ---------------- Sowellian ----------------
  flows.push(
    (async () => {
      const W = -400;
      const out = await run(W, 1, "createdao Sow SOW 2000 3000 sowellian solana");
      assert.match(out, /\(Sowellian\) created/);
      await fund(field(out, "Treasury"), 0.1);
      await run(W, 1, `tip 800 ${A}`);
      await run(W, 1, `tip 500 ${B}`);
      assert.match(await run(W, 1, "stake 300"), /Staked 300 SOW/);
      assert.match(await run(W, 2, "stake 200"), /Staked 200 SOW/);
      const [to1, to2] = [pay(), pay()];
      // Human track, from the action library; then the oracle track, from /propose.
      assert.match(await run(W, 1, `proposeaction transfersol 0.002 ${to1} measure=60 Human goal`), /Proposal \*#1\*.*approval vote/s);
      const p2 = await run(W, 1, `propose ${to2} 0.002 SOL track=oracle feed=0x${SOL_USD} goal=100 when=min measure=60 Oracle goal`);
      assert.match(p2, /Proposal \*#2\*/);
      assert.doesNotMatch(p2, /no sponsored price account/);
      assert.match(await run(W, 3, `propose ${pay()} 0.001 SOL No bond`), /bond from your wallet/);
      assert.match(await run(W, 1, "vote 1 for"), /Voted \*for\* on #1's approval/);
      assert.match(await run(W, 2, "castapprovalvote 1 for"), /Voted \*for\*/);
      assert.match(await run(W, 1, "vote 2 for"), /Voted \*for\*/);
      assert.match(await run(W, 1, "finalizeapproval 1"), /closes in/);
      await waitPast(await clock(), 122);
      assert.match(await run(W, 1, "finalizeapproval 1"), /is approved/);
      assert.match(await run(W, 1, "queue 2"), /is approved/);
      assert.match(await run(W, 1, "takeposition 1 yes 50"), /Backed \*YES\*/);
      assert.match(await run(W, 2, "takeposition 1 no 30"), /YES 50 · NO 30/);
      assert.match(await run(W, 2, "takeposition 2 yes 10"), /Backed \*YES\*/);
      assert.match(await run(W, 1, "execute 1"), /ProposalNotExecutable|not/i);
      await waitPast(await clock(), 122 + 31);
      assert.match(await run(W, 1, "execute 1"), /executed/);
      assert.match(await run(W, 1, "execute 2"), /executed/);
      assert.strictEqual(await solOf(to1), 2_000_000);
      assert.match(await run(W, 1, "proposal 1"), /measured in/);
      assert.match(await run(W, 2, "proposeresolution 1 success"), /isn't waiting for a result/);
      await waitPast(await clock(), 62);
      assert.match(await run(W, 1, "resolveviaoracle 1"), /resolved by people/);
      assert.match(await run(W, 2, "proposeresolution 1 success"), /You said #1 was a \*success\*/);
      assert.match(await run(W, 1, "challengeresolution 1"), /Challenged the resolution/);
      assert.match(await run(W, 1, "vote 1 success"), /true outcome/);
      assert.match(await run(W, 2, "castadjudicationvote 1 failure"), /Voted \*failure\*/);
      assert.match(await run(W, 1, "resolveviaoracle 2"), /resolved from Pyth: \*success\*/);
      assert.match(await run(W, 2, "claimposition 2"), /your winnings: 10 SOW/);
      assert.match(await run(W, 1, "claimposition 2"), /your bond: 100 SOW/);
      await waitPast(await clock(), 122);
      assert.match(await run(W, 1, "finalizeadjudication 1"), /resolved: \*success\*/);
      // Alice: her YES position wins the whole pot (80) and her proposer bond comes back; her challenge bond is lost.
      assert.match(await run(W, 1, "claimposition 1"), /your winnings: 80 SOW and your bond: 100 SOW/);
      // Bob: his NO position lost, but he was the resolver and was right.
      assert.match(await run(W, 2, "claimposition 1"), /your bond: 100 SOW/);
      assert.match(await run(W, 2, "claimposition 1"), /nothing for you to collect/);
    })()
  );

  // ---------------- decision markets ----------------
  flows.push(
    (async () => {
      const M = -500;
      const out = await run(M, 1, "createdao Fut FUT 1000 2000 decisionmarkets solana");
      assert.match(out, /\(decision markets\) created/);
      await fund(field(out, "Treasury"), 0.1);
      await run(M, 1, `tip 300 ${A}`);
      await run(M, 1, `tip 100 ${B}`);
      await fund(A, 1);
      await fund(B, 1);
      const to = pay();
      assert.match(await run(M, 1, "stake 10"), /only applies to/);
      assert.match(await run(M, 1, `propose ${to} 0.002 SOL Pay`), /seed=<FUT>/);
      assert.match(await run(M, 1, `propose ${to} 0.002 SOL seed=50 quote=0.5 Pay from markets`), /Both markets trade/);
      assert.match(await run(M, 2, "trade 1 pass buy 0.1"), /Split some first/);
      assert.match(await run(M, 2, "split 1 quote 0.3"), /pass 0 FUT \+ 0.3 SOL · fail 0 FUT \+ 0.3 SOL/);
      assert.match(await run(M, 2, "trade 1 pass buy 0.2"), /Bought in the \*pass\* market/);
      assert.match(await run(M, 1, "split 1 base 20"), /Split 20 FUT/);
      assert.match(await run(M, 1, "trade 1 fail base 10"), /Sold in the \*fail\* market/);
      assert.match(await run(M, 1, "merge 1 base 5"), /Merged 5 FUT/);
      assert.match(await run(M, 1, "proposal 1"), /Pass market: .* · Fail market/);
      assert.match(await run(M, 1, "finalizeproposal 1"), /closes in/);
      await waitPast(await clock(), 302);
      assert.match(await run(M, 3, "finalizeproposal 1"), /#1 passed/);
      assert.match(await run(M, 1, "execute 1"), /ProposalNotExecutable|not/i);
      await waitPast(await clock(), 62);
      assert.match(await run(M, 1, "execute 1"), /executed/);
      assert.strictEqual(await solOf(to), 2_000_000);
      const bobBefore = await solOf(B);
      assert.match(await run(M, 2, "redeem 1"), /from #1's pass side/);
      assert.ok((await solOf(B)) > bobBefore, "Bob's leftover pass SOL came back unwrapped");
      assert.match(await run(M, 1, "redeem 1"), /Redeemed 15 FUT/);
      assert.match(await run(M, 2, "reclaimliquidity 1"), /Only the proposer/);
      assert.match(await run(M, 1, "reclaimliquidity 1"), /Took back the pass pool/);
      // Every payout came out of this proposal's own collateral: both vaults are empty.
      const g = await v.readGovernance(net, "decisionMarkets", (await v.readDao(net, new PublicKey(field(out, "DAO")))).governance);
      assert.strictEqual((await conn.getTokenAccountBalance(g.baseVault)).value.amount, "0");
      assert.strictEqual((await conn.getTokenAccountBalance(g.quoteVault)).value.amount, "0");
    })()
  );

  const statePath = new URL("../data/solanaListenerState.test-new.json", import.meta.url).pathname;
  const stopListener = startSolanaListener({ platform: "telegram", notify: async (chatId, text) => posted.push({ chatId, text }) }, 5_000, statePath);
  try {
    await Promise.all(flows);
    await sleep(12_000);
  } finally {
    stopListener();
  }
  console.log("\nNotifications posted:\n" + posted.map((p) => `[${p.chatId}] ${p.text}`).join("\n"));
  const at = (chat) => posted.filter((p) => p.chatId === String(chat)).map((p) => p.text).join("\n");
  assert.match(at(-200), /Proposal #1 in \*Liq\* has run/);
  assert.match(at(-300), /Council draw #1 in \*Sort\* is done/);
  assert.match(at(-400), /Proposal #1 in \*Sow\* is approved/);
  assert.match(at(-400), /resolution of proposal #1 in \*Sow\* was challenged/);
  assert.match(at(-400), /Proposal #2 in \*Sow\* is resolved: \*success\* \(from Pyth\)/);
  assert.match(at(-500), /Proposal #1 in \*Fut\* passed its markets/);
});
