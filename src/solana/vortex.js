import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import {
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";

const { AnchorProvider, Program, BN } = anchor;
export { BN };
import { IDLS, GOV_ERRORS, getSolanaOperator, explorerUrl } from "./config.js";
import { trackTx } from "../txLinks.js";

/**
 * Talks to the Vortexes programs: the hub (DAO records, treasuries,
 * execution, model switches) and the ten governance programs that decide.
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
export const MODELS = ["tokenWeighted", "quadratic", "optimistic", "board", "conviction", "delegate", "liquid", "sortition", "sowellian", "decisionMarkets"];
/** Models with a token of their own (decision markets' is its base token; members trade it rather than deposit it). */
export const TOKEN_MODELS = ["tokenWeighted", "quadratic", "optimistic", "conviction", "delegate", "liquid", "sortition", "sowellian", "decisionMarkets"];
/** Models whose members deposit the DAO's token to vote or stand. */
export const STAKE_MODELS = ["tokenWeighted", "quadratic", "optimistic", "conviction", "delegate", "liquid", "sortition", "sowellian"];
/** Models with for/against/abstain votes on proposals, weighted by deposit. */
const VOTING_MODELS = ["tokenWeighted", "quadratic", "optimistic", "liquid"];
/** Models whose council (seated by election or by lot) proposes and votes. */
export const COUNCIL_MODELS = ["delegate", "sortition"];
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
    // liquid
    override: (proposal, delegate) => pda([seed("override"), proposal.toBuffer(), delegate.toBuffer()], gp),
    // sortition
    pool: pda([seed("pool"), governance.toBuffer()], gp),
    // sowellian
    escrow: pda([seed("escrow"), governance.toBuffer()], gp),
    approvalVote: (proposal, owner) => pda([seed("approval_vote"), proposal.toBuffer(), owner.toBuffer()], gp),
    adjudicationVote: (proposal, owner) => pda([seed("adjudication_vote"), proposal.toBuffer(), owner.toBuffer()], gp),
    // sowellian and decision markets
    position: (proposal, owner) => pda([seed("position"), proposal.toBuffer(), owner.toBuffer()], gp),
    // decision markets
    baseVault: pda([seed("base_vault"), governance.toBuffer()], gp),
    quoteVault: pda([seed("quote_vault"), governance.toBuffer()], gp),
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

/**
 * Sends `ixs` signed by `signers` (the first pays); returns the signature.
 * Every Vortexes transaction leaves the bot here, so this is where its
 * explorer link is recorded for the command's reply (txLinks.js).
 */
export async function send(network, ixs, signers, { computeUnits } = {}) {
  const tx = new Transaction();
  if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(...ixs);
  try {
    const sig = await sendAndConfirmTransaction(network.connection, tx, signers, { commitment: "confirmed" });
    trackTx(explorerUrl(network, "tx", sig));
    return sig;
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

/** Sortition: a council of `size` drawn by lot, a majority of it to pass a proposal (60% approval), 2-day terms. */
export function sortitionConfig(network, size) {
  const fast = network.fastTimings;
  return {
    councilSize: size,
    termLength: fast ? 600 : 2 * DAY,
    eligibilityThreshold: new BN(0),
    councilQuorum: Math.floor(size / 2) + 1,
    councilApprovalBps: 6_000,
    votingDelay: 0,
    votingPeriod: fast ? 120 : 20_160,
    timelock: fast ? 30 : HOUR,
    executionPeriod: fast ? DAY : 7 * DAY,
    // ORAO usually answers within seconds; a draw it never answers can restart after this.
    randomnessTimeout: fast ? 120 : HOUR,
  };
}

/**
 * Sowellian, as the EVM bot's defaults: 100-token bonds; a ~5.6h approval
 * vote (10% quorum, 60%); a week of positions; a 1-day timelock; 3 days
 * to challenge a resolution, then a ~5.6h adjudication vote (10%, 60%).
 */
export function sowellianConfig(network, decimals) {
  const fast = network.fastTimings;
  const bond = bn(100n * 10n ** BigInt(decimals));
  return {
    proposalBond: bond,
    approvalVotingDelay: 0,
    approvalVotingPeriod: fast ? 120 : 20_160,
    approvalQuorumBps: 1_000,
    approvalThresholdBps: 6_000,
    positionsWindow: fast ? 120 : 7 * DAY,
    executionTimelock: fast ? 30 : DAY,
    executionPeriod: fast ? DAY : 7 * DAY,
    resolutionBond: bond,
    challengePeriod: fast ? 120 : 3 * DAY,
    challengeBond: bond,
    adjudicationVotingPeriod: fast ? 120 : 20_160,
    adjudicationQuorumBps: 1_000,
    adjudicationThresholdBps: 6_000,
    maxOracleStaleness: HOUR,
  };
}

/**
 * Decision markets, as the EVM bot's defaults: 3 days of trading (fast: 5
 * minutes), pass must beat fail by 3%, 1-day timelock, 7 days to run.
 * Proposers seed each market with at least 1 DAO token and 0.01 of the
 * quote token.
 */
export function marketsConfig(network, baseDecimals, quoteDecimals) {
  const fast = network.fastTimings;
  return {
    tradingPeriod: fast ? 300 : 3 * DAY,
    thresholdBps: 300,
    timelock: fast ? 60 : DAY,
    executionPeriod: fast ? DAY : 7 * DAY,
    minBaseSeed: bn(10n ** BigInt(baseDecimals)),
    minQuoteSeed: bn(10n ** BigInt(quoteDecimals) / 100n || 1n),
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

/** The hub's record of a DAO's token: every token model's setup checks it. */
export function daoTokenAddress(network, dao) {
  return pda([seed("token"), dao.toBuffer()], network.programs.hub);
}

/** The DAO's token on record at the hub, or null (DAOs created before the record existed). */
export async function readDaoToken(network, dao) {
  const record = await clients(network).hub.account.daoToken.fetchNullable(daoTokenAddress(network, dao));
  return record?.mint ?? null;
}

/**
 * The hub's set_dao_token: the creator, right after create_dao (before
 * the first governance is set up), or the treasury inside a proposal - a
 * deliberate change of token, or a first record for an older DAO. `gp` is
 * the program running the DAO now.
 */
export async function setDaoTokenIx(network, dao, gp, authority, payer, mint) {
  return clients(network)
    .hub.methods.setDaoToken(mint)
    .accountsStrict({ authority, payer, dao, governance: addresses(network, dao, gp).governance, daoToken: daoTokenAddress(network, dao), systemProgram: SystemProgram.programId })
    .instruction();
}

/**
 * `init_governance` for `model` on hub DAO `dao`: by its creator right
 * after create_dao, or by the treasury (authority and payer) inside a
 * proposal that switches the DAO to this model.
 * `opts`: { mint } for token models, { signers } for board, { council }
 * for delegate and sortition, and { quoteMint } for decision markets
 * (wrapped SOL if left out).
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
  if (model === "decisionMarkets") {
    const quoteMint = opts.quoteMint ?? NATIVE_MINT;
    const quote = await mintInfo(network, quoteMint);
    return program.methods
      .initGovernance(marketsConfig(network, decimals, quote.decimals))
      .accountsStrict({
        authority,
        payer,
        hubDao: dao,
        governance: a.governance,
        baseMint: opts.mint,
        daoToken: daoTokenAddress(network, dao),
        quoteMint,
        baseVault: a.baseVault,
        quoteVault: a.quoteVault,
        baseTokenProgram: tokenProgram,
        quoteTokenProgram: quote.programId,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }
  const accounts = { authority, payer, hubDao: dao, governance: a.governance, mint: opts.mint, daoToken: daoTokenAddress(network, dao), vault: a.vault, tokenProgram, systemProgram: SystemProgram.programId };
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
    case "liquid":
      return program.methods.initGovernance(votingConfig(network)).accountsStrict(accounts).instruction();
    case "sortition":
      return program.methods.initGovernance(opts.council, sortitionConfig(network, opts.council.length)).accountsStrict({ ...accounts, pool: a.pool }).instruction();
    case "sowellian":
      return program.methods.initGovernance(sowellianConfig(network, decimals)).accountsStrict({ ...accounts, escrow: a.escrow }).instruction();
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
 * with its token on record and its rules, then makes the treasury the
 * token's mint authority, so new tokens can only ever be minted by a
 * passed proposal. Delegate and sortition also take their first `council`.
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
  const record = await setDaoTokenIx(network, dao, gp, operator.publicKey, operator.publicKey, mint.publicKey);
  const init = await initGovernanceIx(network, model, dao, operator.publicKey, operator.publicKey, { mint: mint.publicKey, council });
  await send(network, [create, record, init], [operator, createKey]);

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
  const g = await clients(network)[model].account.governance.fetch(governance);
  // Decision markets' token is its base mint; `mint` is what the rest of the bot reads.
  if (model === "decisionMarkets") g.mint = g.baseMint;
  return g;
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

/** Sortition's council tally: every vote counts (members can't be removed mid-term). */
export function sortitionTally(p) {
  const t = { for: 0, against: 0, abstain: 0 };
  for (const v of p.votes) t[variant(v.choice)] += 1;
  return t;
}

/** The quorum in force: the configured one, or the whole council if it's smaller (as the program). */
export function sortitionQuorum(g) {
  return Math.max(1, Math.min(g.config.councilQuorum, g.council.length));
}

export function sortitionPassed(g, p) {
  const t = sortitionTally(p);
  const counted = t.for + t.against;
  const approval = counted === 0 ? 0 : Math.floor((t.for * 10_000) / counted);
  return t.for + t.against + t.abstain >= sortitionQuorum(g) && approval >= g.config.councilApprovalBps;
}

/** Sortition proposal state; one from an earlier council that never ran is Expired. */
export function sortitionState(p, g, now) {
  if (!p.executed && !p.cancelled && p.councilTerm !== g.councilTerm) return "Expired";
  const c = g.config;
  return coreState(p, { startsAt: toNum(p.votingStartsAt), endsAt: toNum(p.votingEndsAt), timelock: c.timelock, executionPeriod: c.executionPeriod }, sortitionPassed(g, p), now);
}

/**
 * Sowellian proposal state, from its phase: Pending/Active (approval
 * vote), ApprovalClosed (to finalize), Defeated, PositionsOpen, Queued
 * (positions closed, timelock running or over), Expired, Measuring,
 * AwaitingResolution, ResolutionProposed, Adjudicating, Resolved, Cancelled.
 */
export function sowellianState(p, config, now) {
  const c = config;
  switch (variant(p.phase)) {
    case "approvalVoting":
      if (now < toNum(p.approvalStartsAt)) return "Pending";
      return now < toNum(p.approvalEndsAt) ? "Active" : "ApprovalClosed";
    case "rejected":
      return "Defeated";
    case "positionsOpen": {
      const deadline = toNum(p.positionsDeadline);
      if (now < deadline) return "PositionsOpen";
      return now < deadline + c.executionTimelock + c.executionPeriod ? "Queued" : "Expired";
    }
    case "executed":
      return now < toNum(p.measurementDeadline) ? "Measuring" : "AwaitingResolution";
    case "resolutionProposed":
      return "ResolutionProposed";
    case "adjudicating":
      return "Adjudicating";
    case "finalized":
      return "Resolved";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

/** When a sowellian proposal can run (positions closed plus the timelock). */
export function sowellianExecutableAt(p, config) {
  return toNum(p.positionsDeadline) + config.executionTimelock;
}

/** Decision markets proposal state: Trading, TradingClosed (to finalize), Defeated, Queued, Executed, Expired, Cancelled. */
export function marketsState(p, config, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  if (!p.finalized) return now < toNum(p.tradingDeadline) ? "Trading" : "TradingClosed";
  if (!p.passed) return "Defeated";
  return now > toNum(p.queuedAt) + config.timelock + config.executionPeriod ? "Expired" : "Queued";
}

/** A pool's price: quote per base, as a float for display (the program keeps it ×1e12). */
export function poolPrice(pool, baseDecimals, quoteDecimals) {
  const base = Number(big(pool.base)) / 10 ** baseDecimals;
  const quote = Number(big(pool.quote)) / 10 ** quoteDecimals;
  return base === 0 ? 0 : quote / base;
}

/** A TWAP (quote per base in raw units, ×1e12) as quote per whole token, for display. */
export function twapPrice(twap, baseDecimals, quoteDecimals) {
  return (Number(big(twap)) / 1e12) * 10 ** (baseDecimals - quoteDecimals);
}

/** The program's constant-product quote: what `amountIn` buys from a pool, after its 0.3% fee. */
export function amountOut(amountIn, reserveIn, reserveOut) {
  const inFee = BigInt(amountIn) * 997n;
  return (inFee * big(reserveOut)) / (big(reserveIn) * 1000n + inFee);
}

/** Any model's proposal state. */
export function proposalState(model, p, g, now) {
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
    case "liquid":
      return votingState(p, g.config, now);
    case "sortition":
      return sortitionState(p, g, now);
    case "sowellian":
      return sowellianState(p, g.config, now);
    case "decisionMarkets":
      return marketsState(p, g.config, now);
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

/** Liquid: the member's delegate's record, which their deposits and withdrawals keep in step (null if they haven't delegated). */
async function delegateVoterOf(network, d, owner) {
  const voter = await readVoter(network, "liquid", d.voter(owner));
  return voter && !voter.delegate.equals(PublicKey.default) ? d.voter(voter.delegate) : null;
}

/** Deposits `raw` DAO tokens from the member's wallet into the DAO's vault (any staking model). */
export async function deposit(network, model, member, d, governance, raw) {
  const accounts = await depositAccounts(network, member, d, governance);
  if (model === "liquid") accounts.delegateVoter = await delegateVoterOf(network, d, member.publicKey);
  const ix = await clients(network)[model].methods.deposit(bn(raw)).accountsStrict({ ...accounts, systemProgram: SystemProgram.programId }).instruction();
  return send(network, [ix], [member]);
}

export async function withdraw(network, model, member, d, governance, raw) {
  const accounts = await depositAccounts(network, member, d, governance);
  if (model === "liquid") accounts.delegateVoter = await delegateVoterOf(network, d, member.publicKey);
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

/** Instructions turning `lamports` of the owner's SOL into wrapped SOL in their token account (created if needed). */
function wrapSolIxs(owner, lamports) {
  const ata = tokenAccount(NATIVE_MINT, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports: BigInt(lamports) }),
    createSyncNativeInstruction(ata),
  ];
}

/** Closes the owner's wrapped SOL account, turning it back into SOL. */
function unwrapSolIx(owner) {
  return createCloseAccountInstruction(tokenAccount(NATIVE_MINT, owner), owner, owner);
}

/** Decision markets' token accounts for `owner`, and the shared `tokens` accounts its instructions take. */
async function marketAccounts(network, d, g, owner) {
  const [base, quote] = await Promise.all([mintInfo(network, g.baseMint), mintInfo(network, g.quoteMint)]);
  return {
    ownerBase: tokenAccount(g.baseMint, owner, base.programId),
    ownerQuote: tokenAccount(g.quoteMint, owner, quote.programId),
    base,
    quote,
    tokens: {
      governance: d.governance,
      baseVault: g.baseVault,
      quoteVault: g.quoteVault,
      baseMint: g.baseMint,
      quoteMint: g.quoteMint,
      baseTokenProgram: base.programId,
      quoteTokenProgram: quote.programId,
    },
  };
}

/** Whether a decision markets DAO's quote token is wrapped SOL (the bot wraps and unwraps it for members). */
export function quoteIsSol(g) {
  return g.quoteMint.equals(NATIVE_MINT);
}

/**
 * Makes the next proposal; returns { id, proposal, signature }. A
 * conviction DAO also takes the `budget` ([{ mint, amount }], SOL as
 * SOL_ASSET): lines for assets it doesn't list are dropped, as only listed
 * assets are watched; amounts for the same asset are added up. Sowellian
 * takes its `criteria` (and the bond comes from the proposer's wallet);
 * decision markets take both markets' `seeds` ({ base, quote }, raw), from
 * the proposer's wallet - wrapped SOL is wrapped here first.
 */
export async function propose(network, member, d, model, instructions, description, { budget = [], criteria, seeds } = {}) {
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
  } else if (model === "sowellian") {
    const { programId: tokenProgram } = await mintInfo(network, g.mint);
    ix = await program.methods
      .propose(new BN(id), description, instructions, criteria)
      .accountsStrict({ ...base, proposerTokenAccount: tokenAccount(g.mint, member.publicKey, tokenProgram), escrow: g.escrow, mint: g.mint, tokenProgram })
      .instruction();
  } else if (model === "decisionMarkets") {
    const m = await marketAccounts(network, d, g, member.publicKey);
    ix = await program.methods
      .propose(new BN(id), description, instructions, bn(seeds.base), bn(seeds.quote))
      .accountsStrict({ ...base, proposerBase: m.ownerBase, proposerQuote: m.ownerQuote, tokens: m.tokens })
      .instruction();
    const pre = quoteIsSol(g) ? wrapSolIxs(member.publicKey, seeds.quote) : [];
    const signature = await send(network, [...pre, ix], [member]);
    return { id, proposal, signature };
  } else {
    ix = await program.methods.propose(new BN(id), description, instructions).accountsStrict(base).instruction();
  }
  const signature = await send(network, [ix], [member]);
  return { id, proposal, signature };
}

/**
 * A for/against/abstain vote: a deposit-weighted vote (token-weighted,
 * quadratic, liquid, a challenged optimistic proposal) or a council vote
 * (delegate, sortition). A liquid member who has delegated overrides
 * their delegate instead - their own weight, their own choice.
 */
export async function vote(network, member, d, model, id, choice) {
  const proposal = d.proposal(id);
  const program = clients(network)[model];
  if (model === "liquid") {
    const owner = member.publicKey;
    const voter = await readVoter(network, model, d.voter(owner));
    const delegated = voter && !voter.delegate.equals(PublicKey.default) ? voter.delegate : null;
    const ix = delegated
      ? await program.methods
          .overrideVote({ [choice]: {} })
          .accountsStrict({
            owner,
            governance: d.governance,
            proposal,
            voter: d.voter(owner),
            delegateVoter: d.voter(delegated),
            delegateRecord: d.vote(proposal, delegated),
            overrides: d.override(proposal, delegated),
            voteRecord: d.vote(proposal, owner),
            systemProgram: SystemProgram.programId,
          })
          .instruction()
      : await program.methods
          .castVote({ [choice]: {} })
          .accountsStrict({ owner, governance: d.governance, proposal, voter: d.voter(owner), overrides: d.override(proposal, owner), voteRecord: d.vote(proposal, owner), systemProgram: SystemProgram.programId })
          .instruction();
    return send(network, [ix], [member]);
  }
  const ix =
    COUNCIL_MODELS.includes(model)
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
 * operator pays. Token-weighted, quadratic, liquid, conviction, delegate
 * and sortition: `queue`. Optimistic: finalizes it - unchallenged, it's
 * queued; challenged, the vote settles it and the bond (to the treasury if
 * it passed, back to the challenger if not). Sowellian: the step its phase
 * is waiting for (sowellianSettle). Decision markets: settles the markets
 * by TWAP, queueing it if it passed.
 */
export async function queue(network, d, model, id) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const program = clients(network)[model];
  if (model === "sowellian") return sowellianSettle(network, d, id);
  if (model === "decisionMarkets") {
    const ix = await program.methods.finalize().accountsStrict({ governance: d.governance, proposal }).instruction();
    return send(network, [ix], [operator]);
  }
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
// liquid: delegation
// ---------------------------------------------------------------

/** Delegates the member's whole deposit to `to` (one hop: `to` can't have delegated themselves). */
export async function delegateTo(network, member, d, to) {
  const ix = await clients(network)
    .liquid.methods.delegate(to)
    .accountsStrict({ owner: member.publicKey, governance: d.governance, voter: d.voter(member.publicKey), delegateVoter: d.voter(to), systemProgram: SystemProgram.programId })
    .instruction();
  return send(network, [ix], [member]);
}

export async function undelegate(network, member, d, delegate) {
  const ix = await clients(network)
    .liquid.methods.undelegate()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, voter: d.voter(member.publicKey), delegateVoter: d.voter(delegate) })
    .instruction();
  return send(network, [ix], [member]);
}

// ---------------------------------------------------------------
// sortition: the pool and draws (randomness from ORAO VRF)
// ---------------------------------------------------------------

/**
 * ORAO VRF, as vortex-sortition reads it. The request instruction is
 * built here from ORAO's own IDL (@orao-network/solana-vrf 0.8.0,
 * dist/types/orao_vrf.json): `request_v2(seed: [u8; 32])` with accounts
 * payer, network_state, treasury, request, system_program. The fee
 * treasury is read from the network state account (8-byte discriminator,
 * then config.authority and config.treasury).
 */
export const ORAO_VRF = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const ORAO_REQUEST_V2 = Buffer.from([38, 151, 209, 6, 195, 102, 28, 217]);
const ORAO_NETWORK_STATE = Buffer.from([212, 237, 148, 56, 97, 245, 51, 169]);
const ORAO_RANDOMNESS_V2 = Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]);
const oraoRequest = (drawSeed) => pda([seed("orao-vrf-randomness-request"), Buffer.from(drawSeed)], ORAO_VRF);

/** vortex-sortition's draw seed: sha256("vortex-sortition", governance, number, nonce). */
export function drawSeed(governance, number, nonce) {
  return createHash("sha256").update("vortex-sortition").update(governance.toBuffer()).update(u64le(number)).update(Buffer.from(nonce)).digest();
}

export async function readPool(network, d) {
  return clients(network).sortition.account.pool.fetchNullable(d.pool);
}

/** The open draw's randomness request: "missing", "pending" or "fulfilled". */
export async function drawStatus(network, g) {
  const info = await network.connection.getAccountInfo(oraoRequest(g.drawSeed));
  if (!info || !info.owner.equals(ORAO_VRF) || info.data.length < 9 || !info.data.subarray(0, 8).equals(ORAO_RANDOMNESS_V2)) return "missing";
  return info.data[8] === 1 ? "fulfilled" : "pending";
}

export async function joinPool(network, member, d) {
  const ix = await clients(network)
    .sortition.methods.joinPool()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, pool: d.pool, voter: d.voter(member.publicKey) })
    .instruction();
  return send(network, [ix], [member]);
}

export async function leavePool(network, member, d) {
  const ix = await clients(network)
    .sortition.methods.leavePool()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, pool: d.pool, voter: d.voter(member.publicKey) })
    .instruction();
  return send(network, [ix], [member]);
}

/**
 * Starts a draw (or restarts one ORAO never answered): asks ORAO for
 * randomness at this draw's seed, then freezes the pool, in one
 * transaction. The operator pays ORAO's fee. Returns { number, restart }.
 */
export async function startDraw(network, d) {
  const operator = requireOperator();
  const g = await readGovernance(network, "sortition", d.governance);
  const restart = g.drawOpen;
  const number = restart ? toNum(g.drawCount) : toNum(g.drawCount) + 1;
  const nonce = randomBytes(32);
  const drawSeedBytes = drawSeed(d.governance, number, nonce);
  const networkState = pda([seed("orao-vrf-network-configuration")], ORAO_VRF);
  const state = await network.connection.getAccountInfo(networkState);
  if (!state || !state.data.subarray(0, 8).equals(ORAO_NETWORK_STATE)) throw userError(`ORAO VRF isn't set up on ${network.name}, so there's no randomness to draw with.`);
  const oraoTreasury = new PublicKey(state.data.subarray(40, 72));
  const request = oraoRequest(drawSeedBytes);
  const ask = {
    programId: ORAO_VRF,
    keys: [
      { pubkey: operator.publicKey, isSigner: true, isWritable: true },
      { pubkey: networkState, isSigner: false, isWritable: true },
      { pubkey: oraoTreasury, isSigner: false, isWritable: true },
      { pubkey: request, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ORAO_REQUEST_V2, drawSeedBytes]),
  };
  const start = await clients(network)
    .sortition.methods.startDraw([...nonce])
    .accountsStrict({ governance: d.governance, pool: d.pool, randomness: request, previousRandomness: restart ? oraoRequest(g.drawSeed) : request })
    .instruction();
  await send(network, [ask, start], [operator]);
  return { number, restart };
}

/** Seats the council from ORAO's answer. Anyone; the operator pays. */
export async function finalizeDraw(network, d) {
  const operator = requireOperator();
  const g = await readGovernance(network, "sortition", d.governance);
  const ix = await clients(network)
    .sortition.methods.finalizeDraw()
    .accountsStrict({ governance: d.governance, pool: d.pool, randomness: oraoRequest(g.drawSeed) })
    .instruction();
  return send(network, [ix], [operator]);
}

// ---------------------------------------------------------------
// sowellian: approval, positions, resolution
// ---------------------------------------------------------------

/** Pyth's push oracle, which keeps sponsored price feeds' PriceUpdateV2 accounts up to date. */
export const PYTH_PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");

/** The sponsored price account for a Pyth feed (shard 0), as @pythnetwork/pyth-solana-receiver derives it. */
export function pythFeedAccount(feedId, shard = 0) {
  const shardBytes = Buffer.alloc(2);
  shardBytes.writeUInt16LE(shard);
  return pda([shardBytes, Buffer.from(feedId)], PYTH_PUSH_ORACLE);
}

export async function readPosition(network, model, position) {
  return clients(network)[model].account.position.fetchNullable(position);
}

/** The approval vote ("for" | "against" | "abstain"), weighted by the member's deposit. */
export async function approvalVote(network, member, d, id, choice) {
  const proposal = d.proposal(id);
  const ix = await clients(network)
    .sowellian.methods.castApprovalVote({ [choice]: {} })
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, voter: d.voter(member.publicKey), voteRecord: d.approvalVote(proposal, member.publicKey), systemProgram: SystemProgram.programId })
    .instruction();
  return send(network, [ix], [member]);
}

/** The adjudication vote on a challenged resolution ("success" | "failure"). */
export async function adjudicationVote(network, member, d, id, outcome) {
  const proposal = d.proposal(id);
  const ix = await clients(network)
    .sowellian.methods.castAdjudicationVote({ [outcome]: {} })
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, voter: d.voter(member.publicKey), voteRecord: d.adjudicationVote(proposal, member.publicKey), systemProgram: SystemProgram.programId })
    .instruction();
  return send(network, [ix], [member]);
}

/**
 * Moves a sowellian proposal on when its window is over: closes the
 * approval vote, an unchallenged resolution, an adjudication, or voids an
 * approved proposal nobody ran in time. Anyone; the operator pays.
 * Returns the step taken.
 */
export async function sowellianSettle(network, d, id) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const p = await readProposal(network, "sowellian", proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const step = { approvalVoting: "finalizeApproval", resolutionProposed: "finalizeUnchallenged", adjudicating: "finalizeAdjudication", positionsOpen: "voidExpired" }[variant(p.phase)];
  if (!step) throw userError(`Proposal #${id} has nothing to settle right now.`);
  const ix = await clients(network).sowellian.methods[step]().accountsStrict({ governance: d.governance, proposal }).instruction();
  await send(network, [ix], [operator]);
  return step;
}

async function sowellianTokenAccounts(network, g, owner) {
  const { programId: tokenProgram } = await mintInfo(network, g.mint);
  return { ownerTokenAccount: tokenAccount(g.mint, owner, tokenProgram), escrow: g.escrow, mint: g.mint, tokenProgram };
}

/** Backs YES or NO ("yes" | "no") with `raw` DAO tokens from the member's wallet. */
export async function takePosition(network, member, d, g, id, side, raw) {
  const proposal = d.proposal(id);
  const ix = await clients(network)
    .sowellian.methods.takePosition({ [side]: {} }, bn(raw))
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      proposal,
      position: d.position(proposal, member.publicKey),
      ...(await sowellianTokenAccounts(network, g, member.publicKey)),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Human track: states the outcome ("success" | "failure"), posting the resolution bond. */
export async function proposeResolution(network, member, d, g, id, outcome) {
  const ix = await clients(network)
    .sowellian.methods.proposeResolution({ [outcome]: {} })
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal: d.proposal(id), ...(await sowellianTokenAccounts(network, g, member.publicKey)) })
    .instruction();
  return send(network, [ix], [member]);
}

/** Disputes a proposed resolution, posting the challenge bond; opens the adjudication vote. */
export async function challengeResolution(network, member, d, g, id) {
  const ix = await clients(network)
    .sowellian.methods.challengeResolution()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal: d.proposal(id), ...(await sowellianTokenAccounts(network, g, member.publicKey)) })
    .instruction();
  return send(network, [ix], [member]);
}

/** Oracle track: settles the outcome from a Pyth PriceUpdateV2 account (the feed's sponsored one unless given). Anyone; the operator pays. */
export async function resolveViaOracle(network, d, id, priceUpdate) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const p = await readProposal(network, "sowellian", proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const ix = await clients(network)
    .sowellian.methods.resolveViaOracle()
    .accountsStrict({ governance: d.governance, proposal, priceUpdate: priceUpdate ?? pythFeedAccount(p.criteria.feedId) })
    .instruction();
  return send(network, [ix], [operator]);
}

/** Collects the member's position payout (or refund, if the proposal was cancelled or voided). */
export async function claimPosition(network, member, d, g, id) {
  const proposal = d.proposal(id);
  const t = await sowellianTokenAccounts(network, g, member.publicKey);
  const ix = await clients(network)
    .sowellian.methods.claimPosition()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, position: d.position(proposal, member.publicKey), ...t })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, t.ownerTokenAccount, member.publicKey, g.mint, t.tokenProgram), ix], [member]);
}

/** Takes back the bonds owed to the member on this proposal (as proposer, resolver or challenger). */
export async function claimBond(network, member, d, g, id) {
  const t = await sowellianTokenAccounts(network, g, member.publicKey);
  const ix = await clients(network)
    .sowellian.methods.claimBond()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal: d.proposal(id), ...t })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, t.ownerTokenAccount, member.publicKey, g.mint, t.tokenProgram), ix], [member]);
}

/** Sends forfeited bonds to the treasury's token account. Anyone; the operator pays. */
export async function sweepToTreasury(network, d, g) {
  const operator = requireOperator();
  const { programId: tokenProgram } = await mintInfo(network, g.mint);
  const to = tokenAccount(g.mint, d.treasury, tokenProgram);
  const ix = await clients(network)
    .sowellian.methods.sweepToTreasury()
    .accountsStrict({ governance: d.governance, treasuryTokenAccount: to, escrow: g.escrow, mint: g.mint, tokenProgram })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, to, d.treasury, g.mint, tokenProgram), ix], [operator]);
}

// ---------------------------------------------------------------
// decision markets: conditional tokens and the two pools
// ---------------------------------------------------------------

/**
 * One member transaction on a market: opens their token accounts if
 * needed (wrapping `wrap` lamports when the quote token is wrapped SOL),
 * runs `ix`, then unwraps whatever wrapped SOL they hold.
 */
async function sendMarketIx(network, member, g, m, ix, wrap = 0n) {
  const owner = member.publicKey;
  const sol = quoteIsSol(g);
  const pre = [createAssociatedTokenAccountIdempotentInstruction(owner, m.ownerBase, owner, g.baseMint, m.base.programId)];
  if (sol) pre.push(...(wrap > 0n ? wrapSolIxs(owner, wrap) : [createAssociatedTokenAccountIdempotentInstruction(owner, m.ownerQuote, owner, NATIVE_MINT)]));
  else pre.push(createAssociatedTokenAccountIdempotentInstruction(owner, m.ownerQuote, owner, g.quoteMint, m.quote.programId));
  return send(network, [...pre, ix, ...(sol ? [unwrapSolIx(owner)] : [])], [member]);
}

/** Splits `base` DAO tokens and `quote` quote tokens (raw; SOL is wrapped for it) into equal pass and fail balances. */
export async function split(network, member, d, g, id, base, quote) {
  const proposal = d.proposal(id);
  const m = await marketAccounts(network, d, g, member.publicKey);
  const ix = await clients(network)
    .decisionMarkets.methods.split(bn(base), bn(quote))
    .accountsStrict({ owner: member.publicKey, proposal, position: d.position(proposal, member.publicKey), ownerBase: m.ownerBase, ownerQuote: m.ownerQuote, tokens: m.tokens, systemProgram: SystemProgram.programId })
    .instruction();
  return sendMarketIx(network, member, g, m, ix, BigInt(quote));
}

/** Merges pairs of pass and fail balances back into the underlying, while trading lasts. */
export async function merge(network, member, d, g, id, base, quote) {
  const proposal = d.proposal(id);
  const m = await marketAccounts(network, d, g, member.publicKey);
  const ix = await clients(network)
    .decisionMarkets.methods.merge(bn(base), bn(quote))
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, position: d.position(proposal, member.publicKey), ownerBase: m.ownerBase, ownerQuote: m.ownerQuote, tokens: m.tokens })
    .instruction();
  return sendMarketIx(network, member, g, m, ix);
}

/** Trades in one market ("pass" | "fail"): `sideIn` "base" sells conditional DAO tokens, "quote" buys them. */
export async function trade(network, member, d, id, market, sideIn, amountIn, minOut) {
  const proposal = d.proposal(id);
  const ix = await clients(network)
    .decisionMarkets.methods.trade({ [market]: {} }, { [sideIn]: {} }, bn(amountIn), bn(minOut))
    .accountsStrict({ owner: member.publicKey, proposal, position: d.position(proposal, member.publicKey) })
    .instruction();
  return send(network, [ix], [member]);
}

/** Pays out the member's winning-side balances 1:1, once the proposal is settled. */
export async function redeem(network, member, d, g, id) {
  const proposal = d.proposal(id);
  const m = await marketAccounts(network, d, g, member.publicKey);
  const ix = await clients(network)
    .decisionMarkets.methods.redeem()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, position: d.position(proposal, member.publicKey), ownerBase: m.ownerBase, ownerQuote: m.ownerQuote, tokens: m.tokens })
    .instruction();
  return sendMarketIx(network, member, g, m, ix);
}

/** The proposer takes back what's left in the winning pool (their seed plus fees, after trades). */
export async function reclaimLiquidity(network, member, d, g, id) {
  const m = await marketAccounts(network, d, g, member.publicKey);
  const ix = await clients(network)
    .decisionMarkets.methods.reclaimLiquidity()
    .accountsStrict({ proposer: member.publicKey, governance: d.governance, proposal: d.proposal(id), proposerBase: m.ownerBase, proposerQuote: m.ownerQuote, tokens: m.tokens })
    .instruction();
  return sendMarketIx(network, member, g, m, ix);
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
