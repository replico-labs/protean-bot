/**
 * A mainnet fork in LiteSVM, served as a Solana JSON-RPC endpoint (HTTP,
 * plus the websocket signature notifications web3.js confirms with), for
 * scripts/test-hub-mainnet-fork.mjs.
 *
 * Accounts come from mainnet the first time anything reads them or a
 * transaction names them: programs with their program data, so a
 * protocol's real program runs. After that the fork's copy is the truth;
 * whatever a transaction here changes, creates or closes is never fetched
 * again. Oracle accounts (Pyth, Scope, Switchboard, Phoenix's Hawkeye) that
 * nothing here wrote are re-fetched when older than ORACLE_REFRESH_MS, and
 * the fork's clock runs with real time from mainnet's, so prices stay as
 * fresh as the protocols require.
 *
 * Not a full RPC: the methods the bot and the protocols' clients use. Other
 * read-only methods are passed to mainnet as they are.
 */
import http from "node:http";
import { createRequire } from "node:module";
import { LiteSVM, FailedTransactionMetadata, Clock, EpochSchedule, StakeHistory, StakeHistoryEntry } from "litesvm";
import { address, lamports, getTransactionDecoder, getCompiledTransactionMessageDecoder, getBase58Encoder, getBase58Decoder } from "@solana/kit";

const require = createRequire(import.meta.url);
const bs58 = { encode: (bytes) => getBase58Decoder().decode(Uint8Array.from(bytes)), decode: (text) => new Uint8Array(getBase58Encoder().encode(text)) };

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADER_V4 = "LoaderV411111111111111111111111111111111111";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const STAKE_HISTORY = "SysvarStakeHistory1111111111111111111111111";
const LAST_RESTART_SLOT = "SysvarLastRestartS1ot1111111111111111111111";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Programs whose accounts are price feeds, refreshed from mainnet while nothing here writes them. */
const ORACLE_OWNERS = new Set([
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ", // Pyth receiver (price updates)
  "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT", // Pyth push oracle (price feeds)
  "HFn8GnPADiny6XqgoWE8uRPPxb29ikn8yTuPa9MF2fWJ", // Kamino's Scope
  "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv", // Switchboard on-demand
  "RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj", // Phoenix's Hawkeye
]);
export const ORACLE_REFRESH_MS = 10_000;
const SLOTS_PER_SECOND = 2.5;
/** Methods passed to mainnet unchanged when the fork doesn't serve them (reads only). */
const PASS_THROUGH = new Set(["getTokenLargestAccounts", "getInflationReward", "getVoteAccounts", "getSupply", "getClusterNodes", "getLeaderSchedule", "getStakeMinimumDelegation"]);

const b64 = (u8) => Buffer.from(u8).toString("base64");
const fromB64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const u64 = (data, at) => Buffer.from(data.buffer, data.byteOffset, data.length).readBigUInt64LE(at);
const i64 = (data, at) => Buffer.from(data.buffer, data.byteOffset, data.length).readBigInt64LE(at);
const sameBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** A LiteSVM transaction error in the RPC's JSON shape, as far as it maps. */
function errJson(e) {
  if (e === undefined || e === null) return null;
  if (typeof e === "number") return { TransactionError: e };
  if (typeof e.index === "number" && typeof e.err === "function") {
    const inner = e.err();
    if (inner && typeof inner === "object" && typeof inner.code === "number") return { InstructionError: [e.index, { Custom: inner.code }] };
    return { InstructionError: [e.index, typeof inner === "number" ? inner : String(inner)] };
  }
  return { TransactionError: String(e) };
}

/** The compiled message's accounts and instructions, whatever its version. */
function messageOf(tx) {
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const h = m.header;
  const header = { numRequiredSignatures: h.numSignerAccounts, numReadonlySignedAccounts: h.numReadonlySignerAccounts, numReadonlyUnsignedAccounts: h.numReadonlyNonSignerAccounts };
  let instructions;
  if (m.version === 1) {
    instructions = m.instructionHeaders.map((ih, i) => ({ programIdIndex: ih.programAccountIndex, accounts: [...(m.instructionPayloads[i].instructionAccountIndices ?? [])], data: bs58.encode(m.instructionPayloads[i].instructionData ?? []) }));
  } else {
    instructions = m.instructions.map((ix) => ({ programIdIndex: ix.programAddressIndex, accounts: [...(ix.accountIndices ?? [])], data: bs58.encode(ix.data ?? []) }));
  }
  return { version: m.version, staticAccounts: [...m.staticAccounts], lookups: m.addressTableLookups ?? [], header, instructions, blockhash: m.lifetimeToken };
}

/**
 * Starts the fork. `remoteUrl`: a mainnet RPC. Returns the endpoint and
 * the fork's own controls (funding accounts, loading programs, sending
 * without signature checks).
 */
export async function startFork({ remoteUrl, port = 8899, log = () => {} }) {
  // No log limit: a fill's event comes after a Jupiter route's logs.
  const vm = new LiteSVM().withBlockhashCheck(false).withTransactionHistory(0n).withLogBytesLimit();
  const fetchedAt = new Map(); // mainnet copies nothing here has written: address -> when fetched
  const owners = new Map(); // address -> owner, for the copies above
  const absent = new Set(); // not on mainnet (and not created here)
  const dirty = new Set(); // written, created or closed here: never fetched again
  const localPrograms = new Set(); // loaded from files: not on mainnet
  const statuses = new Map(); // signature -> what the RPC reports about it
  const waiters = new Map(); // signature -> callbacks waiting for it
  let remoteCalls = 0;

  async function remote(method, params) {
    remoteCalls++;
    const res = await fetch(remoteUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!res.ok) throw new Error(`mainnet RPC ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    if (body.error) throw new RpcError(body.error.code, `mainnet RPC ${method}: ${body.error.message}`, body.error.data);
    return body.result;
  }

  // ---- the clock: mainnet's, running with real time ----
  const clockInfo = await remote("getAccountInfo", [CLOCK, { encoding: "base64" }]);
  const cd = fromB64(clockInfo.value.data[0]);
  const start = { wall: Date.now(), slot: u64(cd, 0), epochStart: i64(cd, 8), epoch: u64(cd, 16), leaderEpoch: u64(cd, 24), unix: i64(cd, 32) };
  const es = await remote("getEpochSchedule", []);
  vm.setEpochSchedule(new EpochSchedule(BigInt(es.slotsPerEpoch), BigInt(es.leaderScheduleSlotOffset), Boolean(es.warmup), BigInt(es.firstNormalEpoch), BigInt(es.firstNormalSlot)));
  const sh = await remote("getAccountInfo", [STAKE_HISTORY, { encoding: "base64" }]);
  if (sh?.value) {
    const d = fromB64(sh.value.data[0]);
    const history = new StakeHistory();
    const n = Number(u64(d, 0));
    for (let i = 0; i < n; i++) {
      const at = 8 + i * 32;
      history.add(u64(d, at), new StakeHistoryEntry(u64(d, at + 8), u64(d, at + 16), u64(d, at + 24)));
    }
    vm.setStakeHistory(history);
  }
  // Phoenix treats the exchange as under maintenance unless this matches the restart it acknowledged.
  const lrs = await remote("getAccountInfo", [LAST_RESTART_SLOT, { encoding: "base64" }]);
  if (lrs?.value) vm.setLastRestartSlot(u64(fromB64(lrs.value.data[0]), 0));
  const now = () => {
    const elapsed = (Date.now() - start.wall) / 1000;
    return { slot: start.slot + BigInt(Math.floor(elapsed * SLOTS_PER_SECOND)), unix: start.unix + BigInt(Math.floor(elapsed)) };
  };
  let lastSlot = 0n;
  function syncClock() {
    const t = now();
    if (t.slot > lastSlot) {
      vm.warpToSlot(t.slot);
      lastSlot = t.slot;
    }
    vm.setClock(new Clock(t.slot, start.epochStart, start.epoch, start.leaderEpoch, t.unix));
    return t;
  }
  syncClock();

  // ---- accounts ----
  const isOracleCopy = (k) => fetchedAt.has(k) && ORACLE_OWNERS.has(owners.get(k)) && Date.now() - fetchedAt.get(k) > ORACLE_REFRESH_MS;

  function store(k, acct) {
    if (dirty.has(k)) return;
    const data = fromB64(acct.data[0]);
    vm.setAccount({ address: address(k), lamports: lamports(BigInt(acct.lamports)), programAddress: address(acct.owner), executable: Boolean(acct.executable), data, space: BigInt(data.length) });
    fetchedAt.set(k, Date.now());
    owners.set(k, acct.owner);
    absent.delete(k);
  }

  /** Makes sure the fork has every account in `keys` that mainnet has, programs loaded. */
  async function ensure(keys) {
    const want = [...new Set(keys)].filter((k) => {
      if (dirty.has(k) || localPrograms.has(k)) return false;
      if (fetchedAt.has(k)) return isOracleCopy(k);
      if (absent.has(k)) return false;
      return !vm.getAccount(address(k)).exists; // the fork's own: builtins, sysvars, default programs
    });
    for (let i = 0; i < want.length; i += 100) {
      const chunk = want.slice(i, i + 100);
      const { value } = await remote("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
      const programs = [];
      value.forEach((acct, j) => {
        const k = chunk[j];
        if (!acct) {
          if (!fetchedAt.has(k)) absent.add(k);
          return;
        }
        if (acct.executable) programs.push([k, acct]);
        else store(k, acct);
      });
      for (const [k, acct] of programs) await loadProgram(k, acct);
    }
  }

  /** A mainnet program, with its program data first (LiteSVM loads it from there). */
  async function loadProgram(k, acct) {
    const data = fromB64(acct.data[0]);
    if (acct.owner === UPGRADEABLE_LOADER) {
      const programData = bs58.encode(data.slice(4, 36));
      const pd = (await remote("getAccountInfo", [programData, { encoding: "base64" }])).value;
      if (!pd) throw new Error(`mainnet program ${k} has no program data (closed?)`);
      store(programData, pd);
      store(k, acct);
      log(`  [fork] loaded program ${k} (${fromB64(pd.data[0]).length - 45} bytes)`);
    } else if (acct.owner === LOADER_V4) {
      vm.addProgramWithLoader(address(k), data.slice(48), address(LOADER_V4));
      fetchedAt.set(k, Date.now());
      owners.set(k, acct.owner);
      log(`  [fork] loaded program ${k} (loader v4)`);
    } else {
      store(k, acct);
      log(`  [fork] loaded program ${k}`);
    }
  }

  function encodeAccount(acct, { encoding = "base64", dataSlice } = {}) {
    if (!acct?.exists) return null;
    let data = acct.data;
    if (dataSlice) data = data.slice(dataSlice.offset, dataSlice.offset + dataSlice.length);
    return {
      data: encoding === "base58" ? [bs58.encode(data), "base58"] : [b64(data), "base64"],
      executable: acct.executable,
      lamports: Number(acct.lamports),
      owner: acct.programAddress,
      rentEpoch: 0,
      space: acct.data.length,
    };
  }

  const read = (k) => vm.getAccount(address(k));
  const context = () => ({ slot: Number(now().slot), apiVersion: "fork" });

  function matches(data, filters = []) {
    return filters.every((f) => {
      if (f.dataSize !== undefined) return data.length === Number(f.dataSize);
      if (f.memcmp) {
        const want = f.memcmp.encoding === "base64" ? fromB64(f.memcmp.bytes) : bs58.decode(f.memcmp.bytes);
        const off = Number(f.memcmp.offset);
        return off + want.length <= data.length && sameBytes(data.slice(off, off + want.length), want);
      }
      return true;
    });
  }

  async function programAccounts(program, cfg = {}) {
    if (!localPrograms.has(program)) {
      const res = await remote("getProgramAccounts", [program, { ...cfg, encoding: "base64", withContext: false }]);
      const list = Array.isArray(res) ? res : res.value;
      if (!cfg.dataSlice) {
        for (const { pubkey, account } of list) if (!fetchedAt.has(pubkey) && !dirty.has(pubkey)) store(pubkey, account);
      } else {
        // Sliced: mainnet's slices, except where the fork's copy differs.
        const out = new Map(list.map((r) => [r.pubkey, r.account]));
        for (const a of vm.getProgramAccounts(address(program))) if (dirty.has(a.address)) out.delete(a.address);
        for (const a of vm.getProgramAccounts(address(program))) if (matches(a.data, cfg.filters)) out.set(a.address, encodeAccount({ ...a, exists: true }, cfg));
        return [...out].map(([pubkey, account]) => ({ pubkey, account }));
      }
    }
    return vm
      .getProgramAccounts(address(program))
      .filter((a) => matches(a.data, cfg.filters))
      .map((a) => ({ pubkey: a.address, account: encodeAccount({ ...a, exists: true }, cfg) }));
  }

  // ---- transactions ----
  async function keysOf(tx) {
    const m = messageOf(tx);
    const keys = [...m.staticAccounts];
    if (m.lookups.length) {
      await ensure(m.lookups.map((l) => l.lookupTableAddress));
      const loaded = { writable: [], readonly: [] };
      for (const l of m.lookups) {
        const t = read(l.lookupTableAddress);
        if (!t.exists) throw new RpcError(-32602, `address lookup table ${l.lookupTableAddress} not found`);
        const at = (i) => bs58.encode(t.data.slice(56 + 32 * i, 88 + 32 * i));
        loaded.writable.push(...l.writableIndexes.map(at));
        loaded.readonly.push(...l.readonlyIndexes.map(at));
      }
      keys.push(...loaded.writable, ...loaded.readonly);
      m.loaded = loaded;
    }
    return { m, keys };
  }

  const signatureOf = (tx) => {
    const first = Object.values(tx.signatures)[0];
    return first && first.some((b) => b !== 0) ? bs58.encode(first) : bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
  };

  /** Runs `tx` (kit wire format, decoded) for real. Returns { signature, err, logs }. */
  async function execute(tx, { unverified = false } = {}) {
    const { m, keys } = await keysOf(tx);
    await ensure(keys);
    const t = syncClock();
    const before = new Map(keys.map((k) => [k, read(k)]));
    if (unverified) vm.withSigverify(false);
    let res;
    try {
      res = vm.sendTransaction(tx);
    } finally {
      if (unverified) vm.withSigverify(true);
    }
    vm.expireBlockhash();
    for (const k of keys) {
      const was = before.get(k);
      const is = read(k);
      const changed = was.exists !== is.exists || (is.exists && (was.lamports !== is.lamports || was.programAddress !== is.programAddress || !sameBytes(was.data, is.data)));
      if (changed) {
        dirty.add(k);
        fetchedAt.delete(k);
        absent.delete(k);
      }
    }
    const failed = res instanceof FailedTransactionMetadata;
    const meta = failed ? res.meta() : res;
    const signature = signatureOf(tx);
    const status = { slot: Number(t.slot), blockTime: Number(t.unix), err: failed ? errJson(res.err()) : null, logs: meta.logs(), units: Number(meta.computeUnitsConsumed()), m, signatures: Object.values(tx.signatures).map((s) => (s ? bs58.encode(s) : bs58.encode(new Uint8Array(64)))) };
    statuses.set(signature, status);
    for (const cb of waiters.get(signature) ?? []) cb(status);
    waiters.delete(signature);
    return { signature, ...status };
  }

  async function simulate(tx, cfg = {}) {
    const { keys } = await keysOf(tx);
    await ensure(keys);
    const t = syncClock();
    const off = cfg.sigVerify === false || cfg.replaceRecentBlockhash;
    if (off) vm.withSigverify(false);
    let res;
    try {
      res = vm.simulateTransaction(tx);
    } finally {
      if (off) vm.withSigverify(true);
    }
    const failed = res instanceof FailedTransactionMetadata;
    const meta = res.meta();
    return {
      context: { slot: Number(t.slot) },
      value: {
        err: failed ? errJson(res.err()) : null,
        logs: meta.logs(),
        accounts: null,
        unitsConsumed: Number(meta.computeUnitsConsumed()),
        returnData: null,
        innerInstructions: null,
        ...(cfg.replaceRecentBlockhash ? { replacementBlockhash: { blockhash: vm.latestBlockhash(), lastValidBlockHeight: Number(t.slot) + 150 } } : {}),
      },
    };
  }

  const decodeWire = (wire, encoding = "base58") => getTransactionDecoder().decode(encoding === "base64" ? fromB64(wire) : bs58.decode(wire));

  // ---- the RPC ----
  const methods = {
    getHealth: () => "ok",
    getVersion: () => ({ "solana-core": "4.3.0-fork", "feature-set": 0 }),
    getGenesisHash: () => MAINNET_GENESIS,
    getSlot: () => Number(now().slot),
    getBlockHeight: () => Number(now().slot),
    getBlockTime: ([slot]) => Number(start.unix) + Math.floor((Number(slot) - Number(start.slot)) / SLOTS_PER_SECOND),
    getEpochInfo: () => {
      const slot = Number(now().slot);
      return { epoch: Number(start.epoch), slotIndex: slot % es.slotsPerEpoch, slotsInEpoch: es.slotsPerEpoch, absoluteSlot: slot, blockHeight: slot, transactionCount: null };
    },
    getEpochSchedule: () => es,
    getLatestBlockhash: () => ({ context: context(), value: { blockhash: vm.latestBlockhash(), lastValidBlockHeight: Number(now().slot) + 150 } }),
    isBlockhashValid: () => ({ context: context(), value: true }),
    getFeeForMessage: () => ({ context: context(), value: 5000 }),
    getRecentPrioritizationFees: () => [],
    getMinimumBalanceForRentExemption: ([size]) => Number(vm.minimumBalanceForRentExemption(BigInt(size))),
    getSignaturesForAddress: () => [],
    async getAccountInfo([k, cfg]) {
      await ensure([k]);
      return { context: context(), value: encodeAccount(read(k), cfg) };
    },
    async getMultipleAccounts([ks, cfg]) {
      await ensure(ks);
      return { context: context(), value: ks.map((k) => encodeAccount(read(k), cfg)) };
    },
    async getBalance([k]) {
      await ensure([k]);
      const a = read(k);
      return { context: context(), value: a.exists ? Number(a.lamports) : 0 };
    },
    async getProgramAccounts([program, cfg = {}]) {
      const list = await programAccounts(program, cfg);
      return cfg.withContext ? { context: context(), value: list } : list;
    },
    // Mainnet's accounts for the owner, as the fork has them, plus the ones created here.
    async getTokenAccountsByOwner([owner, filter = {}, cfg = {}]) {
      const res = await remote("getTokenAccountsByOwner", [owner, filter, { ...cfg, encoding: "base64" }]);
      const programs = filter.programId ? [filter.programId] : [...TOKEN_PROGRAMS];
      const out = new Map();
      for (const { pubkey, account } of res.value) {
        if (dirty.has(pubkey)) continue;
        if (!fetchedAt.has(pubkey)) store(pubkey, account);
        out.set(pubkey, encodeAccount(read(pubkey), cfg));
      }
      for (const program of programs) {
        for (const a of vm.getProgramAccounts(address(program))) {
          if (a.data.length < 165 || bs58.encode(a.data.slice(32, 64)) !== owner) continue;
          if (filter.mint && bs58.encode(a.data.slice(0, 32)) !== filter.mint) continue;
          out.set(a.address, encodeAccount({ ...a, exists: true }, cfg));
        }
      }
      for (const k of [...out.keys()]) if (!read(k).exists) out.delete(k);
      return { context: context(), value: [...out].map(([pubkey, account]) => ({ pubkey, account })) };
    },
    async getTokenAccountBalance([k]) {
      await ensure([k]);
      const a = read(k);
      if (!a.exists || !TOKEN_PROGRAMS.has(a.programAddress) || a.data.length < 165) throw new RpcError(-32602, "Invalid param: not a Token account");
      const mint = bs58.encode(a.data.slice(0, 32));
      await ensure([mint]);
      return { context: context(), value: uiAmount(u64(a.data, 64), read(mint).data[44]) };
    },
    async getTokenSupply([k]) {
      await ensure([k]);
      const a = read(k);
      if (!a.exists || !TOKEN_PROGRAMS.has(a.programAddress)) throw new RpcError(-32602, "Invalid param: not a Token mint");
      return { context: context(), value: uiAmount(u64(a.data, 36), a.data[44]) };
    },
    async requestAirdrop([k, amount]) {
      const res = vm.airdrop(address(k), lamports(BigInt(amount)));
      vm.expireBlockhash();
      dirty.add(k);
      fetchedAt.delete(k);
      if (!res || res instanceof FailedTransactionMetadata) throw new RpcError(-32000, `airdrop failed: ${res}`);
      const signature = bs58.encode(res.signature());
      statuses.set(signature, { slot: Number(now().slot), blockTime: Number(now().unix), err: null, logs: res.logs(), units: 0, m: null, signatures: [signature] });
      return signature;
    },
    async sendTransaction([wire, cfg = {}]) {
      const tx = decodeWire(wire, cfg.encoding);
      if (!cfg.skipPreflight) {
        const sim = await simulate(tx);
        if (sim.value.err) throw new RpcError(-32002, `Transaction simulation failed: ${JSON.stringify(sim.value.err)}`, { err: sim.value.err, logs: sim.value.logs, accounts: null, unitsConsumed: sim.value.unitsConsumed, returnData: null });
      }
      return (await execute(tx)).signature;
    },
    async simulateTransaction([wire, cfg = {}]) {
      return simulate(decodeWire(wire, cfg.encoding), cfg);
    },
    getSignatureStatuses([sigs]) {
      return { context: context(), value: sigs.map((s) => (statuses.has(s) ? statusOf(statuses.get(s)) : null)) };
    },
    getTransaction([sig]) {
      const s = statuses.get(sig);
      if (!s || !s.m) return null;
      return {
        slot: s.slot,
        blockTime: s.blockTime,
        version: s.m.version === "legacy" ? "legacy" : 0,
        transaction: {
          signatures: s.signatures,
          message: { accountKeys: s.m.staticAccounts, header: s.m.header, instructions: s.m.instructions, recentBlockhash: s.m.blockhash, ...(s.m.version === "legacy" ? {} : { addressTableLookups: s.m.lookups.map((l) => ({ accountKey: l.lookupTableAddress, writableIndexes: [...l.writableIndexes], readonlyIndexes: [...l.readonlyIndexes] })) }) },
        },
        meta: {
          err: s.err,
          status: s.err ? { Err: s.err } : { Ok: null },
          fee: 5000,
          preBalances: [],
          postBalances: [],
          innerInstructions: [],
          logMessages: s.logs,
          preTokenBalances: [],
          postTokenBalances: [],
          rewards: [],
          loadedAddresses: s.m.loaded ?? { writable: [], readonly: [] },
          computeUnitsConsumed: s.units,
        },
      };
    },
  };
  const statusOf = (s) => ({ slot: s.slot, confirmations: null, err: s.err, status: s.err ? { Err: s.err } : { Ok: null }, confirmationStatus: "finalized" });
  const uiAmount = (raw, decimals) => ({ amount: raw.toString(), decimals, uiAmount: Number(raw) / 10 ** decimals, uiAmountString: (Number(raw) / 10 ** decimals).toString() });

  async function handle(req) {
    const { id, method, params = [] } = req;
    try {
      syncClock();
      let result;
      if (methods[method]) result = await methods[method](params);
      else if (PASS_THROUGH.has(method)) result = await remote(method, params);
      else throw new RpcError(-32601, `Method not found (the fork doesn't serve ${method})`);
      return { jsonrpc: "2.0", id, result };
    } catch (err) {
      if (!(err instanceof RpcError)) log(`  [fork] ${method} failed: ${err.stack ?? err}`);
      return { jsonrpc: "2.0", id, error: { code: err.code ?? -32603, message: err.message, ...(err.data ? { data: err.data } : {}) } };
    }
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let out;
      try {
        const parsed = JSON.parse(body);
        out = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
      } catch (err) {
        out = { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${err.message}` } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((ok, fail) => server.once("error", fail).listen(port, "127.0.0.1", ok));

  // Websocket on port + 1, where web3.js looks for it: signature notifications, other subscriptions accepted and left quiet.
  let wss = null;
  try {
    const { WebSocketServer } = require("ws");
    wss = new WebSocketServer({ host: "127.0.0.1", port: port + 1 });
    let nextSub = 1;
    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        const reply = (result) => sock.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        if (/Unsubscribe$/.test(msg.method)) return reply(true);
        const sub = nextSub++;
        reply(sub);
        if (msg.method !== "signatureSubscribe") return;
        const notify = (s) => sock.readyState === 1 && sock.send(JSON.stringify({ jsonrpc: "2.0", method: "signatureNotification", params: { subscription: sub, result: { context: { slot: s.slot }, value: { err: s.err } } } }));
        const sig = msg.params[0];
        if (statuses.has(sig)) notify(statuses.get(sig));
        else waiters.set(sig, [...(waiters.get(sig) ?? []), notify]);
      });
    });
  } catch (err) {
    log(`  [fork] no websocket (${err.message}); web3.js confirms by polling.`);
  }

  // ---- the fork's own controls ----
  const touch = (k) => {
    dirty.add(k);
    fetchedAt.delete(k);
    absent.delete(k);
  };
  return {
    url: `http://127.0.0.1:${port}`,
    vm,
    start,
    remote,
    ensure,
    stats: () => ({ fetched: fetchedAt.size, written: dirty.size, remoteCalls }),
    /** Loads a program from a .so file at `programId` (one mainnet doesn't have). */
    addProgramFile(programId, path) {
      vm.addProgramFromFile(address(programId), path);
      localPrograms.add(programId);
      touch(programId);
    },
    /** Sets `k`'s SOL balance (a system account). */
    setLamports(k, amount) {
      const a = read(k);
      vm.setAccount({ address: address(k), lamports: lamports(BigInt(amount)), programAddress: a.exists ? a.programAddress : address("11111111111111111111111111111111"), executable: false, data: a.exists ? a.data : new Uint8Array(), space: a.exists ? BigInt(a.data.length) : 0n });
      touch(k);
    },
    /** Puts `amount` (raw units) of `mint` in token account `account` owned by `owner` (an initialized account; Token or Token-2022 by `tokenProgram`). */
    async setTokenAccount(account, owner, mint, amount, tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
      await ensure([mint]);
      const data = new Uint8Array(165);
      data.set(bs58.decode(mint), 0);
      data.set(bs58.decode(owner), 32);
      Buffer.from(data.buffer).writeBigUInt64LE(BigInt(amount), 64);
      data[108] = 1; // initialized
      vm.setAccount({ address: address(account), lamports: lamports(vm.minimumBalanceForRentExemption(165n)), programAddress: address(tokenProgram), executable: false, data, space: 165n });
      touch(account);
    },
    /** Sends a wire transaction with signature checks off (for one a third party co-signs on mainnet). */
    async sendUnverified(wire) {
      return execute(getTransactionDecoder().decode(wire), { unverified: true });
    },
    async close() {
      wss?.close();
      await new Promise((ok) => server.close(ok));
    },
  };
}
