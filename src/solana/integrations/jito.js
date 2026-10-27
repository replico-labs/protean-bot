import { PublicKey } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { StakePoolInstruction, getStakePoolAccount } from "@solana/spl-stake-pool";
import * as v from "../vortex.js";
import { fail, deployment, requireProgram, requireOwned } from "./common.js";

/**
 * Jito liquid staking: the treasury stakes SOL for JitoSOL and unstakes it
 * back, through Jito's SPL stake pool.
 *
 * - Stake: the stake pool's deposit_sol, funded by the treasury, minting
 *   JitoSOL to the treasury's token account (created if needed). The pool
 *   has no SOL deposit authority, so anyone may deposit, a PDA included.
 * - Unstake: withdraw_sol, burning the treasury's JitoSOL for SOL from the
 *   pool's reserve (instant; fails if the reserve can't cover it, in which
 *   case a smaller amount or a later execution works).
 *
 * Instructions come from @solana/spl-stake-pool's StakePoolInstruction
 * builders. They're built for the SPL program id; devnet's Jito pool runs
 * its own deployment of the same program, so the program id is swapped.
 * The pool's withdraw authority is the PDA [pool, "withdraw"] under the
 * program (spl-stake-pool's findWithdrawAuthorityProgramAddress).
 *
 * Addresses: Jito's deployed-programs page
 * (go.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs).
 * Devnet uses the current deployment, not the outdated one under the SPL
 * program address.
 */

export const protocol = {
  id: "jito",
  name: "Jito",
  deployments: {
    "solana-mainnet": {
      program: "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy",
      pool: "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
      mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    },
    "solana-devnet": {
      program: "DPoo15wWDqpPJJtS2MUZ49aRxqz5ZaaJCJP4z8bLuib",
      pool: "JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ",
      mint: "J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi",
    },
  },
};

const DECIMALS = 9; // SOL and JitoSOL

/** The pool, checked against the pinned addresses: it must be the pinned program's pool minting the pinned JitoSOL. */
async function pool(network) {
  const dep = deployment(protocol, network);
  await requireProgram(network, dep.program, "Jito's stake pool program");
  await requireOwned(network, dep.pool, dep.program, "Jito's stake pool");
  const { account } = await getStakePoolAccount(network.connection, dep.pool);
  const p = account.data;
  if (!p.poolMint.equals(dep.mint)) fail(`Jito's pool now mints ${p.poolMint.toBase58()}, not the pinned JitoSOL ${dep.mint.toBase58()} - refusing until that's re-verified.`);
  const [withdrawAuthority] = PublicKey.findProgramAddressSync([dep.pool.toBuffer(), Buffer.from("withdraw")], dep.program);
  // SOL per JitoSOL: the pool's lamports over its token supply.
  const rate = Number(p.poolTokenSupply) ? Number(p.totalLamports) / Number(p.poolTokenSupply) : 1;
  return { dep, p, withdrawAuthority, rate };
}

const onProgram = (ix, program) => Object.assign(ix, { programId: program });

export const actions = {
  "jito-stake": {
    models: "all",
    args: [{ name: "<amount>", about: "SOL to stake, e.g. 10" }],
    about: "Stake SOL from the treasury with Jito for JitoSOL (liquid: it keeps earning and can be unstaked).",
    async build(c) {
      const { dep, p, withdrawAuthority, rate } = await pool(c.network);
      if (p.solDepositAuthority) fail("Jito's pool now only takes SOL deposits from its own deposit authority, so a treasury can't stake directly.");
      const lamports = v.parseUnits(c.args[0], DECIMALS);
      if (lamports <= 0n) fail("Stake more than 0 SOL.");
      const ata = v.tokenAccount(dep.mint, c.d.treasury);
      const deposit = onProgram(
        StakePoolInstruction.depositSol({
          stakePool: dep.pool,
          withdrawAuthority,
          reserveStake: p.reserveStake,
          fundingAccount: c.d.treasury,
          destinationPoolAccount: ata,
          managerFeeAccount: p.managerFeeAccount,
          referralPoolAccount: ata,
          poolMint: dep.mint,
          lamports: Number(lamports),
        }),
        dep.program
      );
      return {
        instructions: [v.stored(createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, ata, c.d.treasury, dep.mint)), v.stored(deposit)],
        budget: [{ mint: v.SOL_ASSET, amount: lamports + BigInt(await v.tokenAccountRent(c.network)) }],
        summary: `stake ${v.formatUnits(lamports, DECIMALS)} SOL with Jito for about ${(Number(lamports) / 1e9 / rate).toFixed(4)} JitoSOL (at today's rate, ${rate.toFixed(4)} SOL each)`,
      };
    },
  },

  "jito-unstake": {
    models: "all",
    args: [{ name: "<amount|all>", about: "JitoSOL to unstake, or `all` (the treasury's JitoSOL now)" }],
    about: "Unstake the treasury's JitoSOL back to SOL straight away, from Jito's reserve (less Jito's withdrawal fee).",
    async build(c) {
      const { dep, p, withdrawAuthority, rate } = await pool(c.network);
      if (p.solWithdrawAuthority) fail("Jito's pool now only lets its own withdraw authority take SOL out, so a treasury can't unstake directly.");
      const ata = v.tokenAccount(dep.mint, c.d.treasury);
      const held = await c.network.connection.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
      const amount = String(c.args[0]).toLowerCase() === "all" ? held : v.parseUnits(c.args[0], DECIMALS);
      if (amount <= 0n) fail(held ? "Unstake more than 0 JitoSOL." : "The treasury holds no JitoSOL.");
      if (amount > held) fail(`The treasury holds ${v.formatUnits(held, DECIMALS)} JitoSOL.`);
      const reserve = await c.network.connection.getBalance(p.reserveStake);
      const solOut = Number(amount) * rate;
      const fee = Number(p.solWithdrawalFee.denominator) ? (100 * Number(p.solWithdrawalFee.numerator)) / Number(p.solWithdrawalFee.denominator) : 0;
      const short = solOut > reserve ? ` ⚠️ Jito's reserve holds ${(reserve / 1e9).toFixed(2)} SOL now, less than this needs, so it would fail unless the reserve refills before execution.` : "";
      const withdraw = onProgram(
        StakePoolInstruction.withdrawSol({
          stakePool: dep.pool,
          sourcePoolAccount: ata,
          withdrawAuthority,
          reserveStake: p.reserveStake,
          destinationSystemAccount: c.d.treasury,
          sourceTransferAuthority: c.d.treasury,
          managerFeeAccount: p.managerFeeAccount,
          poolMint: dep.mint,
          poolTokens: Number(amount),
        }),
        dep.program
      );
      return {
        instructions: [v.stored(withdraw)],
        budget: [{ mint: dep.mint, amount }],
        summary: `unstake ${v.formatUnits(amount, DECIMALS)} JitoSOL for about ${(solOut / 1e9).toFixed(4)} SOL, less Jito's ${fee}% withdrawal fee${short}`,
      };
    },
  },
};
