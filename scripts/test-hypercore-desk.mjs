#!/usr/bin/env node
/**
 * The HyperCore trading desk (src/deskHypercore.js) end to end on a local
 * anvil chain posing as HyperEVM testnet, through the same /desk commands a
 * chat runs. HyperCore itself is stood in for twice:
 *
 * - on the chain: a CoreWriter stand-in at 0x3333… that logs each raw action,
 *   and a perpAssetInfo precompile stand-in at 0x…080a (perp 0 BTC, 1 ETH);
 * - off it: a small Hyperliquid API (info + exchange) that approves an agent
 *   when the Treasury's executed proposal logs CoreWriter action 9, and
 *   fills orders - after recovering who signed each one, so the test proves
 *   orders are signed by the bot's agent key and never by the trader.
 *
 * Checks: the appointment proposal approves a fresh agent (action 9,
 * abi(address,string)); the mandate (markets, max, total, leverage) and the
 * pause hold; closing works while paused; removal revokes the agent and the
 * bot destroys its key; resigning destroys the key at once; a second
 * trader gets their own agent and markets, and can't touch the first's.
 *
 *   anvil --chain-id 998 --port 8547 --code-size-limit 100000 --prune-history 300
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol)
 *   node scripts/deploy-local-evm.mjs --rpc http://127.0.0.1:8547 | sed -E 's/^([A-Z_]+)=/HYPEREVM_TESTNET_\1=/' > .env.local-hyperevm
 *   cast rpc --rpc-url http://127.0.0.1:8547 evm_setIntervalMining 1
 *   node --experimental-test-module-mocks --env-file=.env.local-hyperevm scripts/test-hypercore-desk.mjs
 *
 * HyperEVM reads are pinned to the block after the bot's last transaction
 * (receipts.js), so the chain must keep making blocks (interval mining) and
 * keep the last few hundred blocks' state (--prune-history 300 keeps them
 * and keeps mining long voting windows fast).
 *
 * Wallet storage is stood in for; data/chats.json is backed up and restored.
 */
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY ||= LOCAL_KEY;
process.env.HYPEREVM_TESTNET_FAST_TIMINGS = "true"; // short voting windows on this network
process.env.HYPEREVM_TESTNET_RPC_PUBLIC_FALLBACK = "false"; // never the real testnet
process.env.SUPABASE_URL ||= "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";

const fs = await import("node:fs");
const http = await import("node:http");
const { mock } = await import("node:test");
const { parseEther, getAddress, parseAbi, parseEventLogs, decodeAbiParameters, hexToNumber, slice, recoverTypedDataAddress } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { createL1ActionHash } = await import("@nktkas/hyperliquid/signing");

// ---- stand-ins: wallets (userId -> a throwaway key) and the desk's agent keys ----
const accounts = new Map();
const agentKeys = new Map();
mock.module(new URL("../src/walletStore.js", import.meta.url).href, {
  namedExports: {
    isWalletStoreConfigured: () => true,
    createWalletRecord: async () => null,
    getWalletAccount: async () => null,
    recordGasTopup: async () => 0,
    findWalletRecord: async (p, u) => (accounts.has(String(u)) ? { address: accounts.get(String(u)).address } : null),
    findSolanaWallet: async () => null,
    storeSolanaWallet: async () => null,
    recordSolanaTopup: async () => 0,
    createAgentKey: async (id) => {
      const account = privateKeyToAccount(generatePrivateKey());
      agentKeys.set(id, account);
      return account.address;
    },
    getAgentAccount: async (id) => {
      if (!agentKeys.has(id)) throw new Error(`No agent key ${id}`);
      return agentKeys.get(id);
    },
    deleteAgentKey: async (id) => void agentKeys.delete(id),
  },
});
mock.module(new URL("../src/walletResolver.js", import.meta.url).href, {
  namedExports: {
    getOrCreateUserAccount: async (u) => accounts.get(String(u)),
    getUserAddress: async (u) => accounts.get(String(u))?.address,
  },
});

/* ------------------------- a stand-in Hyperliquid API ------------------------- */

const MARKETS = [
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "ETH", szDecimals: 4, maxLeverage: 25 },
];
const core = { agents: new Map(), positions: new Map(), exchange: [] }; // agents: principal -> [{ address, name }]
const principalOf = (agent) => [...core.agents].find(([, list]) => list.some((a) => getAddress(a.address) === getAddress(agent)))?.[0];

async function signerOf({ action, nonce, signature, vaultAddress, expiresAfter }) {
  const connectionId = createL1ActionHash({ action, nonce, vaultAddress, expiresAfter });
  return recoverTypedDataAddress({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: "b", connectionId },
    signature: { r: signature.r, s: signature.s, v: BigInt(signature.v) },
  });
}

async function answer(path, body) {
  if (path === "/info") {
    if (body.type === "meta") return { universe: MARKETS };
    if (body.type === "extraAgents") return (core.agents.get(getAddress(body.user)) ?? []).map((a) => ({ ...a, validUntil: null }));
    if (body.type === "clearinghouseState") {
      const assetPositions = [...core.positions].map(([coin, p]) => ({
        type: "oneWay",
        position: { coin, szi: String(p.szi), entryPx: String(p.px), positionValue: String(Math.abs(p.szi) * p.px), unrealizedPnl: "0", marginUsed: "0", leverage: { type: "cross", value: p.lev ?? 1 } },
      }));
      return { marginSummary: { accountValue: "2000" }, withdrawable: "1500", assetPositions };
    }
    throw new Error(`info ${body.type} isn't stood in for`);
  }
  const signer = await signerOf(body);
  const principal = principalOf(signer);
  core.exchange.push({ action: body.action, signer, principal });
  if (!principal) return { status: "err", response: `User or API Wallet ${signer} does not exist.` };
  if (body.action.type === "updateLeverage") {
    core.lev = body.action.leverage;
    return { status: "ok", response: { type: "default" } };
  }
  if (body.action.type === "order") {
    const o = body.action.orders[0];
    const coin = MARKETS[o.a].name;
    const held = core.positions.get(coin) ?? { szi: 0, px: Number(o.p) };
    const szi = held.szi + (o.b ? 1 : -1) * Number(o.s);
    if (Math.abs(szi) < 1e-12) core.positions.delete(coin);
    else core.positions.set(coin, { szi, px: Number(o.p), lev: core.lev });
    return { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: o.s, avgPx: o.p, oid: core.exchange.length } }] } } };
  }
  throw new Error(`exchange ${body.action.type} isn't stood in for`);
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    try {
      const out = await answer(req.url, JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500).end(err.message);
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.HYPERLIQUID_INFO_URL = `http://127.0.0.1:${server.address().port}/info`;

const chats = new URL("../data/chats.json", import.meta.url);
const backup = fs.existsSync(chats) ? fs.readFileSync(chats) : null;
const restore = () => (backup ? fs.writeFileSync(chats, backup) : fs.rmSync(chats, { force: true }));
// A run stopped part-way (Ctrl-C, a timeout) still puts data/chats.json back.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

const { runOnNetwork } = await import("../src/networks.js");
const { publicClient, walletClient } = await import("../src/config.js");
const { stakeTokens, walletClientFor } = await import("../src/governance/common.js");
const { getAdapter } = await import("../src/governance/index.js");
const { createDaoOnChain } = await import("../src/contracts.js");
const { registerChat, getChatDesk } = await import("../src/db.js");
const { runCommand } = await import("../src/platforms/commands.js");
const { splitArgs } = await import("../src/args.js");
const { parseMandate, mandateText } = await import("../src/desk.js");

// Compiled from (solc 0.8.28):
//   contract CoreWriterStub { event RawAction(address indexed user, bytes data);
//     function sendRawAction(bytes calldata data) external { emit RawAction(msg.sender, data); } }
//   contract PerpInfoStub { struct PerpAssetInfo { string coin; uint32 marginTableId; uint8 szDecimals; uint8 maxLeverage; bool onlyIsolated; }
//     fallback(bytes calldata data) external returns (bytes memory) { uint32 i = abi.decode(data, (uint32));
//       if (i == 0) return abi.encode(PerpAssetInfo("BTC", 0, 5, 40, false)); if (i == 1) return abi.encode(PerpAssetInfo("ETH", 0, 4, 25, false));
//       return abi.encode(PerpAssetInfo("", 0, 0, 0, false)); } }
const CORE_WRITER_CODE = "0x608060405234801561000f575f5ffd5b5060043610610029575f3560e01c806317938e131461002d575b5f5ffd5b61004760048036038101906100429190610106565b610049565b005b3373ffffffffffffffffffffffffffffffffffffffff167f8c7f585fb295f7eb1e6aeb8fba61b23a4fe60beda405f0045073b185c74412e383836040516100919291906101ab565b60405180910390a25050565b5f5ffd5b5f5ffd5b5f5ffd5b5f5ffd5b5f5ffd5b5f5f83601f8401126100c6576100c56100a5565b5b8235905067ffffffffffffffff8111156100e3576100e26100a9565b5b6020830191508360018202830111156100ff576100fe6100ad565b5b9250929050565b5f5f6020838503121561011c5761011b61009d565b5b5f83013567ffffffffffffffff811115610139576101386100a1565b5b610145858286016100b1565b92509250509250929050565b5f82825260208201905092915050565b828183375f83830152505050565b5f601f19601f8301169050919050565b5f61018a8385610151565b9350610197838584610161565b6101a08361016f565b840190509392505050565b5f6020820190508181035f8301526101c481848661017f565b9050939250505056fea264697066735822122071066aee21fb79731bf1fdd5568ecc101b17952f356f6d945fff5566d0a7b1da64736f6c634300081c0033";
const PERP_INFO_CODE = "0x608060405234801561000f575f5ffd5b505f3660605f83838101906100249190610215565b90505f8163ffffffff16036100c6576040518060a001604052806040518060400160405280600381526020017f425443000000000000000000000000000000000000000000000000000000000081525081526020015f63ffffffff168152602001600560ff168152602001602860ff1681526020015f15158152506040516020016100af9190610367565b6040516020818303038152906040529150506101cd565b60018163ffffffff1603610167576040518060a001604052806040518060400160405280600381526020017f455448000000000000000000000000000000000000000000000000000000000081525081526020015f63ffffffff168152602001600460ff168152602001601960ff1681526020015f15158152506040516020016101509190610367565b6040516020818303038152906040529150506101cd565b6040518060a0016040528060405180602001604052805f81525081526020015f63ffffffff1681526020015f60ff1681526020015f60ff1681526020015f15158152506040516020016101ba9190610367565b6040516020818303038152906040529150505b915050805190602001f35b5f5ffd5b5f63ffffffff82169050919050565b6101f4816101dc565b81146101fe575f5ffd5b50565b5f8135905061020f816101eb565b92915050565b5f6020828403121561022a576102296101d8565b5b5f61023784828501610201565b91505092915050565b5f81519050919050565b5f82825260208201905092915050565b8281835e5f83830152505050565b5f601f19601f8301169050919050565b5f61028282610240565b61028c818561024a565b935061029c81856020860161025a565b6102a581610268565b840191505092915050565b6102b9816101dc565b82525050565b5f60ff82169050919050565b6102d4816102bf565b82525050565b5f8115159050919050565b6102ee816102da565b82525050565b5f60a083015f8301518482035f86015261030e8282610278565b915050602083015161032360208601826102b0565b50604083015161033660408601826102cb565b50606083015161034960608601826102cb565b50608083015161035c60808601826102e5565b508091505092915050565b5f6020820190508181035f83015261037f81846102f4565b90509291505056fea264697066735822122079271e4df8d4efa6fe4ff270cd7afadb7e8bb0ed91b201a355cf66d6893d9a5f64736f6c634300081c0033";
const CORE_WRITER = "0x3333333333333333333333333333333333333333";
const PERP_INFO = "0x000000000000000000000000000000000000080a";
const RAW_ACTION = parseAbi(["event RawAction(address indexed user, bytes data)"]);
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures++;
};

const CHAT = "C-HLDESK";
const ctxFor = (u, args, isAdmin) => ({ platform: "slack", chatId: CHAT, userId: u, args, isAdmin, isDirect: false, cmd: (n) => `/protean ${n}` });
const run = (u, line, { admin = false } = {}) => {
  const [name, ...args] = splitArgs(line);
  return runCommand(name, ctxFor(u, args, admin));
};
// In chunks: a long voting window is thousands of blocks, more than anvil mines within one request's timeout.
const mine = async (blocks) => {
  for (let left = blocks; left > 0; left -= 2000) await publicClient.request({ method: "anvil_mine", params: [`0x${Math.min(left, 2000).toString(16)}`] });
};
const send = async (hash) => publicClient.waitForTransactionReceipt({ hash: await hash });

async function main() {
  const chainOk = await publicClient.getChainId().catch(() => null);
  if (chainOk !== 998) {
    console.error("This script only runs against a local anvil chain with chain id 998 (HYPEREVM_TESTNET_RPC_URL).");
    process.exit(2);
  }
  await publicClient.request({ method: "anvil_setCode", params: [CORE_WRITER, CORE_WRITER_CODE] });
  await publicClient.request({ method: "anvil_setCode", params: [PERP_INFO, PERP_INFO_CODE] });

  console.log("The mandate…");
  const m = parseMandate(["BTC,ETH", "max=1000", "total=1500", "lev=3"]);
  check(m.total === "1500" && /up to 1000 USDC each, 1500 USDC in all/.test(mandateText(m, "USDC")), `total= is read and shown (${mandateText(m, "USDC")})`);
  let threw = null;
  try {
    parseMandate(["BTC", "max=1000", "total=500"]);
  } catch (err) {
    threw = err.message;
  }
  check(/can't be less than max/.test(threw ?? ""), "total under max is refused", threw);

  console.log("A DAO on HyperEVM (local), and its desk…");
  const adapter = getAdapter("tokenWeighted");
  const dao = await createDaoOnChain("Desk DAO", "DSK", 1_000_000, 2_000_000);
  registerChat(CHAT, dao.governance, "tokenWeighted", "slack", "A", "hyperevm-testnet");
  const member = async (u) => {
    const account = privateKeyToAccount(generatePrivateKey());
    accounts.set(u, account);
    await send(walletClient.sendTransaction({ to: account.address, value: parseEther("10") }));
    await send(walletClient.writeContract({ address: getAddress(dao.underlyingToken), abi: ERC20, functionName: "transfer", args: [account.address, parseEther("300000")] }));
    const client = walletClientFor(account);
    await stakeTokens(client, dao.governanceToken, 300_000);
    return { u, account, client };
  };
  const A = await member("A"); // the DAO's creator, and the trader
  const B = await member("B");
  const C = await member("C"); // a second trader, later
  await mine(2);

  /** Votes a proposal through and executes it; then HyperCore applies the Treasury's CoreWriter actions. Returns those actions. */
  async function pass(id) {
    // Voting windows and the timelock are counted in blocks.
    // The bot's reads use a block number viem caches for a few seconds: let it see new blocks before going on.
    const settle = () => new Promise((r) => setTimeout(r, 5000));
    const mineTo = async (block) => {
      const now = await publicClient.getBlockNumber({ cacheTime: 0 });
      if (BigInt(block) >= now) await mine(Number(BigInt(block) - now) + 1);
      await settle();
    };
    const p = await adapter.getProposal(dao.governance, id);
    await mineTo(p.startBlock);
    for (const x of [A, B]) await adapter.vote(x.client, dao.governance, id, 1);
    await mineTo(p.endBlock);
    await adapter.queue(A.client, dao.governance, id);
    // tokenWeighted's timelock is a timestamp; models that count it in blocks give a block number.
    const { executableAfter } = await adapter.getProposal(dao.governance, id);
    if (executableAfter > 1_000_000_000n) {
      const { timestamp } = await publicClient.getBlock();
      if (executableAfter >= timestamp) await publicClient.request({ method: "evm_increaseTime", params: [`0x${(executableAfter - timestamp + 2n).toString(16)}`] });
      await mine(2);
      await settle();
    } else await mineTo(executableAfter);
    const { hash } = await adapter.execute(A.client, dao.governance, id);
    const receipt = await publicClient.getTransactionReceipt({ hash });
    const actions = parseEventLogs({ abi: RAW_ACTION, logs: receipt.logs }).filter((l) => getAddress(l.address) === getAddress(CORE_WRITER) && getAddress(l.args.user) === getAddress(dao.treasury)).map((l) => l.args.data);
    for (const data of actions) {
      if (hexToNumber(slice(data, 0, 1)) !== 1 || hexToNumber(slice(data, 1, 4)) !== 9) continue;
      const [agent, name] = decodeAbiParameters([{ type: "address" }, { type: "string" }], slice(data, 4));
      const list = (core.agents.get(getAddress(dao.treasury)) ?? []).filter((a) => a.name !== name);
      core.agents.set(getAddress(dao.treasury), [...list, { address: getAddress(agent), name }]);
    }
    return actions;
  }
  const idIn = (text) => /Proposal #(\d+)/.exec(text)?.[1];
  const lastOrder = () => core.exchange.filter((e) => e.action.type === "order").at(-1);

  let r = await run("A", "desk");
  check(/Trading desk\* \(HyperCore\)/.test(r.text) && /Traders: none/.test(r.text), "/desk on HyperEVM shows the HyperCore desk, no trader", r.text);

  console.log("A applies; the DAO votes the appointment through…");
  r = await run("A", "desk apply BTC,ETH max=1000 total=1500 lev=3 days=30");
  const appoint = idIn(r.text);
  check(Boolean(appoint) && /hypercore-approve-agent/.test(r.text), `the appointment is a proposal (#${appoint})`, r.text);
  const pending = getChatDesk(CHAT, "slack")?.pending?.[appoint];
  check(pending?.kind === "appoint" && agentKeys.has(pending.agentKey), "a fresh agent key is made and kept by the bot, not given to A");
  r = await run("A", "desk long BTC 0.01 at 50000");
  check(/Only the desk's appointed traders/.test(r.text), "no trading before the proposal executes", r.text);

  const actions = await pass(appoint);
  const [agent, name] = actions[0] ? decodeAbiParameters([{ type: "address" }, { type: "string" }], slice(actions[0], 4)) : [];
  check(actions.length === 1 && getAddress(agent ?? "0x0000000000000000000000000000000000000000") === getAddress(pending.agent) && name === pending.agentName && name === "protean-desk-1", `executing it sends CoreWriter action 9 approving that agent as "${pending.agentName}"`);
  r = await run("A", "desk");
  check(/1\. `0x/.test(r.text) && r.text.includes(A.account.address), "/desk shows A as the trader", r.text);

  console.log("A trades within the mandate; the bot refuses outside it…");
  r = await run("A", "desk long BTC 0.01 at 50000 3x");
  let o = lastOrder();
  check(/Filled 0.01 BTC/.test(r.text), "a long within the mandate fills", r.text);
  check(o && getAddress(o.signer) === getAddress(pending.agent) && getAddress(o.signer) !== getAddress(A.account.address), "the order is signed by the desk's agent key, not A's wallet");
  check(core.lev === 3 && o?.action.orders[0].t.limit.tif === "Ioc" && o.action.orders[0].p === "50000", "leverage set to 3x first; immediate-or-cancel at the limit price");
  r = await run("A", "desk long BTC 0.02 at 50000");
  check(/allows up to 1000/.test(r.text), "a BTC position over max (1500 > 1000) is refused", r.text);
  r = await run("A", "desk long BTC 0.001 at 50000 5x");
  check(/up to 3x/.test(r.text), "5x is refused (mandate 3x)", r.text);
  r = await run("A", "desk long ETH 0.3 at 3000 2x");
  check(/Filled 0.3 ETH/.test(r.text), "ETH 900 fills (total 1400 of 1500)", r.text);
  r = await run("A", "desk long BTC 0.004 at 50000");
  check(/1500 in all/.test(r.text), "BTC to 700 would make 1600 in all: refused by total", r.text);
  r = await run("A", "desk mine");
  check(/BTC long 0\.01 .*500 of 1000 USDC used/.test(r.text) && /ETH long 0\.3 .*900 of 1000 USDC used/.test(r.text) && /Desk total: 1,400 of 1500 USDC used \(room for 100\)/.test(r.text), "desk mine shows A's positions, what each uses of max, and the desk total", r.text);
  r = await run("B", "desk mine");
  check(/aren't one of the desk's traders/.test(r.text), "desk mine for a non-trader says so", r.text);
  r = await run("B", "desk long BTC 0.001 at 50000");
  check(/Only the desk's appointed traders/.test(r.text), "B can't trade", r.text);

  console.log("Pause…");
  r = await run("B", "desk pause");
  check(/Only this chat's admins or the DAO's creator/.test(r.text), "B (not admin, not creator) can't pause", r.text);
  r = await run("A", "desk pause");
  check(/paused/.test(r.text), "the DAO's creator pauses", r.text);
  r = await run("A", "desk long BTC 0.001 at 50000");
  check(/The desk is paused/.test(r.text), "no new positions while paused", r.text);
  r = await run("A", "desk close BTC all at 40000");
  o = lastOrder();
  check(/Filled 0.01 BTC/.test(r.text) && o.action.orders[0].r === true && o.action.orders[0].b === false, "closing still works: a reduce-only sell of the whole long", r.text);
  r = await run("B", "desk resume", { admin: true });
  check(/resumed/.test(r.text), "a chat admin resumes", r.text);

  console.log("Removal by proposal…");
  r = await run("B", "desk remove");
  const removal = idIn(r.text);
  check(Boolean(removal), `removing the trader is a proposal (#${removal})`, r.text);
  await pass(removal);
  r = await run("A", "desk long ETH 0.01 at 3000");
  check(/Only the desk's appointed traders|no longer approves/.test(r.text), "after it executes A can't trade", r.text);
  check(!agentKeys.has(pending.agentKey), "and the bot has destroyed the old agent key");
  check(!(core.agents.get(getAddress(dao.treasury)) ?? []).some((a) => getAddress(a.address) === getAddress(pending.agent)), "HyperCore no longer lists the old agent");

  console.log("Re-appointed, and a second trader alongside…");
  r = await run("A", "desk apply ETH max=1000 days=7"); // the 900 ETH long from before is still open
  const again = idIn(r.text);
  const second = getChatDesk(CHAT, "slack")?.pending?.[again];
  await pass(again);
  r = await run("A", "desk long ETH 0.01 at 3000");
  check(/Filled 0.01 ETH/.test(r.text) && getAddress(lastOrder().signer) === getAddress(second.agent), "the new appointment trades with its own new agent", r.text);
  check(getAddress(second.agent) !== getAddress(pending.agent), "a fresh agent address, not the revoked one");

  r = await run("B", "desk apply ETH max=100");
  check(/already trades .*ETH/.test(r.text), "B can't apply for ETH: it's A's market (one position per market on the shared account)", r.text);
  r = await run("C", "desk apply BTC max=1000 lev=2");
  const cId = idIn(r.text);
  const cApp = getChatDesk(CHAT, "slack")?.pending?.[cId];
  check(Boolean(cId) && cApp?.agentName !== second.agentName, `C applies for BTC, with an agent name of its own (${cApp?.agentName} vs ${second.agentName})`, r.text);
  await pass(cId);
  r = await run("B", "desk");
  check(/1\. `0x/.test(r.text) && /2\. `0x/.test(r.text), "/desk lists both traders, numbered", r.text);
  r = await run("C", "desk long BTC 0.01 at 50000 2x");
  check(/Filled 0.01 BTC/.test(r.text) && getAddress(lastOrder().signer) === getAddress(cApp.agent), "C trades BTC, signed by C's own agent", r.text);
  r = await run("C", "desk mine");
  check(/trader 2/.test(r.text) && /BTC long 0\.01/.test(r.text) && !/ETH/.test(r.text.split("\n").slice(2).join("\n")), "C's desk mine shows only C's BTC, not A's ETH", r.text);
  r = await run("A", "desk mine");
  check(/trader 1/.test(r.text) && /ETH long/.test(r.text) && !/BTC long/.test(r.text), "A's desk mine shows only A's ETH", r.text);
  r = await run("B", "desk");
  check(/ETH long .*· trader 1/.test(r.text) && /BTC long .*· trader 2/.test(r.text), "/desk labels each position with its trader", r.text);
  r = await run("C", "desk long ETH 0.01 at 3000");
  check(/isn't one of your markets/.test(r.text), "C can't open ETH, A's market", r.text);
  r = await run("C", "desk close ETH all at 2000");
  check(/isn't one of your markets/.test(r.text), "nor close A's ETH position", r.text);
  r = await run("A", "desk long ETH 0.01 at 3000");
  check(/Filled 0.01 ETH/.test(r.text) && getAddress(lastOrder().signer) === getAddress(second.agent), "A still trades ETH with A's agent", r.text);

  r = await run("B", "desk remove");
  check(/2 traders - say which/.test(r.text), "with two traders, remove asks which", r.text);
  r = await run("B", "desk remove 2");
  const cRemoval = idIn(r.text);
  check(Boolean(cRemoval) && r.text.includes(cApp.agentName), `remove 2 revokes C's agent "${cApp.agentName}"`, r.text);
  await pass(cRemoval);
  r = await run("C", "desk long BTC 0.001 at 50000");
  check(/Only the desk's appointed traders|no longer approves/.test(r.text) && !agentKeys.has(cApp.agentKey), "once it executes C can't trade and C's key is gone", r.text);
  r = await run("A", "desk long ETH 0.01 at 3000");
  check(/Filled 0.01 ETH/.test(r.text), "A is unaffected", r.text);

  r = await run("A", "desk resign");
  check(/destroyed your agent key/.test(r.text) && !agentKeys.has(second.agentKey), "resigning destroys the key at once", r.text);

  r = await run("B", "desk withdraw 100");
  check(/hypercore-usd-transfer/.test(r.text) && /perp to spot/.test(r.text), "desk withdraw proposes moving USDC out of the perps balance", r.text);
}

try {
  await runOnNetwork("hyperevm-testnet", main);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  restore();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll HyperCore desk checks passed.");
process.exit(failures ? 1 : 0);
