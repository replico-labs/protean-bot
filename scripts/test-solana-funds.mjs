// A Solana DAO's money end to end against a local validator, through the bot's own Solana commands
// (wallet storage stood in for in memory, as in test-solana-switch.mjs). Writes to data/chats.json
// (back it up first).
//
// - A token-weighted DAO: a monthly allowance by proposal, claimed (twice in a month refused); its
//   Distributor opened, funded by proposal, a grant to a member's chat account claimed through the
//   operator; a raise past its hard cap accepted by proposal, settled, refunded and claimed pro rata.
// - A prop firm launched in one command: the founder accepts the raise, the money goes into the
//   vault and its first shares into the Distributor; a member claims shares, deposits at a window.
// - A Delegate DAO: candidacy per seat, one vote per seat, a tied seat drawn by ORAO (the stub).
//
// 1. In the Vortexes repo: build the programs (vortex_distribution and vortex_vault included) and
//    start a fresh validator with them and scripts/orao-stub at their addresses.
// 2. node --experimental-test-module-mocks --test scripts/test-solana-funds.mjs   (~15 minutes)
import { test, mock } from "node:test";
import assert from "node:assert";
import { Ed25519Program, Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";

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

const run = async (chatId, userId, line, extra = {}) => {
  const [name, ...args] = line.split(" ");
  const r = await runSolanaCommand(name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}`, ...extra });
  console.log(`\n> /${line}  [chat ${chatId}, user ${userId}]\n${r ? r.text : "(falls through)"}`);
  return r?.text ?? null;
};
const addressIn = (text) => text.match(/(?:^|[\s`])([1-9A-HJ-NP-Za-km-z]{32,44})(?=[\s`]|$)/)[1];
const idIn = (text) => Number(text.match(/Proposal \*#(\d+)\*/)[1]);
const sf = await import("../src/solana/funds.js");
const { accountId } = await import("../src/accountId.js");

async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  const hubPda = pda([Buffer.from("hub")]);
  if (!(await conn.getAccountInfo(hubPda))) await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: hubPda, systemProgram: SystemProgram.programId }).rpc();
  for (const [m, name] of Object.entries({ tokenWeighted: "token-weighted", delegate: "delegate" })) {
    const gp = net.programs[m];
    await hub.methods.setModel(gp, name, true).accountsStrict({ admin: op.publicKey, hub: hubPda, model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
  }
}

// ORAO's stand-in (the Vortexes repo's scripts/orao-stub), as test-solana-new-models.mjs sets it up and answers it.
const ORAO = v.ORAO_VRF;
const oraoState = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-network-configuration")], ORAO)[0];
const fulfiller = ed25519.utils.randomPrivateKey();
const fulfillerKey = new PublicKey(ed25519.getPublicKey(fulfiller));
async function setUpOrao() {
  const fee = Buffer.alloc(8);
  fee.writeBigUInt64LE(10_000n);
  const data = Buffer.concat([Buffer.from([104, 231, 73, 121, 240, 0, 5, 148]), fee, op.publicKey.toBuffer(), Buffer.from([2, 0, 0, 0]), fulfillerKey.toBuffer(), op.publicKey.toBuffer(), Buffer.from([0])]);
  const keys = [
    { pubkey: op.publicKey, isSigner: true, isWritable: true },
    { pubkey: oraoState, isSigner: false, isWritable: true },
    { pubkey: op.publicKey, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  await sendAndConfirmTransaction(conn, new Transaction().add({ programId: ORAO, keys, data }), [op]);
}
async function fulfill(seed) {
  const request = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-randomness-request"), Buffer.from(seed)], ORAO)[0];
  const info = await conn.getAccountInfo(request);
  const client = new PublicKey(info.data.subarray(9, 41));
  const signature = ed25519.sign(Buffer.from(seed), fulfiller);
  const keys = [
    { pubkey: op.publicKey, isSigner: true, isWritable: true },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: oraoState, isSigner: false, isWritable: true },
    { pubkey: request, isSigner: false, isWritable: true },
    { pubkey: client, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const verify = Ed25519Program.createInstructionWithPublicKey({ publicKey: fulfillerKey.toBytes(), message: Buffer.from(seed), signature });
  await sendAndConfirmTransaction(conn, new Transaction().add(verify, { programId: ORAO, keys, data: Buffer.from([164, 227, 237, 84, 112, 111, 147, 196]) }), [op]);
}

/** Votes each proposal through, then queues them, in one round (the fast timings: 2 minutes, then 30 s). */
async function passAll(chat, ids, voter = 1) {
  for (const p of ids) assert.match(await run(chat, voter, `vote ${p} for`), /Voted \*for\*/);
  await waitPast(await clock(), 122);
  for (const p of ids) assert.match(await run(chat, voter, `queue ${p}`), new RegExp(`Queued #${p}`));
  await waitPast(await clock(), 31);
}

async function usdcTo(mint, users) {
  for (const [u, amount] of users) {
    const kp = await getOrCreateSolanaKeypair(String(u), "telegram");
    const ata = await getOrCreateAssociatedTokenAccount(conn, op, mint, kp.publicKey);
    await mintTo(conn, op, mint, ata.address, op, amount * 1_000_000);
  }
}

test("a Solana DAO's allowances, Distributor, raises, prop-firm launch and council seats", { timeout: 2_400_000 }, async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 200 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();
  await setUpOrao();
  const usdc = await createMint(conn, op, op.publicKey, null, 6);
  const T = -401;
  const P = -402;
  const D = -403;

  // 1. A token-weighted DAO: an allowance and the Distributor.
  let out = await run(T, 1, "createdao Funder FND 1000 2000 solana");
  assert.match(out, /\(token-weighted\) created/);
  const A = addressIn(await run(T, 1, "wallet"));
  const B = addressIn(await run(T, 2, "wallet"));
  const C = addressIn(await run(T, 3, "wallet"));

  // The Delegate DAO now: its council's 10-minute term runs while the rest goes on.
  out = await run(D, 1, `createdao Seats STS 1000 2000 delegate solana ${A}`);
  assert.match(out, /\(delegate\) created/);
  assert.match(await run(D, 1, `tip 300 ${B}`), /Sent 300/);
  assert.match(await run(D, 1, `tip 300 ${C}`), /Sent 300/);
  const delegateStart = await clock();

  const link = getChatSolana(T, "telegram");
  const dao = new PublicKey(link.dao);
  let d = await v.readDao(net, dao);
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: op.publicKey, toPubkey: d.treasury, lamports: 2 * LAMPORTS_PER_SOL })), [op]);
  assert.match(await run(T, 1, `tip 600 ${A}`), /Sent 600 FND/);
  assert.match(await run(T, 1, "stake 300"), /Staked 300 FND/);
  // Treasury tokens for the Distributor and the raise's sale.
  assert.match(await run(T, 1, "tip 300 treasury"), /Sent 300 FND/);

  assert.match(await run(T, 1, "allowance"), /No allowances yet/);
  assert.match(await run(T, 1, "distributor open"), /Distributor made/);
  assert.match(await run(T, 1, "distributor"), /Promised, not yet claimed: 0/);
  out = await run(T, 1, `allowance grant ${B} 0.01 sol 3 Pay B monthly`);
  assert.match(out, /pay `.*` 0\.01 SOL a month until/);
  const allowanceProposal = idIn(out);
  out = await run(T, 1, "distributor fund 250 Fund it");
  assert.match(out, /move 250 FND into the Distributor/);
  const fundProposal = idIn(out);
  await passAll(T, [allowanceProposal, fundProposal]);
  assert.match(await run(T, 1, `execute ${allowanceProposal}`), /executed/);
  assert.match(await run(T, 1, `execute ${fundProposal}`), /executed/);
  assert.match(await run(T, 1, "allowance"), /#1 `.*` 0\.01 SOL\/month until .* - claimable now/);
  const before = await conn.getBalance(new PublicKey(B));
  assert.match(await run(T, 2, "allowance claim 1"), /Paid 0\.01 SOL/);
  assert.ok((await conn.getBalance(new PublicKey(B))) > before, "the recipient is paid from the treasury");
  assert.match(await run(T, 2, "allowance claim 1"), /already claimed|AllowanceAlreadyClaimed/i);
  assert.match(await run(T, 3, "allowance claim 1"), /not your wallet/);

  // A grant to a member's chat account (user 33333 hasn't even got a wallet yet).
  out = await run(T, 1, "distributor grant 33333 25 A welcome present");
  assert.match(out, /grant 25 FND to a member's chat account/);
  await passAll(T, [idIn(out)]);
  assert.match(await run(T, 1, `execute ${idIn(out)}`), /executed/);
  assert.match(await run(T, 3, "claim"), /holds nothing for you/);
  assert.match(await run(T, 33333, "claim"), /Claimed 25 FND/);

  // 2. A raise past its hard cap, accepted by proposal.
  await usdcTo(usdc, [[1, 500], [2, 500]]);
  out = await run(T, 1, `raise open ${usdc.toBase58()} 100 200 2m 100`);
  assert.match(out, /Raise open: `.*`, 100 to 200 over 2m/);
  assert.match(await run(T, 1, "contribute 150"), /Contributed 150/);
  assert.match(await run(T, 2, "contribute 100"), /Contributed 100/);
  assert.match(await run(T, 1, "raise"), /Raised 250 · soft cap 100, target 200/);
  await waitPast(await clock(), 125);
  assert.match(await run(T, 1, "raise"), /deciding/);
  out = await run(T, 1, "raise accept 200 Take 200");
  assert.match(out, /accept 200 of the 250 raised/);
  await passAll(T, [idIn(out)]);
  assert.match(await run(T, 1, `execute ${idIn(out)}`), /executed/);
  const raised = await conn.getTokenAccountBalance(v.tokenAccount(usdc, d.treasury));
  assert.strictEqual(raised.value.uiAmount, 200, "the accepted 200 is in the treasury");
  assert.match(await run(T, 3, "raise settle"), /Settled 2 contributors/);
  assert.match(await run(T, 1, "refund"), /Refunded 30/);
  assert.match(await run(T, 2, "refund"), /Refunded 20/);
  assert.match(await run(T, 1, "claim"), /Claimed 60 FND/);
  assert.match(await run(T, 2, "claim"), /Claimed 40 FND/);

  // 3. A prop firm, launched in one command; the founder (user 5) accepts.
  await usdcTo(usdc, [[1, 500], [2, 500], [5, 0]]);
  out = await run(P, 5, `launch tokenweighted Firm FRM 0 propfirm ${usdc.toBase58()} 100 1000 2m solana`);
  assert.match(out, /Firm\* launched on .*: raising 100 to 1000/);
  assert.match(out, /the shares of its vault/);
  assert.match(await run(P, 1, "contribute 300"), /Contributed 300/);
  assert.match(await run(P, 2, "contribute 100"), /Contributed 100/);
  assert.match(await run(P, 1, "launch finish 400"), /Only the launch's founder/);
  await waitPast(await clock(), 125);
  assert.match(await run(P, 5, "launch finish 400"), /Accepted 400: it's in the DAO's vault, whose first shares are in the Distributor/);
  const pd = await v.readDao(net, new PublicKey(getChatSolana(P, "telegram").dao));
  const vault = await sf.readVault(net, pd);
  assert.strictEqual((await conn.getTokenAccountBalance(vault.assets)).value.uiAmount, 400, "the money is in the vault");
  assert.match(await run(P, 3, "raise settle"), /Settled 2 contributors/);
  assert.match(await run(P, 1, "claim"), /Claimed 300 FRM/);
  assert.match(await run(P, 1, "vault"), /Vault\* `.*`[\s\S]*400 shares/);
  assert.match(await run(P, 2, "vault deposit 50"), /50 waiting for the window/);
  await waitPast(Number(vault.nextWindowAt), 2);
  assert.match(await run(P, 3, "vault window"), /processed/);
  assert.match(await run(P, 2, "vault claim"), /Claimed 50 shares/);

  // 4. Council seats: B and C both run for seat 1 and tie; the draw decides.
  await waitPast(delegateStart, 602);
  assert.match(await run(D, 2, "stake 300"), /Staked 300/);
  assert.match(await run(D, 3, "stake 300"), /Staked 300/);
  out = await run(D, 2, "startelection");
  assert.match(out, /Election #1 is open/);
  assert.match(await run(D, 2, "declarecandidacy 1 1"), /running for seat 1/);
  assert.match(await run(D, 3, "declarecandidacy 1 1"), /running for seat 1/);
  assert.match(await run(D, 3, "declarecandidacy 1 2"), /Seats are numbered 1 to 1/);
  await waitPast(await clock(), 122);
  assert.match(await run(D, 2, `voteinelection 1 ${B} ${C}`), /one candidate per seat/);
  assert.match(await run(D, 2, `voteinelection 1 ${B}`), /Voted for 1/);
  assert.match(await run(D, 3, `voteinelection 1 ${C}`), /Voted for 1/);
  assert.match(await run(D, 1, "seats 1"), /Seat 1\*: `.*`\n  `.*` 300 votes\n  `.*` 300 votes/);
  await waitPast(await clock(), 122);
  assert.match(await run(D, 1, "finalizeelection 1"), /tied, so it's drawn by lot/);
  const dd = await v.readDao(net, new PublicKey(getChatSolana(D, "telegram").dao));
  await fulfill(sf.tieSeed(dd.governance, 1));
  assert.match(await run(D, 1, "finalizeelection 1"), /Election #1 closed/);
  const seat = (await run(D, 1, "seats")).match(/Seat 1\*: `([^`]+)`/)[1];
  assert.ok([B, C].includes(seat), `the seat went to one of the tied candidates (${seat})`);
});
