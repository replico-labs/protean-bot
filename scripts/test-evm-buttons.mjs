#!/usr/bin/env node
/**
 * The Sowellian and Decision Markets buttons end to end on a local anvil
 * chain, through the same code a Slack button press runs: proposalButtons
 * for each state, the amount and "are you sure" menus (src/buttonMenus.js)
 * reading real balances and the real pool quote, and the commands their
 * buttons carry, run by runCommand as the member who pressed. Checks that
 * an EVM trade's minimum out is 1% under DecisionMarketPair.getAmountOut,
 * and that /proposal names Sowellian phases (not "Unknown").
 *
 *   anvil --chain-id 10143 --code-size-limit 100000 --prune-history
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol)
 *   node scripts/deploy-local-evm.mjs > .env.local-evm
 *   node --experimental-test-module-mocks --env-file=.env.local-evm scripts/test-evm-buttons.mjs
 *
 * Wallet storage is stood in for (members are throwaway keys the operator
 * funds); data/chats.json is backed up and restored. Local chains only: it
 * mines blocks and moves the clock instead of waiting.
 */
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY ||= LOCAL_KEY;
process.env.FAST_TIMINGS = "true";
process.env.RPC_PUBLIC_FALLBACK = "false"; // never the real testnet
process.env.SUPABASE_URL ||= "https://supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test";

const fs = await import("node:fs");
const { mock } = await import("node:test");
const { parseEther, formatEther, getAddress, encodeFunctionData, parseAbi, zeroAddress, zeroHash } = await import("viem");
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

const { publicClient, walletClient } = await import("../src/config.js");
const { stakeTokens, walletClientFor } = await import("../src/governance/common.js");
const { getAdapter } = await import("../src/governance/index.js");
const { registerChat } = await import("../src/db.js");
const { runCommand } = await import("../src/platforms/commands.js");
const { buttonMenu } = await import("../src/buttonMenus.js");
const { splitArgs } = await import("../src/args.js");

const anvil = await fetch(process.env.RPC_URL ?? "http://127.0.0.1:8545", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_nodeInfo", params: [] }),
})
  .then((r) => r.json())
  .then((j) => Boolean(j.result))
  .catch(() => false);
if (!anvil || (await publicClient.getChainId()) !== 10143) {
  console.error("This script only runs against a local anvil chain (chain id 10143).");
  process.exit(2);
}

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const TREASURY = parseAbi(["function transferETH(address recipient, uint256 amount)"]);
const PAIR = parseAbi(["function token0() view returns (address)", "function getAmountOut(uint256 amountIn, bool zeroForOne) view returns (uint256)"]);
const mine = (blocks) => publicClient.request({ method: "anvil_mine", params: [`0x${blocks.toString(16)}`] });
const warp = async (seconds) => {
  await publicClient.request({ method: "evm_increaseTime", params: [`0x${Math.ceil(seconds).toString(16)}`] });
  await mine(1);
};
const mineTo = async (block) => {
  const now = await publicClient.getBlockNumber({ cacheTime: 0 });
  if (BigInt(block) >= now) await mine(Number(BigInt(block) - now) + 1);
};
const now = async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
const send = async (hash) => publicClient.waitForTransactionReceipt({ hash: await hash });

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures++;
};

/** A member: user id `u` on Slack, a funded throwaway key. */
async function member(u) {
  const account = privateKeyToAccount(generatePrivateKey());
  accounts.set(u, account);
  await send(walletClient.sendTransaction({ to: account.address, value: parseEther("10") }));
  return { u, account, client: walletClientFor(account), address: account.address };
}

const ctxFor = (chatId, u, args = []) => ({ platform: "slack", chatId, userId: u, args, isAdmin: true, isDirect: false, cmd: (n) => `/protean ${n}` });
/** Runs a typed command (or a button's command) as `u`. */
const run = (chatId, u, line) => {
  const [name, ...args] = splitArgs(line);
  return runCommand(name, ctxFor(chatId, u, args));
};
/** Presses a button's command as `u`: an `ask` one returns its menu, anything else runs. */
const press = (chatId, u, cmd) => (cmd.startsWith("ask ") ? buttonMenu(ctxFor(chatId, u), cmd.split(" ").slice(1)) : run(chatId, u, cmd));
const cmdsOf = (buttons) => (buttons ?? []).flat().filter((b) => b.cmd).map((b) => b.cmd);
const payment = (treasury, to) => [{ target: getAddress(treasury), value: 0n, data: encodeFunctionData({ abi: TREASURY, functionName: "transferETH", args: [to, parseEther("0.0001")] }) }];

try {
  /* ------------------------------ Decision Markets ------------------------------ */
  console.log("Decision Markets: create, seed, then trade through the buttons…");
  const dm = getAdapter("decisionMarkets");
  const DM = "C-DM";
  const dmDao = await dm.createDAO("Buttons DM", "BDM", 1_000_000, 2_000_000);
  registerChat(DM, dmDao.governance, "decisionMarkets", "slack", "A");
  const A = await member("A");
  await send(walletClient.writeContract({ address: getAddress(dmDao.underlyingToken), abi: ERC20, functionName: "transfer", args: [A.address, parseEther("300000")] }));
  await stakeTokens(A.client, dmDao.governanceToken, 300_000);
  await send(walletClient.sendTransaction({ to: dmDao.treasury, value: parseEther("0.01") }));
  await mine(2);
  const { proposalId } = await dm.proposeWithSeed(A.client, dmDao.governance, payment(dmDao.treasury, A.address), "test: buttons", 1000, "0.001");
  const id = String(proposalId);

  let r = await run(DM, "A", `proposal ${id}`);
  check(/Open/.test(r.text), `/proposal ${id} shows the markets open`, r.text.split("\n")[0]);
  const trading = cmdsOf(r.buttons);
  for (const c of [`ask amount trade ${id} pass buy`, `ask amount trade ${id} fail sell`, `ask amount split ${id} base`, `finalizeproposal ${id}`]) check(trading.includes(c), `button: ${c}`);

  let menu = await press(DM, "A", `ask amount split ${id} base`);
  const split = cmdsOf(menu.buttons).find((c) => c.startsWith("split "));
  check(Boolean(split) && /You have [\d.]+ /.test(menu.text), `split menu offers shares of A's balance (${split})`, menu.text);
  r = await press(DM, "A", split);
  check(/✅ Split/.test(r.text), "pressing a share splits", r.text);

  menu = await press(DM, "A", `ask amount trade ${id} fail sell`);
  const sell = cmdsOf(menu.buttons).find((c) => c.startsWith("trade "));
  const [, , , side, amount, minOut] = sell?.split(" ") ?? [];
  const p = await dm.getProposal(dmDao.governance, id);
  const quoted = await publicClient.readContract({ address: p.failPool, abi: PAIR, functionName: "getAmountOut", args: [parseEther(amount ?? "0"), true] });
  const floor99 = (quoted * 9_900n) / 10_000n;
  check(side === "base", `selling sells the base side (${sell})`);
  check(parseEther(minOut ?? "0") <= floor99 && parseEther(minOut ?? "0") >= floor99 - parseEther("0.0001"), `minimum out is 1% under the pool's quote (${minOut} vs ${formatEther(floor99)})`);
  r = await press(DM, "A", sell);
  check(/✅ Traded on the \*fail\* market/.test(r.text), "pressing it trades", r.text);

  menu = await press(DM, "A", `ask amount trade ${id} pass buy`);
  check(/Split some first/.test(menu.text) && cmdsOf(menu.buttons).every((c) => !c.startsWith("trade ")), "buying with no pass quote tokens says to split first", menu.text);
  menu = await press(DM, "A", `ask amount split ${id} quote`);
  check(/You have no .+ to split/.test(menu.text), "splitting quote with no quote token says so", menu.text);

  await warp(Number(p.tradingDeadline - (await now())) + 5);
  r = await press(DM, "A", `finalizeproposal ${id}`);
  check(/✅ Proposal #\d+ finalized/.test(r.text), "Settle markets finalizes", r.text);
  r = await run(DM, "A", `proposal ${id}`);
  const settled = cmdsOf(r.buttons);
  check(settled.includes(`redeem ${id} base`) && settled.includes(`redeem ${id} quote`), `once settled: Redeem buttons (${settled.join(", ")})`);
  if (/Queued/.test(r.text)) check(settled[0] === `execute ${id}`, "and Execute first, since it passed");
  r = await press(DM, "A", `redeem ${id} base`);
  check(/✅ Redeemed/.test(r.text), "Redeem tokens redeems", r.text);

  /* --------------------------------- Sowellian --------------------------------- */
  console.log("Sowellian: approval vote, positions and a resolution through the buttons…");
  const sw = getAdapter("sowellian");
  const SW = "C-SW";
  const swDao = await sw.createDAO("Buttons SW", "BSW", 1_000_000, 2_000_000);
  registerChat(SW, swDao.governance, "sowellian", "slack", "B");
  const B = await member("B");
  const C = await member("C");
  for (const [m, n] of [[B, 300_000], [C, 200_000]]) {
    await send(walletClient.writeContract({ address: getAddress(swDao.underlyingToken), abi: ERC20, functionName: "transfer", args: [m.address, parseEther(String(n))] }));
    await stakeTokens(m.client, swDao.governanceToken, n);
  }
  await send(walletClient.sendTransaction({ to: swDao.treasury, value: parseEther("0.01") }));
  await mine(2);
  const HUMAN = 1;
  const { proposalId: sid } = await sw.proposeWithCriteria(B.client, swDao.governance, payment(swDao.treasury, B.address), "test: buttons", HUMAN, zeroAddress, zeroHash, 0, true, 30);
  const s = String(sid);
  let sp = await sw.getProposal(swDao.governance, s);
  await mineTo(sp.approvalStartBlock);

  r = await run(SW, "B", `proposal ${s}`);
  check(/ApprovalVoting/.test(r.text) && !/Unknown/.test(r.text.split("\n")[0]), "/proposal names the phase (ApprovalVoting)", r.text.split("\n")[0]);
  let b = cmdsOf(r.buttons);
  check(b.includes(`castapprovalvote ${s} for`) && b.includes(`finalizeapproval ${s}`), `approval buttons (${b.join(", ")})`);
  for (const u of ["B", "C"]) {
    r = await press(SW, u, `castapprovalvote ${s} for`);
    check(/✅ Voted \*for\*/.test(r.text), `${u} approves with the For button`, r.text);
  }
  await mineTo(sp.approvalEndBlock);
  r = await press(SW, "B", `finalizeapproval ${s}`);
  check(/✅/.test(r.text), "Close approval vote finalizes it", r.text);

  r = await run(SW, "B", `proposal ${s}`);
  b = cmdsOf(r.buttons);
  check(/PositionsOpen/.test(r.text) && b.includes(`ask amount takeposition ${s} yes`), `positions open: Back YES / NO (${b.join(", ")})`, r.text.split("\n")[0]);
  menu = await press(SW, "B", `ask amount takeposition ${s} yes`);
  const back = cmdsOf(menu.buttons).find((c) => c.startsWith("takeposition "));
  check(Boolean(back), `the menu offers shares of B's tokens (${back})`, menu.text);
  r = await press(SW, "B", back);
  check(/✅/.test(r.text), "pressing one takes the position", r.text);
  menu = await press(SW, "C", `ask amount takeposition ${s} no`);
  r = await press(SW, "C", cmdsOf(menu.buttons).find((c) => c.startsWith("takeposition ")));
  check(/✅/.test(r.text), "C backs NO the same way", r.text);

  sp = await sw.getProposal(swDao.governance, s);
  await warp(Number(sp.positionsDeadline - (await now())) + 2);
  r = await run(SW, "B", `execute ${s}`);
  check(/✅/.test(r.text), "execute", r.text);
  sp = await sw.getProposal(swDao.governance, s);
  await warp(Number(sp.measurementDeadline - (await now())) + 2);

  r = await run(SW, "B", `proposal ${s}`);
  b = cmdsOf(r.buttons);
  // The contract's phase stays Executed; past the measurement deadline the buttons offer resolving, on its own track only.
  check(b.includes(`ask sure proposeresolution ${s} success`) && !b.includes(`resolveviaoracle ${s}`), `measurement over: the human track's propose buttons, no oracle one (${b.join(", ")})`);
  menu = await press(SW, "B", `ask sure proposeresolution ${s} success`);
  check(/resolution bond/.test(menu.text), "It worked asks first: it posts a bond", menu.text);
  r = await press(SW, "B", cmdsOf(menu.buttons)[0]);
  check(/✅/.test(r.text), "confirming proposes the outcome", r.text);
  r = await run(SW, "B", `proposal ${s}`);
  b = cmdsOf(r.buttons);
  check(b.includes(`ask sure challengeresolution ${s}`) && b.includes(`finalizeunchallenged ${s}`), `resolution proposed: Challenge / Lock it in (${b.join(", ")})`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  restore();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
