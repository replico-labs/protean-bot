import { createHash, createHmac } from "crypto";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getMint } from "@solana/spl-token";
import BN from "bn.js";
import { getSolanaOperator } from "./config.js";
import * as v from "./vortex.js";

/**
 * Solana (Vortexes) money for a DAO - the counterpart of src/funds.js:
 *   - monthly allowances on the hub, paid from the treasury;
 *   - the Distributor (vortex-distribution), one per DAO token and
 *     operator: grants by proposal, claims from a chat account, welcome
 *     grants a Delegate council member approves;
 *   - raises, decided by the treasury (a proposal), the money going only
 *     to the treasury - or into a prop firm's vault;
 *   - prop-firm vaults (vortex-vault), whose shares are the DAO's token;
 *   - Delegate council seats with tied seats drawn by ORAO.
 * Builders of proposal instructions return StoredInstructions; the rest
 * send one transaction. Each checks its program is deployed on the network.
 */

const fail = (msg) => {
  throw Object.assign(new Error(msg), { userFacing: true });
};
const seed = (s) => Buffer.from(s);
const u64le = (n) => new BN(String(n)).toArrayLike(Buffer, "le", 8);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const bn = (x) => new BN(String(x));
const big = (x) => BigInt(x?.toString?.() ?? x ?? 0);
const programs = (network) => ({ hub: v.programFor(network, "hub"), dist: v.programFor(network, "distribution"), vault: v.programFor(network, "vault"), delegate: v.programFor(network, "delegate") });

export const DAY = 86_400;
export const MONTH = 30 * DAY;
const NO_ACCOUNT = new Array(32).fill(0);

/** Refuses when `name` (distribution or vault) isn't deployed on this network. */
export async function requireProgram(network, name) {
  const id = network.programs[name];
  const info = await network.connection.getAccountInfo(id);
  if (!info?.executable) fail(`Vortexes' ${name} program isn't deployed on ${network.name} yet.`);
  return id;
}

function requireOperator() {
  const op = getSolanaOperator();
  if (!op) fail("This bot has no Solana operator wallet yet - ask an admin to set SOLANA_OPERATOR_KEY.");
  return op;
}

/** "7" (days), or a duration with a unit: "30m", "12h", "3d", "90s". In seconds. */
export function parseSpan(text, what) {
  const m = /^(\d+)([smhd]?)$/.exec(String(text ?? ""));
  if (!m || Number(m[1]) === 0) fail(`${what} is a number of days, or a duration like 30m, 12h or 3d.`);
  return Number(m[1]) * { "": DAY, s: 1, m: 60, h: 3600, d: DAY }[m[2]];
}

/** A chat account as the programs take it: 32 bytes (src/accountId.js). */
export const accountBytes = (hex) => Array.from(Buffer.from(String(hex).replace(/^0x/, ""), "hex"));

// ---------------------------------------------------------------
// addresses
// ---------------------------------------------------------------

export function fundsAddresses(network, dao) {
  const hub = network.programs.hub;
  const dist = network.programs.distribution;
  const vp = network.programs.vault;
  const vault = pda([seed("vault"), dao.toBuffer()], vp);
  return {
    allowance: (id) => pda([seed("allowance"), dao.toBuffer(), u64le(id)], hub),
    distributor: (mint, operator) => pda([seed("distributor"), dao.toBuffer(), mint.toBuffer(), operator.toBuffer()], dist),
    distributorVault: (d) => pda([seed("distributor_vault"), d.toBuffer()], dist),
    allocation: (d, id) => pda([seed("allocation"), d.toBuffer(), u64le(id)], dist),
    welcomed: (d, key) => pda([seed("welcomed"), d.toBuffer(), Buffer.from(key)], dist),
    raise: (createKey) => pda([seed("raise"), dao.toBuffer(), createKey.toBuffer()], dist),
    raiseVault: (r) => pda([seed("raise_vault"), r.toBuffer()], dist),
    contribution: (r, who) => pda([seed("contribution"), r.toBuffer(), who.toBuffer()], dist),
    vault,
    vaultAssets: pda([seed("vault_assets"), vault.toBuffer()], vp),
    vaultEscrow: pda([seed("vault_escrow"), vault.toBuffer()], vp),
    vaultEpoch: (e) => pda([seed("vault_epoch"), vault.toBuffer(), u64le(e)], vp),
    vaultRequest: (e, owner) => pda([seed("vault_request"), vault.toBuffer(), u64le(e), owner.toBuffer()], vp),
    vaultAllowed: (who) => pda([seed("vault_allowed"), vault.toBuffer(), who.toBuffer()], vp),
  };
}

// ---------------------------------------------------------------
// monthly allowances (the hub)
// ---------------------------------------------------------------

export async function listAllowances(network, d) {
  const p = programs(network);
  const dao = await p.hub.account.dao.fetch(d.dao);
  const a = fundsAddresses(network, d.dao);
  const out = [];
  for (let id = 1; id <= Number(dao.allowanceCount); id++) {
    const x = await p.hub.account.allowance.fetchNullable(a.allowance(id));
    if (x) out.push({ id, ...x });
  }
  return out;
}

/** The next allowance id: proposals made before this one runs would take it, so it's checked again at execution. */
async function nextAllowanceId(network, d) {
  const dao = await programs(network).hub.account.dao.fetch(d.dao);
  return Number(dao.allowanceCount) + 1;
}

export async function allowanceGrantIx(network, d, { recipient, mint, amount, months }) {
  if (!Number.isInteger(months) || months < 1 || months > 12) fail("An allowance runs 1 to 12 months.");
  const id = await nextAllowanceId(network, d);
  const endsAt = (await v.clusterNow(network)) + months * MONTH;
  const ix = await programs(network)
    .hub.methods.createAllowance(recipient, mint ?? null, bn(amount), bn(endsAt))
    .accountsStrict({ treasury: d.treasury, dao: d.dao, allowance: fundsAddresses(network, d.dao).allowance(id), systemProgram: SystemProgram.programId })
    .instruction();
  return { instruction: v.stored(ix), id, endsAt };
}

export async function allowanceChangeIx(network, d, id, amount, months) {
  if (!Number.isInteger(months) || months < 1 || months > 12) fail("An allowance runs 1 to 12 months from now.");
  const endsAt = (await v.clusterNow(network)) + months * MONTH;
  const ix = await programs(network).hub.methods.updateAllowance(bn(amount), bn(endsAt)).accountsStrict({ treasury: d.treasury, dao: d.dao, allowance: fundsAddresses(network, d.dao).allowance(id) }).instruction();
  return v.stored(ix);
}

export async function allowanceRevokeIx(network, d, id) {
  const ix = await programs(network).hub.methods.revokeAllowance().accountsStrict({ treasury: d.treasury, dao: d.dao, allowance: fundsAddresses(network, d.dao).allowance(id) }).instruction();
  return v.stored(ix);
}

/** The recipient claims this month's payment. */
export async function claimAllowance(network, member, d, id) {
  const a = fundsAddresses(network, d.dao).allowance(id);
  const x = await programs(network).hub.account.allowance.fetchNullable(a);
  if (!x) fail(`There's no allowance #${id}.`);
  if (!x.recipient.equals(member.publicKey)) fail(`Allowance #${id} is paid to \`${x.recipient.toBase58()}\`, not your wallet.`);
  const mint = x.mint ?? null;
  let tokenProgram = null;
  const ixs = [];
  if (mint) {
    tokenProgram = (await v.mintInfo(network, mint)).programId;
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(member.publicKey, v.tokenAccount(mint, member.publicKey, tokenProgram), member.publicKey, mint, tokenProgram));
  }
  ixs.push(
    await programs(network)
      .hub.methods.claimAllowance()
      .accountsStrict({
        recipient: member.publicKey,
        dao: d.dao,
        allowance: a,
        treasury: d.treasury,
        mint,
        treasuryToken: mint ? v.tokenAccount(mint, d.treasury, tokenProgram) : null,
        recipientToken: mint ? v.tokenAccount(mint, member.publicKey, tokenProgram) : null,
        tokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
  );
  await v.send(network, ixs, [member]);
  return { amount: big(x.amount), mint };
}

// ---------------------------------------------------------------
// the Distributor
// ---------------------------------------------------------------

/** The DAO's Distributor for its token, run by this bot's operator: { address, account | null }. */
export async function distributorOf(network, d, mint) {
  const op = requireOperator();
  const address = fundsAddresses(network, d.dao).distributor(mint, op.publicKey);
  return { address, account: await programs(network).dist.account.distributor.fetchNullable(address) };
}

export async function requireDistributor(network, d, mint) {
  await requireProgram(network, "distribution");
  const x = await distributorOf(network, d, mint);
  if (!x.account) fail("This DAO has no Distributor yet: `distributor open` makes one.");
  return x;
}

/** Opens the Distributor (anyone; the operator pays and runs it). */
export async function createDistributor(network, d, mint, claimDays = 365) {
  await requireProgram(network, "distribution");
  const op = requireOperator();
  const a = fundsAddresses(network, d.dao);
  const address = a.distributor(mint, op.publicKey);
  const { programId } = await v.mintInfo(network, mint);
  const deadline = (await v.clusterNow(network)) + claimDays * DAY;
  const ix = await programs(network)
    .dist.methods.createDistributor(op.publicKey, bn(deadline))
    .accountsStrict({ payer: op.publicKey, hubDao: d.dao, mint, distributor: address, vault: a.distributorVault(address), tokenProgram: programId, systemProgram: SystemProgram.programId })
    .instruction();
  await v.send(network, [ix], [op]);
  return address;
}

/** Treasury tokens into the Distributor's vault (a proposal). */
export async function distributorFundIx(network, d, distributor, mint, amount) {
  const { decimals, programId } = await v.mintInfo(network, mint);
  const vault = fundsAddresses(network, d.dao).distributorVault(distributor);
  return v.stored(createTransferCheckedInstruction(v.tokenAccount(mint, d.treasury, programId), mint, vault, d.treasury, amount, decimals, [], programId));
}

/** A grant to `owner` and/or a chat `account` (a proposal); its id is the Distributor's next. */
export async function allocateIx(network, d, distributor, { owner = PublicKey.default, account = NO_ACCOUNT, amount, cliffDays = 0, vestDays = 0 }) {
  const x = await programs(network).dist.account.distributor.fetch(distributor);
  const id = Number(x.allocationCount) + 1;
  const start = await v.clusterNow(network);
  const ix = await programs(network)
    .dist.methods.allocate(owner, account, bn(amount), bn(start), bn(cliffDays * DAY), bn(vestDays * DAY))
    .accountsStrict({ treasury: d.treasury, distributor, vault: x.vault, allocation: fundsAddresses(network, d.dao).allocation(distributor, id), systemProgram: SystemProgram.programId })
    .instruction();
  return v.stored(ix);
}

export async function setWelcomeIx(network, d, distributor, amount, cap) {
  const ix = await programs(network).dist.methods.setWelcome(bn(amount), bn(cap)).accountsStrict({ treasury: d.treasury, distributor }).instruction();
  return v.stored(ix);
}

/** What the person can claim: [{ id, address, claimable, total, claimed, byAccount }]. */
export async function claimableFor(network, distributor, wallet, account) {
  const p = programs(network);
  const x = await p.dist.account.distributor.fetch(distributor);
  const now = await v.clusterNow(network);
  const rows = [];
  for (let id = 1; id <= Number(x.allocationCount); id++) {
    const address = pda([seed("allocation"), distributor.toBuffer(), u64le(id)], network.programs.distribution);
    const a = await p.dist.account.allocation.fetchNullable(address);
    if (!a) continue;
    const byWallet = !a.owner.equals(PublicKey.default) && a.owner.equals(wallet);
    const byAccount = Buffer.from(a.account).equals(Buffer.from(account)) && !Buffer.from(account).equals(Buffer.alloc(32));
    if (!byWallet && !byAccount) continue;
    const total = big(a.total);
    const start = Number(a.start);
    const cliff = Number(a.cliff);
    const duration = Number(a.duration);
    let vested;
    if (now < start + cliff) vested = 0n;
    else if (duration === 0 || now >= start + duration) vested = total;
    else vested = (total * BigInt(now - start)) / BigInt(duration);
    rows.push({ id, address, total, claimed: big(a.claimed), claimable: vested - big(a.claimed), byAccount: !byWallet });
  }
  return rows;
}

/** Claims everything vested for the member: their own allocations, and their chat account's through the operator. */
export async function claimAll(network, member, distributor, account) {
  const p = programs(network);
  const x = await p.dist.account.distributor.fetch(distributor);
  const rows = await claimableFor(network, distributor, member.publicKey, account);
  const to = v.tokenAccount(x.mint, member.publicKey, x.tokenProgram);
  let claimed = 0n;
  for (const r of rows.filter((y) => y.claimable > 0n)) {
    const accounts = { signer: r.byAccount ? x.operator : member.publicKey, distributor, vault: x.vault, allocation: r.address, to, mint: x.mint, tokenProgram: x.tokenProgram };
    const open = createAssociatedTokenAccountIdempotentInstruction(r.byAccount ? x.operator : member.publicKey, to, member.publicKey, x.mint, x.tokenProgram);
    const ix = await (r.byAccount ? p.dist.methods.claimFor() : p.dist.methods.claim()).accountsStrict(accounts).instruction();
    await v.send(network, [open, ix], [r.byAccount ? requireOperator() : member]);
    claimed += r.claimable;
  }
  return { claimed, rows, mint: x.mint };
}

/** A Delegate council member approves a member's welcome grant (their wallet and chat account). */
export async function grantWelcome(network, councilMember, d, distributor, memberWallet, account) {
  const p = programs(network);
  const x = await p.dist.account.distributor.fetch(distributor);
  if (big(x.welcomeAmount) === 0n) fail("Welcome grants are off: a proposal sets them (`distributor welcome <amount> <cap>`).");
  if (big(x.welcomeGranted) + big(x.welcomeAmount) > big(x.welcomeCap)) fail("The welcome grants' cap is reached.");
  const welcomeKey = welcomeKeyOf(memberWallet, account);
  const a = fundsAddresses(network, d.dao);
  const welcomed = a.welcomed(distributor, welcomeKey);
  if (await network.connection.getAccountInfo(welcomed)) fail("That member already had their welcome grant.");
  const ix = await p.dist.methods
    .grantWelcome(memberWallet, account)
    .accountsStrict({
      approver: councilMember.publicKey,
      hubDao: d.dao,
      governance: d.governance,
      distributor,
      vault: x.vault,
      allocation: a.allocation(distributor, Number(x.allocationCount) + 1),
      welcomed,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await v.send(network, [ix], [councilMember]);
  return { amount: big(x.welcomeAmount), mint: x.mint };
}

/** vortex-distribution's welcome_key(member, account): the account if given, else the member's key. */
function welcomeKeyOf(member, account) {
  return Buffer.from(account).equals(Buffer.alloc(32)) ? member.toBuffer() : Buffer.from(account);
}

// ---------------------------------------------------------------
// raises
// ---------------------------------------------------------------

/**
 * A raise's create key, derived from the operator's key and the DAO, so a
 * prop firm's vault can name the raise as its seeder before the raise
 * exists (and nobody else can make a raise at that address first).
 */
export function raiseCreateKey(dao, nonce) {
  const op = requireOperator();
  const secret = createHmac("sha256", Buffer.from(op.secretKey)).update(Buffer.concat([seed("vortex-raise"), dao.toBuffer(), Buffer.from(String(nonce))])).digest();
  return Keypair.fromSeed(secret);
}

export async function readRaise(network, raise) {
  const r = await programs(network).dist.account.raise.fetchNullable(raise);
  if (!r) fail("There's no such raise.");
  const now = await v.clusterNow(network);
  const t = r.terms;
  const failed = Number(r.acceptedAt) === 0 && now >= Number(t.end) && (big(r.total) < big(t.softCap) || now >= Number(t.end) + Number(t.decisionWindow));
  const phase = Number(r.acceptedAt) > 0 ? "accepted" : failed ? "failed" : now < Number(t.start) ? "upcoming" : now < Number(t.end) ? "open" : "deciding";
  const { decimals } = await v.mintInfo(network, r.currency);
  return { address: raise, ...r, phase, failed, decimals };
}

/**
 * Opens a raise for the DAO (anyone may; the treasury decides it through a
 * proposal). The operator pays and signs with the derived create key.
 */
export async function createRaise(network, d, distributor, { currency, softCap, hardCap, seconds, saleSupply = 0n, min = 0n, max = 0n, cliffDays = 0, vestDays = 0, decideSeconds = 7 * DAY, propFirmVault = null, nonce, decider = d.treasury }) {
  await requireProgram(network, "distribution");
  const op = requireOperator();
  const key = raiseCreateKey(d.dao, nonce);
  const a = fundsAddresses(network, d.dao);
  const raise = a.raise(key.publicKey);
  const now = await v.clusterNow(network);
  const { programId } = await v.mintInfo(network, currency);
  const terms = {
    softCap: bn(softCap),
    hardCap: bn(hardCap),
    start: bn(now),
    end: bn(now + seconds),
    minContribution: bn(min),
    maxContribution: bn(max),
    saleSupply: bn(saleSupply),
    vestCliff: bn(cliffDays * DAY),
    vestDuration: bn(vestDays * DAY),
    decisionWindow: bn(decideSeconds),
  };
  const ix = await programs(network)
    .dist.methods.createRaise(terms, decider)
    .accountsStrict({ payer: op.publicKey, createKey: key.publicKey, hubDao: d.dao, distributor, currency, raise, vault: a.raiseVault(raise), propFirmVault, tokenProgram: programId, systemProgram: SystemProgram.programId })
    .instruction();
  await v.send(network, [ix], [op, key]);
  return raise;
}

export async function contribute(network, member, d, raise, amount, account) {
  const r = await readRaise(network, raise);
  if (r.phase !== "open") fail(r.phase === "upcoming" ? "The raise hasn't opened yet." : "The raise is closed.");
  const ix = await programs(network)
    .dist.methods.contribute(bn(amount), account)
    .accountsStrict({
      contributor: member.publicKey,
      raise,
      contribution: fundsAddresses(network, d.dao).contribution(raise, member.publicKey),
      from: v.tokenAccount(r.currency, member.publicKey, r.currencyTokenProgram),
      vault: r.vault,
      currency: r.currency,
      tokenProgram: r.currencyTokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await v.send(network, [ix], [member]);
  return r;
}

/**
 * Accepting `amount` of a raise, by its decider: the instructions that top
 * the Distributor up with the sale's tokens from the treasury when it's
 * short (only a proposal can), then accept - the money into the treasury,
 * or for a prop firm into its vault, which mints the shares.
 */
async function acceptPlan(network, d, raise, amount, decider) {
  const r = await readRaise(network, raise);
  if (!r.decider.equals(decider)) fail("You aren't this raise's decider.");
  const p = programs(network);
  const dist = await p.dist.account.distributor.fetch(r.distributor);
  const pre = [];
  const propFirm = !r.propFirmVault.equals(PublicKey.default);
  if (!propFirm) {
    const free = big((await network.connection.getTokenAccountBalance(dist.vault)).value.amount) - big(dist.outstanding);
    const short = big(r.terms.saleSupply) - free;
    if (short > 0n) {
      if (!decider.equals(d.treasury)) fail("The Distributor doesn't hold the sale's tokens yet.");
      pre.push(await distributorFundIx(network, d, r.distributor, dist.mint, short));
    }
  }
  const treasuryToken = v.tokenAccount(r.currency, d.treasury, r.currencyTokenProgram);
  const openTreasury = createAssociatedTokenAccountIdempotentInstruction(decider, treasuryToken, d.treasury, r.currency, r.currencyTokenProgram);
  const vault = propFirm ? await p.vault.account.vault.fetch(r.propFirmVault) : null;
  const accept = await p.dist.methods
    .accept(bn(amount))
    .accountsStrict({
      decider,
      raise,
      vault: r.vault,
      treasury: d.treasury,
      treasuryToken: propFirm ? null : treasuryToken,
      distributor: r.distributor,
      distributorVault: dist.vault,
      propFirmVault: propFirm ? r.propFirmVault : null,
      vaultAssets: propFirm ? vault.assets : null,
      shareMint: propFirm ? vault.shareMint : null,
      shareTokenProgram: propFirm ? vault.shareTokenProgram : null,
      vaultProgram: propFirm ? network.programs.vault : null,
      currency: r.currency,
      tokenProgram: r.currencyTokenProgram,
    })
    .instruction();
  return { pre, open: propFirm ? null : openTreasury, accept, raise: r };
}

/** The treasury accepts `amount` (a proposal's instructions). */
export async function acceptIxs(network, d, raise, amount) {
  const plan = await acceptPlan(network, d, raise, amount, d.treasury);
  return { instructions: [...plan.pre, ...(plan.open ? [v.stored(plan.open)] : []), v.stored(plan.accept)], raise: plan.raise };
}

/** A launch's founder accepts `amount` directly (the money still goes only to the treasury or the vault). */
export async function founderAccept(network, founder, d, raise, amount) {
  const plan = await acceptPlan(network, d, raise, amount, founder.publicKey);
  await v.send(network, [...(plan.open ? [plan.open] : []), plan.accept], [founder]);
  return plan.raise;
}

/** Settles every contributor not yet settled (anyone; the operator pays the allocation accounts). */
export async function settleAll(network, d, raise) {
  const op = requireOperator();
  const p = programs(network);
  const r = await readRaise(network, raise);
  if (r.phase !== "accepted") fail("The raise hasn't been accepted.");
  const all = await p.dist.account.contribution.all([{ memcmp: { offset: 8, bytes: raise.toBase58() } }]);
  let settled = 0;
  for (const c of all.filter((x) => !x.account.settled)) {
    const dist = await p.dist.account.distributor.fetch(r.distributor);
    const ix = await p.dist.methods
      .settle()
      .accountsStrict({ payer: op.publicKey, raise, contribution: c.publicKey, distributor: r.distributor, distributorVault: dist.vault, allocation: fundsAddresses(network, d.dao).allocation(r.distributor, Number(dist.allocationCount) + 1), systemProgram: SystemProgram.programId })
      .instruction();
    await v.send(network, [ix], [op]);
    settled++;
  }
  return settled;
}

export async function withdrawRefund(network, member, d, raise) {
  const p = programs(network);
  const r = await readRaise(network, raise);
  const contribution = fundsAddresses(network, d.dao).contribution(raise, member.publicKey);
  const c = await p.dist.account.contribution.fetchNullable(contribution);
  if (!c) fail("You didn't contribute to this raise.");
  const owed = r.failed ? big(c.amount) : big(c.refundOwed);
  if (owed === 0n) fail(r.phase === "accepted" && !c.settled ? "Your contribution isn't settled yet - `raise settle` first." : "Nothing to refund to you.");
  const to = v.tokenAccount(r.currency, member.publicKey, r.currencyTokenProgram);
  const ix = await p.dist.methods.withdrawRefund().accountsStrict({ raise, contribution, vault: r.vault, to, currency: r.currency, tokenProgram: r.currencyTokenProgram }).instruction();
  await v.send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, to, member.publicKey, r.currency, r.currencyTokenProgram), ix], [member]);
  return { amount: owed, decimals: r.decimals };
}

// ---------------------------------------------------------------
// launches
// ---------------------------------------------------------------

/**
 * A launch on Solana: the bot's operator creates the DAO (and holds its new
 * supply for a moment), fills the Distributor with the tokens for sale,
 * sends the rest of the supply to the treasury, and opens a raise the
 * founder decides - the money still only ever goes to the treasury. A prop
 * firm's DAO starts with no supply: the operator, still the token's mint
 * authority, makes the vault (which takes minting over) with the raise as
 * its seeder, so the raise's money becomes the first shares.
 */
export async function launch(network, founder, { name, model = "tokenWeighted", council, supply = 0, saleSupply = 0n, currency, softCap, hardCap, seconds, decideSeconds = 7 * DAY, propFirm = null }) {
  await requireProgram(network, "distribution");
  if (propFirm) await requireProgram(network, "vault");
  const op = requireOperator();
  const made = await v.createTokenDao(network, { name, initialSupply: propFirm ? 0 : supply, model, council, keepMintAuthority: Boolean(propFirm) });
  const d = v.addresses(network, made.dao, network.programs[model]);
  const distributor = await createDistributor(network, d, made.mint, 400);
  const nonce = "launch";
  let propFirmVault = null;
  if (propFirm) {
    const a = fundsAddresses(network, d.dao);
    const raiseAddress = a.raise(raiseCreateKey(d.dao, nonce).publicKey);
    const asset = await v.mintInfo(network, currency);
    const ix = await programs(network)
      .vault.methods.createVault(propFirm, [], raiseAddress)
      .accountsStrict({ payer: op.publicKey, creator: op.publicKey, hubDao: d.dao, vault: a.vault, shareMint: made.mint, assetMint: currency, assets: a.vaultAssets, escrow: a.vaultEscrow, assetTokenProgram: asset.programId, shareTokenProgram: (await v.mintInfo(network, made.mint)).programId, systemProgram: SystemProgram.programId })
      .instruction();
    await v.send(network, [ix], [op]);
    propFirmVault = a.vault;
  } else {
    const { decimals, programId } = await v.mintInfo(network, made.mint);
    const total = BigInt(supply) * 10n ** BigInt(decimals);
    if (saleSupply <= 0n || saleSupply > total) fail("The tokens for sale must be above zero and at most the supply.");
    const from = v.tokenAccount(made.mint, op.publicKey, programId);
    const dvault = fundsAddresses(network, d.dao).distributorVault(distributor);
    const toTreasury = v.tokenAccount(made.mint, d.treasury, programId);
    const ixs = [createTransferCheckedInstruction(from, made.mint, dvault, op.publicKey, saleSupply, decimals, [], programId)];
    if (total > saleSupply) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(op.publicKey, toTreasury, d.treasury, made.mint, programId));
      ixs.push(createTransferCheckedInstruction(from, made.mint, toTreasury, op.publicKey, total - saleSupply, decimals, [], programId));
    }
    await v.send(network, ixs, [op]);
  }
  const raise = await createRaise(network, d, distributor, { currency, softCap, hardCap, seconds, saleSupply: propFirm ? 0n : saleSupply, decideSeconds, propFirmVault, nonce, decider: founder });
  return { ...made, distributor, raise, vault: propFirmVault };
}

// ---------------------------------------------------------------
// prop-firm vaults
// ---------------------------------------------------------------

export async function readVault(network, d) {
  const a = fundsAddresses(network, d.dao);
  const x = await programs(network).vault.account.vault.fetchNullable(a.vault);
  return x ? { address: a.vault, ...x } : null;
}

export async function requireVault(network, d) {
  await requireProgram(network, "vault");
  const x = await readVault(network, d);
  if (!x) fail("This DAO has no vault: only prop firms do (`vault create`, by proposal).");
  return x;
}

/**
 * Opens the DAO's vault over `assetMint` with the DAO's token as shares (a
 * proposal: the treasury is the token's mint authority and hands minting
 * to the vault). `seeder`: the raise that will seed it, or none.
 */
export async function createVaultIx(network, d, { shareMint, assetMint, config, feeSplits, seeder = PublicKey.default }) {
  const a = fundsAddresses(network, d.dao);
  const share = await v.mintInfo(network, shareMint);
  const asset = await v.mintInfo(network, assetMint);
  const m = await getMint(network.connection, shareMint, "confirmed", share.programId);
  if (!m.mintAuthority?.equals(d.treasury)) fail("The treasury isn't the DAO token's mint authority, so it can't hand minting to a vault.");
  if (m.supply > 0n) fail("The DAO's token already has a supply: a vault's shares must start from nothing (a prop firm's token comes only from deposits).");
  const ix = await programs(network)
    .vault.methods.createVault(config, feeSplits, seeder)
    .accountsStrict({
      payer: d.treasury,
      creator: d.treasury,
      hubDao: d.dao,
      vault: a.vault,
      shareMint,
      assetMint,
      assets: a.vaultAssets,
      escrow: a.vaultEscrow,
      assetTokenProgram: asset.programId,
      shareTokenProgram: share.programId,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return v.stored(ix);
}

/** A vault's rules; `fast` (the network's FAST_TIMINGS) makes windows two minutes apart, for trying it out. */
export const vaultConfig = ({ intervalDays = 30, managementBps = 200, performanceBps = 2000, maxDrawdownBps = 2000, openToAll = true, maxPriceAgeSlots = 150, fast = false } = {}) => ({
  interval: bn(fast ? 120 : intervalDays * DAY),
  freezeBefore: bn(fast ? 10 : DAY),
  settleDelay: bn(fast ? 5 : 3600),
  managementBps,
  performanceBps,
  maxDrawdownBps,
  openToAll,
  maxPriceAgeSlots: bn(maxPriceAgeSlots),
});

const adminIx = async (network, d, vault, method, args = []) =>
  v.stored(await programs(network).vault.methods[method](...args).accountsStrict({ treasury: d.treasury, vault }).instruction());
export const vaultPauseIx = (network, d, vault) => adminIx(network, d, vault, "pause");
export const vaultResumeIx = (network, d, vault) => adminIx(network, d, vault, "resume");
export const vaultConfigIx = (network, d, vault, config) => adminIx(network, d, vault, "setConfig", [config]);
export const vaultVenuesIx = (network, d, vault, perpAssetMap, traders, extraTokens = []) => adminIx(network, d, vault, "setVenues", [perpAssetMap, traders, extraTokens]);

export async function vaultAllowIx(network, d, vault, who, ok = true) {
  const ix = await programs(network)
    .vault.methods.setAllowed(who, ok)
    .accountsStrict({ treasury: d.treasury, vault, allowed: fundsAddresses(network, d.dao).vaultAllowed(who), systemProgram: SystemProgram.programId })
    .instruction();
  return v.stored(ix);
}

/**
 * Whose Phoenix account the trading desk trades: a prop firm's vault (its
 * PDA is the Phoenix authority, and every move is a vault.execute the DAO
 * passes), else the Treasury. A network without the vault program has no
 * vaults; a failed read is an error, never a fall-back to the Treasury.
 */
export async function deskOwner(network, d) {
  const id = network.programs?.vault;
  if (id && (await network.connection.getAccountInfo(id))?.executable) {
    const x = await readVault(network, d);
    if (x) return { authority: x.address, vault: x, name: "the vault", Name: "The vault" };
  }
  return { authority: d.treasury, vault: null, name: "the Treasury", Name: "The Treasury" };
}

/**
 * `ix` as the vault makes it: vault.execute with the program and its
 * accounts as remaining accounts (the vault signs for its PDA; the
 * treasury's signature, e.g. as rent payer, passes through). Instructions
 * the vault doesn't sign (creating a token account) stay as they are.
 */
export async function asVault(network, d, vault, ix) {
  if (!ix.keys.some((k) => k.isSigner && k.pubkey.equals(vault))) return ix;
  const inner = [{ pubkey: ix.programId, isSigner: false, isWritable: false }, ...ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.pubkey.equals(vault) ? false : k.isSigner, isWritable: k.isWritable }))];
  return programs(network).vault.methods.execute(Buffer.from(ix.data)).accountsStrict({ treasury: d.treasury, vault }).remainingAccounts(inner).instruction();
}

/** The venue accounts a valuation reads, in the vault's order (process_window, check_drawdown). */
function venueMetas(x) {
  const keys = [];
  if (x.phoenixTraders.length) keys.push(x.perpAssetMap, ...x.phoenixTraders);
  keys.push(...x.extraTokens);
  return keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}

export async function vaultDeposit(network, member, d, amount) {
  const x = await requireVault(network, d);
  const a = fundsAddresses(network, d.dao);
  const e = Number(x.epoch);
  const allowed = a.vaultAllowed(member.publicKey);
  const ix = await programs(network)
    .vault.methods.requestDeposit(bn(amount))
    .accountsStrict({
      user: member.publicKey,
      vault: x.address,
      epoch: a.vaultEpoch(e),
      request: a.vaultRequest(e, member.publicKey),
      allowed: x.config.openToAll ? null : allowed,
      from: v.tokenAccount(x.assetMint, member.publicKey, x.assetTokenProgram),
      assets: x.assets,
      assetMint: x.assetMint,
      assetTokenProgram: x.assetTokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await v.send(network, [ix], [member]);
  return { epoch: e, vault: x };
}

export async function vaultRedeem(network, member, d, shares) {
  const x = await requireVault(network, d);
  const a = fundsAddresses(network, d.dao);
  const e = Number(x.epoch);
  const ix = await programs(network)
    .vault.methods.requestRedeem(bn(shares))
    .accountsStrict({
      user: member.publicKey,
      vault: x.address,
      epoch: a.vaultEpoch(e),
      request: a.vaultRequest(e, member.publicKey),
      from: v.tokenAccount(x.shareMint, member.publicKey, x.shareTokenProgram),
      escrow: x.escrow,
      shareMint: x.shareMint,
      shareTokenProgram: x.shareTokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await v.send(network, [ix], [member]);
  return { epoch: e, vault: x };
}

export async function vaultCancel(network, member, d) {
  const x = await requireVault(network, d);
  const a = fundsAddresses(network, d.dao);
  const e = Number(x.epoch);
  const req = await programs(network).vault.account.vaultRequest.fetchNullable(a.vaultRequest(e, member.publicKey));
  if (!req || (big(req.deposit) === 0n && big(req.redeem) === 0n)) fail("You have no request in this window.");
  const p = programs(network).vault.methods;
  const ixs = [];
  if (big(req.deposit) > 0n)
    ixs.push(await p.cancelDeposit().accountsStrict({ user: member.publicKey, vault: x.address, epoch: a.vaultEpoch(e), request: a.vaultRequest(e, member.publicKey), to: v.tokenAccount(x.assetMint, member.publicKey, x.assetTokenProgram), assets: x.assets, assetMint: x.assetMint, assetTokenProgram: x.assetTokenProgram }).instruction());
  if (big(req.redeem) > 0n)
    ixs.push(await p.cancelRedeem().accountsStrict({ user: member.publicKey, vault: x.address, epoch: a.vaultEpoch(e), request: a.vaultRequest(e, member.publicKey), to: v.tokenAccount(x.shareMint, member.publicKey, x.shareTokenProgram), escrow: x.escrow, shareMint: x.shareMint, shareTokenProgram: x.shareTokenProgram }).instruction());
  await v.send(network, ixs, [member]);
  return { deposit: big(req.deposit), redeem: big(req.redeem), vault: x };
}

/** Processes the due window (anyone; the operator pays). */
export async function vaultProcessWindow(network, d) {
  const op = requireOperator();
  const x = await requireVault(network, d);
  const now = await v.clusterNow(network);
  if (now < Number(x.nextWindowAt)) fail(`The next window is ${new Date(Number(x.nextWindowAt) * 1000).toUTCString()}.`);
  const a = fundsAddresses(network, d.dao);
  const ix = await programs(network)
    .vault.methods.processWindow()
    .accountsStrict({ payer: op.publicKey, vault: x.address, epoch: a.vaultEpoch(Number(x.epoch)), assets: x.assets, escrow: x.escrow, shareMint: x.shareMint, shareTokenProgram: x.shareTokenProgram, systemProgram: SystemProgram.programId })
    .remainingAccounts(venueMetas(x))
    .instruction();
  await v.send(network, [ix], [op]);
  return { epoch: Number(x.epoch) };
}

/** Claims the member's shares and redemption money from processed windows (the last `lookback`). */
export async function vaultClaim(network, member, d, lookback = 24) {
  const x = await requireVault(network, d);
  const a = fundsAddresses(network, d.dao);
  const p = programs(network).vault;
  const e = Number(x.epoch);
  let shares = 0n;
  let assets = 0n;
  for (let i = Math.max(1, e - lookback); i < e; i++) {
    const req = await p.account.vaultRequest.fetchNullable(a.vaultRequest(i, member.publicKey));
    if (!req) continue;
    const ep = await p.account.vaultEpoch.fetch(a.vaultEpoch(i));
    if (big(req.deposit) > 0n) {
      const to = v.tokenAccount(x.shareMint, member.publicKey, x.shareTokenProgram);
      const ix = await p.methods.claimShares().accountsStrict({ vault: x.address, epoch: a.vaultEpoch(i), request: a.vaultRequest(i, member.publicKey), to, escrow: x.escrow, shareMint: x.shareMint, shareTokenProgram: x.shareTokenProgram }).instruction();
      await v.send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, to, member.publicKey, x.shareMint, x.shareTokenProgram), ix], [member]);
      shares += (big(req.deposit) * big(ep.depositShares)) / big(ep.depositAssets);
    }
    if (big(req.redeem) > 0n) {
      const owed = (big(req.redeem) * big(ep.redeemAssets)) / big(ep.redeemShares) - big(req.redeemPaid);
      if (owed <= 0n) continue;
      const to = v.tokenAccount(x.assetMint, member.publicKey, x.assetTokenProgram);
      const before = big((await network.connection.getTokenAccountBalance(to).catch(() => ({ value: { amount: "0" } }))).value.amount);
      const ix = await p.methods.claimRedemption().accountsStrict({ vault: x.address, epoch: a.vaultEpoch(i), request: a.vaultRequest(i, member.publicKey), to, assets: x.assets, assetMint: x.assetMint, assetTokenProgram: x.assetTokenProgram }).instruction();
      const ok = await v.send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, to, member.publicKey, x.assetMint, x.assetTokenProgram), ix], [member]).then(() => true, () => false);
      if (ok) assets += big((await network.connection.getTokenAccountBalance(to)).value.amount) - before;
    }
  }
  if (shares === 0n && assets === 0n) fail("Nothing to claim yet: requests are priced at the window after they're made.");
  return { shares, assets, vault: x };
}

// ---------------------------------------------------------------
// Delegate council seats
// ---------------------------------------------------------------

const ORAO_VRF = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const ORAO_REQUEST_V2 = Buffer.from([38, 151, 209, 6, 195, 102, 28, 217]);
const ORAO_NETWORK_STATE = Buffer.from([212, 237, 148, 56, 97, 245, 51, 169]);
const oraoRequest = (s) => pda([seed("orao-vrf-randomness-request"), Buffer.from(s)], ORAO_VRF);

/** vortex-delegate's tie_seed(governance, id). */
export const tieSeed = (governance, id) => createHash("sha256").update(Buffer.concat([seed("vortex-delegate-tie"), governance.toBuffer(), u64le(id)])).digest();

/** Whether any seat's leaders (candidates with votes) are tied, as the program decides it. */
export function hasTie(election, councilSize) {
  for (let s = 0; s < councilSize; s++) {
    const votes = election.candidates.filter((c) => c.seat === s && big(c.votes) > 0n).map((c) => big(c.votes));
    if (!votes.length) continue;
    const best = votes.reduce((m, x) => (x > m ? x : m), 0n);
    if (votes.filter((x) => x === best).length > 1) return true;
  }
  return false;
}

export async function declareCandidacy(network, member, d, electionId, seat) {
  const election = d.election(electionId);
  const e = await v.readElection(network, election);
  if (!e) fail("There's no such election.");
  const ix = await programs(network)
    .delegate.methods.declareCandidacy(seat)
    .accountsStrict({ candidate: member.publicKey, governance: d.governance, hubDao: d.dao, election, pool: e.pool, stake: d.stakeOf(e.pool, member.publicKey), stakeProgram: network.programs.stake })
    .instruction();
  return v.send(network, [ix], [member]);
}

/**
 * Closes an election (anyone; the operator pays). A tied seat asks ORAO
 * for a draw in the same transaction; once it answers - or after a day
 * without an answer - `resolveTies` seats the council.
 * Returns { drawRequested, seated }.
 */
export async function finalizeElection(network, d, electionId) {
  const op = requireOperator();
  const election = d.election(electionId);
  const e = await v.readElection(network, election);
  if (!e) fail("There's no such election.");
  const g = await v.readGovernance(network, "delegate", d.governance);
  const p = programs(network).delegate;
  if (e.awaitingDraw) {
    const ix = await p.methods.resolveTies().accountsStrict({ governance: d.governance, election, randomness: oraoRequest(tieSeed(d.governance, electionId)) }).instruction();
    await v.send(network, [ix], [op]);
    return { drawRequested: false, seated: true };
  }
  if (!hasTie(e, g.config.councilSize)) {
    const ix = await p.methods.finalizeElection().accountsStrict({ governance: d.governance, election, randomness: null }).instruction();
    await v.send(network, [ix], [op]);
    return { drawRequested: false, seated: true };
  }
  const s = tieSeed(d.governance, electionId);
  const networkState = pda([seed("orao-vrf-network-configuration")], ORAO_VRF);
  const state = await network.connection.getAccountInfo(networkState);
  if (!state || !state.data.subarray(0, 8).equals(ORAO_NETWORK_STATE)) fail(`ORAO VRF isn't set up on ${network.name}, so tied seats can't be drawn.`);
  const ask = {
    programId: ORAO_VRF,
    keys: [
      { pubkey: op.publicKey, isSigner: true, isWritable: true },
      { pubkey: networkState, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(state.data.subarray(40, 72)), isSigner: false, isWritable: true },
      { pubkey: oraoRequest(s), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ORAO_REQUEST_V2, s]),
  };
  const ix = await p.methods.finalizeElection().accountsStrict({ governance: d.governance, election, randomness: oraoRequest(s) }).instruction();
  await v.send(network, [ask, ix], [op]);
  return { drawRequested: true, seated: false };
}

export async function seatLabelIx(network, d, seat, label) {
  const ix = await programs(network).delegate.methods.setSeatLabel(seat, label).accountsStrict({ treasury: d.treasury, governance: d.governance }).instruction();
  return v.stored(ix);
}
