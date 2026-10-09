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
 * execution) and the governance programs that decide. Instructions are
 * built from the programs' own IDLs (src/solana/idl, copied from the
 * Vortexes repo), so no byte layout is written by hand here.
 *
 * Every write is signed by whoever must sign it on-chain (the member for
 * deposits, proposals and votes; the operator for creating DAOs and for
 * the permissionless queue/execute) and paid for by the first signer.
 */

/** Token decimals for DAO tokens the bot creates. */
export const TOKEN_DECIMALS = 6;
const TEN_POW = 10n ** BigInt(TOKEN_DECIMALS);

const MODEL_BY_KEY = { tokenWeighted: "tokenWeighted", board: "board" };

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

const seed = (s) => Buffer.from(s);
const u64le = (n) => new BN(n).toArrayLike(Buffer, "le", 8);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

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
    voter: (owner) => pda([seed("voter"), governance.toBuffer(), owner.toBuffer()], gp),
    proposal: (id) => pda([seed("proposal"), governance.toBuffer(), u64le(id)], gp),
    vote: (proposal, owner) => pda([seed("vote"), proposal.toBuffer(), owner.toBuffer()], gp),
  };
}

export function modelProgram(network, model) {
  const gp = network.programs[MODEL_BY_KEY[model]];
  if (!gp) throw new Error(`${model} isn't available on Solana yet`);
  return gp;
}

/** Which model a governance program ID is, or null. */
export function modelOf(network, programId) {
  return Object.keys(MODEL_BY_KEY).find((m) => network.programs[m].equals(programId)) ?? null;
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
    return Object.assign(new Error(`Not enough SOL: ${lamports.replace(/^.*Transfer: /, "")}. A treasury paying tokens also pays a little rent (~0.002 SOL) for a recipient's new token account.`), { userFacing: true, code: "InsufficientLamports" });
  }
  const hex = text.match(/custom program error: (0x[0-9a-f]+)/i);
  if (hex) {
    const code = parseInt(hex[1], 16);
    const gov = GOV_ERRORS[String(code)];
    if (gov) return Object.assign(new Error(`${gov.msg} (${gov.name})`), { userFacing: true, code: gov.name });
    if (logs.some((l) => /Error: insufficient funds/i.test(l))) {
      return Object.assign(new Error("Not enough tokens for that."), { userFacing: true, code: "InsufficientFunds" });
    }
    const anchorLine = logs.find((l) => l.includes("Error Message:"));
    if (anchorLine) return Object.assign(new Error(anchorLine.split("Error Message:")[1].trim()), { userFacing: true });
    return Object.assign(new Error(`Program error ${code}`), { userFacing: true });
  }
  return err;
}

function requireOperator() {
  const op = getSolanaOperator();
  if (!op) throw Object.assign(new Error("This bot has no Solana operator wallet yet - ask an admin to set SOLANA_OPERATOR_KEY."), { userFacing: true });
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

// ---------------------------------------------------------------
// rules
// ---------------------------------------------------------------

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Token-weighted rules: the bot's EVM defaults (10% quorum, 60% approval, ~5.6h vote, 1-day timelock, 7 days to run). */
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

/** Board rules: a majority of signers, 1-day timelock, 7 days to run (as on EVM). */
export function boardConfig(network, signerCount) {
  const fast = network.fastTimings;
  return {
    requiredApprovals: Math.ceil((signerCount + 1) / 2),
    timelock: fast ? 30 : DAY,
    executionPeriod: fast ? DAY : 7 * DAY,
  };
}

// ---------------------------------------------------------------
// creating DAOs (operator)
// ---------------------------------------------------------------

async function createDaoIx(network, creator, createKey, name, gp) {
  const { hub } = clients(network);
  const dao = pda([seed("dao"), createKey.toBuffer()], network.programs.hub);
  const ix = await hub.methods
    .createDao(name, gp)
    .accountsStrict({
      creator,
      createKey,
      model: pda([seed("model"), gp.toBuffer()], network.programs.hub),
      dao,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return { dao, ix };
}

/**
 * A token-weighted DAO with a new token: mints `initialSupply` to the
 * operator (handed out with /tip, as on EVM), creates the DAO in the hub
 * with its rules, then makes the treasury the token's mint authority, so
 * new tokens can only ever be minted by a passed proposal.
 */
export async function createTokenDao(network, { name, initialSupply }) {
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

  const gp = network.programs.tokenWeighted;
  const createKey = Keypair.generate();
  const { dao, ix: create } = await createDaoIx(network, operator.publicKey, createKey.publicKey, name, gp);
  const a = addresses(network, dao, gp);
  const init = await clients(network)
    .tokenWeighted.methods.initGovernance(votingConfig(network))
    .accountsStrict({
      authority: operator.publicKey,
      payer: operator.publicKey,
      hubDao: dao,
      governance: a.governance,
      mint: mint.publicKey,
      vault: a.vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
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
  const init = await clients(network)
    .board.methods.initGovernance(signers, boardConfig(network, signers.length))
    .accountsStrict({ authority: operator.publicKey, payer: operator.publicKey, hubDao: dao, governance: a.governance, systemProgram: SystemProgram.programId })
    .instruction();
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

/** The cluster's clock (unix seconds), which proposal timing is measured against. */
export async function clusterNow(network) {
  const slot = await network.connection.getSlot("confirmed");
  return (await network.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

const toNum = (bn) => (typeof bn === "number" ? bn : Number(bn.toString()));
const big = (bn) => BigInt(bn.toString());

/** Token-weighted proposal state, as vortex-core computes it. */
export function tokenWeightedState(p, config, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  const starts = toNum(p.votingStartsAt);
  const ends = toNum(p.votingEndsAt);
  if (now < starts) return "Pending";
  if (now < ends) return "Active";
  if (!tokenWeightedPassed(p, config)) return "Defeated";
  const queued = toNum(p.queuedAt);
  if (queued === 0) return "Succeeded";
  if (now > queued + config.timelock + config.executionPeriod) return "Expired";
  return "Queued";
}

/** Quorum (for + against + abstain >= quorum share of deposits when proposed) and approval (for / (for + against)). */
export function tokenWeightedPassed(p, config) {
  const t = p.tally;
  const [f, a, ab] = [big(t.forVotes), big(t.againstVotes), big(t.abstainVotes)];
  const quorum = (big(p.quorumBase) * BigInt(config.quorumBps)) / 10_000n;
  const counted = f + a;
  const approval = counted === 0n ? 0n : (f * 10_000n) / counted;
  return f + a + ab >= quorum && approval >= BigInt(config.approvalBps);
}

/** Board proposal state. */
export function boardState(p, config, now) {
  if (p.cancelled) return "Cancelled";
  if (p.executed) return "Executed";
  const queued = toNum(p.queuedAt);
  if (queued === 0) return "Active";
  if (now > queued + config.timelock + config.executionPeriod) return "Expired";
  return "Queued";
}

/** Raw token units -> "1,234.5" (6 decimals). */
export function formatTokens(raw) {
  const v = big(raw);
  const whole = v / TEN_POW;
  const frac = (v % TEN_POW).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

/** "12.5" whole tokens -> raw units, refusing more than 6 decimals. */
export function parseTokens(text) {
  return parseUnits(text, TOKEN_DECIMALS);
}

/** "0.25" -> raw units at `decimals` (9 for SOL); refuses more decimals than that, and zero. */
export function parseUnits(text, decimals) {
  const m = String(text).match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));
  if (!m) throw Object.assign(new Error(`"${text}" isn't an amount (up to ${decimals} decimals).`), { userFacing: true });
  const raw = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || 0);
  if (raw === 0n) throw Object.assign(new Error("The amount must be more than zero."), { userFacing: true });
  return raw;
}

/** Raw units at `decimals` -> "1,234.5". */
export function formatUnits(raw, decimals) {
  const v = big(raw);
  const unit = 10n ** BigInt(decimals);
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(v / unit).toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

// ---------------------------------------------------------------
// members
// ---------------------------------------------------------------

/** Deposits `raw` DAO tokens from the member's wallet into the DAO's vault (token-weighted). */
export async function deposit(network, member, d, governance, raw) {
  const ix = await clients(network)
    .tokenWeighted.methods.deposit(new BN(raw.toString()))
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      voter: d.voter(member.publicKey),
      ownerTokenAccount: getAssociatedTokenAddressSync(governance.mint, member.publicKey),
      vault: d.vault,
      mint: governance.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return send(network, [ix], [member]);
}

export async function withdraw(network, member, d, governance, raw) {
  const ix = await clients(network)
    .tokenWeighted.methods.withdraw(new BN(raw.toString()))
    .accountsStrict({
      owner: member.publicKey,
      governance: d.governance,
      voter: d.voter(member.publicKey),
      ownerTokenAccount: getAssociatedTokenAddressSync(governance.mint, member.publicKey),
      vault: d.vault,
      mint: governance.mint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return send(network, [ix], [member]);
}

/**
 * What a payment proposal runs: SOL from the treasury, or tokens from the
 * treasury's token account (creating the recipient's, paid by the
 * treasury, if they have none).
 */
export async function paymentInstructions(network, d, { recipient, raw, mint }) {
  if (!mint) {
    const exists = await network.connection.getAccountInfo(recipient);
    if (!exists) {
      const min = await network.connection.getMinimumBalanceForRentExemption(0);
      if (raw < BigInt(min)) {
        throw Object.assign(new Error(`A new Solana account needs at least ${min / 1e9} SOL to exist, so pay at least that much.`), { userFacing: true });
      }
    }
    return [stored(SystemProgram.transfer({ fromPubkey: d.treasury, toPubkey: recipient, lamports: raw }))];
  }
  const from = getAssociatedTokenAddressSync(mint, d.treasury, true);
  const to = getAssociatedTokenAddressSync(mint, recipient, true);
  const { decimals } = await getMint(network.connection, mint);
  return [
    stored(createAssociatedTokenAccountIdempotentInstruction(d.treasury, to, recipient, mint)),
    stored(createTransferCheckedInstruction(from, mint, to, d.treasury, raw, decimals)),
  ];
}

/** Makes the next proposal; returns { id, proposal, signature }. */
export async function propose(network, member, d, model, instructions, description) {
  const g = await readGovernance(network, model, d.governance);
  const id = toNum(g.proposalCount) + 1;
  const proposal = d.proposal(id);
  const program = clients(network)[model];
  let ix;
  if (model === "tokenWeighted") {
    const voter = d.voter(member.publicKey);
    const hasVoter = Boolean(await network.connection.getAccountInfo(voter));
    ix = await program.methods
      .propose(new BN(id), description, instructions)
      .accountsStrict({
        proposer: member.publicKey,
        governance: d.governance,
        hubDao: d.dao,
        voter: hasVoter ? voter : null,
        proposal,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  } else {
    ix = await program.methods
      .propose(new BN(id), description, instructions)
      .accountsStrict({ proposer: member.publicKey, governance: d.governance, hubDao: d.dao, proposal, systemProgram: SystemProgram.programId })
      .instruction();
  }
  const signature = await send(network, [ix], [member]);
  return { id, proposal, signature };
}

export async function vote(network, member, d, id, choice) {
  const proposal = d.proposal(id);
  const ix = await clients(network)
    .tokenWeighted.methods.castVote({ [choice]: {} })
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

/** Queues a passed token-weighted proposal. Anyone may; the operator pays. */
export async function queue(network, d, id) {
  const operator = requireOperator();
  const ix = await clients(network)
    .tokenWeighted.methods.queue()
    .accountsStrict({ governance: d.governance, proposal: d.proposal(id) })
    .instruction();
  return send(network, [ix], [operator]);
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
  if (!p) throw Object.assign(new Error(`There's no proposal #${id}.`), { userFacing: true });
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

/** Sends `raw` DAO tokens from the operator (the creator's /tip) to `recipient`'s token account. */
export async function tipTokens(network, mint, recipient, raw) {
  const operator = requireOperator();
  const from = getAssociatedTokenAddressSync(mint, operator.publicKey);
  const to = getAssociatedTokenAddressSync(mint, recipient, true);
  return send(
    network,
    [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, to, recipient, mint),
      createTransferCheckedInstruction(from, mint, to, operator.publicKey, raw, TOKEN_DECIMALS),
    ],
    [operator]
  );
}

/** Balance of `mint` held by `owner`'s associated token account (0 if none). */
export async function tokenBalance(network, mint, owner) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await network.connection.getTokenAccountBalance(ata).catch(() => null);
  return info ? BigInt(info.value.amount) : 0n;
}
