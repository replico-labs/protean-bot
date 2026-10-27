import { createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Marinade, MarinadeConfig } from "@marinade.finance/marinade-ts-sdk";
import anchor from "@coral-xyz/anchor";
import * as v from "../vortex.js";
import { fail, deployment, requireProgram, requireOwned } from "./common.js";

const { BN } = anchor;

/**
 * Marinade liquid staking: the treasury stakes SOL for mSOL, and unstakes
 * mSOL back to SOL straight away through Marinade's liquidity pool.
 *
 * Instructions come from Marinade's SDK (deposit, liquidUnstake), built
 * with the treasury as the wallet: it funds the deposit and owns the mSOL.
 * The SDK's own "create the mSOL account" step is replaced by an
 * idempotent one, so execution still works if the account was created in
 * the meantime.
 *
 * Liquid unstaking pays a fee that depends on the pool's liquidity
 * (Marinade's own SDK warns it can be high when liquidity is low), and has
 * no minimum out: propose amounts the pool can take.
 *
 * Addresses: Marinade's developer docs (program, mSOL mint) and its SDK's
 * defaults (state account). Devnet isn't pinned yet: Marinade's docs say a
 * devnet deployment exists but its addresses aren't confirmed here.
 */

export const protocol = {
  id: "marinade",
  name: "Marinade",
  deployments: {
    "solana-mainnet": {
      program: "MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD",
      state: "8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC",
      mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    },
  },
};

const DECIMALS = 9; // SOL and mSOL

async function marinadeFor(c) {
  const dep = deployment(protocol, c.network);
  await requireProgram(c.network, dep.program, "Marinade's program");
  await requireOwned(c.network, dep.state, dep.program, "Marinade's state");
  const marinade = new Marinade(new MarinadeConfig({ connection: c.network.connection, publicKey: c.d.treasury, marinadeFinanceProgramId: dep.program, marinadeStateAddress: dep.state }));
  const state = await marinade.getMarinadeState();
  if (!state.mSolMintAddress.equals(dep.mint)) fail(`Marinade's state now names mint ${state.mSolMintAddress.toBase58()}, not the pinned mSOL ${dep.mint.toBase58()} - refusing until that's re-verified.`);
  return { dep, marinade, state, ata: v.tokenAccount(dep.mint, c.d.treasury) };
}

/** The SDK's instructions, minus its account creation (replaced by an idempotent create where needed). */
const withoutAtaCreate = (tx) => tx.instructions.filter((ix) => !ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));

export const actions = {
  "marinade-stake": {
    models: "all",
    args: [{ name: "<amount>", about: "SOL to stake, e.g. 10" }],
    about: "Stake SOL from the treasury with Marinade for mSOL (liquid: it keeps earning and can be unstaked).",
    async build(c) {
      const { dep, marinade, state, ata } = await marinadeFor(c);
      const lamports = v.parseUnits(c.args[0], DECIMALS);
      if (lamports <= 0n) fail("Stake more than 0 SOL.");
      const { transaction } = await marinade.deposit(new BN(lamports.toString()));
      const price = state.mSolPrice;
      return {
        instructions: [v.stored(createAssociatedTokenAccountIdempotentInstruction(c.d.treasury, ata, c.d.treasury, dep.mint)), ...withoutAtaCreate(transaction).map(v.stored)],
        budget: [{ mint: v.SOL_ASSET, amount: lamports + BigInt(await v.tokenAccountRent(c.network)) }],
        summary: `stake ${v.formatUnits(lamports, DECIMALS)} SOL with Marinade for about ${(Number(lamports) / 1e9 / price).toFixed(4)} mSOL (at today's rate, ${price.toFixed(4)} SOL each)`,
      };
    },
  },

  "marinade-unstake": {
    models: "all",
    args: [{ name: "<amount|all>", about: "mSOL to unstake, or `all` (the treasury's mSOL now)" }],
    about: "Unstake the treasury's mSOL back to SOL straight away, through Marinade's liquidity pool (its fee depends on the pool's liquidity).",
    async build(c) {
      const { dep, marinade, state, ata } = await marinadeFor(c);
      const held = await c.network.connection.getTokenAccountBalance(ata).then((b) => BigInt(b.value.amount)).catch(() => 0n);
      const amount = String(c.args[0]).toLowerCase() === "all" ? held : v.parseUnits(c.args[0], DECIMALS);
      if (amount <= 0n) fail(held ? "Unstake more than 0 mSOL." : "The treasury holds no mSOL.");
      if (amount > held) fail(`The treasury holds ${v.formatUnits(held, DECIMALS)} mSOL.`);
      const { transaction } = await marinade.liquidUnstake(new BN(amount.toString()), ata);
      return {
        instructions: withoutAtaCreate(transaction).map(v.stored),
        budget: [{ mint: dep.mint, amount }],
        summary: `unstake ${v.formatUnits(amount, DECIMALS)} mSOL for up to about ${((Number(amount) / 1e9) * state.mSolPrice).toFixed(4)} SOL, less Marinade's liquidity-pool fee`,
      };
    },
  },
};
