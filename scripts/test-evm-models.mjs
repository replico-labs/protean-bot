#!/usr/bin/env node
/**
 * Runs every EVM governance model's whole lifecycle at once, through the
 * bot's own adapters (src/governance/*), and writes a report of what
 * failed and why - one command instead of days of waiting per model.
 *
 *   node scripts/test-evm-models.mjs --network monad-testnet
 *   node scripts/test-evm-models.mjs --network base-sepolia --models board,conviction
 *
 * Uses the bot's .env: OPERATOR_PRIVATE_KEY, the network's RPC and factory
 * addresses (and SORTITION_RANDOMNESS_SOURCE for sortition). Each model
 * gets a fresh DAO created with fast timings (~2 minute votes, 1 minute
 * timelocks, 10 minute council terms - networks.js creationConfig), and
 * three throwaway member wallets the operator funds with gas and tokens,
 * the same way it funds real members. Their leftover gas goes back to the
 * operator at the end.
 *
 * Takes about 20 minutes: the models run side by side, and the delegate
 * and sortition flows wait out a 10-minute council term to hold an
 * election and a draw. On Monad testnet it costs the operator roughly
 * 3-4 MON. The report lands in data/evm-tests/ and is printed at the end.
 *
 * A failed step stops that model's flow (later steps depend on it) but not
 * the other models. Steps marked "extra" don't stop anything.
 *
 * Locally: scripts/deploy-local-evm.mjs deploys everything to anvil first.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ALL_MODELS = ["tokenWeighted", "quadratic", "liquid", "optimistic", "board", "delegate", "sortition", "conviction", "sowellian", "decisionMarkets"];

const networkArg = arg("network");
if (!networkArg) {
  console.error("Which network? e.g. node scripts/test-evm-models.mjs --network monad-testnet");
  process.exit(2);
}

// Fast timings for the DAOs this run creates - set before the network is
// first built, which is when networks.js reads it.
const { resolveNetworkId, networkEnvName } = await import("../src/networks.js");
const networkId = resolveNetworkId(networkArg);
if (!networkId) {
  console.error(`Unknown network "${networkArg}".`);
  process.exit(2);
}
process.env[networkEnvName(networkId, "FAST_TIMINGS")] = "true";

const models = arg("models") ? arg("models").split(",").map((m) => m.trim()) : ALL_MODELS;
const unknownModels = models.filter((m) => !ALL_MODELS.includes(m));
if (unknownModels.length) {
  console.error(`Unknown model(s): ${unknownModels.join(", ")}. Models: ${ALL_MODELS.join(", ")}`);
  process.exit(2);
}

const viem = await import("viem");
const { getAddress, parseEther, formatEther, encodeFunctionData, parseAbi, zeroAddress, zeroHash } = viem;
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { runOnNetwork, getNetwork, currentNetwork } = await import("../src/networks.js");
const { publicClient, walletClient, operatorAccount, writeWithGasBuffer, FACTORY_ADDRESSES, FACTORY_ENV_NAMES, sortitionRandomnessSource } = await import("../src/config.js");
const { createDaoOnChain } = await import("../src/contracts.js");
const common = await import("../src/governance/common.js");
const { getAdapter } = await import("../src/governance/index.js");
const delegateMod = await import("../src/governance/delegate.js");
const sortitionMod = await import("../src/governance/sortition.js");

if (!operatorAccount) {
  console.error("OPERATOR_PRIVATE_KEY isn't set - the operator creates the DAOs and funds the test wallets.");
  process.exit(2);
}

const network = getNetwork(networkId);
if (!network.fastTimings) {
  console.error(`${network.chain.name} isn't a testnet - this test only runs with fast timings, which mainnets ignore.`);
  process.exit(2);
}

/*//////////////////////////////////////////////////////////////
                            HELPERS
//////////////////////////////////////////////////////////////*/

const started = Date.now();
const since = () => `${Math.round((Date.now() - started) / 1000)}s`.padStart(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 3_000;

/** The revert name and arguments, or the RPC's message, from a viem error. */
function describeError(err) {
  const revert = typeof err.walk === "function" ? err.walk((e) => e?.name === "ContractFunctionRevertedError") : null;
  const errorName = revert?.data?.errorName ?? revert?.reason ?? null;
  const errorArgs = revert?.data?.args?.map((a) => String(a)).join(", ");
  let message = (err.shortMessage || err.message || String(err)).split("\n")[0];
  // The RPC turning requests away for load isn't a contract failure - say so.
  if (/too many requests|limited to \d+|rate limit/i.test(`${message} ${err.details ?? ""}`)) message = `RPC rate limit, not a contract failure (${message})`;
  return { revert: errorName ? `${errorName}(${errorArgs ?? ""})` : null, message, details: err.details ?? null };
}

class StepFailed extends Error {}

const loadAbi = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "abis", `${name}.json`), "utf8"));

const TREASURY_ABI = parseAbi(["function transferETH(address recipient, uint256 amount)"]);
const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const STATE_ABI = parseAbi(["function state(uint256) view returns (uint8)", "function executableAfter(uint256) view returns (uint256)"]);
const FEE_ENTROPY_ABI = parseAbi(["function nextSequence() view returns (uint64)", "function reveal(uint64 seq, bytes32 randomNumber)"]);

// Same labels as the adapters' own.
const SHARED_STATES = ["Pending", "Active", "Succeeded", "Queued", "Defeated", "Executed", "Cancelled", "Expired"];
const STATE_LABELS = {
  tokenWeighted: SHARED_STATES,
  quadratic: SHARED_STATES,
  liquid: SHARED_STATES,
  delegate: SHARED_STATES,
  sortition: SHARED_STATES,
  optimistic: ["ChallengeWindow", "Active", "Succeeded", "Queued", "Defeated", "Executed", "Cancelled", "Expired"],
  board: ["Active", "Queued", "Executed", "Cancelled", "Expired"],
  conviction: ["Active", "Queued", "Executed", "Cancelled", "Expired"],
};

const PAYMENT = parseEther("0.0001"); // what each test proposal pays out of the treasury
const SUPPLY = 1_000_000;
const SHARES = { A: 300_000, B: 200_000, C: 100_000 }; // tokens each member is sent and stakes

/** Wall-clock length of a block-counted period on this network, plus slack for slow blocks. */
const blocksMs = (blocks) => Number(blocks) * network.blockTimeMs * 1.5 + 60_000;

const testWallets = [];

/** One model's run: its steps, their results, and the DAO it made. */
class Run {
  constructor(model) {
    this.model = model;
    this.steps = [];
    this.dao = null;
    this.stopped = null;
  }

  log(line) {
    console.log(`${since()}  ${this.model.padEnd(15)} ${line}`);
  }

  /**
   * Runs one step. A failure is recorded and stops the flow, unless
   * `extra` (a check later steps don't need).
   */
  async step(name, fn, { extra = false } = {}) {
    const t = Date.now();
    try {
      const result = await fn();
      this.steps.push({ name, ok: true, ms: Date.now() - t, extra });
      this.log(`✓ ${name}`);
      return result;
    } catch (err) {
      const d = describeError(err);
      this.steps.push({ name, ok: false, ms: Date.now() - t, extra, ...d });
      this.log(`✗ ${name}: ${d.revert ?? d.message}`);
      if (!extra) {
        this.stopped = name;
        throw new StepFailed(name);
      }
      return undefined;
    }
  }

  /** Polls `check` until it returns something truthy, or fails after `timeoutMs`. */
  async waitFor(what, check, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
      await sleep(POLL_MS);
    }
  }
}

function member(label) {
  const account = privateKeyToAccount(generatePrivateKey());
  testWallets.push(account);
  return { label, account, client: common.walletClientFor(account), address: account.address };
}

const latestTimestamp = async () => (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
const blockNumber = () => publicClient.getBlockNumber({ cacheTime: 0 });
const nativeBalance = (address) => publicClient.getBalance({ address, blockTag: "latest" });

async function waitForBlock(run, what, target, budgetBlocks) {
  return run.waitFor(what, async () => (await blockNumber()) > BigInt(target), blocksMs(budgetBlocks));
}

async function waitForTime(run, what, target) {
  const left = Number(BigInt(target) - (await latestTimestamp()));
  return run.waitFor(what, async () => (await latestTimestamp()) >= BigInt(target), Math.max(0, left) * 1000 * 1.5 + 60_000);
}

async function stateOf(model, gov, id) {
  const index = await publicClient.readContract({ address: gov, abi: STATE_ABI, functionName: "state", args: [BigInt(id)] });
  return STATE_LABELS[model][Number(index)];
}

/** Waits for a proposal to reach one of `labels`; fails at once if it lands somewhere else final. */
async function waitForState(run, gov, id, labels, timeoutMs) {
  const finals = ["Defeated", "Executed", "Cancelled", "Expired"];
  return run.waitFor(`proposal #${id} to be ${labels.join("/")}`, async () => {
    const s = await stateOf(run.model, gov, id);
    if (labels.includes(s)) return s;
    if (finals.includes(s)) throw new Error(`Proposal #${id} ended ${s}, expected ${labels.join("/")}`);
    return null;
  }, timeoutMs);
}

async function waitUntilExecutable(run, gov, id) {
  const after = await publicClient.readContract({ address: gov, abi: STATE_ABI, functionName: "executableAfter", args: [BigInt(id)] });
  await waitForTime(run, `proposal #${id}'s timelock`, after);
}

/** Operator -> address, native currency (not gas sponsorship: the value itself). */
async function sendNative(to, amount) {
  const hash = await walletClient.sendTransaction({ to, value: amount });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function sendTokens(token, to, whole) {
  const hash = await writeWithGasBuffer(walletClient, { address: getAddress(token), abi: ERC20_ABI, functionName: "transfer", args: [to, parseEther(String(whole))] });
  await publicClient.waitForTransactionReceipt({ hash });
}

/** A proposal action paying PAYMENT from the treasury to `recipient`. */
const payment = (treasury, recipient) => [
  { target: getAddress(treasury), value: 0n, data: encodeFunctionData({ abi: TREASURY_ABI, functionName: "transferETH", args: [recipient, PAYMENT] }) },
];

async function assertPaid(recipient, before) {
  const after = await nativeBalance(recipient);
  if (after - before !== PAYMENT) throw new Error(`Recipient got ${formatEther(after - before)}, expected ${formatEther(PAYMENT)}`);
}

/** Sends each member their tokens and stakes them; returns the staking token. */
async function fundAndStake(run, dao, members) {
  await run.step("send members tokens", async () => {
    for (const m of members) await sendTokens(dao.underlyingToken, m.address, SHARES[m.label]);
  });
  await run.step("members stake", () => Promise.all(members.map((m) => common.stakeTokens(m.client, dao.governanceToken, SHARES[m.label]))));
  // Votes are counted from a snapshot before the proposal: let a block pass.
  const staked = await blockNumber();
  await waitForBlock(run, "the staking block to pass", staked, 3);
}

async function fundTreasury(run, dao, times = 2) {
  await run.step("fund the treasury", () => sendNative(dao.treasury, PAYMENT * BigInt(times)));
}

const daoName = (model) => `Test ${model} ${new Date().toISOString().slice(5, 16)}`;

/*//////////////////////////////////////////////////////////////
                        MODEL SCENARIOS
//////////////////////////////////////////////////////////////*/

/** Token-weighted, quadratic and liquid: propose, vote, queue, execute; plus a cancel. */
async function votingFlow(run) {
  const { model } = run;
  const adapter = getAdapter(model);
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;

  const dao = (run.dao = await run.step("create DAO", () =>
    model === "tokenWeighted" ? createDaoOnChain(daoName(model), "TST", SUPPLY, SUPPLY * 2) : adapter.createDAO(daoName(model), "TST", SUPPLY, SUPPLY * 2)
  ));
  await fundAndStake(run, dao, [A, B, C]);
  await fundTreasury(run, dao);

  if (model === "liquid") await run.step("C delegates to A", () => adapter.delegate(C.client, dao.governance, A.address));

  const { proposalId: id } = await run.step("A proposes a treasury payment", () => adapter.propose(A.client, dao.governance, payment(dao.treasury, recipient), "test: pay the recipient"));
  const { proposalId: cancelId } = await run.step("B proposes (to cancel)", () => adapter.propose(B.client, dao.governance, payment(dao.treasury, recipient), "test: cancel me"), { extra: true }) ?? {};
  if (cancelId) {
    await run.step("B cancels its proposal", async () => {
      await adapter.cancel(B.client, dao.governance, cancelId);
      const s = await stateOf(model, dao.governance, cancelId);
      if (s !== "Cancelled") throw new Error(`state is ${s}`);
    }, { extra: true });
  }

  await run.step("voting opens", () => waitForState(run, dao.governance, id, ["Active"], blocksMs(5)));
  for (const m of [A, B]) {
    await run.step(`${m.label} votes for`, async () => {
      const { weight } = await adapter.vote(m.client, dao.governance, id, 1);
      if (!weight) throw new Error("The vote counted with zero weight");
    });
  }
  if (model === "liquid") await run.step("C's delegated vote is resolved", () => adapter.resolveDelegatedVote(B.client, dao.governance, id, C.address));

  const { endBlock } = await adapter.getProposal(dao.governance, id);
  await run.step("vote passes", async () => waitForState(run, dao.governance, id, ["Succeeded"], blocksMs(Number(endBlock - (await blockNumber())) + 5)));
  await run.step("queue", () => adapter.queue(A.client, dao.governance, id));
  await run.step("timelock passes", () => waitUntilExecutable(run, dao.governance, id));
  const before = await nativeBalance(recipient);
  await run.step("execute", () => adapter.execute(A.client, dao.governance, id));
  await run.step("treasury paid the recipient", () => assertPaid(recipient, before));
}

/** Optimistic: one proposal passes unchallenged, one is challenged and voted through. */
async function optimisticFlow(run) {
  const adapter = getAdapter("optimistic");
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;

  const dao = (run.dao = await run.step("create DAO", () => adapter.createDAO(daoName("optimistic"), "TST", SUPPLY, SUPPLY * 2)));
  await fundAndStake(run, dao, [A, B, C]);
  await fundTreasury(run, dao);

  const { proposalId: quiet } = await run.step("A proposes (left unchallenged)", () => adapter.propose(A.client, dao.governance, payment(dao.treasury, recipient), "test: unchallenged"));
  const { proposalId: contested } = await run.step("A proposes (to be challenged)", () => adapter.propose(A.client, dao.governance, payment(dao.treasury, recipient), "test: challenged"));
  await run.step("C challenges, posting the bond", () => adapter.challenge(C.client, dao.governance, contested));
  for (const m of [A, B]) {
    await run.step(`${m.label} votes for the challenged proposal`, async () => {
      const { weight } = await adapter.vote(m.client, dao.governance, contested, 1);
      if (!weight) throw new Error("The vote counted with zero weight");
    });
  }

  await run.step("challenge window closes", () => waitForState(run, dao.governance, quiet, ["Succeeded"], blocksMs(400)));
  await run.step("queue the unchallenged one (finalizeUnchallenged)", () => adapter.queue(A.client, dao.governance, quiet));
  await run.step("challenge vote passes", () => waitForState(run, dao.governance, contested, ["Succeeded"], blocksMs(400)));
  await run.step("queue the challenged one (finalizeChallenge)", () => adapter.queue(A.client, dao.governance, contested));
  await run.step("timelocks pass", async () => {
    await waitUntilExecutable(run, dao.governance, quiet);
    await waitUntilExecutable(run, dao.governance, contested);
  });
  for (const id of [quiet, contested]) {
    const before = await nativeBalance(recipient);
    await run.step(`execute #${id}`, () => adapter.execute(A.client, dao.governance, id));
    await run.step(`#${id} paid the recipient`, () => assertPaid(recipient, before));
  }
}

/** Board: two of three signers confirm; plus confirm, revoke, cancel. */
async function boardFlow(run) {
  const adapter = getAdapter("board");
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;

  const dao = (run.dao = await run.step("create DAO (3 signers, 2 to approve)", () => adapter.createDAO(daoName("board"), [A.address, B.address, C.address])));
  await fundTreasury(run, dao);

  // Proposing counts as the proposer's own confirmation.
  const { proposalId: id } = await run.step("A proposes a treasury payment", () => adapter.propose(A.client, dao.governance, payment(dao.treasury, recipient), "test: pay the recipient"));
  await run.step("B confirms (queues it)", async () => {
    await adapter.confirm(B.client, dao.governance, id);
    const s = await stateOf("board", dao.governance, id);
    if (s !== "Queued") throw new Error(`state is ${s} after the second confirmation`);
  });

  const { proposalId: other } = await run.step("C proposes (to revoke and cancel)", () => adapter.propose(C.client, dao.governance, payment(dao.treasury, recipient), "test: cancel me"), { extra: true }) ?? {};
  if (other) {
    await run.step("C revokes its confirmation", () => adapter.revokeConfirmation(C.client, dao.governance, other), { extra: true });
    await run.step("C cancels", () => adapter.cancel(C.client, dao.governance, other), { extra: true });
  }

  await run.step("timelock passes", () => waitUntilExecutable(run, dao.governance, id));
  const before = await nativeBalance(recipient);
  await run.step("execute", () => adapter.execute(A.client, dao.governance, id));
  await run.step("treasury paid the recipient", () => assertPaid(recipient, before));
}

/** Council models: a council proposal end to end, then the term ends. */
async function councilProposal(run, adapter, dao, council, recipient) {
  const { proposalId: id } = await run.step("A proposes a council action", () => adapter.propose(council[0].client, dao.governance, payment(dao.treasury, recipient), "test: pay the recipient"));
  await run.step("council voting opens", () => waitForState(run, dao.governance, id, ["Active"], blocksMs(5)));
  for (const m of council) await run.step(`${m.label} votes for`, () => adapter.vote(m.client, dao.governance, id, 1));
  await run.step("council vote passes", () => waitForState(run, dao.governance, id, ["Succeeded"], blocksMs(400)));
  await run.step("queue", () => adapter.queue(council[0].client, dao.governance, id));
  await run.step("timelock passes", () => waitUntilExecutable(run, dao.governance, id));
  const before = await nativeBalance(recipient);
  await run.step("execute", () => adapter.execute(council[0].client, dao.governance, id));
  await run.step("treasury paid the recipient", () => assertPaid(recipient, before));
}

async function waitForTermEnd(run, dao) {
  await run.step("council term ends", async () => {
    const termEnd = await publicClient.readContract({ address: dao.governance, abi: [{ type: "function", name: "currentTermEnd", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }], functionName: "currentTermEnd" });
    await waitForTime(run, "the council term to end", termEnd);
  });
}

/** Delegate: council proposal, then an election and a recall. */
async function delegateFlow(run) {
  const adapter = delegateMod;
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;

  const dao = (run.dao = await run.step("create DAO (council A, B)", () => adapter.createDAO(daoName("delegate"), "TST", SUPPLY, SUPPLY * 2, [A.address, B.address])));
  await fundAndStake(run, dao, [A, B, C]);
  await fundTreasury(run, dao);
  await councilProposal(run, adapter, dao, [A, B], recipient);

  await waitForTermEnd(run, dao);
  const { electionId } = await run.step("C starts an election", () => adapter.startElection(C.client, dao.governance));
  await run.step("A and C stand", async () => {
    await adapter.declareCandidacy(A.client, dao.governance, electionId);
    await adapter.declareCandidacy(C.client, dao.governance, electionId);
  });
  const election = await adapter.getElection(dao.governance, electionId);
  await run.step("candidacy closes", () => waitForBlock(run, "candidacy to close", election.candidacyDeadline, Number(election.candidacyDeadline - election.snapshotBlock) + 10));
  await run.step("members vote in the election", async () => {
    await adapter.voteInElection(A.client, dao.governance, electionId, [A.address, C.address]);
    await adapter.voteInElection(B.client, dao.governance, electionId, [C.address]);
    await adapter.voteInElection(C.client, dao.governance, electionId, [C.address]);
  });
  await run.step("election voting closes", () => waitForBlock(run, "election voting to close", election.votingEndBlock, Number(election.votingEndBlock - election.candidacyDeadline) + 10));
  await run.step("finalize the election", () => adapter.finalizeElection(B.client, dao.governance, electionId));
  const council = await run.step("C is on the new council", async () => {
    const seated = (await adapter.getCouncil(dao.governance)).map((a) => getAddress(a));
    if (!seated.includes(getAddress(C.address))) throw new Error(`Council is ${seated.join(", ")}`);
    return seated;
  });

  const target = council.find((a) => a !== getAddress(C.address)) ?? council[0];
  const { recallId } = await run.step(`B starts a recall of ${target.slice(0, 8)}…`, () => adapter.initiateRecall(B.client, dao.governance, target));
  await run.step("members vote to recall", async () => {
    await adapter.voteRecall(B.client, dao.governance, recallId, 1);
    await adapter.voteRecall(C.client, dao.governance, recallId, 1);
  });
  const recall = await adapter.getRecall(dao.governance, recallId);
  await run.step("recall vote closes", () => waitForBlock(run, "the recall vote to close", recall.endBlock, 400));
  await run.step("finalize the recall", () => adapter.finalizeRecall(B.client, dao.governance, recallId));
  await run.step("the recalled member is off the council", async () => {
    const seated = (await adapter.getCouncil(dao.governance)).map((a) => getAddress(a));
    if (seated.includes(target)) throw new Error(`${target} is still on the council`);
  });
}

/** Sortition: council proposal, then a random draw for the next council. */
async function sortitionFlow(run) {
  const adapter = sortitionMod;
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;
  const source = sortitionRandomnessSource();
  if (!source) throw Object.assign(new Error(`${networkEnvName(networkId, "SORTITION_RANDOMNESS_SOURCE")} isn't set`), { setup: true });

  const dao = (run.dao = await run.step("create DAO (council A, B)", () => adapter.createDAO(daoName("sortition"), "TST", SUPPLY, SUPPLY * 2, source, [A.address, B.address])));
  await fundAndStake(run, dao, [A, B, C]);
  await fundTreasury(run, dao);
  await run.step("members join the eligible pool", () => Promise.all([A, B, C].map((m) => adapter.registerEligible(m.client, dao.governance))));
  await councilProposal(run, adapter, dao, [A, B], recipient);

  await waitForTermEnd(run, dao);
  await run.step("C starts the draw (pays the Entropy fee)", () => adapter.startSortition(C.client, dao.governance));
  const localEntropy = process.env.LOCAL_FEE_ENTROPY;
  if (localEntropy) {
    // Local stand-in for Pyth's keeper (scripts/deploy-local-evm.mjs).
    await run.step("local Entropy reveals a number", async () => {
      const seq = (await publicClient.readContract({ address: localEntropy, abi: FEE_ENTROPY_ABI, functionName: "nextSequence" })) - 1n;
      const hash = await writeWithGasBuffer(walletClient, { address: localEntropy, abi: FEE_ENTROPY_ABI, functionName: "reveal", args: [seq, `0x${"2a".padStart(64, "0")}`] });
      await publicClient.waitForTransactionReceipt({ hash });
    });
  }
  await run.step("randomness arrives", () => run.waitFor("Pyth Entropy's callback", async () => (await adapter.sortitionStatus(dao.governance)).fulfilled, 5 * 60_000));
  await run.step("finalize the draw", () => adapter.finalizeSortition(A.client, dao.governance));
  await run.step("a new council is seated", async () => {
    const council = await adapter.getCouncil(dao.governance);
    if (council.length === 0) throw new Error("The council is empty");
  });
}

/** Conviction: support builds until the bar is met, then queue and execute. */
async function convictionFlow(run) {
  const adapter = getAdapter("conviction");
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;

  const dao = (run.dao = await run.step("create DAO", () => adapter.createDAO(daoName("conviction"), "TST", SUPPLY, SUPPLY * 2)));
  await fundAndStake(run, dao, [A, B, C]);
  await fundTreasury(run, dao);

  const { proposalId: id, budget } = await run.step("A proposes a treasury payment", () => adapter.propose(A.client, dao.governance, payment(dao.treasury, recipient), "test: pay the recipient"));
  if (budget) run.log(`  budget: ${budget.map((b) => `${formatEther(b.amount)} of ${b.asset}`).join(", ") || "none (asset not listed)"}`);
  for (const m of [A, B]) await run.step(`${m.label} supports it`, () => adapter.support(m.client, dao.governance, id));

  const { convictionGrowthRate } = await publicClient.readContract({ address: dao.governance, abi: loadAbi("ConvictionGovernance"), functionName: "config" });
  const p = await adapter.getProposal(dao.governance, id);
  const blocksNeeded = Number(p.requiredConviction / convictionGrowthRate) + 1;
  run.log(`  needs ${formatEther(p.requiredConviction)} conviction, ~${blocksNeeded} blocks`);
  await run.step("conviction reaches the bar", () =>
    run.waitFor("conviction to reach the bar", async () => {
      const q = await adapter.getProposal(dao.governance, id);
      return q.currentConviction >= q.requiredConviction;
    }, blocksMs(blocksNeeded))
  );
  await run.step("queue", () => adapter.queue(A.client, dao.governance, id));
  await run.step("timelock passes", () => waitUntilExecutable(run, dao.governance, id));
  const before = await nativeBalance(recipient);
  await run.step("execute", () => adapter.execute(A.client, dao.governance, id));
  await run.step("treasury paid the recipient", () => assertPaid(recipient, before));
  await run.step("A withdraws support", () => adapter.withdrawSupport(A.client, dao.governance), { extra: true });
}

/** Sowellian: approval vote, positions, execution, a challenged human resolution, claims. */
async function sowellianFlow(run) {
  const adapter = getAdapter("sowellian");
  const [A, B, C] = ["A", "B", "C"].map(member);
  const recipient = member("R").address;
  const HUMAN = 1, SUCCESS = 1, YES = 0, NO = 1, MEASUREMENT_SECONDS = 30;

  const dao = (run.dao = await run.step("create DAO", () => adapter.createDAO(daoName("sowellian"), "TST", SUPPLY, SUPPLY * 2)));
  await fundAndStake(run, dao, [A, B, C]);
  await fundTreasury(run, dao);

  const { proposalId: id } = await run.step("A proposes (human-resolved, posts the bond)", () =>
    adapter.proposeWithCriteria(A.client, dao.governance, payment(dao.treasury, recipient), "test: pay the recipient", HUMAN, zeroAddress, zeroHash, 0, true, MEASUREMENT_SECONDS)
  );
  let p = await adapter.getProposal(dao.governance, id);
  await run.step("approval voting opens", () => waitForBlock(run, "approval voting to open", p.approvalStartBlock - 1n, 5));
  for (const m of [A, B]) {
    await run.step(`${m.label} approves`, async () => {
      const { weight } = await adapter.castApprovalVote(m.client, dao.governance, id, 1);
      if (!weight) throw new Error("The vote counted with zero weight");
    });
  }
  await run.step("approval voting closes", () => waitForBlock(run, "approval voting to close", p.approvalEndBlock, 400));
  await run.step("finalize approval (positions open)", async () => {
    await adapter.finalizeApproval(A.client, dao.governance, id);
    p = await adapter.getProposal(dao.governance, id);
    if (p.phaseLabel !== "PositionsOpen") throw new Error(`phase is ${p.phaseLabel}`);
  });
  await run.step("A backs yes, B backs no", async () => {
    await adapter.takePosition(A.client, dao.governance, id, YES, 1000);
    await adapter.takePosition(B.client, dao.governance, id, NO, 1000);
  });
  await run.step("positions window closes", () => waitForTime(run, "the positions window to close", p.positionsDeadline + 1n));
  const before = await nativeBalance(recipient);
  await run.step("execute", () => adapter.execute(A.client, dao.governance, id));
  await run.step("treasury paid the recipient", () => assertPaid(recipient, before));
  p = await adapter.getProposal(dao.governance, id);
  await run.step("measurement period ends", () => waitForTime(run, "the measurement period to end", p.measurementDeadline));
  await run.step("A proposes the outcome: success", () => adapter.proposeResolution(A.client, dao.governance, id, SUCCESS));
  await run.step("B challenges the outcome", () => adapter.challengeResolution(B.client, dao.governance, id));
  for (const m of [A, C]) await run.step(`${m.label} votes success in adjudication`, () => adapter.castAdjudicationVote(m.client, dao.governance, id, SUCCESS));
  p = await adapter.getProposal(dao.governance, id);
  await run.step("adjudication closes", () => waitForBlock(run, "adjudication to close", p.adjudicationEndBlock, 400));
  await run.step("finalize adjudication", () => adapter.finalizeAdjudication(A.client, dao.governance, id));
  await run.step("A claims the winning position", async () => {
    const held = () => publicClient.readContract({ address: dao.governanceToken, abi: ERC20_ABI, functionName: "balanceOf", args: [A.address] });
    const pre = await held();
    await adapter.claimPosition(A.client, dao.governance, id);
    if ((await held()) <= pre) throw new Error("A's balance didn't grow");
  });
}

/** Decision markets: seed both markets, trade, finalize on TWAP, execute, reclaim. */
async function decisionMarketsFlow(run) {
  const adapter = getAdapter("decisionMarkets");
  const [A] = ["A"].map(member);
  const recipient = member("R").address;
  const FAIL = 1, BASE = 0;
  const quoteSeed = parseEther("0.001");

  const dao = (run.dao = await run.step("create DAO", () => adapter.createDAO(daoName("decisionMarkets"), "TST", SUPPLY, SUPPLY * 2)));
  await run.step("send A tokens and stake them", async () => {
    await sendTokens(dao.underlyingToken, A.address, SHARES.A);
    await common.stakeTokens(A.client, dao.governanceToken, SHARES.A);
  });
  await run.step("send A the quote-side seed", () => sendNative(A.address, quoteSeed));
  await fundTreasury(run, dao);

  const { proposalId: id } = await run.step("A proposes, seeding both markets", () =>
    adapter.proposeWithSeed(A.client, dao.governance, payment(dao.treasury, recipient), "test: pay the recipient", 1000, formatEther(quoteSeed))
  );
  let p = await adapter.getProposal(dao.governance, id);
  await run.step("A splits tokens into pass/fail", () => adapter.splitTokens(A.client, p.baseVault, 500));
  await run.step("A sells fail-side tokens (pushes the fail price down)", () => adapter.trade(A.client, dao.governance, id, FAIL, BASE, 400, 0));
  await run.step("trading window closes", () => waitForTime(run, "the trading window to close", p.tradingDeadline));
  await run.step("finalize: pass beats fail", async () => {
    await adapter.finalizeProposal(A.client, dao.governance, id);
    p = await adapter.getProposal(dao.governance, id);
    if (!p.passed) throw new Error(`Failed on prices: pass TWAP ${p.passTWAP}, fail TWAP ${p.failTWAP}`);
  });
  const { timelockDelay } = await publicClient.readContract({ address: dao.governance, abi: loadAbi("DecisionMarketsGovernance"), functionName: "config" });
  await run.step("timelock passes", () => waitForTime(run, "the timelock", p.queuedAt + BigInt(timelockDelay)));
  const before = await nativeBalance(recipient);
  await run.step("execute", () => adapter.execute(A.client, dao.governance, id));
  await run.step("treasury paid the recipient", () => assertPaid(recipient, before));
  await run.step("A redeems winning tokens", () => adapter.redeemTokens(A.client, p.baseVault), { extra: true });
  await run.step("A reclaims the seed liquidity", () => adapter.reclaimLiquidity(A.client, dao.governance, id), { extra: true });
}

const FLOWS = {
  tokenWeighted: votingFlow,
  quadratic: votingFlow,
  liquid: votingFlow,
  optimistic: optimisticFlow,
  board: boardFlow,
  delegate: delegateFlow,
  sortition: sortitionFlow,
  conviction: convictionFlow,
  sowellian: sowellianFlow,
  decisionMarkets: decisionMarketsFlow,
};

/*//////////////////////////////////////////////////////////////
                              RUN
//////////////////////////////////////////////////////////////*/

async function runModel(model) {
  const run = new Run(model);
  if (!FACTORY_ADDRESSES[model]) {
    run.skipped = `${networkEnvName(networkId, FACTORY_ENV_NAMES[model])} isn't set`;
    run.log(`- skipped: ${run.skipped}`);
    return run;
  }
  try {
    await FLOWS[model](run);
  } catch (err) {
    if (err instanceof StepFailed) return run;
    if (err.setup) {
      run.skipped = err.message;
      run.log(`- skipped: ${run.skipped}`);
      return run;
    }
    // A bug in this script's own flow, not a step: report it as such.
    const d = describeError(err);
    run.steps.push({ name: "(test script)", ok: false, ...d });
    run.stopped = "(test script)";
    run.log(`✗ test script error: ${err.stack}`);
  }
  return run;
}

/** Sends what's left in the throwaway wallets back to the operator. */
async function sweep() {
  const fees = await publicClient.estimateFeesPerGas();
  const cost = 21_000n * fees.maxFeePerGas;
  let total = 0n;
  for (const account of testWallets) {
    try {
      const balance = await nativeBalance(account.address);
      if (balance <= cost * 2n) continue;
      const client = common.walletClientFor(account);
      const hash = await client.sendTransaction({ to: operatorAccount.address, value: balance - cost, gas: 21_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      await publicClient.waitForTransactionReceipt({ hash });
      total += balance - cost;
    } catch (err) {
      console.error(`Couldn't sweep ${account.address}: ${err.shortMessage || err.message}`);
    }
  }
  return total;
}

function report(runs, spent, swept) {
  const symbol = network.nativeSymbol;
  const lines = [
    `# EVM model test: ${network.chain.name}`,
    "",
    `${new Date(started).toISOString()} · ${Math.round((Date.now() - started) / 60000)} min · fast timings · operator ${operatorAccount.address}`,
    `Operator spent ${formatEther(spent)} ${symbol} (after ${formatEther(swept)} ${symbol} swept back from test wallets).`,
    "",
    "| Model | Result | Steps passed | Stopped at |",
    "|---|---|---|---|",
  ];
  for (const r of runs) {
    const failed = r.steps.filter((s) => !s.ok);
    const passed = r.steps.filter((s) => s.ok).length;
    const result = r.skipped ? "skipped" : failed.some((s) => !s.extra) ? "FAIL" : failed.length ? "pass (extras failed)" : "PASS";
    lines.push(`| ${r.model} | ${result} | ${passed}/${r.steps.length} | ${r.skipped ?? r.stopped ?? ""} |`);
  }
  for (const r of runs) {
    const failed = r.steps.filter((s) => !s.ok);
    if (!failed.length && !r.skipped) continue;
    lines.push("", `## ${r.model}`, "");
    if (r.dao) lines.push(`DAO: governance \`${r.dao.governance}\`, treasury \`${r.dao.treasury}\``, "");
    if (r.skipped) lines.push(`Skipped: ${r.skipped}`);
    for (const s of failed) {
      lines.push(`- **${s.name}**${s.extra ? " (extra)" : ""}: ${s.revert ? `\`${s.revert}\` - ` : ""}${s.message}`);
      if (s.details) lines.push(`  - RPC: ${s.details}`);
    }
    const after = r.steps.findIndex((s) => s.name === r.stopped);
    if (after >= 0) lines.push("", `Not reached: every step after "${r.stopped}".`);
  }
  return lines.join("\n");
}

await runOnNetwork(networkId, async () => {
  const startBalance = await nativeBalance(operatorAccount.address);
  console.log(`Testing ${models.join(", ")} on ${network.chain.name} (chain ${network.chain.id}) with fast timings.`);
  console.log(`Operator ${operatorAccount.address} holds ${formatEther(startBalance)} ${network.nativeSymbol}.\n`);

  // Started a few seconds apart, so ten DAO creations don't hit the RPC at once.
  const runs = await Promise.all(models.map((m, i) => sleep(i * 4_000).then(() => runModel(m))));
  const swept = await sweep();
  const spent = startBalance - (await nativeBalance(operatorAccount.address));

  const text = report(runs, spent, swept);
  const dir = path.join(__dirname, "..", "data", "evm-tests");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${networkId}-${new Date(started).toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(file, text + "\n");
  console.log(`\n${text}\n\nReport saved to ${path.relative(process.cwd(), file)}`);
  process.exitCode = runs.some((r) => r.steps.some((s) => !s.ok && !s.extra)) ? 1 : 0;
});
