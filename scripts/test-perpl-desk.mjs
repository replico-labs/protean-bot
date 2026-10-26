#!/usr/bin/env node
/**
 * The Perpl trading desk (src/desk.js) end to end on a local anvil chain
 * posing as Monad testnet, through the same /desk commands a chat runs.
 * Perpl is stood in for by small contracts (scripts/fixtures/perpl-stubs.sol,
 * compiled into perpl-stubs.json) placed at the addresses the bot pins for
 * Monad testnet: the collateral token, the exchange (immediate-or-cancel
 * orders that fill at the limit price when the mark allows it) and the
 * DelegatedAccount factory (desks owned by the Treasury; operators may only
 * call execOrders, withdrawals pay the owner).
 *
 * Checks: an appointment creates a desk for its trader, who can trade it
 * but never withdraw; the mandate (markets, max, total, leverage, loss=)
 * and the pause hold; closing works while paused or past the loss limit;
 * a second trader gets a desk of their own; /desk mine shows each trader
 * only their own desk, with a PnL card; removal by proposal; the listener's
 * notices (appointed, removed) carry the Desk and My trading buttons;
 * resigning; re-appointment onto a free desk; withdrawing to the Treasury.
 *
 *   anvil --chain-id 10143 --code-size-limit 100000 --prune-history 300
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol)
 *   node scripts/deploy-local-evm.mjs > .env.local-evm
 *   node --experimental-test-module-mocks --env-file=.env.local-evm scripts/test-perpl-desk.mjs
 *
 * Wallet storage is stood in for; data/chats.json is backed up and restored.
 */
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY ||= LOCAL_KEY;
process.env.FAST_TIMINGS = "true"; // short voting windows
process.env.RPC_PUBLIC_FALLBACK = "false"; // never the real testnet
process.env.SUPABASE_URL ||= "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";

const fs = await import("node:fs");
const { mock } = await import("node:test");
const { parseEther, parseUnits, formatUnits, getAddress, parseAbi } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");

// ---- stand-ins: wallets (userId -> a throwaway key) ----
const accounts = new Map();
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
// A run stopped part-way (Ctrl-C, a timeout) still puts data/chats.json back.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

const { publicClient, walletClient } = await import("../src/config.js");
const { stakeTokens, walletClientFor } = await import("../src/governance/common.js");
const { getAdapter } = await import("../src/governance/index.js");
const { createDaoOnChain } = await import("../src/contracts.js");
const { registerChat, getChatDesk } = await import("../src/db.js");
const { runCommand } = await import("../src/platforms/commands.js");
const { splitArgs } = await import("../src/args.js");
const { deskExecuted } = await import("../src/desk.js");
const { checkDesks } = await import("../src/eventListener.js");
const { protocol } = await import("../src/integrations/perpl.js");

const STUBS = JSON.parse(fs.readFileSync(new URL("./fixtures/perpl-stubs.json", import.meta.url)));
const PINNED = protocol.deployments["monad-testnet"];
const BEACON = "0x00000000000000000000000000000000000beac0";
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const BTC = BigInt(PINNED.markets.BTC);
const ETH = BigInt(PINNED.markets.ETH);

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures++;
};

const CHAT = "C-PERPLDESK";
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

/** Deploys a stub, then moves its code to `at` (immutables travel with the code; storage doesn't). */
async function placeStub(name, args, at) {
  const { abi, bytecode } = STUBS[name];
  const receipt = await send(walletClient.deployContract({ abi, bytecode, args }));
  const code = await publicClient.getCode({ address: receipt.contractAddress });
  await publicClient.request({ method: "anvil_setCode", params: [at, code] });
  return { address: getAddress(at), abi };
}

async function main() {
  if ((await publicClient.getChainId().catch(() => null)) !== 10143) {
    console.error("This script only runs against a local anvil chain with chain id 10143 (RPC_URL).");
    process.exit(2);
  }
  const token = await placeStub("TokenStub", [], PINNED.collateral);
  const exchange = await placeStub("ExchangeStub", [getAddress(PINNED.collateral)], PINNED.exchange);
  await placeStub("DelegatedAccountFactoryStub", [getAddress(PINNED.exchange), BEACON, getAddress(PINNED.collateral)], PINNED.deskFactory);
  const ex = (functionName, args = []) => send(walletClient.writeContract({ address: exchange.address, abi: exchange.abi, functionName, args }));
  const exRead = (functionName, args = []) => publicClient.readContract({ address: exchange.address, abi: exchange.abi, functionName, args });
  await ex("listPerp", [BTC, "BTC", 1n, 5n, 500000n]); // 50000.0
  await ex("listPerp", [ETH, "ETH", 2n, 4n, 300000n]); // 3000.00
  await ex("listPerp", [BigInt(PINNED.markets.SOL), "SOL", 3n, 2n, 100000n]); // 100.000
  const DESK_ABI = STUBS.DelegatedAccountStub.abi;

  console.log("A DAO on Monad testnet (local), with 10,000 AUSD in its Treasury…");
  const adapter = getAdapter("tokenWeighted");
  const dao = await createDaoOnChain("Perpl Desk DAO", "PDK", 1_000_000, 2_000_000);
  registerChat(CHAT, dao.governance, "tokenWeighted", "slack", "A", "monad-testnet");
  const daoRow = { chatId: CHAT, platform: "slack", governanceAddress: dao.governance, model: "tokenWeighted", network: "monad-testnet" };
  await send(walletClient.writeContract({ address: token.address, abi: token.abi, functionName: "mint", args: [getAddress(dao.treasury), parseUnits("10000", 6)] }));
  const treasuryAusd = async () => Number(formatUnits(await publicClient.readContract({ address: token.address, abi: ERC20, functionName: "balanceOf", args: [getAddress(dao.treasury)] }), 6));
  const member = async (u) => {
    const account = privateKeyToAccount(generatePrivateKey());
    accounts.set(u, account);
    await send(walletClient.sendTransaction({ to: account.address, value: parseEther("10") }));
    await send(walletClient.writeContract({ address: getAddress(dao.underlyingToken), abi: ERC20, functionName: "transfer", args: [account.address, parseEther("300000")] }));
    const client = walletClientFor(account);
    await stakeTokens(client, dao.governanceToken, 300_000);
    return { u, account, client };
  };
  const A = await member("A"); // the DAO's creator, and the first trader
  const B = await member("B");
  const C = await member("C"); // a second trader, later
  await mine(2);

  /** Votes a proposal through and executes it; the listener's ProposalExecuted step (deskExecuted) follows. Returns its news. */
  async function pass(id) {
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
    return deskExecuted(daoRow, id, hash);
  }
  const idIn = (text) => /Proposal #(\d+)/.exec(text)?.[1];
  const lastCaller = async () => {
    const n = await exRead("orderCallerCount");
    return n ? getAddress(await exRead("orderCallers", [n - 1n])) : null;
  };
  const desksNow = () => Object.keys(getChatDesk(CHAT, "slack")?.desks ?? {});

  let r = await run("A", "desk");
  check(/Trading desk\* \(Perpl\)/.test(r.text) && /No desk yet/.test(r.text), "/desk on Monad shows the Perpl desk, none yet", r.text);

  console.log("A applies; the DAO votes the appointment through…");
  r = await run("A", "desk apply BTC,ETH max=1000 total=1500 lev=3 days=30");
  const appoint = idIn(r.text);
  check(Boolean(appoint) && /perpl-desk-create/.test(r.text), `the appointment is a proposal creating a desk (#${appoint})`, r.text);
  r = await run("A", "desk long BTC 0.01 at 50000");
  check(/Only the desk's appointed traders/.test(r.text), "no trading before the proposal executes", r.text);
  let news = await pass(appoint);
  const desk1 = desksNow()[0];
  check(Boolean(desk1) && news.some((l) => l.includes(A.account.address) && /now trades desk/.test(l)), "executing it creates the desk; the listener's step learns its address and says A trades it", JSON.stringify(news));
  check(await publicClient.readContract({ address: desk1, abi: DESK_ABI, functionName: "isOperator", args: [A.account.address] }), "A is the desk's operator on-chain");
  r = await run("A", "desk long BTC 0.01 at 50000");
  check(/no collateral yet/.test(r.text), "an unfunded desk can't trade", r.text);

  r = await run("B", "desk fund 2000");
  const fund = idIn(r.text);
  check(Boolean(fund) && /perpl-desk-fund/.test(r.text), `funding is a proposal (#${fund})`, r.text);
  await pass(fund);
  r = await run("B", "desk");
  check(/Collateral: 2000 AUSD/.test(r.text) && r.text.includes(A.account.address), "/desk shows the desk's 2000 AUSD and A as its trader", r.text);
  check((await treasuryAusd()) === 8000, "the Treasury sent 2000 AUSD");

  console.log("A trades within the mandate; the bot refuses outside it…");
  r = await run("A", "desk long BTC 0.01 at 50000 3x");
  check(/Filled 0.01 BTC/.test(r.text), "a long within the mandate fills", r.text);
  check((await lastCaller()) === getAddress(desk1), "the order reached the exchange from the desk, A's wallet only signed the desk call");
  r = await run("A", "desk long BTC 0.02 at 50000");
  check(/allows up to 1000/.test(r.text), "a BTC position over max (1500 > 1000) is refused", r.text);
  r = await run("A", "desk long BTC 0.001 at 50000 5x");
  check(/up to 3x/.test(r.text), "5x is refused (mandate 3x)", r.text);
  r = await run("A", "desk long SOL 1 at 100");
  check(/covers BTC, ETH, not SOL/.test(r.text), "a market outside the mandate is refused", r.text);
  r = await run("A", "desk long ETH 0.3 at 3000 2x");
  check(/Filled 0.3 ETH/.test(r.text), "ETH 900 fills (total 1400 of 1500)", r.text);
  r = await run("A", "desk long BTC 0.004 at 50000");
  check(/1500 in all/.test(r.text), "BTC to 700 would make 1600 in all: refused by total", r.text);
  r = await run("A", "desk long ETH 0.01 at 2900");
  check(/Nothing filled/.test(r.text), "a long under the mark doesn't fill (immediate-or-cancel)", r.text);
  r = await run("A", "desk mine");
  check(r.image?.png?.length > 1000, "desk mine comes with a PnL card");
  check(/BTC long 0\.01 .*500 of 1000 AUSD used/.test(r.text) && /ETH long 0\.3 .*900 of 1000 AUSD used/.test(r.text) && /Desk total: 1,400 of 1500 AUSD used \(room for 100\)/.test(r.text), "desk mine shows A's positions, what each uses of max, and the total", r.text);
  check(!/Today \(UTC\).*daily loss limit/.test(r.text), "A has no daily loss limit", r.text);

  console.log("The trader can't take the money…");
  let refused = await A.client.writeContract({ address: desk1, abi: DESK_ABI, functionName: "withdrawCollateral", args: [parseUnits("100", 6)] }).then(() => null, (e) => e.shortMessage ?? e.message);
  check(Boolean(refused), "A's wallet calling the desk's withdrawCollateral is refused", refused);
  refused = await A.client.writeContract({ address: desk1, abi: exchange.abi, functionName: "depositCollateral", args: [1n] }).then(() => null, (e) => e.shortMessage ?? e.message);
  check(Boolean(refused), "and an operator can't call anything but execOrders through the desk", refused);
  r = await run("B", "desk mine");
  check(/aren't one of the desk's traders/.test(r.text), "desk mine for a non-trader says so", r.text);
  r = await run("B", "desk long BTC 0.001 at 50000");
  check(/Only the desk's appointed traders/.test(r.text), "B can't trade", r.text);

  console.log("Pause…");
  r = await run("B", "desk pause");
  check(/Only this chat's admins or the DAO's creator/.test(r.text), "B (not admin, not creator) can't pause", r.text);
  r = await run("A", "desk pause");
  check(/paused/.test(r.text) && JSON.stringify(r.buttons ?? []).includes('"desk mine"'), "the DAO's creator pauses; the reply has the desk buttons", r.text);
  r = await run("A", "desk long BTC 0.001 at 50000");
  check(/The desk is paused/.test(r.text), "no new positions while paused", r.text);
  r = await run("A", "desk close ETH 0.1 at 3000");
  check(/Filled 0.1 ETH/.test(r.text) && /0.2 long/.test(r.text), "closing still works while paused", r.text);
  r = await run("B", "desk resume", { admin: true });
  check(/resumed/.test(r.text), "a chat admin resumes", r.text);

  console.log("A second trader, on a desk of their own, with a daily loss limit…");
  r = await run("C", "desk apply BTC max=1000 lev=2 loss=5");
  const cId = idIn(r.text);
  check(Boolean(cId) && /perpl-desk-create/.test(r.text) && getChatDesk(CHAT, "slack")?.pending?.[cId]?.mandate.loss === "5", `C applies for a new desk (#${cId}), with loss=5 in the mandate`, r.text);
  news = await pass(cId);
  const desk2 = desksNow().find((x) => x !== desk1);
  check(Boolean(desk2) && news.some((l) => l.includes(C.account.address)), "C's desk is created and C trades it", JSON.stringify(news));
  r = await run("B", "desk fund 1000");
  check(/2 desks - say which/.test(r.text), "with two desks, fund asks which", r.text);
  r = await run("B", "desk fund 1000 for=2");
  await pass(idIn(r.text));
  r = await run("B", "desk");
  check(/\*1\.\* Desk/.test(r.text) && /\*2\.\* Desk/.test(r.text) && /Collateral: 1000 AUSD/.test(r.text), "/desk lists both desks, numbered, each with its collateral", r.text);
  check(r.image?.png?.length > 1000, "/desk comes with a PnL card");
  r = await run("C", "desk long BTC 0.01 at 50000 2x");
  check(/Filled 0.01 BTC/.test(r.text) && (await lastCaller()) === getAddress(desk2), "C trades BTC from C's own desk (both traders may hold BTC: separate accounts)", r.text);
  r = await run("C", "desk long ETH 0.01 at 3000");
  check(/covers BTC, not ETH/.test(r.text), "C can't trade ETH", r.text);
  r = await run("C", "desk mine");
  check(/desk 2|trader 2/.test(r.text) && /BTC long 0\.01/.test(r.text) && !/ETH long/.test(r.text), "C's desk mine shows only C's desk", r.text);
  r = await run("A", "desk mine");
  check(/trader 1/.test(r.text) && /ETH long 0\.2/.test(r.text), "A's desk mine shows A's", r.text);

  await ex("setMark", [BTC, 490000n]); // BTC drops to 49000: C's long is down 10 AUSD
  r = await run("C", "desk mine");
  check(/Today \(UTC\): -10 AUSD - ⛔ past your 5 AUSD daily loss limit/.test(r.text), "desk mine shows C down 10 today, past the 5 limit", r.text);
  r = await run("C", "desk long BTC 0.001 at 49000");
  check(/You've lost 10 AUSD today; your mandate stops new positions at 5/.test(r.text), "the daily loss limit stops C's new positions", r.text);
  r = await run("A", "desk long BTC 0.001 at 49000");
  check(/Filled 0.001 BTC/.test(r.text), "A (no loss limit) still trades", r.text);
  r = await run("C", "desk close BTC all at 49000");
  check(/Filled 0.01 BTC/.test(r.text) && /closed/.test(r.text), "closing still works past the limit", r.text);
  await ex("setMark", [BTC, 500000n]);
  r = await run("C", "desk mine");
  check(/Today \(UTC\): -10 AUSD/.test(r.text) && /Collateral|collateral 990 AUSD/.test(r.text), "the realized 10 AUSD loss still counts, and the desk holds 990", r.text);
  r = await run("C", "desk long BTC 0.01 at 50000");
  check(/You've lost 10 AUSD today/.test(r.text), "so C stays stopped for the day", r.text);

  console.log("Removal by proposal, and the listener's notice…");
  r = await run("B", "desk remove");
  check(/2 desks - say which/.test(r.text), "with two traders, remove asks which", r.text);
  r = await run("B", "desk remove 2");
  const cRemoval = idIn(r.text);
  check(Boolean(cRemoval) && /perpl-desk-remove/.test(r.text) && r.text.includes(C.account.address), `remove 2 proposes removing C (#${cRemoval})`, r.text);
  // The listener's ProposalExecuted step (in pass) only handles appointments: a removal is its desk check's to notice.
  await pass(cRemoval);
  const notices = [];
  await checkDesks(async (chatId, text, extra) => notices.push({ chatId, text, extra }), [daoRow]);
  check(notices.length === 1 && notices[0].text.includes(C.account.address) && /no longer the trader/.test(notices[0].text), "the listener posts that C no longer trades desk 2", JSON.stringify(notices));
  check(JSON.stringify(notices[0]?.extra?.buttons ?? []).includes('"desk mine"'), "with Desk and My trading buttons");
  r = await run("C", "desk long BTC 0.001 at 50000");
  check(/Only the desk's appointed traders/.test(r.text), "C can't trade any more", r.text);
  r = await run("A", "desk long ETH 0.01 at 3000");
  check(/Filled 0.01 ETH/.test(r.text), "A is unaffected", r.text);

  console.log("Resigning, then a new appointment onto a free desk…");
  r = await run("A", "desk resign");
  check(/stepped down/.test(r.text), "A resigns", r.text);
  check(!(await publicClient.readContract({ address: desk1, abi: DESK_ABI, functionName: "isOperator", args: [A.account.address] })), "A is no longer desk 1's operator on-chain");
  r = await run("B", "desk apply ETH max=500 days=7");
  const bId = idIn(r.text);
  check(Boolean(bId) && /perpl-desk-appoint/.test(r.text) && r.text.includes(desk1), `B applies and is proposed onto the free desk 1 (#${bId})`, r.text);
  news = await pass(bId);
  check(news.some((l) => l.includes(B.account.address) && l.includes(desk1)), "once it executes, B trades desk 1", JSON.stringify(news));
  r = await run("B", "desk close ETH all at 3000");
  check(/Filled 0.21 ETH/.test(r.text), "B can close the ETH position A left on desk 1", r.text);

  console.log("Withdrawing to the Treasury…");
  const before = await treasuryAusd();
  r = await run("B", "desk withdraw 500 for=1");
  check(/perpl-desk-withdraw/.test(r.text), "withdraw is a proposal", r.text);
  await pass(idIn(r.text));
  check((await treasuryAusd()) === before + 500, `the Treasury got its 500 AUSD back (${before} -> ${await treasuryAusd()})`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  restore();
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll Perpl desk checks passed.");
process.exit(failures ? 1 : 0);
