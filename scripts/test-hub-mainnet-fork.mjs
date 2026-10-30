#!/usr/bin/env node
/**
 * The hub test: every Solana integration run through the Vortexes hub, as
 * proposals a DAO passes and its Treasury (a PDA only the hub signs for)
 * executes, against mainnet's real programs and state.
 *
 * The chain is a mainnet fork in LiteSVM (scripts/lib/mainnetFork.mjs): it
 * copies accounts and programs from your mainnet RPC as they're used, and
 * serves them as an RPC the bot talks to. The Vortexes programs are loaded
 * from your build. Then, through the bot's own commands (as a chat would):
 * a board DAO with one signer, so each proposal is queued as it's made and
 * runs after the 30-second timelock; the Treasury is given SOL and USDC;
 * and the actions are proposed and executed in rounds, each round's checks
 * reading the result:
 *
 *   1. jito-stake, marinade-stake, juplend-deposit, kamino-deposit,
 *      pumpfun-buy, tensor-buy, phoenix-appoint, jup-swap (then the fill
 *      keeper fills the order through Jupiter)
 *   2. jito-unstake, marinade-unstake, juplend-withdraw, kamino-withdraw,
 *      pumpfun-sell, tensor-list, phoenix-fund
 *   3. tensor-delist, phoenix-withdraw
 *   4. phoenix-remove
 *
 * Phoenix registers the Treasury through its API first, as `desk register`
 * does; the API's onboarder co-signs that on mainnet, so here it goes in
 * without signature checks (nothing else does).
 *
 *   VORTEXES_DEPLOY_DIR=~/Vortexes/target/deploy \
 *   HUB_TEST_PUMP_MINT=<a pump.fun coin still on its curve> \
 *   HUB_TEST_TENSOR_MINT=<an NFT listed on Tensor for SOL> \
 *   node --experimental-test-module-mocks scripts/test-hub-mainnet-fork.mjs
 *
 * The mainnet RPC is SOLANA_MAINNET_RPC_URL (from .env too), or
 * HUB_FORK_SOURCE_RPC_URL; a paid one helps, as the first round fetches a
 * few thousand accounts. VORTEXES_DEPLOY_DIR needs vortex_hub.so and
 * vortex_board.so (anchor build); with vortex_fill.so, jup-swap runs too.
 * Without HUB_TEST_PUMP_MINT or HUB_TEST_TENSOR_MINT, those steps are
 * skipped. HUB_TEST_ONLY=jito,kamino runs just those protocols. Nothing
 * reaches mainnet: transactions run in the fork only. data/chats.json is
 * backed up and put back. About 5 minutes.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { startFork } from "./lib/mainnetFork.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = process.env.HUB_FORK_SOURCE_RPC_URL || process.env.SOLANA_MAINNET_RPC_URL;
const DEPLOY = process.env.VORTEXES_DEPLOY_DIR?.replace(/^~/, process.env.HOME);
if (!SOURCE || !/^https?:/.test(SOURCE)) {
  console.error("Set SOLANA_MAINNET_RPC_URL (or HUB_FORK_SOURCE_RPC_URL) to a mainnet RPC.");
  process.exit(2);
}
if (!DEPLOY || !fs.existsSync(path.join(DEPLOY, "vortex_hub.so")) || !fs.existsSync(path.join(DEPLOY, "vortex_board.so"))) {
  console.error("Set VORTEXES_DEPLOY_DIR to the Vortexes repo's target/deploy (after anchor build): it needs vortex_hub.so and vortex_board.so.");
  process.exit(2);
}
if (typeof mock.module !== "function") {
  console.error("Run it with node --experimental-test-module-mocks (it stands in for the wallet store).");
  process.exit(2);
}
const PUMP_MINT = process.env.HUB_TEST_PUMP_MINT || "";
const TENSOR_MINT = process.env.HUB_TEST_TENSOR_MINT || "";
const ONLY = process.env.HUB_TEST_ONLY ? new Set(process.env.HUB_TEST_ONLY.split(",").map((s) => s.trim())) : null;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

// ---- the fork, and the bot pointed at it ----
console.log(`Forking mainnet from ${SOURCE.replace(/(api[-_]?key=|\/)[A-Za-z0-9-]{20,}/gi, "$1…")}`);
const fork = await startFork({ remoteUrl: SOURCE, port: Number(process.env.HUB_FORK_PORT || 18899), log: console.log });
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const IDL_FILES = { hub: "vortex_hub", tokenWeighted: "vortex_token_weighted", quadratic: "vortex_quadratic", optimistic: "vortex_optimistic", board: "vortex_board", conviction: "vortex_conviction", delegate: "vortex_delegate", liquid: "vortex_liquid", sortition: "vortex_sortition", sowellian: "vortex_sowellian", decisionMarkets: "vortex_decision_markets" };
for (const [model, file] of Object.entries(IDL_FILES)) {
  const id = require(`../src/solana/idl/${file}.json`).address;
  process.env[`SOLANA_MAINNET_${model.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_PROGRAM_ID`] = id;
  if (fs.existsSync(path.join(DEPLOY, `${file}.so`))) fork.addProgramFile(id, path.join(DEPLOY, `${file}.so`));
}
const FILL_ID = require("../src/solana/idl/vortex_fill.json").address;
const withFill = fs.existsSync(path.join(DEPLOY, "vortex_fill.so"));
if (withFill) {
  fork.addProgramFile(FILL_ID, path.join(DEPLOY, "vortex_fill.so"));
  process.env.SOLANA_MAINNET_FILL_PROGRAM_ID = FILL_ID;
  process.env.SOLANA_MAINNET_FILL_KEEPER = "true";
} else {
  delete process.env.SOLANA_MAINNET_FILL_PROGRAM_ID;
  delete process.env.SOLANA_MAINNET_FILL_KEEPER;
}
const op = Keypair.generate();
fork.setLamports(op.publicKey.toBase58(), 1_000n * BigInt(LAMPORTS_PER_SOL));
Object.assign(process.env, {
  SOLANA_ENABLED: "true",
  SOLANA_MAINNET_ENABLED: "true",
  SOLANA_MAINNET_RPC_URL: fork.url,
  SOLANA_MAINNET_FAST_TIMINGS: "true",
  SOLANA_MAINNET_V1_TRANSACTIONS: "true",
  SOLANA_OPERATOR_KEY: JSON.stringify(Array.from(op.secretKey)),
  CHAT_LINKS_STORE: "file",
});
// Only the fork's keeper: one configured for devnet in .env would poll it with this throwaway operator.
delete process.env.SOLANA_DEVNET_FILL_KEEPER;

// Wallet storage (Supabase/KMS) stood in for in memory, as in test-solana-local.mjs.
const rows = new Map();
const keyOf = (p, u) => `${p}:${u}`;
mock.module(new URL("../src/walletStore.js", import.meta.url).href, {
  namedExports: {
    PHOENIX_AGENT_PLATFORM: "phoenix-agent",
    deletePhoenixAgentKey: async () => {},
    createAgentKey: async () => null,
    getAgentAccount: async () => null,
    deleteAgentKey: async () => {},
    isWalletStoreConfigured: () => true,
    createWalletRecord: async () => null,
    getWalletAccount: async () => null,
    recordGasTopup: async () => 0,
    findWalletRecord: async (p, u) => rows.get(keyOf(p, u)) ?? null,
    findSolanaWallet: async (p, u) => rows.get(keyOf(p, u))?.solana ?? null,
    storeSolanaWallet: async (p, u, solana) => {
      const r = rows.get(keyOf(p, u)) ?? rows.set(keyOf(p, u), {}).get(keyOf(p, u));
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

const CHATS = path.join(ROOT, "data", "chats.json");
const chatsBackup = fs.existsSync(CHATS) ? fs.readFileSync(CHATS) : null;
const restoreChats = () => (chatsBackup ? fs.writeFileSync(CHATS, chatsBackup) : fs.rmSync(CHATS, { force: true }));
process.on("exit", restoreChats);

const anchor = (await import("@coral-xyz/anchor")).default;
const { runSolanaCommand } = await import("../src/solana/commands.js");
const { getSolanaNetwork, IDLS } = await import("../src/solana/config.js");
const v = await import("../src/solana/vortex.js");
const phx = await import("../src/solana/phoenix.js");
const fill = await import("../src/solana/fill.js");
const { startFillKeeper } = await import("../src/solana/fillKeeper.js");
const net = getSolanaNetwork("solana-mainnet");
const conn = net.connection;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async (chatId, userId, line) => {
  const [name, ...args] = line.split(" ");
  const r = await runSolanaCommand(name, { platform: "telegram", chatId, userId, args, isDirect: false, cmd: (n) => `/${n}` });
  return r?.text ?? "(no reply)";
};
const addressIn = (text) => text.match(/(?:^|[\s`])([1-9A-HJ-NP-Za-km-z]{32,44})(?=[\s`]|$)/)[1];
const field = (text, label) => text.match(new RegExp(`${label}: \`?([^\`\\s]+)`))[1];

/** The hub, set up as its admin does, with the board model approved. */
async function setUpHub() {
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(op), { commitment: "confirmed" });
  const hub = new anchor.Program(IDLS.hub, provider);
  const pda = (s) => PublicKey.findProgramAddressSync(s, net.programs.hub)[0];
  await hub.methods.initHub().accountsStrict({ admin: op.publicKey, hub: pda([Buffer.from("hub")]), systemProgram: SystemProgram.programId }).rpc();
  const gp = net.programs.board;
  await hub.methods.setModel(gp, "board", true).accountsStrict({ admin: op.publicKey, hub: pda([Buffer.from("hub")]), model: pda([Buffer.from("model"), gp.toBuffer()]), systemProgram: SystemProgram.programId }).rpc();
}

// ---- results ----
const results = [];
const record = (step, ok, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${step}${detail ? `\n      ${detail.split("\n").join("\n      ")}` : ""}`);
};

let treasury, d;
const tokenProgramOf = async (mint) => (await conn.getAccountInfo(new PublicKey(mint))).owner;
/** The Treasury's balance of `mint` (raw units), or of SOL (lamports) for "sol". */
async function held(mint) {
  if (mint === "sol") return BigInt(await conn.getBalance(treasury));
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), treasury, true, await tokenProgramOf(mint));
  return conn.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
}

// ---- the steps ----
const trader = Keypair.generate().publicKey.toBase58();
const fmt = (raw, decimals) => v.formatUnits(raw, decimals);
const STEPS = [
  // round 1
  { round: 1, protocol: "jito", line: "jito-stake 1", check: async () => [(await held(JITOSOL)) > 0n, `JitoSOL ${fmt(await held(JITOSOL), 9)}`] },
  { round: 1, protocol: "marinade", line: "marinade-stake 1", check: async () => [(await held(MSOL)) > 0n, `mSOL ${fmt(await held(MSOL), 9)}`] },
  { round: 1, protocol: "juplend", line: "juplend-deposit usdc 10", before: () => held(USDC), check: async (was) => [(await held(USDC)) === was - 10_000_000n, `USDC ${fmt(await held(USDC), 6)} (was ${fmt(was, 6)})`] },
  { round: 1, protocol: "kamino", line: "kamino-deposit sol 1", before: () => held("sol"), check: async (was) => [(await held("sol")) <= was - BigInt(LAMPORTS_PER_SOL), `SOL ${fmt(await held("sol"), 9)} (was ${fmt(was, 9)})`] },
  { round: 1, protocol: "pumpfun", needs: PUMP_MINT, line: `pumpfun-buy ${PUMP_MINT} 0.1 10`, check: async () => [(await held(PUMP_MINT)) > 0n, `coins ${await held(PUMP_MINT)}`] },
  { round: 1, protocol: "tensor", needs: TENSOR_MINT, line: `tensor-buy ${TENSOR_MINT} ${process.env.HUB_TEST_TENSOR_MAX_SOL || "500"}`, check: async () => [(await held(TENSOR_MINT)) === 1n, `the Treasury holds ${await held(TENSOR_MINT)} of the NFT`] },
  { round: 1, protocol: "phoenix", line: `phoenix-appoint 1 ${trader}`, check: async () => [Boolean(await phx.readTrader(net, treasury, 1)), "subaccount 1 registered and delegated"] },
  { round: 1, protocol: "jupiter", needs: withFill, line: "jup-swap sol usdc 0.5 3 1", before: () => held(USDC), check: (was) => swapFilled(was) },
  // round 2
  { round: 2, protocol: "jito", after: "jito-stake", line: "jito-unstake all", check: async () => [(await held(JITOSOL)) === 0n, `JitoSOL ${fmt(await held(JITOSOL), 9)} (a stake account holds it now)`] },
  { round: 2, protocol: "marinade", after: "marinade-stake", line: "marinade-unstake all", check: async () => [(await held(MSOL)) === 0n, `mSOL ${fmt(await held(MSOL), 9)}`] },
  { round: 2, protocol: "juplend", after: "juplend-deposit", line: "juplend-withdraw usdc all", before: () => held(USDC), check: async (was) => [(await held(USDC)) >= was + 9_990_000n, `USDC ${fmt(await held(USDC), 6)} (was ${fmt(was, 6)})`] },
  { round: 2, protocol: "kamino", after: "kamino-deposit", line: "kamino-withdraw sol all", before: () => held("sol"), check: async (was) => [(await held("sol")) >= was + BigInt(0.99 * LAMPORTS_PER_SOL), `SOL ${fmt(await held("sol"), 9)} (was ${fmt(was, 9)})`] },
  { round: 2, protocol: "pumpfun", after: "pumpfun-buy", needs: PUMP_MINT, line: `pumpfun-sell ${PUMP_MINT} all 10`, check: async () => [(await held(PUMP_MINT)) === 0n, `coins ${await held(PUMP_MINT)}`] },
  { round: 2, protocol: "tensor", after: "tensor-buy", needs: TENSOR_MINT, line: `tensor-list ${TENSOR_MINT} 999`, check: async () => [(await held(TENSOR_MINT)) === 0n, "listed at 999 SOL (the NFT is in Tensor's escrow)"] },
  { round: 2, protocol: "phoenix", after: "phoenix-appoint", line: "phoenix-fund 1 10", before: () => held(USDC), check: async (was) => [(await held(USDC)) === was - 10_000_000n, `USDC ${fmt(await held(USDC), 6)} (was ${fmt(was, 6)})`] },
  // round 3
  { round: 3, protocol: "tensor", after: "tensor-list", needs: TENSOR_MINT, line: `tensor-delist ${TENSOR_MINT}`, check: async () => [(await held(TENSOR_MINT)) === 1n, "back in the Treasury"] },
  { round: 3, protocol: "phoenix", after: "phoenix-fund", line: "phoenix-withdraw 1 10", before: () => held(USDC), check: async (was) => [(await held(USDC)) >= was + 9_990_000n, `USDC ${fmt(await held(USDC), 6)} (was ${fmt(was, 6)})`] },
  // round 4
  { round: 4, protocol: "phoenix", after: "phoenix-withdraw", line: "phoenix-remove 1", check: async () => [true, "subaccount 1 delegated back to the Treasury"] },
];

/** The fill keeper (running in this process) fills the order through Jupiter: waits for the Treasury's USDC to rise. */
async function swapFilled(was) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const now = await held(USDC);
    if (now > was) return [true, `filled by the keeper: USDC ${fmt(now, 6)} (was ${fmt(was, 6)})`];
    await sleep(5_000);
  }
  const open = await fill.listOrders(net).catch(() => []);
  return [false, `not filled within 2 minutes (${open.length} order(s) still open; the keeper's log above says why)`];
}

// ---- go ----
const CHAT = -1;
try {
  await setUpHub();
  await run(-9, 1, `createboarddao Wallets ${Keypair.generate().publicKey.toBase58()} solana-mainnet`);
  const signer = addressIn(await run(-9, 1, "wallet"));
  fork.setLamports(signer, 20n * BigInt(LAMPORTS_PER_SOL));
  const out = await run(CHAT, 1, `createboarddao HubTest ${signer} solana-mainnet`);
  if (!/created/.test(out)) throw new Error(`createboarddao: ${out}`);
  treasury = new PublicKey(field(out, "Treasury"));
  d = v.addresses(net, new PublicKey(field(out, "DAO")), net.programs.board);
  console.log(`DAO ${d.dao.toBase58()}, Treasury ${treasury.toBase58()}`);

  // The Treasury's funds: SOL, and 100 USDC in its token account.
  fork.setLamports(treasury.toBase58(), (TENSOR_MINT ? 1_100n : 50n) * BigInt(LAMPORTS_PER_SOL));
  await fork.setTokenAccount(getAssociatedTokenAddressSync(new PublicKey(USDC), treasury, true).toBase58(), treasury.toBase58(), USDC, 100_000_000n, TOKEN_PROGRAM_ID.toBase58());
  record("Treasury funded", (await held(USDC)) === 100_000_000n, `${fmt(await held("sol"), 9)} SOL, ${fmt(await held(USDC), 6)} USDC`);

  const wanted = (s) => (!ONLY || ONLY.has(s.protocol)) && (s.needs === undefined || Boolean(s.needs));
  if (!ONLY || ONLY.has("phoenix")) {
    try {
      await registerOnPhoenix();
      record("Phoenix: Treasury registered (as desk register does)", Boolean(await phx.readTrader(net, treasury, phx.CROSS)));
    } catch (err) {
      record("Phoenix: Treasury registered (as desk register does)", false, err.message);
    }
  }
  if (withFill) startFillKeeper({ platform: "telegram", notify: async (_chat, text) => console.log(`  [keeper → chat] ${text.split("\n")[0]}`) });

  const passed = new Set();
  const failedPhoenixRegistration = results.some((r) => r.step.startsWith("Phoenix: Treasury") && !r.ok);
  for (const round of [1, 2, 3, 4]) {
    const steps = STEPS.filter((s) => s.round === round && wanted(s));
    if (!steps.length) continue;
    console.log(`\nRound ${round}: ${steps.map((s) => s.line.split(" ")[0]).join(", ")}`);
    const queued = [];
    for (const s of steps) {
      const action = s.line.split(" ")[0];
      if (s.after && !passed.has(s.after)) {
        record(action, false, `skipped: ${s.after} didn't pass`);
        continue;
      }
      if (s.protocol === "phoenix" && failedPhoenixRegistration) {
        record(action, false, "skipped: the Treasury isn't registered on Phoenix");
        continue;
      }
      const reply = await run(CHAT, 1, `proposeaction ${s.line} Hub test ${action}`);
      const id = reply.match(/Proposal \*#(\d+)\*/)?.[1];
      if (!id) {
        record(`${action}: propose`, false, reply);
        continue;
      }
      const p = await v.readProposal(net, "board", d.proposal(Number(id)));
      if (!p || Number(p.queuedAt) === 0) {
        record(`${action}: propose`, false, `#${id} wasn't queued by its one signer's confirmation`);
        continue;
      }
      queued.push({ ...s, action, id, summary: reply.split("\n")[0].replace(/^✅ /, "") });
    }
    if (!queued.length) continue;
    console.log(`  ${queued.length} proposal(s) queued; waiting out the 30s timelock`);
    await sleep(32_000);
    for (const s of queued) {
      const was = s.before ? await s.before() : undefined;
      const reply = await run(CHAT, 1, `execute ${s.id}`);
      if (!/executed/.test(reply)) {
        record(`${s.action} (#${s.id})`, false, `${s.summary}\n${reply}`);
        continue;
      }
      const [ok, detail] = await s.check(was);
      record(`${s.action} (#${s.id})`, ok, `${s.summary}\n${detail}`);
      if (ok) passed.add(s.action);
    }
  }
} catch (err) {
  record("setup", false, err.stack ?? String(err));
}

/** Registers the Treasury on Phoenix with the instructions Phoenix's API builds (phoenix.js registerWithPhoenix sends them through the API instead). */
async function registerOnPhoenix() {
  const client = phx.phoenixClient(net);
  const built = await client.api.exchange().buildRegisterIxs({ traderAuthority: treasury.toBase58(), txFeePayer: op.publicKey.toBase58(), maxPositions: 128 });
  const instructions = built.instructions.map((ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) }));
  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: op.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
  tx.sign([op]);
  const r = await fork.sendUnverified(tx.serialize());
  if (r.err) throw new Error(`registration failed: ${JSON.stringify(r.err)}\n${r.logs.slice(-15).join("\n")}`);
}

// ---- summary ----
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length} of ${results.length} passed${bad.length ? `; failed or skipped: ${bad.map((r) => r.step).join(", ")}` : ""}`);
const skippedSteps = STEPS.filter((s) => s.needs !== undefined && !s.needs).map((s) => s.line.split(" ")[0]);
if (skippedSteps.length) console.log(`Not run (set HUB_TEST_PUMP_MINT / HUB_TEST_TENSOR_MINT / build vortex_fill.so): ${skippedSteps.join(", ")}`);
console.log(`Fork: ${JSON.stringify(fork.stats())}`);
await fork.close();
restoreChats();
process.exit(bad.length ? 1 : 0);
