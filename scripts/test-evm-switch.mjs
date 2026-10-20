#!/usr/bin/env node
/**
 * Model switching end to end on a local anvil chain, through the bot's own
 * code (src/modelSwitch.js and the model adapters): one DAO goes
 * token-weighted -> quadratic -> board -> conviction -> token-weighted,
 * each step a real proposal on the current governance that passes and
 * executes, then detectSwitch() has to find the new governance. Checks the
 * Treasury, token and staking contract follow along and the members'
 * stake never moves.
 *
 *   anvil --chain-id 10143 --code-size-limit 100000 --prune-history
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol)
 *   node scripts/deploy-local-evm.mjs > .env.local-evm
 *   node --env-file=.env.local-evm scripts/test-evm-switch.mjs
 *
 * Local chains only: it mines blocks and moves the clock forward instead
 * of waiting out votes and timelocks.
 */
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY ||= LOCAL_KEY;
process.env.FAST_TIMINGS = "true";
process.env.RPC_PUBLIC_FALLBACK = "false"; // never the real testnet

const { parseEther, getAddress, zeroAddress, parseAbi } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { publicClient, walletClient, operatorAccount } = await import("../src/config.js");
const { createDaoOnChain } = await import("../src/contracts.js");
const { stakeTokens, walletClientFor } = await import("../src/governance/common.js");
const { getAdapter } = await import("../src/governance/index.js");
const { buildSwitch, detectSwitch } = await import("../src/modelSwitch.js");

// Asked of the RPC directly: the bot's client would fall back to the real testnet.
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

const READS = parseAbi([
  "function governance() view returns (address)",
  "function owner() view returns (address)",
  "function authorizedLocker() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function getVotes(address) view returns (uint256)",
  "function state(uint256) view returns (uint8)",
  "function executableAfter(uint256) view returns (uint256)",
]);
const read = (address, functionName, args = []) => publicClient.readContract({ address, abi: READS, functionName, args });
const mine = (blocks) => publicClient.request({ method: "anvil_mine", params: [`0x${blocks.toString(16)}`] });
const warp = async (seconds) => {
  await publicClient.request({ method: "evm_increaseTime", params: [`0x${Math.ceil(seconds).toString(16)}`] });
  await mine(1);
};

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`);
  if (!ok) failures++;
};

// A second Board signer, funded by the operator.
const signer2 = privateKeyToAccount(generatePrivateKey());
await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: signer2.address, value: parseEther("10") }) });
const signer2Client = walletClientFor(signer2);
const operator = walletClient;

console.log("Creating a token-weighted DAO and staking…");
const dao = await createDaoOnChain("Switch Test", "SWT", 1_000_000, 10_000_000);
const treasury = getAddress(dao.treasury);
const staking = getAddress(dao.governanceToken);
const token = getAddress(dao.underlyingToken);
await stakeTokens(operator, staking, 500_000);
await mine(2);
const stakeBefore = await read(staking, "balanceOf", [operatorAccount.address]);

async function assertFollowed(previous, next, model, { stakingMoves = true } = {}) {
  const found = await detectSwitch({ governanceAddress: previous });
  check(found && getAddress(found.governance) === getAddress(next) && found.model === model, `detectSwitch finds the new ${model} governance`);
  check(getAddress(await read(treasury, "governance")) === getAddress(next), "Treasury answers to it");
  check(getAddress(await read(token, "owner")) === getAddress(next), "token is owned by it");
  if (stakingMoves) check(getAddress(await read(staking, "owner")) === getAddress(next), "staking contract is owned by it");
  check((await read(staking, "balanceOf", [operatorAccount.address])) === stakeBefore, "members' stake is untouched");
}

/** Token-weighted or quadratic: propose, vote, queue, execute. */
async function passByVote(model, governance, actions) {
  const adapter = getAdapter(model);
  const { proposalId } = await adapter.propose(operator, governance, actions, `Switch away from ${model}`);
  const { startBlock, endBlock } = await adapter.getProposal(governance, proposalId);
  await mine(Number(startBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.vote(operator, governance, proposalId, 1);
  await mine(Number(endBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.queue(operator, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - Number((await publicClient.getBlock()).timestamp) + 1);
  await adapter.execute(operator, governance, proposalId);
}

/** Board: propose (counts as the first confirmation), second signer confirms, execute after the timelock. */
async function passByBoard(governance, actions) {
  const board = getAdapter("board");
  const { proposalId } = await board.propose(operator, governance, actions, "Switch away from board");
  await board.confirm(signer2Client, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - Number((await publicClient.getBlock()).timestamp) + 1);
  await board.execute(operator, governance, proposalId);
}

/** Conviction: support with the whole stake, mine until enough conviction, queue, execute. */
async function passByConviction(governance, actions) {
  const conviction = getAdapter("conviction");
  const { proposalId } = await conviction.propose(operator, governance, actions, "Switch away from conviction");
  await conviction.support(operator, governance, proposalId);
  // Conviction grows by a fixed amount per block, up to the support behind
  // the proposal: mine in big steps until it's enough.
  for (let i = 0; i < 100; i++) {
    const p = await conviction.getProposal(governance, proposalId);
    if (p.currentConviction >= p.requiredConviction) break;
    if (i === 0) console.log(`  conviction ${p.currentConviction} of ${p.requiredConviction} needed`);
    await mine(1000);
  }
  await conviction.queue(operator, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - Number((await publicClient.getBlock()).timestamp) + 1);
  await conviction.execute(operator, governance, proposalId);
  return proposalId;
}

let governance = getAddress(dao.governance);

console.log("tokenWeighted -> quadratic");
let plan = await buildSwitch({ fromModel: "tokenWeighted", governance, toModel: "quadratic" });
check(plan.actions.length === 5, "five actions: deploy, Treasury, token, locker, staking");
await passByVote("tokenWeighted", governance, plan.actions);
await assertFollowed(governance, plan.newGovernance, "quadratic");
governance = plan.newGovernance;

console.log("quadratic -> board");
plan = await buildSwitch({ fromModel: "quadratic", governance, toModel: "board", members: [operatorAccount.address, signer2.address] });
await passByVote("quadratic", governance, plan.actions);
await assertFollowed(governance, plan.newGovernance, "board");
governance = plan.newGovernance;

console.log("board -> conviction (token found through the board's predecessor)");
plan = await buildSwitch({ fromModel: "board", governance, toModel: "conviction" });
check(plan.staking === staking && plan.token === token, "the switch found the DAO's token and staking contract");
await passByBoard(governance, plan.actions);
await assertFollowed(governance, plan.newGovernance, "conviction");
check(getAddress(await read(staking, "authorizedLocker")) === getAddress(plan.newGovernance), "conviction is the staking contract's locker");
governance = plan.newGovernance;

console.log("conviction -> tokenWeighted (support stays locked until withdrawn)");
plan = await buildSwitch({ fromModel: "conviction", governance, toModel: "tokenWeighted" });
await passByConviction(governance, plan.actions);
await assertFollowed(governance, plan.newGovernance, "tokenWeighted");
check((await read(staking, "authorizedLocker")) === zeroAddress, "locking is off again");
await getAdapter("conviction").withdrawSupport(operator, governance);
check(true, "support withdrawn on the old conviction governance after the switch");
const old = governance;
governance = plan.newGovernance;
check((await detectSwitch({ governanceAddress: governance })) === null, "nothing to follow while nothing switched");

console.log("refusals");
const refused = async (what, args) => {
  try {
    await buildSwitch(args);
    check(false, what);
  } catch (err) {
    check(err.userFacing === true, `${what}: ${err.message.split("\n")[0].slice(0, 110)}`);
  }
};
await refused("same model", { fromModel: "tokenWeighted", governance, toModel: "tokenWeighted" });
await refused("old governance", { fromModel: "conviction", governance: old, toModel: "quadratic" });
await refused("board without signers", { fromModel: "tokenWeighted", governance, toModel: "board" });

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll switch checks passed.");
process.exit(failures ? 1 : 0);
