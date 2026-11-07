#!/usr/bin/env node
/**
 * Token changes, the stake converter and the security council end to end on
 * a local anvil chain, through the bot's own builders (src/governanceChanges.js,
 * src/modelSwitch.js) and the model adapters:
 *   - a token-weighted DAO moves to a new token with a converter; a proposal
 *     opened before the change still votes with the old token; a member
 *     converts their stake in one call;
 *   - it turns a security council on in one proposal, switches to quadratic
 *     under it (one batch the council confirms), and turns it off again;
 *   - a Board-born DAO switches to token-weighted with a new token made in
 *     the same proposal.
 *
 *   anvil --chain-id 10143 --code-size-limit 100000 --prune-history
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol)
 *   node scripts/deploy-local-evm.mjs > .env.local-evm
 *   node --env-file=.env.local-evm scripts/test-evm-changes.mjs
 */
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY ||= LOCAL_KEY;
process.env.FAST_TIMINGS = "true";
process.env.RPC_PUBLIC_FALLBACK = "false"; // never the real testnet

const { parseEther, getAddress, zeroAddress, parseAbi } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { publicClient, walletClient, operatorAccount, writeWithGasBuffer } = await import("../src/config.js");
const { createDaoOnChain } = await import("../src/contracts.js");
const { stakeTokens, walletClientFor } = await import("../src/governance/common.js");
const { getAdapter } = await import("../src/governance/index.js");
const { buildSwitch, detectSwitch } = await import("../src/modelSwitch.js");
const { buildTokenChange, buildCouncilOn, buildCouncilOff, parseRate, GUARD_ABI, CONVERTER_ABI } = await import("../src/governanceChanges.js");

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
  "function governanceToken() view returns (address)",
  "function underlyingToken() view returns (address)",
  "function owner() view returns (address)",
  "function underlying() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function getVotes(address) view returns (uint256)",
  "function executableAfter(uint256) view returns (uint256)",
  "function proposalToken(uint256) view returns (address)",
  "function instructionCount() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
const read = (address, functionName, args = []) => publicClient.readContract({ address, abi: READS, functionName, args });
const mine = (blocks) => publicClient.request({ method: "anvil_mine", params: [`0x${blocks.toString(16)}`] });
const warp = async (seconds) => {
  await publicClient.request({ method: "evm_increaseTime", params: [`0x${Math.ceil(Math.max(seconds, 1)).toString(16)}`] });
  await mine(1);
};
const now = async () => Number((await publicClient.getBlock()).timestamp);
const send = async (client, req) => publicClient.waitForTransactionReceipt({ hash: await writeWithGasBuffer(client, req) });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`);
  if (!ok) failures++;
};

const operator = walletClient;
const me = operatorAccount.address;
const signer2 = privateKeyToAccount(generatePrivateKey());
await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: signer2.address, value: parseEther("10") }) });
const signer2Client = walletClientFor(signer2);

/** Token-weighted or quadratic: propose, vote, queue, execute. Returns the proposal id. */
async function passByVote(model, governance, actions, what) {
  const adapter = getAdapter(model);
  const { proposalId } = await adapter.propose(operator, governance, actions, what);
  const { startBlock, endBlock } = await adapter.getProposal(governance, proposalId);
  await mine(Number(startBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.vote(operator, governance, proposalId, 1);
  await mine(Number(endBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.queue(operator, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - (await now()) + 1);
  await adapter.execute(operator, governance, proposalId);
  return proposalId;
}

async function passByBoard(governance, actions) {
  const board = getAdapter("board");
  const { proposalId } = await board.propose(operator, governance, actions, "Board proposal");
  await board.confirm(signer2Client, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - (await now()) + 1);
  await board.execute(operator, governance, proposalId);
}

console.log("A token-weighted DAO changes its token, with a converter");
const dao = await createDaoOnChain("Changes Test", "CHG", 1_000_000, 10_000_000);
let governance = getAddress(dao.governance);
const treasury = getAddress(dao.treasury);
const oldStaking = getAddress(dao.governanceToken);
await stakeTokens(operator, oldStaking, 500_000);
await mine(2);

// A proposal opened before the change keeps the old token.
const tw = getAdapter("tokenWeighted");
const { proposalId: early } = await tw.propose(operator, governance, [{ target: treasury, value: 0n, data: "0x" }], "Opened before the change");

const change = await buildTokenChange({ model: "tokenWeighted", governance, tokenSpec: "new:Next:NXT:2000000", rate: parseRate("2:1"), fundRaw: parseEther("600000") });
check(change.converter && change.staking && change.token, "the plan names the new token, staking contract and converter");
await passByVote("tokenWeighted", governance, change.actions, "Move to NXT");
check(getAddress(await read(governance, "governanceToken")) === getAddress(change.staking), "same governance, new staking contract");
check(getAddress(await read(governance, "proposalToken", [early])) === oldStaking, "the open proposal keeps the old token");
check((await read(change.token, "balanceOf", [change.converter])) === parseEther("600000"), "the converter is funded from the Treasury");

await send(operator, { address: oldStaking, abi: READS, functionName: "approve", args: [change.converter, parseEther("100000")] });
await send(operator, { address: getAddress(change.converter), abi: CONVERTER_ABI, functionName: "convert", args: [parseEther("100000")] });
await mine(1);
check((await read(change.staking, "balanceOf", [me])) === parseEther("200000"), "100k old stake became 200k new stake, in one call");
check((await read(change.staking, "getVotes", [me])) === parseEther("200000"), "with its votes");
check((await read(oldStaking, "balanceOf", [me])) === parseEther("400000"), "the rest of the old stake is untouched");

console.log("The security council: on, a switch under it, off");
const on = await buildCouncilOn({ model: "tokenWeighted", governance, signers: [me, signer2.address], required: 2, tenureSeconds: 86_400 });
await passByVote("tokenWeighted", governance, on.actions, "Council on");
const wrapper = getAddress(on.wrapper);
check(getAddress(await read(treasury, "governance")) === wrapper, "the Treasury answers to the council's wrapper");
check(getAddress(await read(change.staking, "owner")) === wrapper && getAddress(await read(change.token, "owner")) === wrapper, "so do the token and staking contract");
check(getAddress(await read(wrapper, "governance")) === governance, "and the wrapper answers to the governance");

const sw = await buildSwitch({ fromModel: "tokenWeighted", governance, toModel: "quadratic" });
check(sw.council && getAddress(sw.council) === wrapper, "the switch goes through the council");
await passByVote("tokenWeighted", governance, sw.actions, "Switch to quadratic under the council");
const batch = await read(wrapper, "instructionCount");
check((await detectSwitch({ governanceAddress: governance })) === null, "nothing changes until the council confirms");
await send(operator, { address: wrapper, abi: GUARD_ABI, functionName: "confirmInstruction", args: [batch] });
await send(signer2Client, { address: wrapper, abi: GUARD_ABI, functionName: "confirmInstruction", args: [batch] });
const followed = await detectSwitch({ governanceAddress: governance });
check(followed && getAddress(followed.governance) === getAddress(sw.newGovernance) && followed.model === "quadratic", "confirmed: detectSwitch follows the new governance through the wrapper");
check(getAddress(await read(treasury, "governance")) === wrapper, "the Treasury never moved");
governance = getAddress(sw.newGovernance);

const off = await buildCouncilOff({ model: "quadratic", governance });
await passByVote("quadratic", governance, off.actions, "Council off");
const offBatch = await read(wrapper, "instructionCount");
await send(operator, { address: wrapper, abi: GUARD_ABI, functionName: "confirmInstruction", args: [offBatch] });
await send(signer2Client, { address: wrapper, abi: GUARD_ABI, functionName: "confirmInstruction", args: [offBatch] });
check(getAddress(await read(treasury, "governance")) === governance, "off: the Treasury answers to the governance again");
check(getAddress(await read(change.staking, "owner")) === governance && getAddress(await read(change.token, "owner")) === governance, "and so do the token and staking contract");

console.log("A Board-born DAO switches to token-weighted with a new token");
const boardDao = await getAdapter("board").createDAO("Board Born", [me, signer2.address]);
const board = getAddress(boardDao.governance);
const boardTreasury = getAddress(boardDao.treasury);
check((await read(board, "governanceToken")) === zeroAddress, "no token yet");
let refused = null;
try {
  await buildSwitch({ fromModel: "board", governance: board, toModel: "tokenWeighted" });
} catch (err) {
  refused = err;
}
check(refused?.userFacing && /token=new:/.test(refused.message), "without token= the switch asks for one");
const born = await buildSwitch({ fromModel: "board", governance: board, toModel: "tokenWeighted", tokenSpec: "new:Born:BRN:1000000" });
await passByBoard(board, born.actions);
const grown = await detectSwitch({ governanceAddress: board });
check(grown && getAddress(grown.governance) === getAddress(born.newGovernance) && grown.model === "tokenWeighted", "it follows to token-weighted");
check(getAddress(await read(born.newGovernance, "governanceToken")) === getAddress(born.staking), "voting with the new token's staking contract");
check((await read(born.token, "balanceOf", [boardTreasury])) === parseEther("1000000"), "its supply sits in the Treasury");
check(getAddress(await read(born.token, "owner")) === getAddress(born.newGovernance), "and the new governance owns it");

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll token change and council checks passed.");
process.exit(failures ? 1 : 0);
