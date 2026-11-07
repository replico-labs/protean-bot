import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
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
import { legacySize, sendV1, LEGACY_TRANSACTION_SIZE_LIMIT, V1_TRANSACTION_SIZE_LIMIT } from "./v1.js";

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
/** Models whose members stake the DAO's token (in its stake pool, shared by every model) to vote or stand. */
export const STAKE_MODELS = ["tokenWeighted", "quadratic", "optimistic", "conviction", "delegate", "liquid", "sortition", "sowellian"];
/** Models with for/against/abstain votes on proposals, weighted by stake. */
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
    roomyEncoder(made[name].coder.instruction);
  }
  programs.set(network, made);
  return made;
}

/**
 * Anchor's JS coder encodes every instruction into a fixed 1,000-byte buffer,
 * which a proposal carrying a protocol's larger instructions (sent as a v1
 * transaction, up to 4,096 bytes) overflows. Same encoding, a buffer the
 * size of the largest transaction.
 */
function roomyEncoder(coder) {
  coder.encode = (ixName, ix) => {
    const encoder = coder.ixLayouts.get(ixName);
    if (!encoder) throw new Error(`Unknown method: ${ixName}`);
    const buffer = Buffer.alloc(V1_TRANSACTION_SIZE_LIMIT);
    const len = encoder.layout.encode(ix, buffer);
    return Buffer.concat([Buffer.from(encoder.discriminator), buffer.subarray(0, len)]);
  };
}

/** The Anchor client for `model` (or "hub"), for decoding events and instructions. */
export function programFor(network, model) {
  return clients(network)[model];
}

const seed = (s) => Buffer.from(s);
const u64le = (n) => new BN(n).toArrayLike(Buffer, "le", 8);
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Number(n));
  return b;
};
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const bn = (v) => new BN(v.toString());

/**
 * A DAO's account in governance program `gp` for hub epoch `epoch`:
 * `[governance, dao, epoch u32 LE]`. Every switch sets up a fresh one.
 */
export function governanceAddress(dao, gp, epoch) {
  return pda([seed("governance"), dao.toBuffer(), u32le(epoch)], gp);
}

/**
 * vortex-stake's addresses for hub DAO `dao`: one pool per token, a stake
 * per member per pool, and what a governance has locked of a stake.
 */
export function stakeAddresses(network, dao) {
  const sp = network.programs.stake;
  const stakeOf = (pool, owner) => pda([seed("stake"), pool.toBuffer(), owner.toBuffer()], sp);
  const converter = (fromPool, toPool) => pda([seed("converter"), fromPool.toBuffer(), toPool.toBuffer()], sp);
  return {
    poolOf: (mint) => pda([seed("pool"), dao.toBuffer(), mint.toBuffer()], sp),
    poolVault: (pool) => pda([seed("vault"), pool.toBuffer()], sp),
    stakeOf,
    lockOf: (pool, owner, governance) => pda([seed("lock"), stakeOf(pool, owner).toBuffer(), governance.toBuffer()], sp),
    converter,
    converterVault: (c) => pda([seed("converter_vault"), c.toBuffer()], sp),
  };
}

/** All the addresses of hub DAO `dao` in governance program `gp`, for hub epoch `epoch` (the DAO's current one unless it's a switch being set up). */
export function addresses(network, dao, gp, epoch = 1) {
  const hub = network.programs.hub;
  const governance = governanceAddress(dao, gp, epoch);
  return {
    dao,
    epoch,
    treasury: pda([seed("treasury"), dao.toBuffer()], hub),
    executor: pda([seed("executor"), dao.toBuffer()], hub),
    governance,
    // optimistic: one bond vault per token proposals were made in
    bondVault: (mint) => pda([seed("bond_vault"), governance.toBuffer(), mint.toBuffer()], gp),
    voter: (owner) => pda([seed("voter"), governance.toBuffer(), owner.toBuffer()], gp),
    proposal: (id) => pda([seed("proposal"), governance.toBuffer(), u64le(id)], gp),
    vote: (proposal, owner) => pda([seed("vote"), proposal.toBuffer(), owner.toBuffer()], gp),
    election: (id) => pda([seed("election"), governance.toBuffer(), u64le(id)], gp),
    ballot: (election, owner) => pda([seed("ballot"), election.toBuffer(), owner.toBuffer()], gp),
    recall: (id) => pda([seed("recall"), governance.toBuffer(), u64le(id)], gp),
    recallVote: (recall, owner) => pda([seed("recall_vote"), recall.toBuffer(), owner.toBuffer()], gp),
    // liquid
    override: (proposal, delegate) => pda([seed("override"), proposal.toBuffer(), delegate.toBuffer()], gp),
    // sortition: who can be drawn
    pool: pda([seed("pool"), governance.toBuffer()], gp),
    // sowellian: one escrow per token proposals were made in
    escrow: (mint) => pda([seed("escrow"), governance.toBuffer(), mint.toBuffer()], gp),
    approvalVote: (proposal, owner) => pda([seed("approval_vote"), proposal.toBuffer(), owner.toBuffer()], gp),
    adjudicationVote: (proposal, owner) => pda([seed("adjudication_vote"), proposal.toBuffer(), owner.toBuffer()], gp),
    // sowellian and decision markets
    position: (proposal, owner) => pda([seed("position"), proposal.toBuffer(), owner.toBuffer()], gp),
    // decision markets: one base vault per token
    baseVault: (mint) => pda([seed("base_vault"), governance.toBuffer(), mint.toBuffer()], gp),
    quoteVault: pda([seed("quote_vault"), governance.toBuffer()], gp),
    // the hub's council records
    waiting: (proposal) => pda([seed("waiting"), dao.toBuffer(), proposal.toBuffer()], hub),
    ...stakeAddresses(network, dao),
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
 *
 * A legacy transaction where it fits; one too big for legacy (a proposal
 * carrying a protocol's larger instructions, or running them) goes as a v1
 * transaction (src/solana/v1.js) on networks where those are enabled.
 */
export async function send(network, ixs, signers, { computeUnits } = {}) {
  const tx = new Transaction();
  if (computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(...ixs);
  const tooBig = legacySize(tx.instructions, signers[0].publicKey) > LEGACY_TRANSACTION_SIZE_LIMIT;
  if (tooBig && !network.v1Transactions) {
    throw userError(`That's too big for a Solana transaction on ${network.name}: it needs v1 transactions, which aren't enabled there (${network.envPrefix}_V1_TRANSACTIONS=true turns them on once the cluster supports them).`);
  }
  try {
    const sig = tooBig ? await sendV1(network.connection, ixs, signers, { computeUnits }) : await sendAndConfirmTransaction(network.connection, tx, signers, { commitment: "confirmed" });
    trackTx(explorerUrl(network, "tx", sig));
    return sig;
  } catch (err) {
    // A failure found while confirming carries no logs; fetch them, as they name the error.
    if (!err?.logs?.length && !err?.transactionLogs?.length && typeof err?.getLogs === "function") {
      err.logs = await err.getLogs(network.connection).catch(() => undefined);
    }
    throw explain(err, network);
  }
}

/**
 * Turns a failed transaction into a readable error: a Vortexes GovError
 * by name and message where the logs carry one, else the first error log.
 */
export function explain(err, network) {
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
    // Which program raised it (the first to fail; the callers above it fail with the same code): a GovError code
    // means something only from a Vortexes program, as other programs reuse the numbers.
    const failed = logs.map((l) => l.match(/^Program (\S+) failed: custom program error/)).find(Boolean)?.[1];
    const vortexes = !failed || !network || Object.values(network.programs).some((p) => p.toBase58() === failed);
    const gov = vortexes ? GOV_ERRORS[String(code)] : undefined;
    if (gov) return userError(`${gov.msg} (${gov.name})`, { code: gov.name });
    if (logs.some((l) => /Error: insufficient funds/i.test(l))) return userError("Not enough tokens for that.", { code: "InsufficientFunds" });
    const anchorLine = logs.find((l) => l.includes("Error Message:"));
    const where = failed && !vortexes ? ` (program \`${failed}\`, error ${code})` : "";
    if (anchorLine) return userError(`${anchorLine.split("Error Message:")[1].trim()}${where}`);
    return userError(`Program error ${code}${where ? ` in program \`${failed}\`` : ""}`);
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

/** The DAO's token on record at the hub, or null if it has none (a board DAO that never recorded one). */
export async function readDaoToken(network, dao) {
  return (await readTokenRecord(network, dao))?.mint ?? null;
}

/** The hub's whole token record: { mint, pool } (the current stake pool), or null. */
export async function readTokenRecord(network, dao) {
  return clients(network).hub.account.daoToken.fetchNullable(daoTokenAddress(network, dao));
}

/**
 * The hub's set_dao_token: the creator, right after create_dao (before
 * the first governance is set up), or the treasury inside a proposal - a
 * deliberate change of token, or a first record for an older DAO. `gp` is
 * the program running the DAO now.
 */
export async function setDaoTokenIx(network, dao, gp, authority, payer, mint, epoch = 1) {
  return clients(network)
    .hub.methods.setDaoToken(mint)
    .accountsStrict({ authority, payer, dao, governance: governanceAddress(dao, gp, epoch), daoToken: daoTokenAddress(network, dao), systemProgram: SystemProgram.programId })
    .instruction();
}

/** vortex-stake's create_pool: the DAO's pool for `mint` (anyone may open one; `payer` pays its rent). */
export async function createPoolIx(network, dao, payer, mint, tokenProgram) {
  tokenProgram ??= (await mintInfo(network, mint)).programId;
  const st = stakeAddresses(network, dao);
  const pool = st.poolOf(mint);
  return clients(network)
    .stake.methods.createPool()
    .accountsStrict({ payer, hubDao: dao, mint, pool, vault: st.poolVault(pool), tokenProgram, systemProgram: SystemProgram.programId })
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
  const epoch = opts.epoch ?? 1;
  const a = addresses(network, dao, gp, epoch);
  const program = clients(network)[model];
  const e = epoch;
  if (model === "board") {
    return program.methods
      .initGovernance(e, opts.signers, boardConfig(network, opts.signers.length))
      .accountsStrict({ authority, payer, hubDao: dao, governance: a.governance, systemProgram: SystemProgram.programId })
      .instruction();
  }
  const { decimals, programId: tokenProgram } = await mintInfo(network, opts.mint);
  const daoToken = daoTokenAddress(network, dao);
  if (model === "decisionMarkets") {
    const quoteMint = opts.quoteMint ?? NATIVE_MINT;
    const quote = await mintInfo(network, quoteMint);
    return program.methods
      .initGovernance(e, marketsConfig(network, decimals, quote.decimals))
      .accountsStrict({
        authority,
        payer,
        hubDao: dao,
        governance: a.governance,
        baseMint: opts.mint,
        daoToken,
        quoteMint,
        baseVault: a.baseVault(opts.mint),
        quoteVault: a.quoteVault,
        baseTokenProgram: tokenProgram,
        quoteTokenProgram: quote.programId,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }
  // Token models keep no vault: members stake in the DAO's pool (vortex-stake).
  const accounts = { authority, payer, hubDao: dao, governance: a.governance, daoToken, systemProgram: SystemProgram.programId };
  switch (model) {
    case "tokenWeighted":
    case "quadratic":
    case "liquid":
      return program.methods.initGovernance(e, votingConfig(network)).accountsStrict(accounts).instruction();
    case "sortition":
      return program.methods.initGovernance(e, opts.council, sortitionConfig(network, opts.council.length)).accountsStrict({ ...accounts, pool: a.pool }).instruction();
    case "sowellian":
      return program.methods.initGovernance(e, sowellianConfig(network, decimals)).accountsStrict(accounts).instruction();
    case "optimistic":
      return program.methods.initGovernance(e, optimisticConfig(network, decimals)).accountsStrict(accounts).instruction();
    case "conviction": {
      // Conviction keeps the token for its spending-budget asset list.
      const supply = (await getMint(network.connection, opts.mint, "confirmed", tokenProgram)).supply;
      const { config, solWeight, tokenWeight } = convictionSetup(network, supply);
      return program.methods
        .initGovernance(e, config, solWeight, tokenWeight)
        .accountsStrict({ authority, payer, hubDao: dao, governance: a.governance, mint: opts.mint, daoToken, tokenProgram, systemProgram: SystemProgram.programId })
        .instruction();
    }
    case "delegate":
      return program.methods.initGovernance(e, opts.council, delegateConfig(network, opts.council.length)).accountsStrict(accounts).instruction();
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
export async function createTokenDao(network, { name, initialSupply, model = "tokenWeighted", council, keepMintAuthority = false }) {
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
  const pool = await createPoolIx(network, dao, operator.publicKey, mint.publicKey);
  const init = await initGovernanceIx(network, model, dao, operator.publicKey, operator.publicKey, { mint: mint.publicKey, council });
  await send(network, [create, record, pool, init], [operator, createKey]);

  // A prop firm's launch keeps minting a moment longer, to hand it to the vault instead (src/solana/funds.js).
  if (!keepMintAuthority) await send(network, [createSetAuthorityInstruction(mint.publicKey, operator.publicKey, AuthorityType.MintTokens, a.treasury)], [operator]);
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
  const a = addresses(network, dao, record.governanceProgram, record.epoch);
  const token = await readTokenRecord(network, dao);
  // `mint` and `stakePool`: the DAO's token and current stake pool (null for a board DAO without one).
  return { record, model, gp: record.governanceProgram, ...a, mint: token?.mint ?? null, stakePool: token?.pool ?? null };
}

/**
 * A model's governance account. Token models' `mint` (what the rest of
 * the bot reads) is the DAO's token on record at the hub; decision
 * markets' is its base mint.
 */
export async function readGovernance(network, model, governance) {
  const g = await clients(network)[model].account.governance.fetch(governance);
  if (model === "decisionMarkets") g.mint = g.baseMint;
  else if (model !== "board") g.mint = (await readTokenRecord(network, g.hubDao))?.mint ?? null;
  return g;
}

/** A member's stake in `pool` (vortex-stake), or null if they never staked there. */
export async function readStake(network, dao, pool, owner) {
  return clients(network).stake.account.stake.fetchNullable(stakeAddresses(network, dao).stakeOf(pool, owner));
}

export async function readStakePool(network, pool) {
  return clients(network).stake.account.pool.fetchNullable(pool);
}

/**
 * What the commands read about a member: their stake in the DAO's current
 * pool (`amount`, `locked`, `stakeLockedUntil`), merged with the model's
 * own record of them where it has one (liquid, conviction, sortition).
 * `amount` is the stake. Null if neither exists.
 */
export async function readMember(network, model, d, owner) {
  const [stake, voter] = await Promise.all([
    d.stakePool ? readStake(network, d.dao, d.stakePool, owner) : null,
    ["liquid", "conviction", "sortition"].includes(model) ? readVoter(network, model, d.voter(owner)) : null,
  ]);
  if (!stake && !voter) return null;
  // A member with stake but no record in the model yet: not supporting, delegating or in the draw pool.
  const none = { supporting: PublicKey.default, supportWeight: new BN(0), delegate: PublicKey.default, delegators: 0, delegatedPower: new BN(0), powerLockedUntil: new BN(0), lockedUntil: new BN(0), eligible: false };
  return {
    ...none,
    ...(voter ?? {}),
    amount: stake?.amount ?? new BN(0),
    locked: stake?.locked ?? new BN(0),
    stakeLockedUntil: stake?.lockedUntil ?? new BN(0),
    hasVoter: Boolean(voter),
  };
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

/**
 * The cluster's clock (unix seconds), which proposal timing is measured
 * against: the Clock sysvar the programs read (unix_timestamp, the i64 at
 * byte 32, after slot, epoch_start_timestamp, epoch and
 * leader_schedule_epoch). Asking getBlockTime for the newest slot fails
 * while the RPC hasn't stored that block yet ("Block not available").
 */
export async function clusterNow(network) {
  const info = await network.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  if (info?.data?.length >= 40) return Number(Buffer.from(info.data).readBigInt64LE(32));
  return Math.floor(Date.now() / 1000);
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

/** A pool's price as the program keeps it: quote per base in raw units, ×1e12 (decision-markets PRICE_SCALE). */
export function rawPrice(pool) {
  const base = big(pool.base);
  return base === 0n ? 0n : (big(pool.quote) * 1_000_000_000_000n) / base;
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
// members: staking (vortex-stake, shared by every model)
// ---------------------------------------------------------------

async function stakeAccounts(network, member, dao, pool) {
  const p = await readStakePool(network, pool);
  if (!p) throw userError("This DAO has no stake pool for that token.");
  const st = stakeAddresses(network, dao);
  return {
    owner: member.publicKey,
    pool,
    stake: st.stakeOf(pool, member.publicKey),
    ownerTokenAccount: tokenAccount(p.mint, member.publicKey, p.tokenProgram),
    vault: p.vault,
    mint: p.mint,
    tokenProgram: p.tokenProgram,
  };
}

/**
 * Stakes `raw` DAO tokens from the member's wallet in the DAO's current
 * pool. Every token model reads it, so it stays put through switches.
 * (`model` and `governance` are unused; kept so callers read as before.)
 */
export async function deposit(network, model, member, d, governance, raw) {
  if (!d.stakePool) throw userError("This DAO has no token to stake.");
  const accounts = await stakeAccounts(network, member, d.dao, d.stakePool);
  const ix = await clients(network)
    .stake.methods.stake(bn(raw))
    .accountsStrict({ ...accounts, daoToken: daoTokenAddress(network, d.dao), systemProgram: SystemProgram.programId })
    .instruction();
  return send(network, [ix], [member]);
}

/**
 * Takes `raw` back out of a pool of the DAO's: the current one unless
 * `pool` is given (an old token's, after a token change). Only what
 * isn't locked, once the votes it was cast in have ended.
 */
export async function withdraw(network, model, member, d, governance, raw, pool = d.stakePool) {
  if (!pool) throw userError("This DAO has no token to unstake.");
  const accounts = await stakeAccounts(network, member, d.dao, pool);
  const ix = await clients(network).stake.methods.withdraw(bn(raw)).accountsStrict(accounts).instruction();
  return send(network, [ix], [member]);
}

/** The member's stakes in every pool the DAO has had (current first), for /unstake after a token change. */
export async function memberStakes(network, d, owner, mints = []) {
  const st = stakeAddresses(network, d.dao);
  const pools = [...new Set([d.stakePool, ...mints.map((m) => st.poolOf(m))].filter(Boolean).map((p) => p.toBase58()))].map((k) => new PublicKey(k));
  const out = [];
  for (const pool of pools) {
    const s = await readStake(network, d.dao, pool, owner);
    if (s && BigInt(s.amount.toString()) > 0n) out.push({ pool, current: d.stakePool?.equals(pool) ?? false, stake: s, mint: (await readStakePool(network, pool)).mint });
  }
  return out;
}

// ---------------------------------------------------------------
// proposals
// ---------------------------------------------------------------

/** Rent the treasury pays for a recipient's new token account (Token-2022 accounts can be a little larger). */
export async function tokenAccountRent(network) {
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

/**
 * Opens `owner`'s token account for `mint` (paid by the operator) unless it
 * exists. A proposal that would otherwise create it carries ~245 bytes less,
 * which some integrations need to fit a legacy propose transaction. Anyone
 * may open a token account for anyone; only `owner` can use it.
 */
export async function openTokenAccount(network, owner, mint, programId = TOKEN_PROGRAM_ID) {
  const account = tokenAccount(mint, owner, programId);
  if (await network.connection.getAccountInfo(account)) return account;
  const operator = requireOperator();
  await send(network, [createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, account, owner, mint, programId)], [operator]);
  return account;
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

/**
 * Decision markets' token accounts for `owner`, and the shared `tokens`
 * accounts its instructions take. The base side is proposal `p`'s own
 * (the token it was seeded in), or the governance's current one when
 * proposing.
 */
async function marketAccounts(network, d, g, owner, p = null) {
  const baseMint = p?.baseMint ?? g.baseMint;
  const baseVault = p?.baseVault ?? g.baseVault;
  const [base, quote] = await Promise.all([mintInfo(network, baseMint), mintInfo(network, g.quoteMint)]);
  return {
    baseMint,
    ownerBase: tokenAccount(baseMint, owner, base.programId),
    ownerQuote: tokenAccount(g.quoteMint, owner, quote.programId),
    base,
    quote,
    tokens: {
      governance: d.governance,
      baseVault,
      quoteVault: g.quoteVault,
      baseMint,
      quoteMint: g.quoteMint,
      baseTokenProgram: base.programId,
      quoteTokenProgram: quote.programId,
    },
  };
}

/** After a token change: moves new decision-markets proposals onto the DAO's new token. Anyone; the operator pays. */
export async function syncBaseToken(network, d) {
  const operator = requireOperator();
  if (!d.mint) throw userError("This DAO has no token on record.");
  const { programId } = await mintInfo(network, d.mint);
  const ix = await clients(network)
    .decisionMarkets.methods.syncBaseToken()
    .accountsStrict({
      payer: operator.publicKey,
      governance: d.governance,
      hubDao: d.dao,
      daoToken: daoTokenAddress(network, d.dao),
      baseMint: d.mint,
      baseVault: d.baseVault(d.mint),
      baseTokenProgram: programId,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [operator]);
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
  // Token models fix the DAO's current pool on the proposal; the proposer's stake there (if any) meets the threshold.
  const pooled = async () => {
    const stake = d.stakeOf(d.stakePool, member.publicKey);
    const hasStake = Boolean(await network.connection.getAccountInfo(stake));
    return { daoToken: daoTokenAddress(network, d.dao), pool: d.stakePool, proposerStake: hasStake ? stake : null };
  };
  let ix;
  if (VOTING_MODELS.includes(model) || model === "conviction") {
    const accounts = { ...base, ...(await pooled()) };
    if (model === "liquid") {
      // Liquid also reads the proposer's record: delegations to them count toward the threshold.
      const voter = d.voter(member.publicKey);
      accounts.voter = (await network.connection.getAccountInfo(voter)) ? voter : null;
    }
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
      .accountsStrict({
        ...base,
        daoToken: daoTokenAddress(network, d.dao),
        pool: d.stakePool,
        proposerTokenAccount: tokenAccount(g.mint, member.publicKey, tokenProgram),
        escrow: d.escrow(g.mint),
        mint: g.mint,
        tokenProgram,
      })
      .instruction();
  } else if (model === "decisionMarkets") {
    const m = await marketAccounts(network, d, g, member.publicKey);
    ix = await program.methods
      .propose(new BN(id), description, instructions, bn(seeds.base), bn(seeds.quote))
      .accountsStrict({ ...base, daoToken: daoTokenAddress(network, d.dao), proposerBase: m.ownerBase, proposerQuote: m.ownerQuote, tokens: m.tokens })
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
  const owner = member.publicKey;
  if (COUNCIL_MODELS.includes(model)) {
    const ix = await program.methods.castVote({ [choice]: {} }).accountsStrict({ member: owner, governance: d.governance, proposal }).instruction();
    return send(network, [ix], [member]);
  }
  // Votes count the stake in the pool the proposal was made with, and hold it until the vote ends.
  const p = await readProposal(network, model, proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const staked = { hubDao: d.dao, pool: p.pool, stake: d.stakeOf(p.pool, owner), stakeProgram: network.programs.stake };
  if (model === "liquid") {
    const voter = await readVoter(network, model, d.voter(owner));
    const delegated = voter && !voter.delegate.equals(PublicKey.default) ? voter.delegate : null;
    const ix = delegated
      ? await program.methods
          .overrideVote({ [choice]: {} })
          .accountsStrict({
            owner,
            governance: d.governance,
            proposal,
            ...staked,
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
          .accountsStrict({
            owner,
            governance: d.governance,
            proposal,
            ...staked,
            voter: d.voter(owner),
            overrides: d.override(proposal, owner),
            voteRecord: d.vote(proposal, owner),
            systemProgram: SystemProgram.programId,
          })
          .instruction();
    return send(network, [ix], [member]);
  }
  const ix = await program.methods
    .castVote({ [choice]: {} })
    .accountsStrict({ owner, governance: d.governance, proposal, ...staked, voteRecord: d.vote(proposal, owner), systemProgram: SystemProgram.programId })
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
  // The bond is in the token the proposal was made with.
  const mint = p.mint;
  const { programId: tokenProgram } = await mintInfo(network, mint);
  const treasuryAta = tokenAccount(mint, d.treasury, tokenProgram);
  const challengerAta = tokenAccount(mint, p.challenger, tokenProgram);
  const ix = await program.methods
    .finalizeChallenge()
    .accountsStrict({ governance: d.governance, proposal, bondVault: d.bondVault(mint), treasuryTokenAccount: treasuryAta, challengerTokenAccount: challengerAta, mint, tokenProgram })
    .instruction();
  return send(
    network,
    [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, treasuryAta, d.treasury, mint, tokenProgram),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, challengerAta, p.challenger, mint, tokenProgram),
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
  if (d.record.council) {
    // With a security council on, a passed proposal waits for it instead of running.
    const ix = await clients(network)
      .hub.methods.submitToCouncil()
      .accountsStrict({ payer: operator.publicKey, dao: d.dao, executor: d.executor, governanceProgram: d.gp, governance: d.governance, proposal, waiting: d.waiting(proposal), systemProgram: SystemProgram.programId })
      .instruction();
    const signature = await send(network, [ix], [operator]);
    return Object.assign(new String(signature), { awaitingCouncil: true });
  }
  const ix = await clients(network)
    .hub.methods.execute()
    .accountsStrict({ dao: d.dao, executor: d.executor, governanceProgram: d.gp, governance: d.governance, proposal })
    .remainingAccounts(remainingFor(p.core.instructions))
    .instruction();
  return send(network, [ix], [operator], { computeUnits: 400_000 });
}

/** Every account a proposal's stored instructions use, and the programs they call (the treasury signs inside the hub). */
function remainingFor(instructions) {
  const remaining = [];
  for (const ix of instructions) {
    for (const m of ix.accounts) remaining.push({ pubkey: m.pubkey, isSigner: false, isWritable: m.isWritable });
    remaining.push({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  return remaining;
}

// ---------------------------------------------------------------
// the security council (on the hub's DAO record)
// ---------------------------------------------------------------

/** The hub's record of a proposal waiting for the council, or null. */
export async function readWaiting(network, d, proposal) {
  return clients(network).hub.account.waiting.fetchNullable(d.waiting(proposal));
}

/** A council signer confirms (or rejects) proposal `id` of the running model. */
export async function councilVote(network, signer, d, id, confirm = true) {
  const proposal = d.proposal(id);
  const method = confirm ? "councilConfirm" : "councilReject";
  const ix = await clients(network).hub.methods[method]().accountsStrict({ signer: signer.publicKey, dao: d.dao, waiting: d.waiting(proposal) }).instruction();
  return send(network, [ix], [signer]);
}

/** Runs a proposal the council confirmed (or a signer replacement after their tenure). Anyone; the operator pays. */
export async function runConfirmed(network, d, model, id) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const p = await readProposal(network, model, proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const ix = await clients(network)
    .hub.methods.runConfirmed()
    .accountsStrict({ dao: d.dao, waiting: d.waiting(proposal), proposal })
    .remainingAccounts(remainingFor(p.core.instructions))
    .instruction();
  return send(network, [ix], [operator], { computeUnits: 400_000 });
}

/** The hub's set_council, for the treasury to sign inside a proposal (turns it on, or replaces the signers). */
export async function setCouncilIx(network, d, signers, required, tenureSeconds) {
  return stored(await clients(network).hub.methods.setCouncil(signers, required, new BN(tenureSeconds)).accountsStrict({ treasury: d.treasury, dao: d.dao }).instruction());
}

/** The hub's clear_council (turns it off; the council itself must confirm the proposal). */
export async function clearCouncilIx(network, d) {
  return stored(await clients(network).hub.methods.clearCouncil().accountsStrict({ treasury: d.treasury, dao: d.dao }).instruction());
}

// ---------------------------------------------------------------
// optimistic: challenges
// ---------------------------------------------------------------

/** Challenges proposal `id`, posting the DAO's bond from the member's wallet. */
export async function challenge(network, member, d, governance, id) {
  const proposal = d.proposal(id);
  const p = await readProposal(network, "optimistic", proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const mint = p.mint;
  const { programId: tokenProgram } = await mintInfo(network, mint);
  const ix = await clients(network)
    .optimistic.methods.challenge()
    .accountsStrict({
      challenger: member.publicKey,
      governance: d.governance,
      proposal,
      challengerTokenAccount: tokenAccount(mint, member.publicKey, tokenProgram),
      bondVault: d.bondVault(mint),
      mint,
      tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Returns the bond of a cancelled, challenged proposal to its challenger. Anyone; the operator pays. */
export async function reclaimBond(network, d, governance, id, challenger) {
  const operator = requireOperator();
  const proposal = d.proposal(id);
  const p = await readProposal(network, "optimistic", proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const mint = p.mint;
  const { programId: tokenProgram } = await mintInfo(network, mint);
  const to = tokenAccount(mint, challenger, tokenProgram);
  const ix = await clients(network)
    .optimistic.methods.reclaimBond()
    .accountsStrict({ governance: d.governance, proposal, bondVault: d.bondVault(mint), challengerTokenAccount: to, mint, tokenProgram })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, to, challenger, mint, tokenProgram), ix], [operator]);
}

// ---------------------------------------------------------------
// conviction: support
// ---------------------------------------------------------------

/** Backs proposal `id` with the member's whole deposit (moving their support from another proposal, if any). */
export async function support(network, member, d, id) {
  const owner = member.publicKey;
  const proposal = d.proposal(id);
  const p = await readProposal(network, "conviction", proposal);
  if (!p) throw userError(`There's no proposal #${id}.`);
  const voter = await readVoter(network, "conviction", d.voter(owner));
  const current = voter?.supporting;
  const previous = current && !current.equals(PublicKey.default) && !current.equals(proposal) ? current : null;
  // Support locks the stake (with the member's signature) in the pool the proposal was made with.
  const ix = await clients(network)
    .conviction.methods.support()
    .accountsStrict({
      owner,
      governance: d.governance,
      hubDao: d.dao,
      voter: d.voter(owner),
      proposal,
      previous,
      pool: p.pool,
      stake: d.stakeOf(p.pool, owner),
      lock: d.lockOf(p.pool, owner, d.governance),
      stakeProgram: network.programs.stake,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Stops backing the member's current proposal, releasing its lock on their stake. */
export async function withdrawSupport(network, member, d, supporting) {
  const owner = member.publicKey;
  const voter = await readVoter(network, "conviction", d.voter(owner));
  const pool = voter?.supportPool ?? d.stakePool;
  const ix = await clients(network)
    .conviction.methods.withdrawSupport()
    .accountsStrict({
      owner,
      governance: d.governance,
      voter: d.voter(owner),
      proposal: supporting,
      stake: d.stakeOf(pool, owner),
      lock: d.lockOf(pool, owner, d.governance),
      stakeProgram: network.programs.stake,
    })
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
    .accountsStrict({ payer: operator.publicKey, governance: d.governance, hubDao: d.dao, daoToken: daoTokenAddress(network, d.dao), pool: d.stakePool, election: d.election(id), systemProgram: SystemProgram.programId })
    .instruction();
  await send(network, [ix], [operator]);
  return id;
}

/** An election's pool (the one current when it started): candidacy and ballots read stake there. */
async function electionPool(network, d, election) {
  const e = await readElection(network, election);
  if (!e) throw userError("There's no such election.");
  return e.pool;
}

export async function declareCandidacy(network, member, d, electionId) {
  const election = d.election(electionId);
  const pool = await electionPool(network, d, election);
  const ix = await clients(network)
    .delegate.methods.declareCandidacy()
    .accountsStrict({ candidate: member.publicKey, governance: d.governance, hubDao: d.dao, election, pool, stake: d.stakeOf(pool, member.publicKey), stakeProgram: network.programs.stake })
    .instruction();
  return send(network, [ix], [member]);
}

export async function voteInElection(network, member, d, electionId, candidates) {
  const election = d.election(electionId);
  const pool = await electionPool(network, d, election);
  const ix = await clients(network)
    .delegate.methods.voteInElection(candidates)
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      hubDao: d.dao,
      election,
      pool,
      stake: d.stakeOf(pool, member.publicKey),
      stakeProgram: network.programs.stake,
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
    .accountsStrict({
      initiator: member.publicKey,
      governance: d.governance,
      hubDao: d.dao,
      daoToken: daoTokenAddress(network, d.dao),
      pool: d.stakePool,
      stake: d.stakeOf(d.stakePool, member.publicKey),
      recall: d.recall(id),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  await send(network, [ix], [member]);
  return id;
}

export async function voteRecall(network, member, d, recallId, choice) {
  const recall = d.recall(recallId);
  const r = await readRecall(network, recall);
  if (!r) throw userError(`There's no recall #${recallId}.`);
  const ix = await clients(network)
    .delegate.methods.voteRecall({ [choice]: {} })
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      hubDao: d.dao,
      recall,
      pool: r.pool,
      stake: d.stakeOf(r.pool, member.publicKey),
      stakeProgram: network.programs.stake,
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

/** Delegates the member's unlocked stake to `to`, locking it while delegated (one hop: `to` can't have delegated themselves). */
export async function delegateTo(network, member, d, to) {
  const owner = member.publicKey;
  const ix = await clients(network)
    .liquid.methods.delegate(to)
    .accountsStrict({
      owner,
      governance: d.governance,
      hubDao: d.dao,
      daoToken: daoTokenAddress(network, d.dao),
      pool: d.stakePool,
      stake: d.stakeOf(d.stakePool, owner),
      lock: d.lockOf(d.stakePool, owner, d.governance),
      voter: d.voter(owner),
      delegateVoter: d.voter(to),
      stakeProgram: network.programs.stake,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Takes the delegation back and releases the stake it locked. */
export async function undelegate(network, member, d, delegate) {
  const owner = member.publicKey;
  const voter = await readVoter(network, "liquid", d.voter(owner));
  const pool = voter?.pool ?? d.stakePool;
  const ix = await clients(network)
    .liquid.methods.undelegate()
    .accountsStrict({
      owner,
      governance: d.governance,
      voter: d.voter(owner),
      delegateVoter: d.voter(delegate),
      stake: d.stakeOf(pool, owner),
      lock: d.lockOf(pool, owner, d.governance),
      stakeProgram: network.programs.stake,
    })
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
  return clients(network).sortition.account.drawPool.fetchNullable(d.pool);
}

/** The open draw's randomness request: "missing", "pending" or "fulfilled". */
export async function drawStatus(network, g) {
  const info = await network.connection.getAccountInfo(oraoRequest(g.drawSeed));
  if (!info || !info.owner.equals(ORAO_VRF) || info.data.length < 9 || !info.data.subarray(0, 8).equals(ORAO_RANDOMNESS_V2)) return "missing";
  return info.data[8] === 1 ? "fulfilled" : "pending";
}

/** Joins the draw pool, locking the eligibility threshold of the member's stake (they sign). */
export async function joinPool(network, member, d) {
  const owner = member.publicKey;
  const ix = await clients(network)
    .sortition.methods.joinPool()
    .accountsStrict({
      owner,
      governance: d.governance,
      hubDao: d.dao,
      pool: d.pool,
      voter: d.voter(owner),
      daoToken: daoTokenAddress(network, d.dao),
      stakePool: d.stakePool,
      stake: d.stakeOf(d.stakePool, owner),
      lock: d.lockOf(d.stakePool, owner, d.governance),
      stakeProgram: network.programs.stake,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Leaves the draw pool, releasing what joining locked. */
export async function leavePool(network, member, d) {
  const owner = member.publicKey;
  const voter = await readVoter(network, "sortition", d.voter(owner));
  const pool = voter?.stakePool ?? d.stakePool;
  const locked = voter && BigInt(voter.locked.toString()) > 0n;
  const ix = await clients(network)
    .sortition.methods.leavePool()
    .accountsStrict({
      owner,
      governance: d.governance,
      pool: d.pool,
      voter: d.voter(owner),
      stake: d.stakeOf(pool, owner),
      lock: locked ? d.lockOf(pool, owner, d.governance) : null,
      stakeProgram: network.programs.stake,
    })
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
/** The proposal's pool, and the member's stake in it, for a sowellian stake-weighted vote. */
async function sowellianStake(network, d, proposal, owner) {
  const p = await readProposal(network, "sowellian", proposal);
  if (!p) throw userError("There's no such proposal.");
  return { hubDao: d.dao, pool: p.pool, stake: d.stakeOf(p.pool, owner), stakeProgram: network.programs.stake };
}

export async function approvalVote(network, member, d, id, choice) {
  const proposal = d.proposal(id);
  const owner = member.publicKey;
  const ix = await clients(network)
    .sowellian.methods.castApprovalVote({ [choice]: {} })
    .accountsStrict({ owner, governance: d.governance, proposal, ...(await sowellianStake(network, d, proposal, owner)), voteRecord: d.approvalVote(proposal, owner), systemProgram: SystemProgram.programId })
    .instruction();
  return send(network, [ix], [member]);
}

/** The adjudication vote on a challenged resolution ("success" | "failure"). */
export async function adjudicationVote(network, member, d, id, outcome) {
  const proposal = d.proposal(id);
  const owner = member.publicKey;
  const ix = await clients(network)
    .sowellian.methods.castAdjudicationVote({ [outcome]: {} })
    .accountsStrict({ owner, governance: d.governance, proposal, ...(await sowellianStake(network, d, proposal, owner)), voteRecord: d.adjudicationVote(proposal, owner), systemProgram: SystemProgram.programId })
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

/** A sowellian proposal's token accounts: its own token (the one it was made with) and escrow. */
async function sowellianTokenAccounts(network, d, id, owner) {
  const p = await readProposal(network, "sowellian", d.proposal(id));
  if (!p) throw userError(`There's no proposal #${id}.`);
  const { programId: tokenProgram } = await mintInfo(network, p.mint);
  return { ownerTokenAccount: tokenAccount(p.mint, owner, tokenProgram), escrow: d.escrow(p.mint), mint: p.mint, tokenProgram, pool: p.pool };
}
const withoutPool = ({ pool, ...rest }) => rest;

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
      ...withoutPool(await sowellianTokenAccounts(network, d, id, member.publicKey)),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/** Human track: states the outcome ("success" | "failure"), posting the resolution bond. */
export async function proposeResolution(network, member, d, g, id, outcome) {
  const ix = await clients(network)
    .sowellian.methods.proposeResolution({ [outcome]: {} })
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal: d.proposal(id), ...(await sowellianTokenAccounts(network, d, id, member.publicKey)) })
    .instruction();
  return send(network, [ix], [member]);
}

/** Disputes a proposed resolution, posting the challenge bond; opens the adjudication vote. */
export async function challengeResolution(network, member, d, g, id) {
  const ix = await clients(network)
    .sowellian.methods.challengeResolution()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal: d.proposal(id), ...(await sowellianTokenAccounts(network, d, id, member.publicKey)) })
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
  const t = withoutPool(await sowellianTokenAccounts(network, d, id, member.publicKey));
  const ix = await clients(network)
    .sowellian.methods.claimPosition()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, position: d.position(proposal, member.publicKey), ...t })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, t.ownerTokenAccount, member.publicKey, t.mint, t.tokenProgram), ix], [member]);
}

/** Takes back the bonds owed to the member on this proposal (as proposer, resolver or challenger). */
export async function claimBond(network, member, d, g, id) {
  const t = withoutPool(await sowellianTokenAccounts(network, d, id, member.publicKey));
  const ix = await clients(network)
    .sowellian.methods.claimBond()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal: d.proposal(id), ...t })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(member.publicKey, t.ownerTokenAccount, member.publicKey, t.mint, t.tokenProgram), ix], [member]);
}

/** Sends a proposal's forfeited bonds to the treasury's token account. Anyone; the operator pays. */
export async function sweepToTreasury(network, d, g, id) {
  const operator = requireOperator();
  const t = await sowellianTokenAccounts(network, d, id, operator.publicKey);
  const to = tokenAccount(t.mint, d.treasury, t.tokenProgram);
  const ix = await clients(network)
    .sowellian.methods.sweepToTreasury()
    .accountsStrict({ governance: d.governance, proposal: d.proposal(id), treasuryTokenAccount: to, escrow: t.escrow, mint: t.mint, tokenProgram: t.tokenProgram })
    .instruction();
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, to, d.treasury, t.mint, t.tokenProgram), ix], [operator]);
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
  const pre = [createAssociatedTokenAccountIdempotentInstruction(owner, m.ownerBase, owner, m.baseMint, m.base.programId)];
  if (sol) pre.push(...(wrap > 0n ? wrapSolIxs(owner, wrap) : [createAssociatedTokenAccountIdempotentInstruction(owner, m.ownerQuote, owner, NATIVE_MINT)]));
  else pre.push(createAssociatedTokenAccountIdempotentInstruction(owner, m.ownerQuote, owner, g.quoteMint, m.quote.programId));
  return send(network, [...pre, ix, ...(sol ? [unwrapSolIx(owner)] : [])], [member]);
}

/** Splits `base` DAO tokens and `quote` quote tokens (raw; SOL is wrapped for it) into equal pass and fail balances. */
export async function split(network, member, d, g, id, base, quote) {
  const proposal = d.proposal(id);
  const m = await marketAccounts(network, d, g, member.publicKey, await readProposal(network, "decisionMarkets", proposal));
  const ix = await clients(network)
    .decisionMarkets.methods.split(bn(base), bn(quote))
    .accountsStrict({ owner: member.publicKey, proposal, position: d.position(proposal, member.publicKey), ownerBase: m.ownerBase, ownerQuote: m.ownerQuote, tokens: m.tokens, systemProgram: SystemProgram.programId })
    .instruction();
  return sendMarketIx(network, member, g, m, ix, BigInt(quote));
}

/** Merges pairs of pass and fail balances back into the underlying, while trading lasts. */
export async function merge(network, member, d, g, id, base, quote) {
  const proposal = d.proposal(id);
  const m = await marketAccounts(network, d, g, member.publicKey, await readProposal(network, "decisionMarkets", proposal));
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
  const m = await marketAccounts(network, d, g, member.publicKey, await readProposal(network, "decisionMarkets", proposal));
  const ix = await clients(network)
    .decisionMarkets.methods.redeem()
    .accountsStrict({ owner: member.publicKey, governance: d.governance, proposal, position: d.position(proposal, member.publicKey), ownerBase: m.ownerBase, ownerQuote: m.ownerQuote, tokens: m.tokens })
    .instruction();
  return sendMarketIx(network, member, g, m, ix);
}

/** The proposer takes back what's left in the winning pool (their seed plus fees, after trades). */
export async function reclaimLiquidity(network, member, d, g, id) {
  const m = await marketAccounts(network, d, g, member.publicKey, await readProposal(network, "decisionMarkets", d.proposal(id)));
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
  const newGovernance = governanceAddress(d.dao, next, d.record.epoch + 1);
  const ix = await clients(network).hub.methods.applySwitch().accountsStrict({ dao: d.dao, model: modelPda(network, next), newGovernance }).instruction();
  return send(network, [ix], [operator]);
}

// ---------------------------------------------------------------
// token changes: new pools and the converter (vortex-stake)
// ---------------------------------------------------------------

/**
 * vortex-stake's open_converter, for the treasury to sign inside a proposal: `rateNum` new tokens per `rateDen` old,
 * into the current pool, funded with `fund` raw new tokens from the treasury in the same instruction (0n: none).
 */
export async function openConverterIx(network, d, fromMint, toMint, rateNum, rateDen, fund = 0n, tokenProgram) {
  const fromPool = d.poolOf(fromMint);
  const toPool = d.poolOf(toMint);
  const converter = d.converter(fromPool, toPool);
  tokenProgram ??= (await mintInfo(network, toMint)).programId;
  return stored(
    await clients(network)
      .stake.methods.openConverter(bn(rateNum), bn(rateDen), bn(fund))
      .accountsStrict({
        treasury: d.treasury,
        hubDao: d.dao,
        daoToken: daoTokenAddress(network, d.dao),
        fromPool,
        toPool,
        mint: toMint,
        converter,
        converterVault: d.converterVault(converter),
        treasuryAccount: fund > 0n ? tokenAccount(toMint, d.treasury, tokenProgram) : null,
        tokenProgram,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
  );
}

/** A treasury transfer of `raw` new tokens into a converter's vault (topping it up), for a proposal. */
export async function fundConverterIx(network, d, fromMint, toMint, raw, known) {
  const converter = d.converter(d.poolOf(fromMint), d.poolOf(toMint));
  const { decimals, programId } = known ?? (await mintInfo(network, toMint));
  return stored(createTransferCheckedInstruction(tokenAccount(toMint, d.treasury, programId), toMint, d.converterVault(converter), d.treasury, raw, decimals, [], programId));
}

/** vortex-stake's close_converter (what's left goes back to the treasury), for a proposal. */
export async function closeConverterIx(network, d, fromMint, toMint) {
  const converter = d.converter(d.poolOf(fromMint), d.poolOf(toMint));
  const { programId } = await mintInfo(network, toMint);
  return stored(
    await clients(network)
      .stake.methods.closeConverter()
      .accountsStrict({ treasury: d.treasury, converter, converterVault: d.converterVault(converter), treasuryAccount: tokenAccount(toMint, d.treasury, programId), mint: toMint, tokenProgram: programId })
      .instruction()
  );
}

/** The converter from `fromMint`'s pool into `toMint`'s, with its funding, or null. */
export async function readConverter(network, d, fromMint, toMint) {
  const address = d.converter(d.poolOf(fromMint), d.poolOf(toMint));
  const c = await clients(network).stake.account.converter.fetchNullable(address);
  if (!c) return null;
  const funded = await network.connection.getTokenAccountBalance(c.vault).catch(() => null);
  return { ...c, address, funded: funded ? BigInt(funded.value.amount) : 0n };
}

/** A member converts `raw` of their old stake (in `fromMint`'s pool) into stake in the current pool, at the converter's rate. */
export async function convert(network, member, d, fromMint, raw) {
  const owner = member.publicKey;
  const fromPool = d.poolOf(fromMint);
  const toPool = d.stakePool;
  const [from, to] = await Promise.all([readStakePool(network, fromPool), readStakePool(network, toPool)]);
  if (!from || !to) throw userError("This DAO has no such pool.");
  const converter = d.converter(fromPool, toPool);
  const treasuryFrom = tokenAccount(from.mint, d.treasury, from.tokenProgram);
  const ix = await clients(network)
    .stake.methods.convert(bn(raw))
    .accountsStrict({
      owner,
      converter,
      converterVault: d.converterVault(converter),
      fromPool,
      fromStake: d.stakeOf(fromPool, owner),
      fromVault: from.vault,
      fromMint: from.mint,
      treasuryFromAccount: treasuryFrom,
      toPool,
      toStake: d.stakeOf(toPool, owner),
      toVault: to.vault,
      toMint: to.mint,
      fromTokenProgram: from.tokenProgram,
      toTokenProgram: to.tokenProgram,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  // The treasury's account for the old token receives what's converted.
  return send(network, [createAssociatedTokenAccountIdempotentInstruction(owner, treasuryFrom, d.treasury, from.mint, from.tokenProgram), ix], [member]);
}

/**
 * A new token for a DAO to move to: the operator creates the mint, mints
 * `initialSupply` to the treasury, and hands the mint authority to the
 * treasury, so only a passed proposal can mint more. Nothing changes for
 * the DAO until a proposal records it (/settoken).
 */
export async function createTokenForTreasury(network, d, initialSupply, mint = Keypair.generate()) {
  const operator = requireOperator();
  const conn = network.connection;
  const treasuryAta = getAssociatedTokenAddressSync(mint.publicKey, d.treasury, true);
  const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  await send(
    network,
    [
      SystemProgram.createAccount({ fromPubkey: operator.publicKey, newAccountPubkey: mint.publicKey, lamports: rent, space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(mint.publicKey, TOKEN_DECIMALS, operator.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, treasuryAta, d.treasury, mint.publicKey),
      createMintToInstruction(mint.publicKey, treasuryAta, operator.publicKey, BigInt(initialSupply) * TEN_POW),
      createSetAuthorityInstruction(mint.publicKey, operator.publicKey, AuthorityType.MintTokens, d.treasury),
    ],
    [operator, mint]
  );
  return mint.publicKey;
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
