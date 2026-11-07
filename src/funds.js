import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encodeFunctionData, getAddress, isAddress, keccak256, toHex, zeroAddress, maxUint256 } from "viem";
import { publicClient, walletClient, operatorAccount, writeWithGasBuffer, distributionFactoryAddress, vaultFactoryAddress, launcherAddress, FACTORY_ADDRESSES } from "./config.js";
import { currentNetwork, networkEnvName } from "./networks.js";
import { daoState, GUARD_ABI } from "./governanceChanges.js";
import { NO_ACCOUNT } from "./accountId.js";

/**
 * EVM (Spaces) money for a DAO: monthly allowances on the Treasury, the
 * Distributor (everything the DAO has promised someone, claimable from a
 * chat account), raises, launches and prop-firm vaults. Builders return a
 * proposal's actions; the rest send one transaction from the given client.
 * docs/contracts-roadmap-design.md has the design.
 *
 * Who controls what: the Treasury, the Distributor and a vault all answer
 * to `treasury.governance()` - the governance, or the security council's
 * wrapper in front of it. With a council, a proposal asks the wrapper
 * (proposeInstruction) and the council confirms after it passes.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abi = (name) => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8"));
  return Array.isArray(j) ? j : j.abi;
};
export const TREASURY_ABI = abi("Treasury");
export const DISTRIBUTOR_ABI = abi("Distributor");
export const RAISE_ABI = abi("Raise");
export const DISTRIBUTION_FACTORY_ABI = abi("DistributionFactory");
export const LAUNCHER_ABI = abi("Launcher");
export const VAULT_ABI = abi("PropFirmVault");
export const VAULT_FACTORY_ABI = abi("VaultFactory");
const DAO_FACTORY_ABI = abi("DAOFactory");
const DELEGATE_FACTORY_ABI = abi("DelegateDAOFactory");
export const ERC20_ABI = [
  { type: "function", name: "decimals", inputs: [], outputs: [{ type: "uint8" }], stateMutability: "view" },
  { type: "function", name: "symbol", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalSupply", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "allowance", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
];

export const DAY = 24 * 60 * 60;
export const MONTH = 30 * DAY;

export class FundsError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}
const fail = (msg) => {
  throw new FundsError(msg);
};

const read = (address, contractAbi, functionName, args = []) => publicClient.readContract({ address: getAddress(address), abi: contractAbi, functionName, args });
const call = (target, contractAbi, functionName, args = [], value = 0n) => ({ target: getAddress(target), value, data: encodeFunctionData({ abi: contractAbi, functionName, args }) });

async function send(client, address, contractAbi, functionName, args = [], value = 0n) {
  const hash = await writeWithGasBuffer(client, { address: getAddress(address), abi: contractAbi, functionName, args, ...(value ? { value } : {}) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") fail(`The ${functionName} transaction reverted.`);
  return { hash, receipt };
}

/** Approves `spender` for `amount` of `token` from the client's wallet when it isn't already. */
async function ensureApproved(client, token, spender, amount) {
  const have = await read(token, ERC20_ABI, "allowance", [client.account.address, spender]);
  if (have < amount) await send(client, token, ERC20_ABI, "approve", [spender, amount]);
}

const now = async () => Number((await publicClient.getBlock()).timestamp);

/** A salt nobody else's call will reuse. */
export const freshSalt = (what) => keccak256(toHex(`${what}:${Date.now()}:${Math.random()}`));

/**
 * An action on something that answers to the DAO (`target` is the
 * Treasury, the Distributor or a vault): directly, or with a council,
 * through its wrapper for the council to confirm. Returns { action, viaCouncil }.
 */
export function adminAction(s, target, contractAbi, functionName, args = []) {
  const data = encodeFunctionData({ abi: contractAbi, functionName, args });
  if (s.wrapper) return { action: call(s.wrapper, GUARD_ABI, "proposeInstruction", [getAddress(target), 0n, data]), viaCouncil: true };
  return { action: { target: getAddress(target), value: 0n, data }, viaCouncil: false };
}
export const COUNCIL_NOTE = "This goes through the security council: it confirms after the proposal passes.";

/** A token by address or the native coin's words: { address (zero for native), decimals, symbol }. */
export async function tokenInfo(word) {
  const w = String(word ?? "").toLowerCase();
  if (["native", "eth", "mon", "hype"].includes(w)) return { address: zeroAddress, decimals: 18, symbol: currentNetwork().chain.nativeCurrency.symbol };
  if (!isAddress(word, { strict: false })) fail(`\`${word}\` isn't a token address (or \`native\`).`);
  const address = getAddress(word);
  const [decimals, symbol] = await Promise.all([read(address, ERC20_ABI, "decimals").catch(() => null), read(address, ERC20_ABI, "symbol").catch(() => "tokens")]);
  if (decimals === null) fail(`\`${address}\` doesn't look like an ERC20 token.`);
  return { address, decimals: Number(decimals), symbol };
}

/*//////////////////////////////////////////////////////////////
                         MONTHLY ALLOWANCES
//////////////////////////////////////////////////////////////*/

/** Every allowance on the Treasury: [{ id, recipient, token, amount, start, endsAt, paidThrough, revoked, claimable, nextAt }]. */
export async function listAllowances(treasury) {
  const count = Number(await read(treasury, TREASURY_ABI, "allowanceCount"));
  const out = [];
  for (let id = 1; id <= count; id++) {
    const a = await read(treasury, TREASURY_ABI, "allowance", [BigInt(id)]);
    const [claimable, nextAt] = await read(treasury, TREASURY_ABI, "claimableAllowance", [BigInt(id)]).catch(() => [0n, 0n]);
    out.push({ id, ...a, claimable, nextAt: Number(nextAt) });
  }
  return out;
}

/** A grant: `amountRaw` of `token` (zero: native) a month to `recipient` for `months` (at most 12). */
export async function buildAllowanceGrant({ model, governance, recipient, token, amountRaw, months }) {
  if (!Number.isInteger(months) || months < 1 || months > 12) fail("An allowance runs 1 to 12 months.");
  const s = await daoState(model, governance);
  const endsAt = BigInt((await now()) + months * MONTH);
  const { action, viaCouncil } = adminAction(s, s.treasury, TREASURY_ABI, "createAllowance", [getAddress(recipient), token, amountRaw, endsAt]);
  return { actions: [action], viaCouncil, treasury: s.treasury, endsAt: Number(endsAt) };
}

export async function buildAllowanceChange({ model, governance, id, amountRaw, months }) {
  if (!Number.isInteger(months) || months < 1 || months > 12) fail("An allowance runs 1 to 12 months from now.");
  const s = await daoState(model, governance);
  const a = await read(s.treasury, TREASURY_ABI, "allowance", [BigInt(id)]).catch(() => fail(`There's no allowance #${id}.`));
  if (a.recipient === zeroAddress) fail(`There's no allowance #${id}.`);
  const endsAt = BigInt((await now()) + months * MONTH);
  const { action, viaCouncil } = adminAction(s, s.treasury, TREASURY_ABI, "updateAllowance", [BigInt(id), amountRaw, endsAt]);
  return { actions: [action], viaCouncil, allowance: a };
}

export async function buildAllowanceRevoke({ model, governance, id }) {
  const s = await daoState(model, governance);
  const { action, viaCouncil } = adminAction(s, s.treasury, TREASURY_ABI, "revokeAllowance", [BigInt(id)]);
  return { actions: [action], viaCouncil };
}

/** The recipient claims this period's payment. */
export async function claimAllowance(client, treasury, id) {
  const a = await read(treasury, TREASURY_ABI, "allowance", [BigInt(id)]);
  if (getAddress(a.recipient) !== getAddress(client.account.address)) fail(`Allowance #${id} is paid to \`${a.recipient}\`, not your wallet.`);
  const [claimable, nextAt] = await read(treasury, TREASURY_ABI, "claimableAllowance", [BigInt(id)]);
  if (claimable === 0n) fail(Number(nextAt) ? `Allowance #${id} is already claimed this month; the next payment is from ${new Date(Number(nextAt) * 1000).toUTCString()}.` : `Allowance #${id} has ended.`);
  const { hash } = await send(client, treasury, TREASURY_ABI, "claimAllowance", [BigInt(id)]);
  return { hash, amount: claimable, token: a.token };
}

/*//////////////////////////////////////////////////////////////
                           THE DISTRIBUTOR
//////////////////////////////////////////////////////////////*/

function requireDistributionFactory() {
  const a = distributionFactoryAddress();
  if (!a) fail(`${networkEnvName(currentNetwork().id, "DISTRIBUTION_FACTORY_ADDRESS")} isn't configured on this bot, so it can't make Distributors or raises on ${currentNetwork().chain.name}.`);
  return getAddress(a);
}

/** Whether `address` is a Distributor (and not the old WelcomeDistributor). */
export async function isDistributor(address) {
  return read(address, DISTRIBUTOR_ABI, "allocationCount").then(() => true, () => false);
}

export async function distributorInfo(d) {
  const [token, treasury, operator, outstanding, unpromised, welcomeAmount, welcomeCap, welcomeGranted, claimDeadline, closed, count] = await Promise.all(
    ["token", "treasury", "operator", "outstanding", "unpromised", "welcomeAmount", "welcomeCap", "welcomeGranted", "claimDeadline", "closed", "allocationCount"].map((f) => read(d, DISTRIBUTOR_ABI, f))
  );
  const t = await tokenInfo(token);
  return { address: getAddress(d), token: t, treasury, operator, outstanding, unpromised, welcomeAmount, welcomeCap, welcomeGranted, claimDeadline: Number(claimDeadline), closed, count: Number(count) };
}

/**
 * Opens the DAO's Distributor (anyone may; it holds nothing until the DAO
 * funds it), run by the bot's operator, which claims for chat accounts.
 */
export async function createDistributor(client, { token, treasury, claimDays = 365, allocators = [] }) {
  const factory = requireDistributionFactory();
  if (!operatorAccount) fail("This bot has no operator wallet (OPERATOR_PRIVATE_KEY), which claims for chat accounts.");
  const salt = freshSalt("distributor");
  const deadline = BigInt((await now()) + claimDays * DAY);
  const args = [getAddress(token), getAddress(treasury), operatorAccount.address, allocators.map(getAddress), deadline, salt];
  const predicted = await read(factory, DISTRIBUTION_FACTORY_ABI, "predictDistributor", [client.account.address, ...args.slice(0, 4), salt]);
  const { hash } = await send(client, factory, DISTRIBUTION_FACTORY_ABI, "createDistributor", args);
  return { hash, distributor: getAddress(predicted) };
}

export async function buildDistributorFund({ model, governance, distributor, amountRaw }) {
  const s = await daoState(model, governance);
  const token = await read(distributor, DISTRIBUTOR_ABI, "token");
  const { action, viaCouncil } = adminAction(s, s.treasury, TREASURY_ABI, "transferERC20", [token, getAddress(distributor), amountRaw]);
  return { actions: [action], viaCouncil };
}

export async function buildDistributorGrant({ model, governance, distributor, owner, account = NO_ACCOUNT, amountRaw, cliffDays = 0, vestDays = 0 }) {
  const s = await daoState(model, governance);
  const start = BigInt(await now());
  const { action, viaCouncil } = adminAction(s, distributor, DISTRIBUTOR_ABI, "allocate", [getAddress(owner ?? zeroAddress), account, amountRaw, start, BigInt(cliffDays * DAY), BigInt(vestDays * DAY)]);
  return { actions: [action], viaCouncil };
}

export async function buildWelcomeTerms({ model, governance, distributor, amountRaw, capRaw }) {
  const s = await daoState(model, governance);
  const { action, viaCouncil } = adminAction(s, distributor, DISTRIBUTOR_ABI, "setWelcome", [amountRaw, capRaw]);
  return { actions: [action], viaCouncil };
}

/** Allocations the person can claim now: theirs by wallet, or by chat account. [{ id, claimable, byAccount }]. */
export async function claimableFor(d, wallet, account) {
  const count = Number(await read(d, DISTRIBUTOR_ABI, "allocationCount"));
  const mine = [];
  for (let id = 1; id <= count; id++) {
    const a = await read(d, DISTRIBUTOR_ABI, "allocation", [BigInt(id)]);
    const byWallet = a.owner !== zeroAddress && getAddress(a.owner) === getAddress(wallet);
    const byAccount = a.account === account && account !== NO_ACCOUNT;
    if (!byWallet && !byAccount) continue;
    const claimable = await read(d, DISTRIBUTOR_ABI, "claimable", [BigInt(id)]);
    mine.push({ id, claimable, total: a.total, claimed: a.claimed, byAccount: !byWallet });
  }
  return mine;
}

/**
 * Claims everything vested for the caller: their own allocations from
 * their wallet; their chat account's through the operator, into the same
 * wallet. Returns { claimed, rows }.
 */
export async function claimAll(client, d, account) {
  const wallet = getAddress(client.account.address);
  const rows = await claimableFor(d, wallet, account);
  let claimed = 0n;
  for (const r of rows.filter((x) => x.claimable > 0n)) {
    if (r.byAccount) {
      if (!walletClient || !operatorAccount) fail("This bot has no operator wallet, so it can't claim for chat accounts.");
      await send(walletClient, d, DISTRIBUTOR_ABI, "claimFor", [BigInt(r.id), wallet]);
    } else {
      await send(client, d, DISTRIBUTOR_ABI, "claim", [BigInt(r.id)]);
    }
    claimed += r.claimable;
  }
  return { claimed, rows };
}

/** A council member approves a member's welcome grant (their wallet and chat account). */
export async function grantWelcome(client, d, member, account) {
  const [amount, cap, granted] = await Promise.all(["welcomeAmount", "welcomeCap", "welcomeGranted"].map((f) => read(d, DISTRIBUTOR_ABI, f)));
  if (amount === 0n) fail("Welcome grants are off: a proposal sets them (`/distributor welcome <amount> <cap>`).");
  if (granted + amount > cap) fail("The welcome grants' cap is reached.");
  if (await read(d, DISTRIBUTOR_ABI, "welcomed", [account])) fail("That member already had their welcome grant.");
  const { hash } = await send(client, d, DISTRIBUTOR_ABI, "grantWelcome", [getAddress(member), account]);
  return { hash, amount };
}

/*//////////////////////////////////////////////////////////////
                               RAISES
//////////////////////////////////////////////////////////////*/

export async function raiseInfo(raise) {
  const r = getAddress(raise);
  const [terms, total, accepted, acceptedAt, decider, failed, count, distributor, saleSupply] = await Promise.all(
    ["terms", "totalContributed", "accepted", "acceptedAt", "decider", "failed", "contributorCount", "distributor", "saleSupply"].map((f) => read(r, RAISE_ABI, f))
  );
  const currency = await tokenInfo(terms.currency === zeroAddress ? "native" : terms.currency);
  const t = await now();
  const phase = acceptedAt > 0n ? "accepted" : failed ? "failed" : t < Number(terms.start) ? "upcoming" : t < Number(terms.end) ? "open" : "deciding";
  return { address: r, terms, total, accepted, acceptedAt: Number(acceptedAt), decider, failed, count: Number(count), distributor, saleSupply, currency, phase };
}

/**
 * An existing DAO's raise, in one proposal: the raise (decided by the
 * governance, paying only into the Treasury), its Distributor (a new one
 * if the DAO has none, else the raise is made one of its allocators), and
 * the sale's tokens moved there from the Treasury.
 */
export async function buildRaiseOpen({ model, governance, distributor, currency, softCapRaw, hardCapRaw, days, saleSupplyRaw, minRaw = 0n, maxRaw = 0n, cliffDays = 0, vestDays = 0, decideDays = 7 }) {
  const factory = requireDistributionFactory();
  const s = await daoState(model, governance);
  if (s.token === zeroAddress) fail("This DAO has no token to sell.");
  if (softCapRaw <= 0n || hardCapRaw < softCapRaw) fail("The soft cap must be above zero and at most the hard cap.");
  if (!Number.isInteger(days) || days < 1) fail("A raise runs at least a day.");
  const t = await now();
  const terms = {
    currency,
    softCap: softCapRaw,
    hardCap: hardCapRaw,
    start: BigInt(t),
    end: BigInt(t + days * DAY),
    minContribution: minRaw,
    maxContribution: maxRaw,
    saleSupply: saleSupplyRaw,
    vestCliff: BigInt(cliffDays * DAY),
    vestDuration: BigInt(vestDays * DAY),
    decisionWindow: BigInt(decideDays * DAY),
    fundsTo: s.treasury,
  };
  // The governance executes the proposal, so it creates (and decides) the raise.
  const raiseSalt = freshSalt("raise");
  const raise = getAddress(await read(factory, DISTRIBUTION_FACTORY_ABI, "predictRaise", [s.governance, raiseSalt]));
  const actions = [];
  let viaCouncil = false;
  let d = distributor;
  if (!d) {
    if (!operatorAccount) fail("This bot has no operator wallet (OPERATOR_PRIVATE_KEY), which claims for chat accounts.");
    const salt = freshSalt("distributor");
    const deadline = BigInt(t + (days + decideDays + 365) * DAY);
    const args = [s.token, s.treasury, operatorAccount.address, [raise], deadline, salt];
    d = getAddress(await read(factory, DISTRIBUTION_FACTORY_ABI, "predictDistributor", [s.governance, ...args.slice(0, 4), salt]));
    actions.push(call(factory, DISTRIBUTION_FACTORY_ABI, "createDistributor", args));
  }
  actions.push(call(factory, DISTRIBUTION_FACTORY_ABI, "createRaise", [terms, raiseSalt]));
  if (distributor) {
    const a = adminAction(s, d, DISTRIBUTOR_ABI, "setAllocator", [raise, true]);
    actions.push(a.action);
    viaCouncil ||= a.viaCouncil;
  }
  const fund = adminAction(s, s.treasury, TREASURY_ABI, "transferERC20", [s.token, d, saleSupplyRaw]);
  actions.push(fund.action);
  viaCouncil ||= fund.viaCouncil;
  return { actions, raise, distributor: d, newDistributor: !distributor, terms, viaCouncil };
}

/**
 * The DAO accepts `amountRaw` of its raise (a proposal; the governance is
 * the decider), naming the Distributor that holds the sale's tokens (the
 * raise only records it at acceptance).
 */
export async function buildRaiseAccept({ model, governance, raise, distributor, amountRaw }) {
  const s = await daoState(model, governance);
  const info = await raiseInfo(raise);
  if (getAddress(info.decider) !== s.governance) fail("This DAO's governance isn't the raise's decider (a launch's founder decides with /launch finish).");
  if (info.phase !== "deciding") fail(info.phase === "open" || info.phase === "upcoming" ? "The raise hasn't ended yet." : `The raise is ${info.phase}.`);
  if (amountRaw < info.terms.softCap || amountRaw > info.total) fail("Accept at least the soft cap and at most what was contributed.");
  if (!distributor) fail("This DAO has no Distributor holding the sale's tokens.");
  if (!(await read(distributor, DISTRIBUTOR_ABI, "isAllocator", [getAddress(raise)]))) fail("The raise can't write into that Distributor (it isn't one of its allocators).");
  return { actions: [call(raise, RAISE_ABI, "accept", [amountRaw, s.treasury, getAddress(distributor)])], info };
}

/** Contributes `amountRaw` from the caller's wallet, tied to their chat account. */
export async function contribute(client, raise, amountRaw, account) {
  const info = await raiseInfo(raise);
  if (info.phase !== "open") fail(info.phase === "upcoming" ? "The raise hasn't opened yet." : "The raise is closed.");
  const native = info.terms.currency === zeroAddress;
  if (!native) await ensureApproved(client, info.terms.currency, raise, amountRaw);
  const { hash } = await send(client, raise, RAISE_ABI, "contribute", [amountRaw, account], native ? amountRaw : 0n);
  return { hash, info };
}

/** Settles every contributor not yet settled (anyone; in batches of 25). */
export async function settleAll(client, raise) {
  const n = Number(await read(raise, RAISE_ABI, "contributorCount"));
  const pending = [];
  for (let i = 0; i < n; i++) {
    const who = await read(raise, RAISE_ABI, "contributors", [BigInt(i)]);
    const c = await read(raise, RAISE_ABI, "contributions", [who]);
    if (!c[2]) pending.push(who);
  }
  for (let i = 0; i < pending.length; i += 25) await send(client, raise, RAISE_ABI, "settle", [pending.slice(i, i + 25)]);
  return { settled: pending.length };
}

export async function withdrawRefund(client, raise) {
  const me = client.account.address;
  const c = await read(raise, RAISE_ABI, "contributions", [me]);
  const info = await raiseInfo(raise);
  const owed = info.failed ? c[0] : c[3];
  if (owed === 0n) fail(info.phase === "accepted" && !c[2] ? "Your contribution isn't settled yet - `/raise settle` first." : "Nothing to refund to you.");
  const { hash } = await send(client, raise, RAISE_ABI, "withdrawRefund", [me]);
  return { hash, amount: owed, currency: info.currency };
}

/*//////////////////////////////////////////////////////////////
                              LAUNCHES
//////////////////////////////////////////////////////////////*/

function requireLauncher() {
  const a = launcherAddress();
  if (!a) fail(`${networkEnvName(currentNetwork().id, "LAUNCHER_ADDRESS")} isn't configured on this bot, so it can't run launches on ${currentNetwork().chain.name}.`);
  return getAddress(a);
}

/** Models a launch can create: their factories take (name, symbol, supply, max, config) - Delegate adds the council. */
export const LAUNCH_MODELS = ["tokenWeighted", "quadratic", "liquid", "optimistic", "conviction", "sowellian", "decisionMarkets", "delegate"];

/**
 * The founder opens a launch: the DAO is made only when they finish it,
 * with the money going straight to its new Treasury. `config` is the
 * model's governance config (each adapter's newDaoConfig). A prop firm's
 * launch has no sale supply: its vault mints the shares from the money.
 */
export async function createLaunch(client, { model, name, symbol, supplyRaw, maxSupplyRaw, config, council = [], terms, shares = [], allowances = [], claimDays = 365, propFirm = null }) {
  const launcher = requireLauncher();
  if (!LAUNCH_MODELS.includes(model)) fail(`A launch can create ${LAUNCH_MODELS.join(", ")} DAOs.`);
  const factory = FACTORY_ADDRESSES[model];
  if (!factory) fail(`No ${model} factory is configured on ${currentNetwork().chain.name}.`);
  if (!(await read(launcher, LAUNCHER_ABI, "approvedFactory", [getAddress(factory)]))) fail(`The Launcher doesn't take ${model} DAOs on this network yet.`);
  const createCall =
    model === "delegate"
      ? encodeFunctionData({ abi: DELEGATE_FACTORY_ABI, functionName: "createDAO", args: [name, symbol, supplyRaw, maxSupplyRaw, config, council.map(getAddress)] })
      : encodeFunctionData({ abi: DAO_FACTORY_ABI, functionName: "createDAO", args: [name, symbol, supplyRaw, maxSupplyRaw, config] });
  if (!operatorAccount) fail("This bot has no operator wallet (OPERATOR_PRIVATE_KEY), which claims for chat accounts.");
  const deadline = BigInt((await now()) + claimDays * DAY) + terms.end - terms.start;
  const pf = propFirm ? { enabled: true, config: propFirm } : { enabled: false, config: { interval: 1n, freezeBefore: 0n, settleDelay: 0n, managementBps: 0, performanceBps: 0, maxDrawdownBps: 0, openToAll: true } };
  const { hash, receipt } = await send(client, launcher, LAUNCHER_ABI, "createLaunch", [getAddress(factory), createCall, { ...terms, fundsTo: zeroAddress }, shares, allowances, operatorAccount.address, deadline, pf]);
  const id = await read(launcher, LAUNCHER_ABI, "launchCount");
  const l = await read(launcher, LAUNCHER_ABI, "launch", [id]);
  return { hash, receipt, id: Number(id), raise: getAddress(l.raise) };
}

export async function launchInfo(id) {
  const launcher = requireLauncher();
  return read(launcher, LAUNCHER_ABI, "launch", [BigInt(id)]);
}

/** The founder accepts `amountRaw` and the DAO is made, funded and set up in one transaction. */
export async function finishLaunch(client, id, amountRaw) {
  const launcher = requireLauncher();
  const l = await read(launcher, LAUNCHER_ABI, "launch", [BigInt(id)]);
  if (getAddress(l.founder) !== getAddress(client.account.address)) fail("Only the launch's founder finishes it.");
  if (l.finished) fail("This launch is already finished.");
  const { hash } = await send(client, launcher, LAUNCHER_ABI, "finish", [BigInt(id), amountRaw]);
  return { hash, launch: await read(launcher, LAUNCHER_ABI, "launch", [BigInt(id)]) };
}

/*//////////////////////////////////////////////////////////////
                         PROP-FIRM VAULTS
//////////////////////////////////////////////////////////////*/

/**
 * A prop firm's desk trades its vault: the chat's vault and whether its
 * trading is paused (a drawdown, or a proposal), or null when the chat has
 * no vault (the desk then trades the Treasury).
 */
export async function deskVault(chatId, platform) {
  const { getChatFunds } = await import("./db.js");
  const v = getChatFunds(chatId, platform).vault;
  if (!v) return null;
  return { vault: getAddress(v), paused: await read(v, VAULT_ABI, "paused") };
}

export async function vaultInfo(v) {
  const vault = getAddress(v);
  const fields = ["asset", "shares", "epoch", "nextWindowAt", "paused", "config", "highWater", "pendingDepositAssets", "owedAssets", "feeSplits", "valuers", "lastMoveAt"];
  const vals = await Promise.all(fields.map((f) => read(vault, VAULT_ABI, f)));
  const info = Object.fromEntries(fields.map((f, i) => [f, vals[i]]));
  info.address = vault;
  info.asset = await tokenInfo(info.asset);
  info.supply = await read(info.shares, ERC20_ABI, "totalSupply");
  info.value = await read(vault, VAULT_ABI, "totalValue").catch(() => null); // null: a stale price
  info.price = await read(vault, VAULT_ABI, "sharePrice").catch(() => null);
  return info;
}

export async function vaultDeposit(client, vault, amountRaw) {
  const asset = await read(vault, VAULT_ABI, "asset");
  await ensureApproved(client, asset, vault, amountRaw);
  const { hash } = await send(client, vault, VAULT_ABI, "requestDeposit", [amountRaw]);
  return { hash, epoch: Number(await read(vault, VAULT_ABI, "epoch")) };
}

export async function vaultRedeem(client, vault, sharesRaw) {
  const shares = await read(vault, VAULT_ABI, "shares");
  await ensureApproved(client, shares, vault, sharesRaw);
  const { hash } = await send(client, vault, VAULT_ABI, "requestRedeem", [sharesRaw]);
  return { hash, epoch: Number(await read(vault, VAULT_ABI, "epoch")) };
}

/** Cancels the caller's deposit and redemption requests in the open epoch. */
export async function vaultCancel(client, vault) {
  const me = client.account.address;
  const e = await read(vault, VAULT_ABI, "epoch");
  const [dep, red] = await Promise.all([read(vault, VAULT_ABI, "depositOf", [e, me]), read(vault, VAULT_ABI, "redeemOf", [e, me])]);
  if (dep === 0n && red === 0n) fail("You have no request in this window.");
  if (dep > 0n) await send(client, vault, VAULT_ABI, "cancelDeposit");
  if (red > 0n) await send(client, vault, VAULT_ABI, "cancelRedeem");
  return { deposit: dep, redeem: red };
}

/** Claims the caller's shares and redemption money from processed windows (the last `lookback`). */
export async function vaultClaim(client, vault, lookback = 24) {
  const me = client.account.address;
  const e = Number(await read(vault, VAULT_ABI, "epoch"));
  let shares = 0n;
  let assets = 0n;
  for (let i = Math.max(1, e - lookback); i < e; i++) {
    const [dep, red, paid] = await Promise.all([read(vault, VAULT_ABI, "depositOf", [BigInt(i), me]), read(vault, VAULT_ABI, "redeemOf", [BigInt(i), me]), read(vault, VAULT_ABI, "redeemPaid", [BigInt(i), me])]);
    if (dep > 0n) {
      const before = await read(await read(vault, VAULT_ABI, "shares"), ERC20_ABI, "balanceOf", [me]);
      await send(client, vault, VAULT_ABI, "claimShares", [BigInt(i)]);
      shares += (await read(await read(vault, VAULT_ABI, "shares"), ERC20_ABI, "balanceOf", [me])) - before;
    }
    if (red > 0n) {
      const [ra, rs] = await Promise.all([read(vault, VAULT_ABI, "epochRedeemAssets", [BigInt(i)]), read(vault, VAULT_ABI, "epochRedeemShares", [BigInt(i)])]);
      const owed = (red * ra) / rs - paid;
      if (owed > 0n) {
        const asset = await read(vault, VAULT_ABI, "asset");
        const before = await read(asset, ERC20_ABI, "balanceOf", [me]);
        const ok = await send(client, vault, VAULT_ABI, "claimRedemption", [BigInt(i)]).then(() => true, () => false);
        if (ok) assets += (await read(asset, ERC20_ABI, "balanceOf", [me])) - before;
      }
    }
  }
  if (shares === 0n && assets === 0n) fail("Nothing to claim yet: requests are priced at the window after they're made.");
  return { shares, assets };
}

export async function vaultProcessWindow(client, vault) {
  const next = Number(await read(vault, VAULT_ABI, "nextWindowAt"));
  if ((await now()) < next) fail(`The next window is ${new Date(next * 1000).toUTCString()}.`);
  const { hash } = await send(client, vault, VAULT_ABI, "processWindow");
  return { hash };
}

/** A proposal's action on the vault (pause, resume, setAllowed, setFeeSplits, setConfig, setValuer). */
export async function buildVaultAdmin({ model, governance, vault, functionName, args = [] }) {
  const s = await daoState(model, governance);
  const { action, viaCouncil } = adminAction(s, vault, VAULT_ABI, functionName, args);
  return { actions: [action], viaCouncil };
}

/**
 * Creates a valuer for the vault's own account on a venue (anyone may;
 * the factory is permissionless), so a proposal can then add it with
 * setValuer. HyperCore: the vault's HyperCore account (perp dex 0, spot
 * USDC token 0, perp USD at 6 decimals). Perpl: one of the vault's desks
 * (`account`, a Perpl account of its own), the exchange and the market ids
 * it trades. Returns { hash, valuer }.
 */
export async function createValuer(client, { vault, venue, exchange, account = vault, markets = [], perpDex = 0, usdcToken = 0n, perpUsdDecimals = 6 }) {
  const vf = vaultFactoryAddress();
  if (!vf) fail(`${networkEnvName(currentNetwork().id, "VAULT_FACTORY_ADDRESS")} isn't configured on this bot.`);
  const assetDecimals = (await tokenInfo(await read(vault, VAULT_ABI, "asset"))).decimals;
  const { hash, receipt } =
    venue === "hypercore"
      ? await send(client, vf, VAULT_FACTORY_ABI, "createHyperCoreValuer", [getAddress(vault), perpDex, usdcToken, perpUsdDecimals, assetDecimals])
      : venue === "perpl"
        ? await send(client, vf, VAULT_FACTORY_ABI, "createPerplValuer", [getAddress(exchange), getAddress(account), markets.map(BigInt), assetDecimals])
        : fail("Valuers: hypercore or perpl.");
  const { parseEventLogs } = await import("viem");
  const ev = parseEventLogs({ abi: VAULT_FACTORY_ABI, logs: receipt.logs, eventName: "ValuerCreated" })[0];
  if (!ev) fail("The valuer was created but its address wasn't in the receipt.");
  return { hash, valuer: getAddress(ev.args.valuer) };
}

export { maxUint256 };
