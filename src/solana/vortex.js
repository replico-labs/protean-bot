import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";

const { AnchorProvider, Program, BN } = anchor;
import { IDLS, GOV_ERRORS, getSolanaOperator } from "./config.js";

/**
 * Talks to the Vortexes programs: the hub (DAO records, treasuries,
 * execution, model switches) and the six governance programs that decide.
 * Instructions are built from the programs' own IDLs (src/solana/idl,
 * copied from the Vortexes repo), so no byte layout is written by hand
 * here.
 *
 * Every write is signed by whoever must sign it on-chain (the member for
 * deposits, proposals and votes; the operator for creating DAOs and for
 * the permissionless steps - queue, execute, finalize, apply a switch)
 * and paid for by the first signer.
 */

/** Token decimals for DAO tokens the bot creates. */
export const TOKEN_DECIMALS = 6;
const TEN_POW = 10n ** BigInt(TOKEN_DECIMALS);

/** The governance models, by the key the bot uses everywhere ("tokenWeighted", ...). */
export const MODELS = ["tokenWeighted", "quadratic", "optimistic", "board", "conviction", "delegate"];
/** Models whose members deposit the DAO's token. */
export const TOKEN_MODELS = ["tokenWeighted", "quadratic", "optimistic", "conviction", "delegate"];
/** Models with for/against/abstain votes on proposals, weighted by deposit. */
const VOTING_MODELS = ["tokenWeighted", "quadratic", "optimistic"];
/** The list entry conviction uses for SOL (the treasury's own balance). */
export const SOL_ASSET = PublicKey.default;

const userError = (msg, extra = {}) => Object.assign(new Error(msg), { userFacing: true, ...extra });

// ---------------------------------------------------------------
// programs and addresses
// ---------------------------------------------------------------

const programs = new WeakMap();

/** The network's Anchor clients, keyed by model ("hub", "tokenWeighted", ...). */
function clients(network) {
  if (programs.has(network)) return programs.get(network);
  // Instructions are built here and signed by our own keypairs, so the
  // provider's wallet is never asked to sign anything.
  const wallet = {
    publicKey: getSolanaOperator()?.publicKey ?? PublicKey.default,
    signTransaction: () => Promise.reject(new Error("not used")),
    signAllTransactions: () => Promise.reject(new Error("not used")),
  };
  const provider = new AnchorProvider(network.connection, wallet, { commitment: "confirmed" });
  const made = {};
  for (const [name, idl] of Object.entries(IDLS)) {
    made[name] = new Program({ ...idl, address: network.programs[name].toBase58() }, provider);
  }
  programs.set(network, made);
  return made;
}

/** The Anchor client for `model` (or "hub"), for decoding events and instructions. */
export function programFor(network, model) {
  return clients(network)[model];
}

const seed = (s) => Buffer.from(s);
const u64le = (n) => new BN(n).toArrayLike(Buffer, "le", 8);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const bn = (v) => new BN(v.toString());

/** All the addresses of hub DAO `dao` in governance program `gp`. */
export function addresses(network, dao, gp) {
  const hub = network.programs.hub;
  const governance = pda([seed("governance"), dao.toBuffer()], gp);
  return {
    dao,
    treasury: pda([seed("treasury"), dao.toBuffer()], hub),
    executor: pda([seed("executor"), dao.toBuffer()], hub),
    governance,
    vault: pda([seed("vault"), governance.toBuffer()], gp),
    bondVault: pda([seed("bond_vault"), governance.toBuffer()], gp),
    voter: (owner) => pda([seed("voter"), governance.toBuffer(), owner.toBuffer()], gp),
    proposal: (id) => pda([seed("proposal"), governance.toBuffer(), u64le(id)], gp),
    vote: (proposal, owner) => pda([seed("vote"), proposal.toBuffer(), owner.toBuffer()], gp),
    election: (id) => pda([seed("election"), governance.toBuffer(), u64le(id)], gp),
    ballot: (election, owner) => pda([seed("ballot"), election.toBuffer(), owner.toBuffer()], gp),
    recall: (id) => pda([seed("recall"), governance.toBuffer(), u64le(id)], gp),
    recallVote: (recall, owner) => pda([seed("recall_vote"), recall.toBuffer(), owner.toBuffer()], gp),
  };
}

const modelPda = (network, gp) => pda([seed("model"), gp.toBuffer()], network.programs.hub);

/** Which model a governance program ID is, or null. */
export function modelOf(network, programId) {
  return MODELS.find((m) => network.programs[m].equals(programId)) ?? null;
}

const mints = new Map();

/** A mint's decimals and token program (Token or Token-2022), cached. */
export async function mintInfo(network, mint) {
  const k = `${network.id}:${mint.toBase58()}`;
  if (mints.has(k)) return mints.get(k);
  const account = await network.connection.getAccountInfo(mint);
  if (!account) throw userError(`\`${mint.toBase58()}\` isn't a token mint on ${network.name}.`);
  const m = await getMint(network.connection, mint, "confirmed", account.owner).catch(() => null);
  if (!m) throw userError(`\`${mint.toBase58()}\` isn't a token mint on ${network.name}.`);
  const info = { decimals: m.decimals, programId: account.owner };
  mints.set(k, info);
  return info;
}

/** `owner`'s associated token account for `mint`. */
export function tokenAccount(mint, owner, tokenProgram = TOKEN_PROGRAM_ID) {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

// ---------------------------------------------------------------
// sending
// ---------------------------------------------------------------

/** Sends `ixs` signed by `signers` (the first pays); returns the signature. */
export async function send(network, ixs, signers, { computeUnits } = {}) {
  const tx = new Transaction();
  if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(...ixs);
  try {
    return await sendAndConfirmTransaction(network.connection, tx, signers, { commitment: "confirmed" });
  } catch (err) {
    // A failure found while confirming carries no logs; fetch them, as they name the error.
    if (!err?.logs?.length && !err?.transactionLogs?.length && typeof err?.getLogs === "function") {
      err.logs = await err.getLogs(network.connection).catch(() => undefined);
    }
    throw explain(err);
  }
}

/**
 * Turns a failed transaction into a readable error: a Vortexes GovError
 * by name and message where the logs carry one, else the first error log.
 */
export function explain(err) {
  const logs = err?.logs ?? err?.transactionLogs ?? [];
  const text = [err?.message ?? "", ...logs].join("\n");
  // The system program's own wording, e.g. a treasury too poor to pay rent.
  const lamports = logs.find((l) => /insufficient lamports/i.test(l));
  if (lamports) {
    return userError(
      `Not enough SOL: ${lamports.replace(/^.*Transfer: /, "")}. A treasury paying tokens also pays a little rent (~0.002 SOL) for a recipient's new token account, and setting up a new model pays rent for its accounts.`,
      { code: "InsufficientLamports" }
    );
  }
  const hex = text.match(/custom program error: (0x[0-9a-f]+)/i);
  if (hex) {
    const code = parseInt(hex[1], 16);
    const gov = GOV_ERRORS[String(code)];
    if (gov) return userError(`${gov.msg} (${gov.name})`, { code: gov.name });
    if (logs.some((l) => /Error: insufficient funds/i.test(l))) return userError("Not enough tokens for that.", { code: "InsufficientFunds" });
    const anchorLine = logs.find((l) => l.includes("Error Message:"));
    if (anchorLine) return userError(anchorLine.split("Error Message:")[1].trim());
    return userError(`Program error ${code}`);
  }
  return err;
}

function requireOperator() {
  const op = getSolanaOperator();
  if (!op) throw userError("This bot has no Solana operator wallet yet - ask an admin to set SOLANA_OPERATOR_KEY.");
  return op;
}

/** A web3.js instruction as the StoredInstruction a proposal carries. */
export function stored(ix) {
  return {
    programId: ix.programId,
    accounts: ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data),
  };
}

/** A stored instruction decoded by the Vortexes program it calls: { program, name, data }, or null. */
export function decodeInstruction(network, ix) {
  for (const [program, client] of Object.entries(clients(network))) {
    if (!client.programId.equals(ix.programId)) continue;
    const decoded = client.coder.instruction.decode(Buffer.from(ix.data));
    return decoded ? { program, ...decoded } : null;
  }
  return null;
}

// ---------------------------------------------------------------
// rules (the bot's defaults, as on EVM; SOLANA_DEVNET_FAST_TIMINGS
// shortens them to minutes for trying things out)
// ---------------------------------------------------------------

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Token-weighted and quadratic: 10% quorum, 60% approval, ~5.6h vote, 1-day timelock, 7 days to run. */
export function votingConfig(network) {
  const fast = network.fastTimings;
  return {
    quorumBps: 1_000,
    approvalBps: 6_000,
    votingDelay: 0,
    votingPeriod: fast ? 120 : 20_160,
    timelock: fast ? 30 : DAY,
    executionPeriod: fast ? DAY : 7 * DAY,
    proposalThreshold: new BN(0),
  };
}

/** Optimistic: ~5.6h to challenge with a 100-token bond, then a ~5.6h vote (10% quorum, 60% approval). */
export function optimisticConfig(network, decimals) {
  const fast = network.fastTimings;
  return {
    challengePeriod: fast ? 120 : 20_160,
    challengeBond: bn(100n * 10n ** BigInt(decimals)),
    quorumBps: 1_000,
    approvalBps: 6_000,
    votingPeriod: fast ? 120 : 20_160,
    timelock: fast ? 30 : DAY,
    executionPeriod: fast ? DAY : 7 * DAY,
    proposalThreshold: new BN(0),
  };
}

/**
 * Conviction, scaled to the token's supply: a proposal's bar is the larger
 * of 1% of supply and 20% of all deposits, plus its budget's share of the
 * treasury (SOL and the DAO's token each weigh a quarter of supply).
 * Conviction grows by at most a tenth of supply a day (fast: in a minute),
 * so a bar of 20% of supply takes two days of full support.
 */
export function convictionSetup(network, supplyRaw) {
  const fast = network.fastTimings;
  const supply = BigInt(supplyRaw);
  const max = (a, b) => (a > b ? a : b);
  const quarter = max(supply / 4n, 1n);
  return {
    config: {
      growthRate: bn(max((supply + BigInt(fast ? 599 : 863_999)) / BigInt(fast ? 600 : 864_000), 1n)),
      minConviction: bn(max(supply / 100n, 1n)),
      supportBps: 2_000,
      proposalThreshold: new BN(0),
      timelock: fast ? 30 : DAY,
      executionPeriod: fast ? DAY : 7 * DAY,
    },
    solWeight: bn(quarter),
    tokenWeight: bn(quarter),
  };
}

/** Delegate: a council of `size`, a majority of it to pass a proposal (60% approval), 2-day terms. */
export function delegateConfig(network, size) {
  const fast = network.fastTimings;
  return {
    councilSize: size,
    termLength: fast ? 600 : 2 * DAY,
    candidacyThreshold: new BN(0),
    candidacyPeriod: fast ? 120 : 20_160,
    electionVotingPeriod: fast ? 120 : 20_160,
    councilQuorum: Math.floor(size / 2) + 1,
    councilApprovalBps: 6_000,
    votingDelay: 0,
    votingPeriod: fast ? 120 : 20_160,
    timelock: fast ? 30 : HOUR,
    executionPeriod: fast ? DAY : 7 * DAY,
    recallQuorumBps: 1_000,
    recallApprovalBps: 6_000,
    recallVotingPeriod: fast ? 120 : 20_160,
  };
}

/** Board: a majority of signers, 1-day timelock, 7 days to run (as on EVM). */
export function boardConfig(network, signerCount) {
  const fast = network.fastTimings;
  return {
    requiredApprovals: Math.floor(signerCount / 2) + 1,
    timelock: fast ? 30 : DAY,
    executionPeriod: fast ? DAY : 7 * DAY,
  };
}

// ---------------------------------------------------------------
// creating DAOs (operator) and setting up a model
// ---------------------------------------------------------------

async function createDaoIx(network, creator, createKey, name, gp) {
  const { hub } = clients(network);
  const dao = pda([seed("dao"), createKey.toBuffer()], network.programs.hub);
  const ix = await hub.methods
    .createDao(name, gp)
    .accountsStrict({ creator, createKey, model: modelPda(network, gp), dao, systemProgram: SystemProgram.programId })
    .instruction();
  return { dao, ix };
}

/**
 * `init_governance` for `model` on hub DAO `dao`: by its creator right
 * after create_dao, or by the treasury (authority and payer) inside a
 * proposal that switches the DAO to this model.
 * `opts`: { mint } for token models, { signers } for board, { council }
 * for delegate.
 */
export async function initGovernanceIx(network, model, dao, authority, payer, opts = {}) {
  const gp = network.programs[model];
  const a = addresses(network, dao, gp);
  const program = clients(network)[model];
  if (model === "board") {
    return program.methods
      .initGovernance(opts.signers, boardConfig(network, opts.signers.length))
      .accountsStrict({ authority, payer, hubDao: dao, governance: a.governance, systemProgram: SystemProgram.programId })
      .instruction();
  }
  const { decimals, programId: tokenProgram } = await mintInfo(network, opts.mint);
  const accounts = { authority, payer, hubDao: dao, governance: a.governance, mint: opts.mint, vault: a.vault, tokenProgram, systemProgram: SystemProgram.programId };
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
      return program.methods.initGovernance(votingConfig(network)).accountsStrict(accounts).instruction();
    case "optimistic":
      return program.methods.initGovernance(optimisticConfig(network, decimals)).accountsStrict({ ...accounts, bondVault: a.bondVault }).instruction();
    case "conviction": {
      const supply = (await getMint(network.connection, opts.mint, "confirmed", tokenProgram)).supply;
      const { config, solWeight, tokenWeight } = convictionSetup(network, supply);
      return program.methods.initGovernance(config, solWeight, tokenWeight).accountsStrict(accounts).instruction();
    }
    case "delegate":
      return program.methods.initGovernance(opts.council, delegateConfig(network, opts.council.length)).accountsStrict(accounts).instruction();
    default:
      throw new Error(`unknown model ${model}`);
  }
}

/**
 * A DAO with a new token, on any token model: mints `initialSupply` to the
 * operator (handed out with /tip, as on EVM), creates the DAO in the hub
 * with its rules, then makes the treasury the token's mint authority, so
 * new tokens can only ever be minted by a passed proposal. Delegate also
 * takes its first `council`.
 */
export async function createTokenDao(network, { name, initialSupply, model = "tokenWeighted", council }) {
  if (!TOKEN_MODELS.includes(model)) throw new Error(`${model} has no token`);
  const operator = requireOperator();
  const conn = network.connection;
  const mint = Keypair.generate();
  const operatorAta = getAssociatedTokenAddressSync(mint.publicKey, operator.publicKey);
  const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  await send(
    network,
    [
      SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, TOKEN_DECIMALS, operator.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, operatorAta, operator.publicKey, mint.publicKey),
      createMintToInstruction(mint.publicKey, operatorAta, operator.publicKey, BigInt(initialSupply) * TEN_POW),
    ],
    [operator, mint]
  );

  const gp = network.programs[model];
  const createKey = Keypair.generate();
  const { dao, ix: create } = await createDaoIx(network, operator.publicKey, createKey.publicKey, name, gp);
  const a = addresses(network, dao, gp);
  const init = await initGovernanceIx(network, model, dao, operator.publicKey, operator.publicKey, { mint: mint.publicKey, council });
  await send(network, [create, init], [operator, createKey]);

  await send(network, [createSetAuthorityInstruction(mint.publicKey, operator.publicKey, AuthorityType.MintTokens, a.treasury)], [operator]);
  return { dao, treasury: a.treasury, governance: a.governance, mint: mint.publicKey };
}

/** A board (multisig) DAO with these signers; a majority must confirm. */
export async function createBoardDao(network, { name, signers }) {
  const operator = requireOperator();
  const gp = network.programs.board;
  const createKey = Keypair.generate();
  const { dao, ix: create } = await createDaoIx(network, operator.publicKey, createKey.publicKey, name, gp);
  const a = addresses(network, dao, gp);
  const init = await initGovernanceIx(network, "board", dao, operator.publicKey, operator.publicKey, { signers });
  await send(network, [create, init], [operator, createKey]);
  return { dao, treasury: a.treasury, governance: a.governance };
}

// ---------------------------------------------------------------
// reading
// ---------------------------------------------------------------

/** The hub's record of a DAO, plus its model and addresses. */
export async function readDao(network, dao) {
  const { hub } = clients(network);
  const record = await hub.account.dao.fetch(dao);
  const model = modelOf(network, record.governanceProgram);
  const a = addresses(network, dao, record.governanceProgram);
  return { record, model, gp: record.governanceProgram, ...a };
}

export async function readGovernance(network, model, governance) {
  return clients(network)[model].account.governance.fetch(governance);
}

export async function readProposal(network, model, proposal) {
  return clients(network)[model].account.proposal.fetchNullable(proposal);
}

export async function readVoter(network, model, voter) {
  return clients(network)[model].account.voter.fetchNullable(voter);
}

export async function readElection(network, election) {
  return clients(network).delegate.account.election.fetchNullable(election);
}

export async function readRecall(network, recall) {
  return clients(network).delegate.account.recall.fetchNullable(recall);
}

/** The cluster's clock (unix seconds), which proposal timing is measured against. */
export async function clusterNow(network) {
  const slot = await network.connection.getSlot("confirmed");
  return (await network.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

const toNum = (v) => (typeof v === "number" ? v : Number(v.toString()));
const big = (v) => BigInt(v.toString());
/** An Anchor enum value ({ for: {} }) as its name ("for"). */
export const variant = (e) => Object.keys(e)[0];

/** Quorum (for + against + abstain >= quorum share of the base) and approval (for / (for + against)). */
function tallyPassed(t, base, quorumBps, approvalBps) {
  const [f, a, ab] = [big(t.forVotes), big(t.againstVotes), big(t.abstainVotes)];
  const quorum = (big(base) * BigInt(quorumBps)) / 10_000n;
  const counted = f + a;
  const approval = counted === 0n ? 0n : (f * 10_000n) / counted;
  return f + a + ab >= quorum && approval >= BigInt(approvalBps);
}

/** vortex-core's proposal_state. */
function coreState(p, { startsAt, endsAt, timelock, executionPeriod }, passed, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  if (now < startsAt) return "Pending";
  if (now < endsAt) return "Active";
  if (!passed) return "Defeated";
  const queued = toNum(p.queuedAt);
  if (queued === 0) return "Succeeded";
  if (now > queued + timelock + executionPeriod) return "Expired";
  return "Queued";
}

/** Token-weighted and quadratic proposal state. */
export function votingState(p, config, now) {
  return coreState(
    p,
    { startsAt: toNum(p.votingStartsAt), endsAt: toNum(p.votingEndsAt), timelock: config.timelock, executionPeriod: config.executionPeriod },
    votingPassed(p, config),
    now
  );
}
export const tokenWeightedState = votingState;

export function votingPassed(p, config) {
  return tallyPassed(p.tally, p.quorumBase, config.quorumBps, config.approvalBps);
}
export const tokenWeightedPassed = votingPassed;

/** Optimistic proposal state: ChallengeWindow, Active (challenged, voting), Succeeded, Queued, Defeated, ... */
export function optimisticState(p, config, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  const queued = toNum(p.queuedAt);
  if (queued !== 0) return now > queued + config.timelock + config.executionPeriod ? "Expired" : "Queued";
  if (!p.challenged) return now < toNum(p.challengeDeadline) ? "ChallengeWindow" : "Succeeded";
  if (now < toNum(p.votingEndsAt)) return "Active";
  return tallyPassed(p.tally, p.quorumBase, config.quorumBps, config.approvalBps) ? "Succeeded" : "Defeated";
}

/** Board proposal state (proposals queue themselves at enough confirmations). */
export function boardState(p, config, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  const queued = toNum(p.queuedAt);
  if (queued === 0) return "Active";
  if (now > queued + config.timelock + config.executionPeriod) return "Expired";
  return "Queued";
}

/** Conviction at `now`: moved toward total support by at most growthRate per second, never past it. */
export function convictionAt(p, growthRate, now) {
  const elapsed = BigInt(Math.max(0, now - toNum(p.lastUpdate)));
  const maxDelta = big(growthRate) * elapsed;
  const [c, target] = [big(p.conviction), big(p.totalSupport)];
  if (c < target) return c + (maxDelta < target - c ? maxDelta : target - c);
  return c - (maxDelta < c - target ? maxDelta : c - target);
}

export function convictionState(p, config, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  const queued = toNum(p.queuedAt);
  if (queued === 0) return "Active";
  return now > queued + config.timelock + config.executionPeriod ? "Expired" : "Queued";
}

/** Council votes on `p` from people on the council now: { for, against, abstain }. */
export function councilTally(g, p) {
  const t = { for: 0, against: 0, abstain: 0 };
  for (const v of p.votes) if (g.council.some((m) => m.equals(v.member))) t[variant(v.choice)] += 1;
  return t;
}

export function councilPassed(g, p) {
  const t = councilTally(g, p);
  const counted = t.for + t.against;
  const approval = counted === 0 ? 0 : Math.floor((t.for * 10_000) / counted);
  return t.for + t.against + t.abstain >= g.config.councilQuorum && approval >= g.config.councilApprovalBps;
}

/** Delegate proposal state; one from an earlier council that never ran is Expired. */
export function delegateState(p, g, now) {
  if (!p.executed && !p.cancelled && p.councilTerm !== g.councilTerm) return "Expired";
  const c = g.config;
  return coreState(p, { startsAt: toNum(p.votingStartsAt), endsAt: toNum(p.votingEndsAt), timelock: c.timelock, executionPeriod: c.executionPeriod }, councilPassed(g, p), now);
}

/** Any model's proposal state. */
export function proposalState(model, p, g, now) {
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
      return votingState(p, g.config, now);
    case "optimistic":
      return optimisticState(p, g.config, now);
    case "board":
      return boardState(p, g.config, now);
    case "conviction":
      return convictionState(p, g.config, now);
    case "delegate":
      return delegateState(p, g, now);
    default:
      return "Unknown";
  }
}

/** Raw token units -> "1,234.5" (6 decimals). */
export function formatTokens(raw) {
  return formatUnits(raw, TOKEN_DECIMALS);
}

/** "12.5" whole tokens -> raw units, refusing more than 6 decimals. */
export function parseTokens(text) {
  return parseUnits(text, TOKEN_DECIMALS);
}

/** "0.25" -> raw units at `decimals` (9 for SOL); refuses more decimals than that, and zero. */
export function parseUnits(text, decimals) {
  const m = String(text).match(decimals > 0 ? new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`) : /^(\d+)$/);
  if (!m) throw userError(`"${text}" isn't an amount (up to ${decimals} decimals).`);
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || 0);
  if (raw === 0n) throw userError("The amount must be more than zero.");
  return raw;
}

/** Raw units at `decimals` -> "1,234.5". */
export function formatUnits(raw, decimals) {
  const v = big(raw);
  const unit = 10n ** BigInt(decimals);
  const frac = decimals > 0 ? (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${(v / unit).toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

// ---------------------------------------------------------------
// members: deposits
// ---------------------------------------------------------------

async function depositAccounts(network, member, d, governance) {
  const { programId: tokenProgram } = await mintInfo(network, governance.mint);
  return {
    owner: member.publicKey,
    governance: d.governance,
    voter: d.voter(member.publicKey),
    ownerTokenAccount: tokenAccount(governance.mint, member.publicKey, tokenProgram),
    vault: d.vault,
    mint: governance.mint,
    tokenProgram,
  };
}

/** Deposits `raw` DAO tokens from the member's wallet into the DAO's vault (any token model). */
export async function deposit(network, model, member, d, governance, raw) {
  const accounts = await depositAccounts(network, member, d, governance);
  const ix = await clients(network)[model].methods.deposit(bn(raw)).accountsStrict({ ...accounts, systemProgram: SystemProgram.programId }).instruction();
  return send(network, [ix], [member]);
}

export async function withdraw(network, model, member, d, governance, raw) {
  const accounts = await depositAccounts(network, member, d, governance);
  const ix = await clients(network)[model].methods.withdraw(bn(raw)).accountsStrict(accounts).instruction();
  return send(network, [ix], [member]);
}

// ---------------------------------------------------------------
// proposals
// ---------------------------------------------------------------

/** Rent the treasury pays for a recipient's new token account (Token-2022 accounts can be a little larger). */
async function tokenAccountRent(network) {
  return BigInt(await network.connection.getMinimumBalanceForRentExemption(200));
}

/**
 * What a payment proposal runs: SOL from the treasury, or tokens from the
 * treasury's token account (creating the recipient's, paid by the
 * treasury, if they have none). Also the budget a conviction DAO needs
 * for it: the amount, plus the SOL rent of the recipient's token account.
 */
export async function paymentInstructions(network, d, { recipient, raw, mint }) {
  if (!mint) {
    const exists = await network.connection.getAccountInfo(recipient);
    if (!exists) {
      const min = await network.connection.getMinimumBalanceForRentExemption(0);
      if (raw < BigInt(min)) throw userError(`A new Solana account needs at least ${min / 1e9} SOL to exist, so pay at least that much.`);
    }
    return { instructions: [stored(SystemProgram.transfer({ fromPubkey: d.treasury, toPubkey: recipient, lamports: raw }))], budget: [{ mint: SOL_ASSET, amount: raw }] };
  }
  const { decimals, programId } = await mintInfo(network, mint);
  const from = tokenAccount(mint, d.treasury, programId);
  const to = tokenAccount(mint, recipient, programId);
  return {
    instructions: [
      stored(createAssociatedTokenAccountIdempotentInstruction(d.treasury, to, recipient, mint, programId)),
      stored(createTransferCheckedInstruction(from, mint, to, d.treasury, raw, decimals, [], programId)),
    ],
    budget: [
      { mint, amount: raw },
      { mint: SOL_ASSET, amount: await tokenAccountRent(network) },
    ],
  };
}

/** Instructions minting `raw` new DAO tokens to `recipient` (the treasury must be the mint authority). */
export async function mintInstructions(network, d, { mint, recipient, raw }) {
  const { decimals, programId } = await mintInfo(network, mint);
  const m = await getMint(network.connection, mint, "confirmed", programId);
  if (!m.mintAuthority?.equals(d.treasury)) throw userError("This DAO's treasury isn't its token's mint authority, so a proposal can't mint it.");
  const to = tokenAccount(mint, recipient, programId);
  return {
    instructions: [
      stored(createAssociatedTokenAccountIdempotentInstruction(d.treasury, to, recipient, mint, programId)),
      stored(createMintToCheckedInstruction(mint, to, d.treasury, raw, decimals, [], programId)),
    ],
    budget: [{ mint: SOL_ASSET, amount: await tokenAccountRent(network) }],
  };
}

/**
 * Makes the next proposal; returns { id, proposal, signature }. A
 * conviction DAO also takes the `budget` ([{ mint, amount }], SOL as
 * SOL_ASSET): lines for assets it doesn't list are dropped, as only listed
 * assets are watched; amounts for the same asset are added up.
 */
export async function propose(network, member, d, model, instructions, description, { budget = [] } = {}) {
  const g = await readGovernance(network, model, d.governance);
  const id = toNum(g.proposalCount) + 1;
  const proposal = d.proposal(id);
  const program = clients(network)[model];
  const base = { proposer: member.publicKey, governance: d.governance, hubDao: d.dao, proposal, systemProgram: SystemProgram.programId };
  let ix;
  if (VOTING_MODELS.includes(model) || model === "conviction") {
    const voter = d.voter(member.publicKey);
    const hasVoter = Boolean(await network.connection.getAccountInfo(voter));
    const accounts = { ...base, voter: hasVoter ? voter : null };
    if (model === "conviction") {
      const lines = new Map();
      for (const b of budget) {
        if (!g.assets.some((a) => a.mint.equals(b.mint))) continue;
        const k = b.mint.toBase58();
        lines.set(k, { mint: b.mint, amount: (lines.get(k)?.amount ?? 0n) + BigInt(b.amount) });
      }
      ix = await program.methods
        .propose(new BN(id), description, instructions, [...lines.values()].map((b) => ({ mint: b.mint, amount: bn(b.amount) })))
        .accountsStrict(accounts)
        .remainingAccounts(g.assets.map((a) => ({ pubkey: a.account, isSigner: false, isWritable: false })))
        .instruction();
    } else {
      ix = await program.methods.propose(new BN(id), description, instructions).accountsStrict(accounts).instruction();
    }
  } else {
    ix = await program.methods.propose(new BN(id), description, instructions).accountsStrict(base).instruction();
  }
  const signature = await send(network, [ix], [member]);
  return { id, proposal, signature };
}

/** A for/against/abstain vote: a deposit-weighted vote (token-weighted, quadratic, a challenged optimistic proposal) or a council vote (delegate). */
export async function vote(network, member, d, model, id, choice) {
  const proposal = d.proposal(id);
  const program = clients(network)[model];
  const ix =
    model === "delegate"
      ? await program.methods.castVote({ [choice]: {} }).accountsStrict({ member: member.publicKey, governance: d.governance, proposal }).instruction()
      : await program.methods
          .castVote({ [choice]: {} })
          .accountsStrict({
            owner: member.publicKey,
            governance: d.governance,
            proposal,
            voter: d.voter(member.publicKey),
            voteRecord: d.vote(proposal, member.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .instruction();
  return send(network, [ix], [member]);
}

export async function confirm(network, signer, d, id) {
  const ix = await clients(network)
    .board.methods.confirm()
    .accountsStrict({ signer: signer.publicKey, governance: d.governance, proposal: d.proposal(id) })
    .instruction();
  return send(network, [ix], [signer]);
}

export async function revoke(network, signer, d, id) {
  const ix = await clients(network)
    .board.methods.revokeConfirmation()
    .accountsStrict({ signer: signer.publicKey, governance: d.governance, proposal: d.proposal(id) })
    .instruction();
  return send(network, [ix], [signer]);
}

export async function cancel(network, who, d, model, id) {
  const ix = await clients(network)
    [model].methods.cancel()
    .accountsStrict({ authority: who.publicKey, governance: d.governance, proposal: d.proposal(id) })
    .instruction();
  return send(network, [ix], [who]);
}

/**
 * Moves a proposal on once its vote (or wait) is over. Anyone may; the
 * operator pays. Token-weighted, quadratic, conviction and delegate:
 * `queue`. Optimistic: finalizes it - unchallenged, it's queued; challenged,
 * the vote settles it and the bond (to the treasury if it passed, back to
 * the challenger if not).
 */
export async function queue(network, d, model, id) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const program = clients(network)[model];
  if (model !== "optimistic") {
    const ix = await program.methods.queue().accountsStrict({ governance: d.governance, proposal }).instruction();
    return send(network, [ix], [operator]);
  }
  const p = await readProposal(network, model, proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  if (!p.challenged) {
    const ix = await program.methods.finalizeUnchallenged().accountsStrict({ governance: d.governance, proposal }).instruction();
    return send(network, [ix], [operator]);
  }
  const g = await readGovernance(network, model, d.governance);
  const { programId: tokenProgram } = await mintInfo(network, g.mint);
  const treasuryAta = tokenAccount(g.mint, d.treasury, tokenProgram);
  const challengerAta = tokenAccount(g.mint, p.challenger, tokenProgram);
  const ix = await program.methods
    .finalizeChallenge()
    .accountsStrict({ governance: d.governance, proposal, bondVault: g.bondVault, treasuryTokenAccount: treasuryAta, challengerTokenAccount: challengerAta, mint: g.mint, tokenProgram })
    .instruction();
  return send(
    network,
    [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, treasuryAta, d.treasury, g.mint, tokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, challengerAta, p.challenger, g.mint, tokenProgram),
      ix,
    ],
    [operator]
  );
}

/**
 * Runs a proposal through the hub, passing every account its stored
 * instructions use (the treasury signs inside the hub). Anyone may; the
 * operator pays.
 */
export async function execute(network, d, model, id) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const p = await readProposal(network, model, proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const remaining = [];
  for (const ix of p.core.instructions) {
    for (const m of ix.accounts) remaining.push({ pubkey: m.pubkey, isSigner: false, isWritable: m.isWritable });
    remaining.push({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const ix = await clients(network)
    .hub.methods.execute()
    .accountsStrict({ dao: d.dao, executor: d.executor, governanceProgram: d.gp, governance: d.governance, proposal })
    .remainingAccounts(remaining)
    .instruction();
  return send(network, [ix], [operator], { computeUnits: 400_000 });
}

// ---------------------------------------------------------------
// optimistic: challenges
// ---------------------------------------------------------------

/** Challenges proposal `id`, posting the DAO's bond from the member's wallet. */
export async function challenge(network, member, d, governance, id) {
  const { programId: tokenProgram } = await mintInfo(network, governance.mint);
  const ix = await clients(network)
    .optimistic.methods.challenge()
    .accountsStrict({
      challenger: member.publicKey,
      governance: d.governance,
      proposal: d.proposal(id),
      challengerTokenAccount: tokenAccount(governance.mint, member.publicKey, tokenProgram),
      bondVault: governance.bondVault,
      mint: governance.mint,
      tokenProgram,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Returns the bond of a cancelled, challenged proposal to its challenger. Anyone; the operator pays. */
export async function reclaimBond(network, d, governance, id, challenger) {
  const operator = requireOperator();
  const { programId: tokenProgram } = await mintInfo(network, governance.mint);
  const to = tokenAccount(governance.mint, challenger, tokenProgram);
  const ix = await clients(network)
    .optimistic.methods.reclaimBond()
    .accountsStrict({ governance: d.governance, proposal: d.proposal(id), bondVault: governance.bondVault, challengerTokenAccount: to, mint: governance.mint, tokenProgram })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, to, challenger, governance.mint, tokenProgram), ix], [operator]);
}

// ---------------------------------------------------------------
// conviction: support
// ---------------------------------------------------------------

/** Backs proposal `id` with the member's whole deposit (moving their support from another proposal, if any). */
export async function support(network, member, d, id) {
  const proposal = d.proposal(id);
  const voter = await readVoter(network, "conviction", d.voter(member.publicKey));
  const current = voter?.supporting;
  const previous = current && !current.equals(PublicKey.default) && !current.equals(proposal) ? current : null;
  const ix = await clients(network)
    .conviction.methods.support()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, voter: d.voter(member.publicKey), proposal, previous })
    .instruction();
  return send(network, [ix], [member]);
}

/** Stops backing the member's current proposal. */
export async function withdrawSupport(network, member, d, supporting) {
  const ix = await clients(network)
    .conviction.methods.withdrawSupport()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, voter: d.voter(member.publicKey), proposal: supporting })
    .instruction();
  return send(network, [ix], [member]);
}

// ---------------------------------------------------------------
// delegate: elections and recalls
// ---------------------------------------------------------------

/** Opens the next election (the council's term must be over). Anyone; the operator pays the election's rent. */
export async function startElection(network, d) {
  const operator = requireOperator();
  const g = await readGovernance(network, "delegate", d.governance);
  const id = toNum(g.electionCount) + 1;
  const ix = await clients(network)
    .delegate.methods.startElection(new BN(id))
    .accountsStrict({ payer: operator.publicKey, governance: d.governance, election: d.election(id), systemProgram: SystemProgram.programId })
    .instruction();
  await send(network, [ix], [operator]);
  return id;
}

export async function declareCandidacy(network, member, d, electionId) {
  const ix = await clients(network)
    .delegate.methods.declareCandidacy()
    .accountsStrict({ candidate: member.publicKey, governance: d.governance, election: d.election(electionId), voter: d.voter(member.publicKey) })
    .instruction();
  return send(network, [ix], [member]);
}

export async function voteInElection(network, member, d, electionId, candidates) {
  const election = d.election(electionId);
  const ix = await clients(network)
    .delegate.methods.voteInElection(candidates)
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      election,
      voter: d.voter(member.publicKey),
      ballot: d.ballot(election, member.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Closes an election and seats the winners. Anyone; the operator pays. */
export async function finalizeElection(network, d, electionId) {
  const operator = requireOperator();
  const ix = await clients(network).delegate.methods.finalizeElection().accountsStrict({ governance: d.governance, election: d.election(electionId) }).instruction();
  return send(network, [ix], [operator]);
}

/** Starts a recall of council member `target`; returns its id. */
export async function initiateRecall(network, member, d, target) {
  const g = await readGovernance(network, "delegate", d.governance);
  const id = toNum(g.recallCount) + 1;
  const ix = await clients(network)
    .delegate.methods.initiateRecall(new BN(id), target)
    .accountsStrict({ initiator: member.publicKey, governance: d.governance, voter: d.voter(member.publicKey), recall: d.recall(id), systemProgram: SystemProgram.programId })
    .instruction();
  await send(network, [ix], [member]);
  return id;
}

export async function voteRecall(network, member, d, recallId, choice) {
  const recall = d.recall(recallId);
  const ix = await clients(network)
    .delegate.methods.voteRecall({ [choice]: {} })
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      recall,
      voter: d.voter(member.publicKey),
      recallVote: d.recallVote(recall, member.publicKey),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

export async function finalizeRecall(network, d, recallId) {
  const operator = requireOperator();
  const ix = await clients(network).delegate.methods.finalizeRecall().accountsStrict({ governance: d.governance, recall: d.recall(recallId) }).instruction();
  return send(network, [ix], [operator]);
}

// ---------------------------------------------------------------
// instructions proposals can carry (the action library builds on these)
// ---------------------------------------------------------------

/** The hub's propose_switch to `model`, for the treasury to sign inside a proposal. */
export async function proposeSwitchIx(network, d, model) {
  const gp = network.programs[model];
  return stored(await clients(network).hub.methods.proposeSwitch(gp).accountsStrict({ treasury: d.treasury, dao: d.dao, model: modelPda(network, gp) }).instruction());
}

export async function cancelSwitchIx(network, d) {
  return stored(await clients(network).hub.methods.cancelSwitch().accountsStrict({ treasury: d.treasury, dao: d.dao }).instruction());
}

/** A board rule change ("addSigner", "removeSigner" with a key; "updateConfig" with a config), signed by the treasury. */
export async function boardIx(network, d, method, arg) {
  return stored(await clients(network).board.methods[method](arg).accountsStrict({ treasury: d.treasury, governance: d.governance }).instruction());
}

/** Conviction: lists `mint` with `weight` (raw conviction units), signed by the treasury. */
export async function addAssetIx(network, d, mint, weight) {
  return stored(await clients(network).conviction.methods.addAsset(bn(weight)).accountsStrict({ treasury: d.treasury, governance: d.governance, mint }).instruction());
}

/** Applies a DAO's pending model switch once it's due. Anyone; the operator pays. */
export async function applySwitch(network, d) {
  const operator = requireOperator();
  const next = d.record.pendingSwitch.program;
  const newGovernance = addresses(network, d.dao, next).governance;
  const ix = await clients(network).hub.methods.applySwitch().accountsStrict({ dao: d.dao, model: modelPda(network, next), newGovernance }).instruction();
  return send(network, [ix], [operator]);
}

// ---------------------------------------------------------------
// tokens
// ---------------------------------------------------------------

/** Sends `raw` DAO tokens from the operator (the creator's /tip) to `recipient`'s token account. */
export async function tipTokens(network, mint, recipient, raw) {
  const operator = requireOperator();
  const { decimals, programId } = await mintInfo(network, mint);
  const from = tokenAccount(mint, operator.publicKey, programId);
  const to = tokenAccount(mint, recipient, programId);
  return send(
    network,
    [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, to, recipient, mint, programId),
      createTransferCheckedInstruction(from, mint, to, operator.publicKey, raw, decimals, [], programId),
    ],
    [operator]
  );
}

/** Balance of `mint` held by `owner`'s associated token account (0 if none). */
export async function tokenBalance(network, mint, owner) {
  const { programId } = await mintInfo(network, mint);
  const info = await network.connection.getTokenAccountBalance(tokenAccount(mint, owner, programId)).catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}
