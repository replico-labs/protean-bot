import { SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import { getDepositIxs, getWithdrawIxs, getRedeemIxs, getDepositContext } from "@jup-ag/lend/earn";
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
 * The SDK has Jupiter Lend's mainnet program IDs built in (its "main"
 * market; lending program as in Jupiter's docs), so this is mainnet only.
 * Jupiter's docs also list a devnet lending program, which the SDK doesn't
 * support.
 */

export const protocol = {
  id: "juplend",
  name: "Jupiter Lend",
  // A deposit's stored instructions are 883 bytes (1,466 for SOL), more than a legacy propose transaction holds.
  needsV1Transactions: true,
  deployments: {
    "solana-mainnet": {
      lending: "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9",
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
};

