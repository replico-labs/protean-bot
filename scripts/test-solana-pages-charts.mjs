// Solana proposal pages, vote charts and explorer links, end to end against a local validator:
// a DAO per chart-drawing model proposes; its page is served through the bot's real HTTP API
// (GET live data, POST the proposer's details, edit with the password); /proposal returns its
// chart; the listener posts each vote's result with a chart and the page link once it closes;
// and every reply that sent a transaction carries its explorer link.
//
// Wallet storage (Supabase/KMS) and the proposal_details tables are stood in for in memory;
// the commands, the page API, db.js, the listener and the Vortexes programs are real. Backs up
// and restores data/chats.json.
//
// 1. In the Vortexes repo: anchor build, then start a fresh validator with the eleven programs
//    at the IDs in their declare_id! (see scripts/test-solana-local.mjs).
// 2. node --experimental-test-module-mocks --test scripts/test-solana-pages-charts.mjs
//    About 5 minutes (fast timings: votes last minutes).
import { test, mock } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, PublicKey } from "@solana/web3.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const op = Keypair.generate();
process.env.SOLANA_ENABLED = "true";
process.env.SOLANA_DEVNET_RPC_URL = "http://127.0.0.1:8899";
process.env.SOLANA_DEVNET_FAST_TIMINGS = "true";
process.env.SOLANA_OPERATOR_KEY = JSON.stringify(Array.from(op.secretKey));
process.env.PROPOSAL_SITE_URL = "https://site.test";
process.env.PROPOSAL_LINK_SECRET = "test-secret-".padEnd(48, "x");
process.env.SUPABASE_URL = "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test";

// ---- stand-ins: wallets ----
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

// ---- stand-in: Supabase tables, enough of the query builder for proposalPages.js ----
const tables = { proposal_details: [], proposal_detail_versions: [] };
const matches = (row, filters) => filters.every(([k, op, val]) => (op === "is" ? (row[k] ?? null) === val : row[k] === val));
function query(table) {
  const q = { filters: [], op: "select", order: null };
  const run = () => {
    const all = tables[table];
    if (q.op === "insert") {
      all.push({ saved_at: new Date().toISOString(), ...q.row });
      return { data: null, error: null };
    }
    if (q.op === "upsert") {
      const keys = q.opts.onConflict.split(",");
      const existing = all.find((r) => keys.every((k) => r[k] === q.row[k]));
      if (!existing) all.push({ ...q.row });
      else if (!q.opts.ignoreDuplicates) Object.assign(existing, q.row);
      return { data: null, error: null };
    }
    const hit = all.filter((r) => matches(r, q.filters));
    if (q.op === "update") hit.forEach((r) => Object.assign(r, q.patch));
    let data = hit.map((r) => ({ ...r }));
    if (q.order) data.sort((a, b) => a[q.order] - b[q.order]);
    if (q.single) data = data[0] ?? null;
    return { data, error: null };
  };
  const b = {
    select: () => b,
    match: (o) => (q.filters.push(...Object.entries(o).map(([k, v]) => [k, "eq", v])), b),
    is: (k, v) => (q.filters.push([k, "is", v]), b),
    order: (k) => ((q.order = k), b),
    maybeSingle: () => ((q.single = true), b),
    insert: (row) => ((q.op = "insert"), (q.row = row), b),
    upsert: (row, opts) => ((q.op = "upsert"), (q.row = row), (q.opts = opts), b),
    update: (patch) => ((q.op = "update"), (q.patch = patch), b),
    then: (ok, bad) => Promise.resolve().then(run).then(ok, bad),
  };
  return b;
}
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => ({ from: query }) } });

const chatsFile = path.join(root, "data", "chats.json");
const backup = fs.existsSync(chatsFile) ? fs.readFileSync(chatsFile) : null;

const anchor = (await import("@coral-xyz/anchor")).default;
const { runSolanaCommand } = await import("../src/solana/commands.js");
const { startSolanaListener } = await import("../src/solana/listener.js");
const { getSolanaNetwork, IDLS } = await import("../src/solana/config.js");
const { startProposalApi } = await import("../src/proposalPages.js");
const { withTxTracking, takeTxLinks } = await import("../src/txLinks.js");
const net = getSolanaNetwork("solana-devnet");
const conn = net.connection;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A command as the platforms run it: inside tx tracking, explorer links appended (platforms/commands.js). */
const run = (chatId, userId, line) =>
  withTxTracking(async () => {
    const [name, ...args] = line.split(" ");
    const r = await runSolanaCommand(name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}` });
    assert.ok(r, `/${line} wasn't handled as a Solana command`);
    const links = takeTxLinks();
    const out = { ...r, text: r.text + links };
    console.log(`\n> /${line}  [chat ${chatId}, user ${userId}]\n${out.text}${out.image ? `\n[chart ${out.image.name}, ${out.image.png.length} bytes]` : ""}`);
    return out;
  });
const addressIn = (text) => text.match(/`([1-9A-HJ-NP-Za-km-z]{32,44})`/)[1];
const isPng = (image) => image && image.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const TX_LINK = /🔗 https:\/\/explorer\.solana\.com\/tx\/[1-9A-HJ-NP-Za-km-z]+\?cluster=/;

async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  const hubPda = pda([Buffer.from("hub")]);
  if (!(await conn.getAccountInfo(hubPda))) await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: hubPda, systemProgram: SystemProgram.programId }).rpc();
  for (const m of ["tokenWeighted", "quadratic", "optimistic", "board", "conviction", "delegate", "liquid"]) {
    const gp = net.programs[m];
    await hub.methods.setModel(gp, m, true).accountsStrict({ admin: op.publicKey, hub: hubPda, model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
  }
}

test("Solana proposal pages, charts and explorer links", { timeout: 1_200_000 }, async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = await startProposalApi(port);
  const api = (p, init) => fetch(`http://127.0.0.1:${port}/api/proposals/${p}`, init).then(async (r) => ({ status: r.status, body: await r.json() }));
  const posted = [];
  let stopListener = () => {};
  t.after(() => {
    stopListener();
    server?.close?.();
    if (backup) fs.writeFileSync(chatsFile, backup);
  });

  await conn.confirmTransaction(await conn.requestAirdrop(op.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  await setUpHub();
  // Wallets for alice (1), bob (2), carol (3), through a throwaway board link.
  await run(-9, 1, `createboarddao Wallets ${Keypair.generate().publicKey.toBase58()} solana`);
  const A = addressIn((await run(-9, 1, "wallet")).text);
  const B = addressIn((await run(-9, 2, "wallet")).text);
  const C = addressIn((await run(-9, 3, "wallet")).text);
  const pay = () => Keypair.generate().publicKey.toBase58();

  // ---- token-weighted: the page, its details, charts and links ----
  const T = -201;
  let out = await run(T, 1, "createdao Pages PGS 1000 2000 solana");
  assert.match(out.text, /\(token-weighted\) created/);
  assert.match(out.text, TX_LINK, "creating the DAO links its transactions");
  await run(T, 1, `tip 500 ${A}`);
  await run(T, 1, `tip 400 ${B}`);
  out = await run(T, 1, "stake 500");
  assert.match(out.text, /Staked 500 PGS/);
  assert.match(out.text, TX_LINK, "staking links its transaction");
  await run(T, 2, "stake 400");
  out = await run(T, 1, `propose ${pay()} 0.01 SOL Fund the docs`);
  assert.match(out.text, TX_LINK, "proposing links its transaction");
  const pageUrl = out.text.match(/📄 (https:\/\/site\.test\/p\/solana-devnet\/([1-9A-HJ-NP-Za-km-z]+)\/1)/);
  assert.ok(pageUrl, "the proposal reply links its page");
  const governance = pageUrl[2];
  assert.match(out.privateFollowUp ?? "", /\?edit=/, "the proposer gets a private edit link");
  const token = new URL(out.privateFollowUp.match(/https:\/\/site\.test\/\S+\?edit=\S+/)[0]).searchParams.get("edit");

  let page = await api(`solana-devnet/${governance}/1`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.equal(page.body.live.model, "tokenWeighted");
  assert.equal(page.body.live.state, "Active");
  assert.equal(page.body.details, null);
  assert.equal(page.body.submittable, true);
  assert.ok(page.body.live.actions[0].label.includes("SOL"), "the action is described in words");

  const save = (body) => api(`solana-devnet/${governance}/1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, ...body }) });
  let saved = await save({ password: "correct horse", title: "Docs sprint", summary: "Pay the writer", body: "Two weeks of docs.", links: [] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal((await save({ password: "wrong password", title: "Hijacked", summary: "", body: "", links: [] })).status, 403);
  saved = await save({ password: "correct horse", title: "Docs sprint (v2)", summary: "Pay the writer", body: "Two weeks of docs.", links: [] });
  assert.equal(saved.body.version, 2);
  page = await api(`solana-devnet/${governance}/1`);
  assert.equal(page.body.details.title, "Docs sprint (v2)");
  assert.equal(page.body.history.length, 2);
  assert.notEqual((await api(`solana-devnet/${governance.toLowerCase()}/1`)).status, 200, "Solana addresses are case-sensitive");
  assert.equal((await api(`solana-devnet/${governance}/9`)).status, 404);

  out = await run(T, 1, "vote 1 for");
  assert.match(out.text, TX_LINK, "votes link their transaction");
  await run(T, 2, "vote 1 against");
  out = await run(T, 3, "proposal 1");
  assert.ok(isPng(out.image), "/proposal returns a chart");
  assert.match(out.text, /📄 Details and live status: https:\/\/site\.test\/p\/solana-devnet\//);

  // ---- council and conviction models: /proposal charts ----
  const D = -202;
  await run(D, 1, `createdao Council CNL 1000 2000 delegate solana ${A} ${B}`);
  await run(D, 1, `propose ${pay()} 0.01 SOL Council pays`);
  await run(D, 1, "vote 1 for");
  out = await run(D, 3, "proposal 1");
  assert.ok(isPng(out.image), "council votes get a chart");

  const V = -203;
  await run(V, 1, "createdao Backing BCK 1000 2000 conviction solana");
  await run(V, 1, `tip 300 ${A}`);
  await run(V, 1, "stake 300");
  await run(V, 1, `propose ${pay()} 0.01 SOL Back this`);
  await run(V, 1, "support 1");
  out = await run(V, 3, "proposal 1");
  assert.ok(isPng(out.image), "conviction gets its progress chart");

  const Q = -204;
  await run(Q, 1, "createdao Square SQR 1000 2000 quadratic solana");
  await run(Q, 1, `tip 400 ${A}`);
  await run(Q, 1, "stake 400");
  const B2 = await run(Q, 1, `propose ${pay()} 0.01 SOL Quadratic pays`);
  assert.match(B2.text, /📄 https:\/\/site\.test\/p\/solana-devnet\//);
  await run(Q, 1, "vote 1 for");

  const O = -205;
  await run(O, 1, "createdao Calm CLM 1000 2000 optimistic solana");
  await run(O, 1, `tip 500 ${A}`);
  await run(O, 1, "stake 500");
  await run(O, 1, `propose ${pay()} 0.01 SOL Quiet one`);


  // ---- the listener: links on notices, and every vote's result with its chart ----
  const statePath = path.join(root, "data", `solanaListenerState.pagestest.json`);
  fs.rmSync(statePath, { force: true });
  // Started after the DAOs exist, so its first look records where each is; these proposals open votes it sees.
  stopListener = startSolanaListener({ platform: "telegram", notify: async (chatId, text, opts = {}) => posted.push({ chatId: String(chatId), text, image: opts.image ?? null }) }, 3_000, statePath);
  await sleep(8_000);
  await run(T, 1, `propose ${pay()} 0.01 SOL Second one`);
  await run(T, 1, "vote 2 for");
  await run(Q, 1, `propose ${pay()} 0.01 SOL Second square`);
  await run(Q, 1, "vote 2 for");
  await run(O, 1, `propose ${pay()} 0.01 SOL Quiet two`);
  await run(D, 1, `propose ${pay()} 0.01 SOL Council two`);
  await run(D, 1, "vote 2 for");
  await run(D, 2, "vote 2 for");

  const closed = (chat, id) => posted.find((p) => p.chatId === String(chat) && p.text.includes(`Voting on proposal #${id}`) && p.text.includes("has closed"));
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline && ![[T, 2], [Q, 2], [O, 2], [D, 2]].every(([c, id]) => closed(c, id))) await sleep(5_000);
  console.log("\nNotifications posted:\n" + posted.map((p) => `[${p.chatId}] ${p.text}${p.image ? ` [chart ${p.image.png.length} bytes]` : ""}`).join("\n"));

  const created = posted.find((p) => p.chatId === String(T) && p.text.includes("New proposal #2"));
  assert.ok(created, "the listener announced the new proposal");
  assert.match(created.text, TX_LINK, "notices link their transaction");
  assert.match(created.text, /📄 https:\/\/site\.test\/p\/solana-devnet\/.+\/2/, "a new proposal's notice links its page");

  for (const [chat, label] of [[T, "token-weighted"], [Q, "quadratic"], [D, "delegate"]]) {
    const c = closed(chat, 2);
    assert.ok(c, `${label}: the vote's result was posted`);
    assert.match(c.text, /has closed: \*Succeeded\*/, `${label}: ${c.text}`);
    assert.ok(isPng(c.image), `${label}: with a chart`);
    assert.match(c.text, /📄 https:\/\/site\.test\/p\/solana-devnet\//, `${label}: and the page link`);
  }
  const quiet = closed(O, 2);
  assert.ok(quiet, "optimistic: the unchallenged result was posted");
  assert.match(quiet.text, /Succeeded\*\. Nobody challenged it\./);
  assert.equal(quiet.image, null);
});
