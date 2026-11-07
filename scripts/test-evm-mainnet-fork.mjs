#!/usr/bin/env node
/**
 * The EVM protocol actions against the real protocols, on a mainnet fork.
 * A board DAO (three signers, two to approve) is created on an anvil fork of
 * Monad, Base or HyperEVM mainnet, and each action is proposed through the
 * chat command (/proposeaction), confirmed by a second signer, executed, and
 * its result checked on-chain (balances, Aave/HyperLend positions). Nothing
 * is stood in for: the protocols are the deployed ones, at the fork's block.
 *
 *   anvil --fork-url <mainnet RPC> --code-size-limit 100000
 *   (cd ../Spaces && forge build)            # the Board contracts this script deploys
 *   node --experimental-test-module-mocks scripts/test-evm-mainnet-fork.mjs --network base
 *
 * --network monad | base | hyperevm (the fork's chain must match).
 * Options (env):
 *   FORK_RPC_URL           the fork (default http://127.0.0.1:8545)
 *   SPACES_DIR             Spaces checkout with forge build output (default ../Spaces)
 *   FORK_ONLY              comma-separated step names to run (default all)
 *   FORK_FLAUNCH_COIN      Base: a current-generation Flaunch coin for flaunch-buy/sell
 *   FORK_NADFUN_TOKEN      Monad: a Nad.fun token for nadfun-buy/sell
 *   FORK_MON_SWAP          Monad: MON to swap for USDC and AUSD (default 500 each)
 *   RPC_TIMEOUT_MS         how long one request may take (default 10000); a slow fork, e.g. Monad, needs 60000
 *
 * What it covers per network:
 *   Base:     uniswap-swap, aerodrome-swap, aave-supply/borrow/repay/collateral/withdraw,
 *             lido-buy/sell-wsteth, flaunch-buy/sell
 *   Monad:    uniswap-swap, aave-supply/borrow/repay/withdraw, shmon-stake/unstake-instant/
 *             request-unstake, nadfun-buy/sell, perpl-deposit/open/close/withdraw
 *   HyperEVM: hyperlend-supply/borrow/repay/withdraw, kinetiq-buy/sell-khype (through HyperSwap)
 * Not here: HyperCore (its state lives in Hyperliquid's engine, which a fork
 * doesn't have), OpenSea (needs an API key and a listing), Uniswap liquidity.
 *
 * The board's timelock is 1 second (the bot's fast timings, scaled down), so
 * the fork's clock moves only seconds and oracles stay fresh.
 * Wallet storage is stood in for; data/chats.json is backed up and restored.
 */
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const NETWORKS = { monad: ["monad-mainnet", "MONAD_MAINNET", 143], base: ["base", "BASE", 8453], hyperevm: ["hyperevm", "HYPEREVM", 999] };
const which = arg("network");
if (!NETWORKS[which]) {
  console.error("Which fork? --network monad | base | hyperevm");
  process.exit(2);
}
const [NETWORK, PREFIX, CHAIN_ID] = NETWORKS[which];
const FORK = process.env.FORK_RPC_URL || "http://127.0.0.1:8545";

// anvil's well-known first account: funded by anvil on the fork, never anywhere real.
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY = LOCAL_KEY;
process.env.DEFAULT_NETWORK = NETWORK;
process.env.NETWORKS = NETWORK;
process.env[`${PREFIX}_RPC_URL`] = FORK;
process.env[`${PREFIX}_RPC_PUBLIC_FALLBACK`] = "false"; // never the real mainnet
process.env[`${PREFIX}_RPC_MAX_RPS`] = "200";
process.env.SUPABASE_URL ||= "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";

const fs = await import("node:fs");
const path = await import("node:path");
const { mock } = await import("node:test");
const { parseEther, formatEther, formatUnits, parseUnits, getAddress, erc20Abi, parseAbi, createWalletClient, http } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");

// ---- stand-ins: wallets (userId -> a throwaway key) ----
const accounts = new Map();
mock.module(new URL("../src/walletStore.js", import.meta.url).href, {
  namedExports: {
    PHOENIX_AGENT_PLATFORM: "phoenix-agent",
    deletePhoenixAgentKey: async () => {},
    isWalletStoreConfigured: () => true,
    createWalletRecord: async () => null,
    getWalletAccount: async () => null,
    recordGasTopup: async () => 0,
    findWalletRecord: async (p, u) => (accounts.has(String(u)) ? { address: accounts.get(String(u)).address } : null),
    findSolanaWallet: async () => null,
    storeSolanaWallet: async () => null,
    recordSolanaTopup: async () => 0,
    createAgentKey: async () => null,
    getAgentAccount: async () => null,
    deleteAgentKey: async () => {},
  },
});
mock.module(new URL("../src/walletResolver.js", import.meta.url).href, {
  namedExports: {
    getOrCreateUserAccount: async (u) => accounts.get(String(u)),
    getUserAddress: async (u) => accounts.get(String(u))?.address,
  },
});

const chats = new URL("../data/chats.json", import.meta.url);
const backup = fs.existsSync(chats) ? fs.readFileSync(chats) : null;
const restore = () => (backup ? fs.writeFileSync(chats, backup) : fs.rmSync(chats, { force: true }));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

const { getNetwork, networkEnvName } = await import("../src/networks.js");
const { publicClient, walletClient } = await import("../src/config.js");
const { getAdapter } = await import("../src/governance/index.js");
const { registerChat } = await import("../src/db.js");
const { runCommand } = await import("../src/platforms/commands.js");
const { splitArgs } = await import("../src/args.js");
const { loadIntegrationAbi } = await import("../src/integrations/abis/index.js");
const aave = await import("../src/integrations/aaveV3.js");
const shmonad = await import("../src/integrations/shmonad.js");
const perpl = await import("../src/integrations/perpl.js");
const lido = await import("../src/integrations/lido.js");
const kinetiq = await import("../src/integrations/kinetiq.js");
const hyperlendMod = await import("../src/integrations/hyperlend.js");
const hyperswap = await import("../src/integrations/hyperswap.js");

const AAVE = loadIntegrationAbi("aaveV3");
const HYPERLEND = loadIntegrationAbi("hyperlend");
const WRAPPED = parseAbi(["function deposit() payable"]);
const net = getNetwork(NETWORK);
const NATIVE = net.nativeSymbol;
const CHAT = `C-FORK-${which.toUpperCase()}`;

// ---- helpers ----
const rpc = (method, params = []) => publicClient.request({ method, params });
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const settle = () => new Promise((r) => setTimeout(r, 2500)); // the bot's reads cache the block number briefly
const send = async (hash) => {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: await hash });
  if (receipt.status !== "success") throw new Error(`transaction ${receipt.transactionHash} reverted`);
  return receipt;
};
const ctxFor = (u, args) => ({ platform: "slack", chatId: CHAT, userId: u, args, isAdmin: true, isDirect: false, cmd: (n) => `/protean ${n}` });
const run = (u, line) => {
  const [name, ...args] = splitArgs(line);
  return runCommand(name, ctxFor(u, args));
};
const idIn = (text) => /Proposal #(\d+)/.exec(text ?? "")?.[1];
const trim = (s, n = 900) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

let treasury;
const native = async () => publicClient.getBalance({ address: treasury });
const held = async (token) => publicClient.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [treasury] });
const decimalsOf = async (token) => Number(await publicClient.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "decimals" }));
const show = async (token, amount) => formatUnits(amount, await decimalsOf(token));
const account = async (pool) => {
  const r = await publicClient.readContract({ address: getAddress(pool), abi: AAVE.pool, functionName: "getUserAccountData", args: [treasury] });
  return { collateral: r[0], debt: r[1], available: r[2] };
};

/** Deploys a Spaces contract from its forge build output. */
function artifact(name) {
  const spaces = path.resolve(process.env.SPACES_DIR || "../Spaces");
  const file = path.join(spaces, "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing - run forge build in Spaces (SPACES_DIR) first.`);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return { abi: json.abi, bytecode: json.bytecode.object };
}
async function deploy(name, args = []) {
  const { abi, bytecode } = artifact(name);
  return (await send(walletClient.deployContract({ abi, bytecode, args }))).contractAddress;
}

// ---- the steps ----
const results = [];
let only = process.env.FORK_ONLY ? new Set(process.env.FORK_ONLY.split(",").map((s) => s.trim())) : null;

/**
 * One action as a proposal: A proposes it from the chat, B confirms (two of
 * three: it queues), the 1-second timelock passes, A executes, then `check`
 * looks at the chain. `line` may be a function (built from earlier results).
 */
async function step(s) {
  const name = s.name ?? (typeof s.line === "string" ? s.line.split(" ")[0] : "step");
  if (only && !only.has(name)) return;
  if (s.skip) {
    console.log(`  - ${name}: skipped (${s.skip})`);
    results.push({ name, ok: null });
    return;
  }
  if (s.skipIf && (await s.skipIf())) {
    console.log(`  - ${name}: skipped (nothing to do: no debt)`);
    results.push({ name, ok: null });
    return;
  }
  if (s.setup) {
    try {
      console.log(`  · ${name}: ${await s.setup()}`);
    } catch (err) {
      console.log(`  ✗ ${name}\n      ${trim(err.message ?? String(err), 600)}`);
      results.push({ name, ok: false });
    }
    return;
  }
  const line = typeof s.line === "function" ? await s.line() : s.line;
  let r;
  try {
    const before = s.before ? await s.before() : undefined;
    r = await run("A", `proposeaction ${line} fork test`);
    const id = idIn(r.text);
    // A refusal the step expects (the bot guarding the DAO) is a pass.
    if (!id && s.refuse && (await s.refuse()) && s.refusal.test(r.text)) {
      console.log(`  ✓ ${name}: refused, as it should be\n      ${trim(r.text.split("\n").find((l) => l.trim()) ?? "", 400)}`);
      results.push({ name, ok: true });
      return;
    }
    if (!id) throw new Error(`not proposed:\n      ${trim(r.text)}`);
    const summary = r.text.split("\n").find((l) => l.trim() && !/^✅/.test(l)) ?? "";
    const c = await run("B", `confirm ${id}`);
    if (!/Confirmed/.test(c.text)) throw new Error(`B's confirmation failed:\n      ${trim(c.text)}`);
    await rpc("evm_increaseTime", [hex(2)]);
    await rpc("evm_mine");
    await settle();
    const e = await run("A", `execute ${id}`);
    if (!/executed/.test(e.text)) throw new Error(`execute #${id} failed:\n      ${trim(e.text)}`);
    await settle();
    const detail = s.check ? await s.check(before) : "";
    console.log(`  ✓ ${name} (#${id})\n      ${trim(summary, 400)}${detail ? `\n      ${detail}` : ""}`);
    results.push({ name, ok: true });
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${trim(err.message ?? String(err), 1500)}`);
    results.push({ name, ok: false });
  }
}
const expect = (ok, what) => {
  if (!ok) throw new Error(`check failed: ${what}`);
  return what;
};

// ---- per network ----
function baseSteps() {
  const d = aave.protocol.deployments.base;
  const USDC = getAddress(d.tokens.USDC);
  const WETH = getAddress(d.tokens.WETH);
  const WSTETH = getAddress(lido.protocol.deployments.base.wsteth);
  const coin = process.env.FORK_FLAUNCH_COIN;
  return [
    { name: "uniswap-swap", line: `uniswap-swap ETH ${USDC} 0.05 3%`, before: () => held(USDC), check: async (b) => expect((await held(USDC)) > b, `USDC ${await show(USDC, await held(USDC))} (was ${await show(USDC, b)})`) },
    { name: "aerodrome-swap", line: "aerodrome-swap ETH USDC 0.05 3%", before: () => held(USDC), check: async (b) => expect((await held(USDC)) > b, `USDC ${await show(USDC, await held(USDC))} (was ${await show(USDC, b)})`) },
    { name: "aave-supply", line: "aave-supply ETH 2", before: native, check: async (b) => { const a = await account(d.pool); expect(a.collateral > 0n && (await native()) <= b - parseEther("2"), "2 ETH supplied"); return `collateral $${formatUnits(a.collateral, 8)}, ETH ${formatEther(await native())}`; } },
    { name: "aave-borrow", line: "aave-borrow USDC 50", before: () => held(USDC), check: async (b) => { const a = await account(d.pool); expect((await held(USDC)) === b + parseUnits("50", 6) && a.debt > 0n, "50 USDC borrowed"); return `USDC ${await show(USDC, await held(USDC))}, debt $${formatUnits(a.debt, 8)}`; } },
    { name: "aave-repay", line: "aave-repay USDC all", check: async () => { const a = await account(d.pool); expect(a.debt === 0n, "no debt left"); return `debt $0, USDC ${await show(USDC, await held(USDC))}`; } },
    { name: "aave-collateral", line: "aave-collateral WETH off", check: async () => { const a = await account(d.pool); expect(a.collateral === 0n, "WETH no longer collateral"); return "collateral $0 (still supplied)"; } },
    { name: "aave-withdraw", line: "aave-withdraw WETH all", before: () => held(WETH), check: async (b) => { const w = await held(WETH); expect(w >= b + parseEther("2"), "2 WETH and interest back"); return `WETH ${formatEther(w)}`; } },
    { name: "lido-buy-wsteth", line: "lido-buy-wsteth 0.5 maxgap=3%", check: async () => { const w = await held(WSTETH); expect(w > 0n, "wstETH bought"); return `wstETH ${formatEther(w)}`; } },
    { name: "lido-sell-wsteth", line: "lido-sell-wsteth all", before: native, check: async (b) => { expect((await held(WSTETH)) === 0n && (await native()) > b, "wstETH sold for ETH"); return `wstETH 0, ETH ${formatEther(await native())}`; } },
    coin
      ? { name: "flaunch-buy", line: `flaunch-buy ${coin} 0.01 5%`, check: async () => { const h = await held(coin); expect(h > 0n, "coin bought"); return `coin ${await show(coin, h)}`; } }
      : { name: "flaunch-buy", skip: "set FORK_FLAUNCH_COIN" },
    coin
      ? { name: "flaunch-sell", line: `flaunch-sell ${coin} all 10%`, check: async () => { expect((await held(coin)) === 0n, "coin sold"); return "coin 0"; } }
      : { name: "flaunch-sell", skip: "set FORK_FLAUNCH_COIN" },
  ];
}

function monadSteps() {
  const d = aave.protocol.deployments["monad-mainnet"];
  const USDC = getAddress(d.tokens.USDC);
  const P = perpl.protocol.deployments["monad-mainnet"];
  const AUSD = getAddress(P.collateral);
  const SHMON = getAddress(shmonad.protocol.deployments["monad-mainnet"].shmonad);
  const token = process.env.FORK_NADFUN_TOKEN;
  const swap = process.env.FORK_MON_SWAP || "500";
  let supplied = 0n;
  // Perpl: a small BTC order a little through the mark, immediate-or-cancel.
  const pctx = { publicClient, network: net };
  const btc = async () => {
    const m = await perpl.deskVenue.market(pctx, checksum(P), "BTC");
    const info = await perpl.deskVenue.read(pctx, checksum(P), "getPerpetualInfo", [m.perpId]);
    const mark = Number(formatUnits(info.markPNS, m.priceDecimals));
    return { m, mark, price: (x) => (mark * x).toFixed(Math.min(m.priceDecimals, 1)) };
  };
  return [
    { name: "uniswap-swap", line: `uniswap-swap MON ${USDC} ${swap} 3%`, before: () => held(USDC), check: async (b) => expect((await held(USDC)) > b, `USDC ${await show(USDC, await held(USDC))} (was ${await show(USDC, b)})`) },
    // Supplied USDC may not count as collateral on Monad's market (loan-to-value 0): then it only earns
    // interest, and the bot refuses a borrow against it up front.
    { name: "aave-supply", line: async () => { supplied = (await held(USDC)) / 2n; return `aave-supply USDC ${await show(USDC, supplied)}`; }, before: () => held(USDC), check: async (b) => { const a = await account(d.pool); expect((await held(USDC)) <= b - supplied, "USDC supplied"); return `USDC ${await show(USDC, await held(USDC))} left; collateral $${formatUnits(a.collateral, 8)}${a.available === 0n ? " (USDC isn't collateral on this market)" : ""}`; } },
    { name: "aave-borrow", line: async () => `aave-borrow USDC ${await show(USDC, supplied / 10n)}`, refuse: async () => (await account(d.pool)).available === 0n, refusal: /nothing on Aave v3 to borrow against/, before: () => held(USDC), check: async (b) => { const a = await account(d.pool); expect((await held(USDC)) > b && a.debt > 0n, "USDC borrowed"); return `USDC ${await show(USDC, await held(USDC))}, debt $${formatUnits(a.debt, 8)}`; } },
    { name: "aave-repay", line: "aave-repay USDC all", skipIf: async () => (await account(d.pool)).debt === 0n, check: async () => { const a = await account(d.pool); expect(a.debt === 0n, "no debt left"); return "debt $0"; } },
    { name: "aave-withdraw", line: "aave-withdraw USDC all", before: () => held(USDC), check: async (b) => { expect((await held(USDC)) >= b + supplied, "USDC and interest back"); return `USDC ${await show(USDC, await held(USDC))}`; } },
    { name: "shmon-stake", line: "shmon-stake 100", check: async () => { const s = await held(SHMON); expect(s > 0n, "shMON received"); return `shMON ${formatEther(s)}`; } },
    { name: "shmon-unstake-instant", line: async () => `shmon-unstake-instant ${formatEther((await held(SHMON)) / 2n)} 3%`, before: native, check: async (b) => { expect((await native()) > b, "MON back now"); return `MON ${formatEther(await native())}, shMON ${formatEther(await held(SHMON))}`; } },
    { name: "shmon-request-unstake", line: "shmon-request-unstake all", check: async () => { expect((await held(SHMON)) === 0n, "shMON burned, unstake queued"); return "shMON 0 (queued; completeUnstake comes epochs later)"; } },
    token
      ? { name: "nadfun-buy", line: `nadfun-buy ${token} 10 10%`, check: async () => { const h = await held(token); expect(h > 0n, "token bought"); return `token ${await show(token, h)}`; } }
      : { name: "nadfun-buy", skip: "set FORK_NADFUN_TOKEN" },
    token
      ? { name: "nadfun-sell", line: `nadfun-sell ${token} all 10%`, check: async () => { expect((await held(token)) === 0n, "token sold"); return "token 0"; } }
      : { name: "nadfun-sell", skip: "set FORK_NADFUN_TOKEN" },
    // MON/AUSD on Uniswap can be too thin: the bot refusing it (price impact) is right.
    { name: "uniswap-swap (AUSD)", line: `uniswap-swap MON ${AUSD} ${swap} 3%`, refuse: async () => true, refusal: /too thin/, before: () => held(AUSD), check: async (b) => expect((await held(AUSD)) > b, `AUSD ${await show(AUSD, await held(AUSD))}`) },
    // Perpl needs at least 10 AUSD: on the fork, give the Treasury 50 (anvil_dealERC20, Foundry 1.x).
    { name: "fund AUSD (fork only)", setup: async () => { const want = parseUnits(process.env.FORK_AUSD || "50", await decimalsOf(AUSD)); const have = await held(AUSD); if (have < want) await rpc("anvil_dealERC20", [AUSD, treasury, hex(want)]); return `AUSD ${await show(AUSD, await held(AUSD))} in the Treasury`; } },
    { name: "perpl-deposit", line: async () => `perpl-deposit ${await show(AUSD, await held(AUSD))}`, check: async () => { expect((await held(AUSD)) === 0n, "AUSD deposited"); return "AUSD 0 in the Treasury (in its Perpl account)"; } },
    { name: "perpl-open", line: async () => { const b = await btc(); return `perpl-open BTC long ${(10 ** -b.m.lotDecimals).toFixed(b.m.lotDecimals)} ${b.price(1.02)}`; }, check: async () => { const b = await btc(); const pos = await perpl.deskVenue.read(pctx, checksum(P), "getPosition", [b.m.perpId, await accountId(P)]); expect(pos[0].lotLNS > 0n, "a BTC long is open"); return `BTC long ${formatUnits(pos[0].lotLNS, b.m.lotDecimals)} (mark ${b.mark})`; } },
    { name: "perpl-close", line: async () => { const b = await btc(); return `perpl-close BTC long all ${b.price(0.98)}`; }, check: async () => { const b = await btc(); const pos = await perpl.deskVenue.read(pctx, checksum(P), "getPosition", [b.m.perpId, await accountId(P)]); expect(pos[0].lotLNS === 0n, "the long is closed"); return "no BTC position"; } },
    { name: "perpl-withdraw", line: async () => { const s = await perpl.deskVenue.exchangeState({ ...pctx, treasury }, checksum(P)); return `perpl-withdraw ${formatUnits(s.balance, s.decimals)}`; }, check: async () => { const a = await held(AUSD); expect(a > 0n, "AUSD back in the Treasury"); return `AUSD ${await show(AUSD, a)}`; } },
  ];
}
const checksum = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : v]));
const accountId = async (P) => (await perpl.deskVenue.exchangeState({ publicClient, network: net, treasury }, checksum(P))).accountId;

async function hyperevmSteps() {
  const WHYPE = getAddress(hyperswap.protocol.deployments.hyperevm.whype);
  const KHYPE = getAddress(kinetiq.protocol.deployments.hyperevm.khype);
  // HyperLend's one market, read from its registry the way the bot does.
  const registry = getAddress(hyperlendMod.protocol.deployments.hyperevm.registry);
  const [provider] = await publicClient.readContract({ address: registry, abi: HYPERLEND.registry, functionName: "getAddressesProvidersList" });
  const pool = await publicClient.readContract({ address: provider, abi: AAVE.addressesProvider, functionName: "getPool" });
  return [
    { name: "hyperlend-supply", line: "hyperlend-supply WHYPE 10", check: async () => { const a = await account(pool); expect(a.collateral > 0n, "WHYPE supplied"); return `collateral $${formatUnits(a.collateral, 8)}`; } },
    { name: "hyperlend-borrow", line: "hyperlend-borrow WHYPE 1", before: () => held(WHYPE), check: async (b) => { const a = await account(pool); expect((await held(WHYPE)) === b + parseEther("1") && a.debt > 0n, "1 WHYPE borrowed"); return `debt $${formatUnits(a.debt, 8)}`; } },
    { name: "hyperlend-repay", line: "hyperlend-repay WHYPE all", check: async () => { const a = await account(pool); expect(a.debt === 0n, "no debt left"); return "debt $0"; } },
    { name: "hyperlend-withdraw", line: "hyperlend-withdraw WHYPE all", before: () => held(WHYPE), check: async (b) => { const a = await account(pool); expect(a.collateral === 0n && (await held(WHYPE)) >= b + parseEther("10"), "10 WHYPE and interest back"); return `WHYPE ${formatEther(await held(WHYPE))}`; } },
    { name: "kinetiq-buy-khype", line: "kinetiq-buy-khype 5", check: async () => { const k = await held(KHYPE); expect(k > 0n, "kHYPE bought"); return `kHYPE ${formatEther(k)}`; } },
    { name: "kinetiq-sell-khype", line: "kinetiq-sell-khype all", before: native, check: async (b) => { expect((await held(KHYPE)) === 0n && (await native()) > b, "kHYPE sold for HYPE"); return `kHYPE 0, HYPE ${formatEther(await native())}`; } },
  ];
}

// ---- main ----
async function main() {
  const chainId = await publicClient.getChainId().catch(() => null);
  if (chainId !== CHAIN_ID) {
    console.error(`${FORK} is chain ${chainId ?? "unreachable"}; --network ${which} needs an anvil fork of chain ${CHAIN_ID}.`);
    process.exit(2);
  }
  const block = await publicClient.getBlockNumber();
  console.log(`Forked ${net.chain.name} at block ${block}`);

  // Board contracts, deployed onto the fork; the bot finds the factory through its env var.
  process.env[networkEnvName(NETWORK, "BOARD_FACTORY_ADDRESS")] = await deploy("BoardDAOFactory", [await deploy("Treasury"), await deploy("BoardGovernance")]);
  // A 1-second timelock: the bot's fast timings (testnets only), shrunk.
  net.fastTimings = true;
  net.fastScale = 1 / 60;

  for (const u of ["A", "B", "C"]) {
    const a = privateKeyToAccount(generatePrivateKey());
    accounts.set(u, a);
    await rpc("anvil_setBalance", [a.address, hex(parseEther("100"))]);
  }
  const signers = ["A", "B", "C"].map((u) => accounts.get(u).address);
  const dao = await getAdapter("board").createDAO(`Fork ${which}`, signers);
  treasury = getAddress(dao.treasury);
  registerChat(CHAT, dao.governance, "board", "slack", "A", NETWORK);
  const funds = { monad: "100000", base: "50", hyperevm: "1000" }[which];
  await rpc("anvil_setBalance", [treasury, hex(parseEther(funds))]);
  console.log(`Board DAO ${dao.governance} (2 of 3), Treasury ${treasury} with ${funds} ${NATIVE}\n`);

  if (which === "hyperevm") {
    // HyperLend takes WHYPE, not HYPE: the Treasury wraps 20 itself (setup, not an action under test).
    await rpc("anvil_impersonateAccount", [treasury]);
    const asTreasury = createWalletClient({ account: treasury, chain: net.chain, transport: http(FORK) });
    await send(asTreasury.writeContract({ address: getAddress(hyperswap.protocol.deployments.hyperevm.whype), abi: WRAPPED, functionName: "deposit", value: parseEther("20") }));
    await rpc("anvil_stopImpersonatingAccount", [treasury]);
    console.log("  Treasury wrapped 20 HYPE into WHYPE (setup)\n");
  }

  const steps = which === "base" ? baseSteps() : which === "monad" ? monadSteps() : await hyperevmSteps();
  for (const s of steps) await step(s);
}

try {
  await main();
} catch (err) {
  console.error(err);
  results.push({ name: "setup", ok: false });
} finally {
  restore();
}
const ran = results.filter((r) => r.ok !== null);
const passed = ran.filter((r) => r.ok).length;
const skipped = results.length - ran.length;
console.log(`\n${passed} of ${ran.length} passed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(passed === ran.length ? 0 : 1);
