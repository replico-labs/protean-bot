import { SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, createTransferInstruction } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import { getDepositIxs, getWithdrawIxs, getRedeemIxs, getDepositContext } from "@jup-ag/lend/earn";
import { getOperateIx, getVaultsProgram, getVaultsProgramId, getInitPositionContext, VAULT_T1_TYPE } from "@jup-ag/lend/borrow";
import * as v from "../vortex.js";
import { fail, key, deployment, requireProgram } from "./common.js";

const { BN } = anchor;

/**
 * Jupiter Lend (Earn): the treasury lends a token for interest, holding the
 * market's fToken, and withdraws it later.
 *
 * Instructions come from Jupiter's SDK (@jup-ag/lend/earn: getDepositIxs,
 * getWithdrawIxs, getRedeemIxs), with the treasury as the signer. The
 * SDK's own account set-up and SOL wrapping are left off and done here
 * instead, with idempotent account creation, so execution still works if
 * an account was created in the meantime. SOL is lent as wrapped SOL: it's
 * wrapped before the deposit and unwrapped after a withdrawal.
 *
 * Borrowing (Jupiter Lend's vaults, @jup-ag/lend/borrow): each vault pairs
 * one collateral token with one borrowed token, and a position in it is an
 * NFT; whoever holds the NFT owns the position. A position's number is the
 * vault's next one when it's opened, so a proposal can't open it (anyone
 * opening a position before execution would take the number): the bot
 * opens it when the proposal is made, paid by the operator, and moves the
 * NFT to the treasury in the same transaction. The proposal then adds
 * collateral and borrows, or repays and takes collateral back, with one
 * `operate` instruction (plus any tick or branch accounts it needs, which
 * the SDK works out from the vault's state when the proposal is written:
 * if liquidations or interest move the position across a tick before
 * execution, it fails and should be proposed again).
 *
 * The SDK has Jupiter Lend's mainnet program IDs built in (its "main"
 * market; lending program as in Jupiter's docs, vaults program as the SDK
 * names it), so this is mainnet only. Jupiter's docs also list a devnet
 * lending program, which the SDK doesn't support.
 */

export const protocol = {
  id: "juplend",
  name: "Jupiter Lend",
  // A deposit's stored instructions are 883 bytes (1,466 for SOL), more than a legacy propose transaction holds.
  needsV1Transactions: true,
  deployments: {
    "solana-mainnet": {
      lending: "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
      // Vaults (borrowing), as @jup-ag/lend/borrow's getVaultsProgramId("main") names it; checked against the SDK below.
      vaults: "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi",
      // USDC's mint, as Phoenix's SDK pins it (rise-public rust/ix/src/constants.rs), for the `usdc` shortcut.
      usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    },
  },
};

const MARKET = "main";

/** `sol`, `usdc` or a mint address -> { mint, decimals, programId, isSol, label }. */
async function asset(c, word) {
  const dep = deployment(protocol, c.network);
  const w = String(word ?? "").toLowerCase();
  const mint = w === "sol" ? NATIVE_MINT : w === "usdc" ? dep.usdc : key(word, "the token's mint");
  const { decimals, programId } = await v.mintInfo(c.network, mint);
  return { dep, mint, decimals, programId, isSol: mint.equals(NATIVE_MINT), label: w === "sol" ? "SOL" : w === "usdc" ? "USDC" : `of token \`${mint.toBase58()}\`` };
}

/** The asset's Jupiter Lend market for the treasury, or a refusal if it has none. */
async function market(c, a) {
  await requireProgram(c.network, a.dep.lending, "Jupiter Lend's lending program");
  const context = await getDepositContext({ asset: a.mint, signer: c.d.treasury, connection: c.network.connection, market: MARKET }).catch(() => null);
  if (!context) fail(`Jupiter Lend has no lending market for ${a.label}.`);
  const fToken = await v.mintInfo(c.network, context.fTokenMint);
  return { fTokenMint: context.fTokenMint, fTokenProgram: fToken.programId, fTokenAccount: v.tokenAccount(context.fTokenMint, c.d.treasury, fToken.programId) };
}


// ---- borrowing ----

const POSITION_MINT_OFFSET = 8 + 2 + 4; // Position: discriminator, vault_id (u16), nft_id (u32), position_mint

/** The vaults program, read as the treasury, after checking the SDK names the pinned one. */
async function vaultsProgram(c) {
  const dep = deployment(protocol, c.network);
  if (!getVaultsProgramId(MARKET).equals(dep.vaults)) fail("Jupiter Lend's SDK names another vaults program than the pinned one - refusing until that's re-checked.");
  await requireProgram(c.network, dep.vaults, "Jupiter Lend's vaults program");
  return getVaultsProgram({ connection: c.network.connection, signer: c.d.treasury, market: MARKET });
}

/** The vault lending `debt` against `col` (a standard one: Jupiter's smart vaults aren't supported). */
async function vaultFor(program, col, debt) {
  const configs = await program.account.vaultConfig.all();
  const found = configs.find(({ account: v }) => Number(v.vaultType) === VAULT_T1_TYPE && v.supplyToken.equals(col.mint) && v.borrowToken.equals(debt.mint));
  if (!found) fail(`Jupiter Lend has no vault lending ${debt.label} against ${col.label}.`);
  return Number(found.account.vaultId);
}

/** The treasury's position in vault `vaultId` (the position NFT it holds), or null. */
async function positionOf(c, program, vaultId) {
  const { value } = await c.network.connection.getTokenAccountsByOwner(c.d.treasury, { programId: TOKEN_PROGRAM_ID });
  for (const { account } of value) {
    const data = account.data;
    if (data.readBigUInt64LE(64) !== 1n) continue;
    const mint = new anchor.web3.PublicKey(data.subarray(0, 32));
    const found = await program.account.position.all([{ memcmp: { offset: POSITION_MINT_OFFSET, bytes: mint.toBase58() } }]);
    const p = found.find(({ account: pos }) => Number(pos.vaultId) === vaultId);
    if (p) return { nftId: Number(p.account.nftId), mint };
  }
  return null;
}

/** Opens position `nftId` in vault `vaultId` as the operator and hands its NFT to the treasury, in one transaction. */
function openPosition(c, vaultId, nftId) {
  return async ({ operator, send }) => {
    const program = getVaultsProgram({ connection: c.network.connection, signer: operator, market: MARKET });
    const accounts = getInitPositionContext(vaultId, nftId, operator, MARKET);
    const init = await program.methods.initPosition(vaultId, nftId).accounts(accounts).instruction();
    const theirs = v.tokenAccount(accounts.positionMint, c.d.treasury);
    await send([
      init,
      createAssociatedTokenAccountIdempotentInstruction(operator, theirs, c.d.treasury, accounts.positionMint),
      createTransferInstruction(accounts.positionTokenAccount, theirs, operator, 1n),
      createCloseAccountInstruction(accounts.positionTokenAccount, operator, operator),
    ]);
  };
}

/** `raw` as the signed amount operate takes; "all" -> the SDK's max mode. */
const bn = (raw) => new BN(raw.toString());

/** Wraps, operates and unwraps: the treasury's side of an operate, in order. */
function operateIxs(c, col, debt, sdkIxs, wrapLamports) {
  const ixs = [];
  for (const a of [col, debt]) ixs.push(createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, v.tokenAccount(a.mint, c.d.treasury, a.programId), c.d.treasury, a.mint, a.programId));
  if (wrapLamports > 0n) {
    const wsol = v.tokenAccount(NATIVE_MINT, c.d.treasury);
    ixs.push(SystemProgram.transfer({ fromPubkey: c.d.treasury, toPubkey: wsol, lamports: wrapLamports }), createSyncNativeInstruction(wsol));
  }
  ixs.push(...sdkIxs);
  // SOL comes and goes as wrapped SOL: close the account so the treasury holds plain SOL (and its rent back).
  if (col.isSol || debt.isSol) ixs.push(createCloseAccountInstruction(v.tokenAccount(NATIVE_MINT, c.d.treasury), c.d.treasury, c.d.treasury));
  return ixs;
}

const amountOf = (a, word, what) => {
  const raw = v.parseUnits(word, a.decimals);
  if (raw < 0n) fail(`Give ${what} as 0 or more.`);
  return raw;
};

const sdk = (c, a) => ({ asset: a.mint, signer: c.d.treasury, connection: c.network.connection, market: MARKET, includeATASetup: false, includeWrapSol: false });

export const actions = {
  "juplend-deposit": {
    models: "all",
    args: [
      { name: "<asset>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<amount>", about: "how much to lend, e.g. 500" },
    ],
    about: "Lend a token from the treasury on Jupiter Lend for interest (the treasury holds the market's fToken).",
    async build(c) {
      const a = await asset(c, c.args[0]);
      const m = await market(c, a);
      const raw = v.parseUnits(c.args[1], a.decimals);
      if (raw <= 0n) fail("Lend more than 0.");
      const own = v.tokenAccount(a.mint, c.d.treasury, a.programId);
      const ixs = [createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, m.fTokenAccount, c.d.treasury, m.fTokenMint, m.fTokenProgram)];
      if (a.isSol) {
        ixs.push(
          createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, own, c.d.treasury, NATIVE_MINT),
          SystemProgram.transfer({ fromPubkey: c.d.treasury, toPubkey: own, lamports: raw }),
          createSyncNativeInstruction(own)
        );
      }
      const { ixs: deposit } = await getDepositIxs({ ...sdk(c, a), amount: new BN(raw.toString()) });
      ixs.push(...deposit);
      // Lent SOL leaves an empty wrapped-SOL account behind: close it (its rent returns to the treasury).
      if (a.isSol) ixs.push(createCloseAccountInstruction(own, c.d.treasury, c.d.treasury));
      const rent = BigInt(await v.tokenAccountRent(c.network));
      return {
        instructions: ixs.map(v.stored),
        budget: a.isSol ? [{ mint: v.SOL_ASSET, amount: raw + rent }] : [{ mint: a.mint, amount: raw }, { mint: v.SOL_ASSET, amount: rent }],
        summary: `lend ${v.formatUnits(raw, a.decimals)} ${a.label} on Jupiter Lend`,
      };
    },
  },

  "juplend-withdraw": {
    models: "all",
    args: [
      { name: "<asset>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<amount|all>", about: "how much to take back, or `all` (every fToken the treasury holds)" },
    ],
    about: "Withdraw a token the treasury lent on Jupiter Lend, with its interest.",
    async build(c) {
      const a = await asset(c, c.args[0]);
      const m = await market(c, a);
      const shares = await c.network.connection.getTokenAccountBalance(m.fTokenAccount).then((b) => BigInt(b.value.amount)).catch(() => 0n);
      if (shares === 0n) fail(`The treasury has nothing lent on Jupiter Lend in ${a.label}.`);
      const all = String(c.args[1]).toLowerCase() === "all";
      const raw = all ? null : v.parseUnits(c.args[1], a.decimals);
      if (raw !== null && raw <= 0n) fail("Withdraw more than 0.");
      const own = v.tokenAccount(a.mint, c.d.treasury, a.programId);
      const ixs = [createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, own, c.d.treasury, a.mint, a.programId)];
      // `all` redeems every fToken, so nothing is left behind as the rate moves until execution.
      const { ixs: out } = all ? await getRedeemIxs({ ...sdk(c, a), shares: new BN(shares.toString()) }) : await getWithdrawIxs({ ...sdk(c, a), amount: new BN(raw.toString()) });
      ixs.push(...out);
      if (a.isSol) ixs.push(createCloseAccountInstruction(own, c.d.treasury, c.d.treasury));
      return {
        instructions: ixs.map(v.stored),
        // fTokens spent: all of them, or for an amount at most all of them (the bound conviction budgets count).
        budget: [{ mint: m.fTokenMint, amount: shares }],
        summary: all ? `withdraw everything the treasury lent on Jupiter Lend in ${a.label}, with interest` : `withdraw ${v.formatUnits(raw, a.decimals)} ${a.label} from Jupiter Lend`,
      };
    },
  },

  "juplend-borrow": {
    models: "all",
    args: [
      { name: "<collateral>", about: "`sol`, `usdc`, or a token's mint address" },
      { name: "<amount>", about: "collateral to add from the treasury (0 for none)" },
      { name: "<borrow>", about: "the token to borrow: `sol`, `usdc`, or a mint address" },
      { name: "<amount>", about: "how much to borrow (0 for none)" },
    ],
    about: "Borrow on Jupiter Lend against collateral from the treasury (its vault for that pair). The bot opens the treasury's position the first time. If the collateral falls far enough in value, Jupiter Lend liquidates part of it.",
    async build(c) {
      const program = await vaultsProgram(c);
      const col = await asset(c, c.args[0]);
      const debt = await asset(c, c.args[2]);
      const colRaw = amountOf(col, c.args[1], "the collateral");
      const debtRaw = amountOf(debt, c.args[3], "the amount to borrow");
      if (colRaw === 0n && debtRaw === 0n) fail("Add collateral, borrow, or both.");
      const vaultId = await vaultFor(program, col, debt);
      const pos = await positionOf(c, program, vaultId);
      if (!pos && colRaw === 0n) fail(`The treasury has no ${col.label}/${debt.label} position on Jupiter Lend yet: add collateral with the first borrow.`);
      const r = await getOperateIx({ vaultId, positionId: pos?.nftId ?? 0, colAmount: bn(colRaw), debtAmount: bn(debtRaw), connection: c.network.connection, signer: c.d.treasury, market: MARKET });
      // A new position's init is the SDK's first instruction, signed by the treasury: the bot opens it instead (prepare).
      const sdkIxs = pos ? r.ixs : r.ixs.slice(1);
      const ixs = operateIxs(c, col, debt, sdkIxs, col.isSol ? colRaw : 0n);
      const rent = BigInt(await v.tokenAccountRent(c.network)) * 2n;
      const parts = [colRaw > 0n && `put up ${v.formatUnits(colRaw, col.decimals)} ${col.label} as collateral`, debtRaw > 0n && `borrow ${v.formatUnits(debtRaw, debt.decimals)} ${debt.label}`].filter(Boolean);
      return {
        instructions: ixs.map(v.stored),
        budget: col.isSol ? [{ mint: v.SOL_ASSET, amount: colRaw + rent }] : [...(colRaw > 0n ? [{ mint: col.mint, amount: colRaw }] : []), { mint: v.SOL_ASSET, amount: rent }],
        summary: `${parts.join(" and ")} on Jupiter Lend (vault ${vaultId}, ${pos ? `the treasury's position #${pos.nftId}` : `a new position #${r.nftId}, opened by the bot and held by the treasury`}); if ${col.label} falls far enough against ${debt.label}, part of the collateral is liquidated`,
        prepare: pos ? undefined : openPosition(c, vaultId, r.nftId),
      };
    },
  },

  "juplend-repay": {
    models: "all",
    args: [
      { name: "<collateral>", about: "the position's collateral: `sol`, `usdc`, or a mint address" },
      { name: "<borrow>", about: "the position's borrowed token" },
      { name: "<repay|all>", about: "how much to repay, `all`, or 0" },
      { name: "<withdraw|all>", about: "collateral to take back, `all`, or 0" },
    ],
    about: "Repay a Jupiter Lend borrow from the treasury and/or take collateral back.",
    async build(c) {
      const program = await vaultsProgram(c);
      const col = await asset(c, c.args[0]);
      const debt = await asset(c, c.args[1]);
      const vaultId = await vaultFor(program, col, debt);
      const pos = await positionOf(c, program, vaultId);
      if (!pos) fail(`The treasury has no ${col.label}/${debt.label} position on Jupiter Lend.`);
      const repayAll = String(c.args[2]).toLowerCase() === "all";
      const withdrawAll = String(c.args[3]).toLowerCase() === "all";
      if (repayAll && debt.isSol) fail("To repay all of a SOL loan, give an amount a little above the debt (the rest comes back to the treasury).");
      const repayRaw = repayAll ? 0n : amountOf(debt, c.args[2], "the repayment");
      const withdrawRaw = withdrawAll ? 0n : amountOf(col, c.args[3], "the collateral to take back");
      if (!repayAll && !withdrawAll && repayRaw === 0n && withdrawRaw === 0n) fail("Repay, take collateral back, or both.");
      const r = await getOperateIx({
        vaultId,
        positionId: pos.nftId,
        colAmount: bn(-withdrawRaw),
        debtAmount: bn(-repayRaw),
        colAmountMode: withdrawAll ? "max" : "exact",
        debtAmountMode: repayAll ? "max" : "exact",
        connection: c.network.connection,
        signer: c.d.treasury,
        market: MARKET,
      });
      const ixs = operateIxs(c, col, debt, r.ixs, debt.isSol ? repayRaw : 0n);
      // Spent: the repayment (for `all`, at most what the treasury holds of the token).
      const held = repayAll ? await c.network.connection.getTokenAccountBalance(v.tokenAccount(debt.mint, c.d.treasury, debt.programId)).then((b) => BigInt(b.value.amount)).catch(() => 0n) : repayRaw;
      const parts = [repayAll ? `repay the whole ${debt.label} loan` : repayRaw > 0n && `repay ${v.formatUnits(repayRaw, debt.decimals)} ${debt.label}`, withdrawAll ? `take back all the ${col.label} collateral` : withdrawRaw > 0n && `take back ${v.formatUnits(withdrawRaw, col.decimals)} ${col.label} of collateral`].filter(Boolean);
      return {
        instructions: ixs.map(v.stored),
        budget: held > 0n ? [{ mint: debt.isSol ? v.SOL_ASSET : debt.mint, amount: held }] : [],
        summary: `${parts.join(" and ")} on Jupiter Lend (vault ${vaultId}, the treasury's position #${pos.nftId})`,
      };
    },
  },
};
