#!/usr/bin/env node
/**
 * A DAO's money end to end on a local anvil chain, through the bot's own
 * builders (src/funds.js) and the model adapters:
 *   - monthly allowances: granted by proposal, claimed once a month, a
 *     missed month lapsing, revoked by proposal;
 *   - the Distributor: grants by proposal to a wallet (vesting) and to a
 *     chat account the operator claims for; welcome grants a Delegate
 *     council member approves;
 *   - an existing DAO's raise past its hard cap, accepted by proposal,
 *     settled, claimed and refunded pro rata;
 *   - a launch: the founder finishes it and one transaction makes the DAO,
 *     funds its Treasury and fills its Distributor;
 *   - a prop firm's launch: the money goes into its vault, the shares to
 *     the Distributor; then a deposit and a redemption at windows;
 *   - the vault's desk: a desk proposal runs through vault.execute, and a
 *     paused vault pauses its desks;
 *   - Delegate council seats: candidacy per seat, one vote per seat, a
 *     tied seat drawn through the local Entropy stand-in.
 *
 *   anvil --chain-id 10143 --code-size-limit 100000 --block-time 0.4
 *   (cd ../Spaces && FOUNDRY_PROFILE=size-limited forge build && forge build test/PythAdapters.t.sol test/PropFirmVault.t.sol)
 *   node scripts/deploy-local-evm.mjs > .env.local-evm
 *   node --env-file=.env.local-evm scripts/test-evm-funds.mjs
 */
const LOCAL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
process.env.OPERATOR_PRIVATE_KEY ||= LOCAL_KEY;
process.env.FAST_TIMINGS = "true";
process.env.RPC_PUBLIC_FALLBACK = "false"; // never the real testnet

const { parseEther, parseUnits, getAddress, zeroAddress, parseAbi } = await import("viem");
const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { publicClient, walletClient, operatorAccount, writeWithGasBuffer } = await import("../src/config.js");
const { createDaoOnChain, newTokenWeightedConfig } = await import("../src/contracts.js");
const { stakeTokens, walletClientFor, getDaoInfo } = await import("../src/governance/common.js");
const { buildIntegrationProposal } = await import("../src/proposalBuilder.js");
const { currentNetwork } = await import("../src/networks.js");
const hypercore = await import("../src/integrations/hypercore.js");
const { withVaultPause } = await import("../src/deskMandate.js");
const { getAdapter } = await import("../src/governance/index.js");
const f = await import("../src/funds.js");
const { accountId, NO_ACCOUNT } = await import("../src/accountId.js");

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
for (const k of ["DISTRIBUTION_FACTORY_ADDRESS", "VAULT_FACTORY_ADDRESS", "LAUNCHER_ADDRESS", "LOCAL_USDC", "LOCAL_FEE_ENTROPY"]) {
  if (!process.env[k]) {
    console.error(`${k} isn't set: run scripts/deploy-local-evm.mjs into the env file first.`);
    process.exit(2);
  }
}

const READS = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function executableAfter(uint256) view returns (uint256)",
  "function mint(address,uint256)",
  "function approve(address,uint256) returns (bool)",
  "function governance() view returns (address)",
  "function totalSupply() view returns (uint256)",
  "function nextSequence() view returns (uint64)",
  "function reveal(uint64 seq, bytes32 randomNumber)",
  "function currentTermEnd() view returns (uint256)",
]);
const read = (address, functionName, args = []) => publicClient.readContract({ address: getAddress(address), abi: READS, functionName, args });
const mine = (blocks) => publicClient.request({ method: "anvil_mine", params: [`0x${Math.max(1, blocks).toString(16)}`] });
const warp = async (seconds) => {
  await publicClient.request({ method: "evm_increaseTime", params: [`0x${Math.ceil(Math.max(seconds, 1)).toString(16)}`] });
  await mine(1);
};
const now = async () => Number((await publicClient.getBlock()).timestamp);
const send = async (client, req) => publicClient.waitForTransactionReceipt({ hash: await writeWithGasBuffer(client, req) });
const ethOf = (a) => publicClient.getBalance({ address: a });
const USDC = getAddress(process.env.LOCAL_USDC);
const usdc = (n) => parseUnits(String(n), 6);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`);
  if (!ok) failures++;
};
const refuses = async (fn, pattern, what) => {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  check(err && pattern.test(`${err.message} ${err.shortMessage ?? ""}`), `${what}${err ? "" : " (it went through)"}`);
};

const operator = walletClient;
const me = operatorAccount.address;
async function member() {
  const account = privateKeyToAccount(generatePrivateKey());
  await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: account.address, value: parseEther("20") }) });
  return { address: account.address, client: walletClientFor(account) };
}

/** Token-weighted: propose, vote, queue, execute (the operator holds the votes). */
async function pass(governance, actions, what, voter = operator) {
  const adapter = getAdapter("tokenWeighted");
  const { proposalId } = await adapter.propose(voter, governance, actions, what);
  const { startBlock, endBlock } = await adapter.getProposal(governance, proposalId);
  await mine(Number(startBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.vote(voter, governance, proposalId, 1);
  await mine(Number(endBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.queue(operator, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - (await now()) + 1);
  await adapter.execute(operator, governance, proposalId);
  return proposalId;
}

/** Delegate: the council (the operator alone) passes a council proposal. */
async function passByCouncil(governance, actions, what) {
  const adapter = getAdapter("delegate");
  const { proposalId } = await adapter.propose(operator, governance, actions, what);
  const p = await adapter.getProposal(governance, proposalId);
  await mine(Number(p.startBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.vote(operator, governance, proposalId, 1);
  await mine(Number(p.endBlock - (await publicClient.getBlockNumber())) + 2);
  await adapter.queue(operator, governance, proposalId);
  await warp(Number(await read(governance, "executableAfter", [proposalId])) - (await now()) + 1);
  await adapter.execute(operator, governance, proposalId);
}

const [alice, bob, carol, founder] = [await member(), await member(), await member(), await member()];

console.log("Monthly allowances");
const dao = await createDaoOnChain("Funds Test", "FND", 1_000_000, 10_000_000);
const governance = getAddress(dao.governance);
const treasury = getAddress(dao.treasury);
const token = getAddress(dao.underlyingToken);
await stakeTokens(operator, dao.governanceToken, 600_000);
await mine(2);
await publicClient.waitForTransactionReceipt({ hash: await walletClient.sendTransaction({ to: treasury, value: parseEther("10") }) });
const TRANSFER = parseAbi(["function transfer(address,uint256) returns (bool)"]);
// The creator holds the supply here: give the Treasury some to grant and sell.
await send(operator, { address: token, abi: TRANSFER, functionName: "transfer", args: [treasury, parseEther("300000")] });

const grant = await f.buildAllowanceGrant({ model: "tokenWeighted", governance, recipient: alice.address, token: zeroAddress, amountRaw: parseEther("1"), months: 3 });
await pass(governance, grant.actions, "Pay Alice 1 ETH a month");
const listed = await f.listAllowances(treasury);
check(listed.length === 1 && getAddress(listed[0].recipient) === alice.address && listed[0].amount === parseEther("1"), "the allowance is on the Treasury");
let before = await ethOf(alice.address);
await f.claimAllowance(alice.client, treasury, 1);
check((await ethOf(alice.address)) - before > parseEther("0.99"), "Alice claims this month's 1 ETH");
await refuses(() => f.claimAllowance(alice.client, treasury, 1), /already claimed/, "a second claim in the same month is refused");
await refuses(() => f.claimAllowance(bob.client, treasury, 1), /not your wallet/, "nobody else can claim it");
await warp(2 * f.MONTH + 10);
before = await ethOf(alice.address);
await f.claimAllowance(alice.client, treasury, 1);
const got = (await ethOf(alice.address)) - before;
check(got > parseEther("0.99") && got < parseEther("1.01"), "two months later only the current month pays (the missed one lapsed)");
const revoke = await f.buildAllowanceRevoke({ model: "tokenWeighted", governance, id: 1 });
await pass(governance, revoke.actions, "End Alice's allowance");
await warp(f.MONTH);
await refuses(() => f.claimAllowance(alice.client, treasury, 1), /ended/, "revoked: no more payments");

console.log("The Distributor: grants, chat accounts, claims");
const { distributor } = await f.createDistributor(alice.client, { token, treasury, claimDays: 365 });
check(await f.isDistributor(distributor), "anyone opens the DAO's Distributor; the operator runs it");
await pass(governance, (await f.buildDistributorFund({ model: "tokenWeighted", governance, distributor, amountRaw: parseEther("10000") })).actions, "Fund the Distributor");
const acct = accountId("telegram", "424242");
const g1 = await f.buildDistributorGrant({ model: "tokenWeighted", governance, distributor, owner: alice.address, amountRaw: parseEther("1000"), vestDays: 10 });
const g2 = await f.buildDistributorGrant({ model: "tokenWeighted", governance, distributor, owner: null, account: acct, amountRaw: parseEther("500") });
await pass(governance, [...g1.actions, ...g2.actions], "Two grants");
let info = await f.distributorInfo(distributor);
check(info.count === 2 && info.outstanding === parseEther("1500"), "two grants promised, backed by what it holds");
await warp(5 * f.DAY);
const a1 = await f.claimAll(alice.client, distributor, accountId("telegram", "1"));
check(a1.claimed > parseEther("499") && a1.claimed < parseEther("502"), `Alice claims about half her vesting grant (${Number(a1.claimed) / 1e18})`);
const nobody = await f.claimAll(carol.client, distributor, accountId("telegram", "999"));
check(nobody.claimed === 0n && nobody.rows.length === 0, "someone else's /claim finds nothing");
const b1 = await f.claimAll(bob.client, distributor, acct);
check(b1.claimed === parseEther("500") && (await read(token, "balanceOf", [bob.address])) === parseEther("500"), "the chat account's grant: the operator claims it into the member's wallet");

console.log("Welcome grants, approved by a Delegate council member");
const ddao = await getAdapter("delegate").createDAO("Welcome Test", "WLC", 1_000_000, 2_000_000, [me]);
const dGov = getAddress(ddao.governance);
const dTreasury = getAddress(ddao.treasury);
const dToken = getAddress(ddao.underlyingToken);
await stakeTokens(operator, ddao.governanceToken, 600_000);
await send(operator, { address: dToken, abi: TRANSFER, functionName: "transfer", args: [dTreasury, parseEther("100000")] });
await mine(2);
const { distributor: dd } = await f.createDistributor(operator, { token: dToken, treasury: dTreasury });
await passByCouncil(dGov, [...(await f.buildDistributorFund({ model: "delegate", governance: dGov, distributor: dd, amountRaw: parseEther("1000") })).actions, ...(await f.buildWelcomeTerms({ model: "delegate", governance: dGov, distributor: dd, amountRaw: parseEther("100"), capRaw: parseEther("200") })).actions], "Welcome grants");
const newbie = accountId("telegram", "777");
await refuses(() => f.grantWelcome(alice.client, dd, carol.address, newbie), /NotCouncilMember|reverted/, "a member who isn't on the council can't approve one");
await f.grantWelcome(operator, dd, carol.address, newbie);
await refuses(() => f.grantWelcome(operator, dd, carol.address, newbie), /already had/, "one welcome grant per member");
const c1 = await f.claimAll(carol.client, dd, newbie);
check(c1.claimed === parseEther("100"), "the new member claims it");

console.log("An existing DAO's raise, past its hard cap");
for (const m of [alice, bob]) await send(operator, { address: USDC, abi: READS, functionName: "mint", args: [m.address, usdc(5000)] });
const open = await f.buildRaiseOpen({ model: "tokenWeighted", governance, distributor, currency: USDC, softCapRaw: usdc(1000), hardCapRaw: usdc(2000), days: 3, saleSupplyRaw: parseEther("100000"), decideDays: 7 });
await pass(governance, open.actions, "Raise 1,000-2,000 USDC");
let r = await f.raiseInfo(open.raise);
check(r.phase === "open" && getAddress(r.decider) === governance, "the raise is open, decided by the DAO");
await f.contribute(alice.client, open.raise, usdc(1500), accountId("telegram", "1"));
await f.contribute(bob.client, open.raise, usdc(1000), NO_ACCOUNT);
r = await f.raiseInfo(open.raise);
check(r.total === usdc(2500), "2,500 raised against a 2,000 target: contributions go past it");
await warp(3 * f.DAY + 10);
const accept = await f.buildRaiseAccept({ model: "tokenWeighted", governance, raise: open.raise, distributor: open.distributor, amountRaw: usdc(2000) });
await pass(governance, accept.actions, "Accept 2,000");
check((await read(USDC, "balanceOf", [treasury])) === usdc(2000), "the accepted 2,000 is in the Treasury");
const { settled } = await f.settleAll(carol.client, open.raise);
check(settled === 2, "anyone settles the contributors");
const aRefund = await f.withdrawRefund(alice.client, open.raise);
const bRefund = await f.withdrawRefund(bob.client, open.raise);
check(aRefund.amount === usdc(300) && bRefund.amount === usdc(200), "each gets back their share of the 500 not accepted (300 and 200)");
const aTokens = await f.claimAll(alice.client, distributor, accountId("telegram", "1"));
check(aTokens.claimed > parseEther("60000") - 10n && aTokens.claimed <= parseEther("60000") + parseEther("501"), "Alice's 60% of the sale (plus what else vested) claimed");

console.log("A launch: the founder finishes it in one transaction");
const config = newTokenWeightedConfig();
const t0 = await now();
const terms = { currency: zeroAddress, softCap: parseEther("1"), hardCap: parseEther("2"), start: BigInt(t0), end: BigInt(t0 + f.DAY), minContribution: 0n, maxContribution: 0n, saleSupply: parseEther("100000"), vestCliff: 0n, vestDuration: 0n, decisionWindow: BigInt(7 * f.DAY), fundsTo: zeroAddress };
const shares = [{ owner: founder.address, account: NO_ACCOUNT, amount: parseEther("50000"), cliff: BigInt(90 * f.DAY), duration: BigInt(365 * f.DAY) }];
const allowances = [{ recipient: founder.address, token: zeroAddress, daoToken: false, amount: parseEther("0.1"), duration: BigInt(180 * f.DAY) }];
const launched = await f.createLaunch(founder.client, { model: "tokenWeighted", name: "Launched", symbol: "LCH", supplyRaw: parseEther("1000000"), maxSupplyRaw: parseEther("10000000"), config, terms, shares, allowances });
check(launched.id >= 1 && launched.raise, "the founder opens a launch (no DAO yet)");
await f.contribute(alice.client, launched.raise, parseEther("1"), NO_ACCOUNT);
await f.contribute(bob.client, launched.raise, parseEther("1"), NO_ACCOUNT);
await warp(f.DAY + 10);
await refuses(() => f.finishLaunch(alice.client, launched.id, parseEther("1.5")), /founder/, "only the founder finishes it");
const { launch: l } = await f.finishLaunch(founder.client, launched.id, parseEther("1.5"));
check((await ethOf(l.treasury)) === parseEther("1.5"), "the accepted 1.5 ETH is in the new Treasury, not the founder's wallet");
check(getAddress(await read(l.treasury, "governance")) === getAddress(l.governance), "the new governance runs it");
check((await read(l.token, "balanceOf", [l.distributor])) === parseEther("150000"), "the sale and the team share are in its Distributor");
check((await f.listAllowances(l.treasury)).length === 1, "the agreed allowance is set");

console.log("A prop firm's launch: its vault takes the money, the Distributor the shares");
const t1 = await now();
const pfTerms = { ...terms, currency: USDC, softCap: usdc(1000), hardCap: usdc(5000), start: BigInt(t1), end: BigInt(t1 + f.DAY), saleSupply: 0n };
const pfConfig = { interval: BigInt(30 * f.DAY), freezeBefore: BigInt(f.DAY), settleDelay: 3600n, managementBps: 0, performanceBps: 2000, maxDrawdownBps: 2000, openToAll: true };
const pf = await f.createLaunch(founder.client, { model: "tokenWeighted", name: "Firm", symbol: "FIRM", supplyRaw: 0n, maxSupplyRaw: 2n ** 128n - 1n, config, terms: pfTerms, propFirm: pfConfig });
await f.contribute(alice.client, pf.raise, usdc(1200), NO_ACCOUNT);
await f.contribute(bob.client, pf.raise, usdc(800), NO_ACCOUNT);
await warp(f.DAY + 10);
const { launch: pl } = await f.finishLaunch(founder.client, pf.id, usdc(2000));
const vaultAddr = getAddress(pl.vault);
check(vaultAddr !== zeroAddress && (await read(USDC, "balanceOf", [vaultAddr])) === usdc(2000), "the 2,000 accepted is in the vault");
check((await read(pl.token, "balanceOf", [pl.distributor])) === parseEther("2000"), "its shares (one per dollar) are in the Distributor");
await f.settleAll(carol.client, pf.raise);
const aShares = await f.claimAll(alice.client, pl.distributor, NO_ACCOUNT);
check(aShares.claimed === parseEther("1200"), "Alice claims her 1,200 shares");
let v = await f.vaultInfo(vaultAddr);
check(v.value === usdc(2000) && v.supply === parseEther("2000"), "the vault is worth 2,000 against 2,000 shares");

await send(operator, { address: USDC, abi: READS, functionName: "mint", args: [carol.address, usdc(1000)] });
await f.vaultDeposit(carol.client, vaultAddr, usdc(1000));
await f.vaultRedeem(alice.client, vaultAddr, parseEther("200"));
await refuses(() => f.vaultProcessWindow(carol.client, vaultAddr), /next window/, "the window isn't due yet");
await warp(30 * f.DAY + 10);
await f.vaultProcessWindow(carol.client, vaultAddr);
const cClaim = await f.vaultClaim(carol.client, vaultAddr);
const aClaim = await f.vaultClaim(alice.client, vaultAddr);
check(cClaim.shares === parseEther("1000"), "Carol's 1,000 bought 1,000 shares at the window");
check(aClaim.assets === usdc(200), "Alice's 200 shares paid out 200");
v = await f.vaultInfo(vaultAddr);
check(v.value === usdc(2800) && v.supply === parseEther("2800"), "the vault is worth 2,800 against 2,800 shares");

console.log("The vault's desk: a desk proposal moves the vault's money, through vault.execute");
// HyperCore only exists on HyperEVM; here its CoreWriter address has no code, so the call just has to reach it.
hypercore.protocol.deployments[currentNetwork().id] = hypercore.protocol.deployments.hyperevm;
const pfStaking = (await getDaoInfo("tokenWeighted", pl.governance)).tokenAddress;
await stakeTokens(alice.client, pfStaking, 1000);
await mine(2);
const agent = privateKeyToAccount(generatePrivateKey()).address;
const deskProp = await buildIntegrationProposal({ model: "tokenWeighted", governanceAddress: pl.governance, actionId: "hypercore-approve-agent", words: [agent, "desk-1", "Approve the desk's agent"], vault: vaultAddr });
check(deskProp.actions.length === 1 && getAddress(deskProp.actions[0].target) === vaultAddr && !deskProp.guarded, "the desk proposal calls the vault, not the Treasury");
await pass(getAddress(pl.governance), deskProp.actions, "Approve the desk's agent", alice.client);
const moves = await publicClient.getContractEvents({ address: vaultAddr, abi: parseAbi(["event Moved(address indexed target, uint256 value, bytes data)"]), eventName: "Moved", fromBlock: 0n });
check(moves.length === 1 && getAddress(moves[0].args.target) === getAddress("0x3333333333333333333333333333333333333333"), "executed: the vault made the CoreWriter call (approve agent) itself");
const trProp = await buildIntegrationProposal({ model: "tokenWeighted", governanceAddress: pl.governance, actionId: "hypercore-approve-agent", words: [agent, "desk-1", "x"] });
check(getAddress(trProp.actions[0].target) === getAddress(pl.treasury), "without the vault the same action still goes to the Treasury");
const deskRec = { paused: null };
check(withVaultPause(deskRec, { vaultPaused: true }).paused && !withVaultPause(deskRec, { vaultPaused: false }).paused, "a paused vault pauses its desks' new positions");

console.log("Delegate council seats: one race per seat, a tie drawn by lot");
const [s1, s2, s3] = [alice, bob, carol];
const sdao = await getAdapter("delegate").createDAO("Seats Test", "SEAT", 1_000_000, 2_000_000, [me, founder.address]);
const sGov = getAddress(sdao.governance);
for (const m of [s1, s2]) {
  await send(operator, { address: sdao.underlyingToken, abi: TRANSFER, functionName: "transfer", args: [m.address, parseEther("100000")] });
  await stakeTokens(m.client, sdao.governanceToken, 100_000);
}
await mine(2);
const del = getAdapter("delegate");
await warp(Number(await read(sGov, "currentTermEnd")) - (await now()) + 1);
const { electionId } = await del.startElection(s1.client, sGov);
await del.declareCandidacy(s1.client, sGov, electionId, 0);
await del.declareCandidacy(s2.client, sGov, electionId, 0);
await del.declareCandidacy(s3.client, sGov, electionId, 1);
const el = await del.getElection(sGov, electionId);
await mine(Number(el.candidacyDeadline - (await publicClient.getBlockNumber())) + 1);
await refuses(() => del.voteInElection(s1.client, sGov, electionId, [s1.address, s2.address]), /one candidate per seat/, "two candidates for the same seat in one ballot are refused");
await del.voteInElection(s1.client, sGov, electionId, [s1.address, s3.address]);
await del.voteInElection(s2.client, sGov, electionId, [s2.address]);
await mine(Number(el.votingEndBlock - (await publicClient.getBlockNumber())) + 1);
const first = await del.finalizeElection(s1.client, sGov, electionId);
check(first.drawRequested, "seat 1 is tied 100k-100k: the draw is requested (the DAO's Entropy credit topped up)");
const ent = getAddress(process.env.LOCAL_FEE_ENTROPY);
const seq = (await read(ent, "nextSequence")) - 1n;
await send(operator, { address: ent, abi: READS, functionName: "reveal", args: [seq, `0x${"2a".padStart(64, "0")}`] });
const second = await del.finalizeElection(s1.client, sGov, electionId);
check(second.seated, "once drawn, finalizing again seats the council");
const seats = await del.getSeats(sGov, electionId);
check(seats.length === 2 && [s1.address, s2.address].includes(getAddress(seats[0].holder)), `seat 1 went to one of the tied candidates (${seats[0].holder.slice(0, 8)})`);
check(getAddress(seats[1].holder) === s3.address, "seat 2 went to its only candidate");

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll allowance, Distributor, raise, launch, vault and seat checks passed.");
process.exit(failures ? 1 : 0);
