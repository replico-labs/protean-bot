// Proposal pages for Solana DAOs (src/proposalPages.js + src/solana/pages.js), end to end
// against a local validator: the edit link a proposer gets, the page's live data, the
// once-only submission, and the "too late once people vote" rule. Supabase (wallets and
// proposal_details) and KMS are stood in for in memory; the commands, db.js and the
// Vortexes programs are real. Writes to data/chats.json - back it up first.
//
// Start a fresh validator with the programs, as for scripts/test-solana-local.mjs, then:
//   node --experimental-test-module-mocks --test scripts/test-solana-pages.mjs
// About 1 minute.
import { test, mock } from "node:test";
import assert from "node:assert";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

const op = Keypair.generate();
process.env.SOLANA_ENABLED = "true";
process.env.SOLANA_DEVNET_RPC_URL = "http://127.0.0.1:8899";
process.env.SOLANA_DEVNET_FAST_TIMINGS = "true";
process.env.SOLANA_OPERATOR_KEY = JSON.stringify(Array.from(op.secretKey));
process.env.PROPOSAL_SITE_URL = "https://protean.example";
process.env.PROPOSAL_LINK_SECRET = "test-secret";
process.env.SUPABASE_URL = "https://supabase.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";

const rows = new Map();
const keyOf = (p, u) => `${p}:${u}`;
mock.module(new URL("../src/walletStore.js", import.meta.url).href, {
  namedExports: {
    isWalletStoreConfigured: () => true,
    recordGasTopup: async () => 1,
    createWalletRecord: async () => null,
    getWalletAccount: async () => null,
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

// proposal_details in memory: just the query shapes proposalPages.js uses.
const details = [];
const matches = (row, k) => Object.entries(k).every(([f, val]) => row[f] === val);
function query() {
  const q = { filters: {}, nullField: null, op: null, payload: null };
  const run = () => {
    const hit = details.filter((r) => matches(r, q.filters) && (q.nullField === null || r[q.nullField] == null));
    if (q.op === "update") {
      hit.forEach((r) => Object.assign(r, q.payload));
      return { data: hit.map((r) => ({ proposal_id: r.proposal_id })), error: null };
    }
    return { data: hit, error: null };
  };
  const builder = {
    upsert(row) {
      if (!details.some((r) => matches(r, { network: row.network, dao: row.dao, proposal_id: row.proposal_id }))) details.push({ ...row, title: null, created_at: new Date().toISOString() });
      return Promise.resolve({ error: null });
    },
    select() {
      return builder;
    },
    update(payload) {
      q.op = "update";
      q.payload = payload;
      return builder;
    },
    match(k) {
      Object.assign(q.filters, k);
      return builder;
    },
    is(field) {
      q.nullField = field;
      return builder;
    },
    maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
    then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => ({ from: () => query() }) } });

const anchor = (await import("@coral-xyz/anchor")).default;
const { runSolanaCommand } = await import("../src/solana/commands.js");
const pages = await import("../src/proposalPages.js");
const { getSolanaNetwork, IDLS } = await import("../src/solana/config.js");
const net = getSolanaNetwork("solana-devnet");
const conn = net.connection;

const run = async (chatId, userId, line) => {
  const [name, ...args] = line.split(" ");
  const r = await runSolanaCommand(name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}` });
  console.log(`\n> /${line}  [user ${userId}]\n${r?.text}${r?.privateFollowUp ? `\n  [private] ${r.privateFollowUp.split("\n")[0]}` : ""}`);
  return r;
};
const addressIn = (text) => text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/)[1];
const field = (text, label) => text.match(new RegExp(`${label}: \`([^\`]+)\``))[1];
/** The page's network, governance and id, and the edit token, from the private link. */
function editLink(text) {
  const url = new URL(text.match(/https:\/\/protean\.example\S+/)[0]);
  const [, , network, dao, id] = url.pathname.split("/");
  return { network, dao, id, token: url.searchParams.get("edit") };
}

async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  const hubPda = pda([Buffer.from("hub")]);
  if (!(await conn.getAccountInfo(hubPda))) await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: hubPda, systemProgram: SystemProgram.programId }).rpc();
  for (const m of ["tokenWeighted", "board"]) {
    const gp = net.programs[m];
    await hub.methods.setModel(gp, m, true).accountsStrict({ admin: op.publicKey, hub: hubPda, model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
  }
}

test("Solana proposal pages", { timeout: 300_000 }, async () => {
  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 50 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();

  // Token-weighted: alice (1) proposes, bob (2) watches.
  const T = -500;
  let r = await run(T, 1, "createdao Pages PGS 1000 2000 solana");
  assert.match(r.text, /\(token-weighted\) created/);
  await run(T, 1, `tip 600 ${addressIn((await run(T, 1, "wallet")).text)}`);
  await run(T, 1, "stake 600");
  const to = Keypair.generate().publicKey.toBase58();
  r = await run(T, 1, `propose ${to} 0.002 SOL Pay the designer`);
  assert.match(r.text, /📄 https:\/\/protean\.example\/p\/solana-devnet\/[1-9A-HJ-NP-Za-km-z]+\/1 /);
  assert.match(r.privateFollowUp, /only you have this link/);
  const link = editLink(r.privateFollowUp);
  assert.strictEqual(link.network, "solana-devnet");
  assert.match(r.startPayload, /^ps_0_[1-9A-HJ-NP-Za-km-z]{32,44}_1$/);
  assert.ok(r.startPayload.length <= 64);
  assert.deepStrictEqual(pages.parseProposalStartPayload(r.startPayload), { network: "solana-devnet", dao: link.dao, proposalId: "1" });
  assert.strictEqual(await pages.knownDaoModel("solana-devnet", link.dao), "tokenWeighted");

  // The page's data.
  let page = await pages.getProposalPage("solana", link.dao, "1");
  assert.strictEqual(page.status, 200, JSON.stringify(page.body));
  const { live } = page.body;
  console.log("\nlive:", JSON.stringify(live, null, 2));
  assert.strictEqual(live.model, "tokenWeighted");
  assert.strictEqual(live.state, "Active");
  assert.strictEqual(live.description, "Pay the designer");
  assert.strictEqual(live.explorerQuery, "?cluster=devnet");
  assert.deepStrictEqual(live.actions.map((a) => a.label), [`pay 0.002 SOL to ${to}`]);
  assert.ok(live.times.some((t) => t.label === "Voting closes" && t.at > 0));
  assert.strictEqual(page.body.submittable, true);
  assert.strictEqual(page.body.details, null);

  // /proposal: the proposer gets their link again, nobody else does.
  r = await run(T, 1, "proposal 1");
  assert.match(r.text, /📄 Details and live status: https:\/\/protean\.example\/p\/solana-devnet\//);
  assert.match(r.privateFollowUp ?? "", /only you have this link/);
  r = await run(T, 2, "proposal 1");
  assert.strictEqual(r.privateFollowUp, undefined);

  // Submitting: a forged token fails, the real one works once.
  assert.strictEqual((await pages.saveProposalPage("solana-devnet", link.dao, "1", { token: "x.y", title: "Hi" })).status, 403);
  const lowercase = link.dao.toLowerCase();
  assert.notStrictEqual((await pages.saveProposalPage("solana-devnet", lowercase, "1", { token: link.token, title: "Hi" })).status, 200, "Solana addresses are case-sensitive");
  let saved = await pages.saveProposalPage("solana-devnet", link.dao, "1", { token: link.token, title: "Pay the designer", summary: "For the logo", body: "Two rounds.", links: [{ label: "Brief", url: "https://example.com/brief" }] });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  saved = await pages.saveProposalPage("solana-devnet", link.dao, "1", { token: link.token, title: "Changed" });
  assert.strictEqual(saved.status, 409);
  page = await pages.getProposalPage("solana-devnet", link.dao, "1");
  assert.strictEqual(page.body.details.title, "Pay the designer");
  assert.strictEqual(page.body.submittable, false);

  // Second and third proposals, both voted on: inside the grace period the
  // proposer can still add details; once it's over, only if nobody voted.
  r = await run(T, 1, `propose ${to} 0.001 SOL Second payment`);
  const second = editLink(r.privateFollowUp);
  assert.strictEqual(second.id, "2");
  r = await run(T, 1, `propose ${to} 0.001 SOL Third payment`);
  const third = editLink(r.privateFollowUp);
  await run(T, 1, "vote 2 for");
  await run(T, 1, "vote 3 for");
  page = await pages.getProposalPage("solana-devnet", second.dao, "2");
  assert.deepStrictEqual(page.body.detailsWindow, { graceHours: 6, windowHours: 72 });
  assert.strictEqual(page.body.live.started, true);
  assert.strictEqual(page.body.submittable, true, "voting has started, but the grace period hasn't ended");
  assert.strictEqual(page.body.live.facts.find((f) => f.label === "For").value, "600");
  saved = await pages.saveProposalPage("solana-devnet", second.dao, "2", { token: second.token, title: "Within the grace period" });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  process.env.PROPOSAL_DETAILS_GRACE_HOURS = "0";
  page = await pages.getProposalPage("solana-devnet", third.dao, "3");
  assert.strictEqual(page.body.submittable, false);
  saved = await pages.saveProposalPage("solana-devnet", third.dao, "3", { token: third.token, title: "Late" });
  assert.strictEqual(saved.status, 409);
  assert.match(saved.body.error, /too late to add details: the first 0 hours are over/);

  // Board (no grace period still): the proposer's own confirmation doesn't close the window.
  const B = -501;
  const bob = addressIn((await run(T, 2, "wallet")).text);
  const alice = addressIn((await run(T, 1, "wallet")).text);
  r = await run(B, 1, `createboarddao Board ${alice} ${bob} solana`);
  assert.match(r.text, /created/);
  r = await run(B, 1, `propose ${to} 0.001 SOL Board payment`);
  const board = editLink(r.privateFollowUp);
  page = await pages.getProposalPage("solana-devnet", board.dao, "1");
  assert.strictEqual(page.body.live.model, "board");
  assert.strictEqual(page.body.submittable, true, "the proposer's own confirmation doesn't count as backing");
  assert.match(page.body.live.facts.find((f) => f.label === "Confirmations").value, /^1 of 2$/);
  await run(B, 2, "confirm 1");
  page = await pages.getProposalPage("solana-devnet", board.dao, "1");
  assert.strictEqual(page.body.submittable, false);
  delete process.env.PROPOSAL_DETAILS_GRACE_HOURS;

  // Not-ours and malformed addresses.
  assert.strictEqual((await pages.getProposalPage("solana-devnet", Keypair.generate().publicKey.toBase58(), "1")).status, 404);
  assert.strictEqual((await pages.getProposalPage("solana-devnet", "0xnotbase58", "1")).status, 400);
  assert.strictEqual((await pages.getProposalPage("solana-devnet", link.dao, "99")).status, 404);

  // EVM links are unchanged.
  const evm = "0x1111111111111111111111111111111111111111";
  assert.deepStrictEqual(pages.parseProposalStartPayload(pages.proposalStartPayload("monad-testnet", evm, 7)), { network: "monad-testnet", dao: evm, proposalId: "7" });
  assert.strictEqual(pages.proposalPageUrl("monad-testnet", evm.toLowerCase(), 7), `https://protean.example/p/monad-testnet/${evm}/7`);
});
