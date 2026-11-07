import { PublicKey } from "@solana/web3.js";
import * as rise from "@ellipsis-labs/rise";
import * as v from "../vortex.js";
import * as phx from "../phoenix.js";
import * as sf from "../funds.js";
import { fail, key } from "./common.js";

/**
 * Phoenix perps: the proposals behind the trading desk on Solana
 * (src/solana/deskPhoenix.js, `/desk` in a Solana chat). The Treasury's
 * Phoenix account has a cross-margin subaccount (0), where deposits land,
 * and one isolated subaccount per trader (1, 2, ...), delegated to the
 * trader's key: Phoenix lets that key trade the subaccount but never
 * withdraw from it. Every move of money is one of these proposals:
 *
 * - phoenix-appoint <sub> <key>: registers isolated subaccount `sub` if
 *   it's new (synced from the cross account), and delegates it to `key`.
 * - phoenix-fund <sub> <amount>: deposits USDC (wrapped by Phoenix's Ember)
 *   into the cross account, then moves it into `sub`.
 * - phoenix-withdraw <sub> <amount|all>: moves `sub`'s collateral back to
 *   the cross account, withdraws the amount and unwraps it to USDC.
 * - phoenix-remove <sub>: delegates `sub` to the Treasury itself, so only
 *   proposals can trade it.
 *
 * The Treasury must be registered on Phoenix first (the desk does it,
 * through Phoenix's API, paid by the operator). Mainnet only.
 *
 * A prop firm's desk trades its vault's money: the vault's PDA is the
 * Phoenix authority, each instruction it signs runs as vault.execute, the
 * USDC comes from and returns to the vault's assets account, and the
 * Treasury only pays rent.
 */

export const protocol = {
  id: "phoenix",
  name: "Phoenix",
  // Funding, opening a subaccount and withdrawing store 948-1,792 bytes (scripts/test-phoenix-flow.mjs).
  needsV1Transactions: true,
  deployments: { "solana-mainnet": { program: phx.PINNED.program, ember: phx.PINNED.ember, usdc: phx.PINNED.usdc } },
};

function subOf(word) {
  const n = Number(word);
  if (!Number.isInteger(n) || n < 1 || n > phx.MAX_SUBACCOUNT) fail(`Give the trader's subaccount as a number from 1 to ${phx.MAX_SUBACCOUNT}.`);
  return n;
}

const usd = (raw) => `${v.formatUnits(raw, phx.QUOTE_DECIMALS)} USDC`;

/** What the instructions need about the desk's Phoenix account (the Treasury's, or a prop firm's vault's). */
async function account(c, sub) {
  const owner = await sf.deskOwner(c.network, c.d);
  const authority = owner.authority;
  const exchange = await phx.exchangeAccounts(c.network);
  const cross = await phx.traderAccount(authority, phx.CROSS);
  if (!(await phx.readTrader(c.network, authority, phx.CROSS))) fail(`${owner.Name} isn't registered on Phoenix yet: run \`desk register\` first.`);
  const child = sub === undefined ? null : await phx.traderAccount(authority, sub);
  const tokens = await phx.tokenAccounts(c.network, authority);
  if (owner.vault) {
    if (!owner.vault.assetMint.equals(new PublicKey(exchange.usdcMint))) fail("The vault's money isn't USDC, so it can't go to Phoenix.");
    tokens.usdc = owner.vault.assets.toBase58();
  }
  // A vault holds no SOL: the Treasury pays rent for it.
  return { owner, authority: authority.toBase58(), payer: (owner.vault ? c.d.treasury : authority).toBase58(), exchange, cross, child, tokens };
}

/**
 * A vault is valued at each window from the Phoenix accounts it names
 * (set_venues): money on an account it doesn't name would go uncounted,
 * mispricing every deposit and redemption. So appointing a trader names
 * the cross account and the trader's subaccount too (8 at most).
 */
async function venuesFor(c, a) {
  if (!a.owner.vault) return [];
  const x = a.owner.vault;
  const have = x.phoenixTraders.map((k) => k.toBase58());
  const want = [...new Set([...have, a.cross, a.child])];
  if (want.length === have.length && x.perpAssetMap.toBase58() === a.exchange.perpAssetMap) return [];
  if (want.length > 8) fail("The vault is valued from at most 8 Phoenix accounts (its cross account and 7 traders' subaccounts): remove a trader's subaccount from its venues first.");
  return [await sf.vaultVenuesIx(c.network, c.d, x.address, new PublicKey(a.exchange.perpAssetMap), want.map((k) => new PublicKey(k)), x.extraTokens)];
}

/** Refuses moving a vault's money onto a Phoenix account its windows don't count. */
function requireVenues(a) {
  if (!a.owner.vault) return;
  const named = a.owner.vault.phoenixTraders.map((k) => k.toBase58());
  if (!named.includes(a.cross) || !named.includes(a.child)) fail("The vault doesn't count this subaccount (or its cross account) in its value yet: its trader's appointment proposal names it, so that has to run first.");
}

/** Phoenix instructions as stored proposal instructions; a vault's go through vault.execute. */
const stored = async (c, a, ixs) =>
  Promise.all(phx.listOf(ixs).map(async (ix) => v.stored(a.owner.vault ? await sf.asVault(c.network, c.d, a.owner.authority, phx.web3Instruction(ix)) : phx.web3Instruction(ix))));

export const actions = {
  "phoenix-appoint": {
    models: "all",
    args: [
      { name: "<sub>", about: "the trader's isolated subaccount, 1 or more" },
      { name: "<key>", about: "the trader's key (the bot makes it with `desk apply`)" },
    ],
    about: "Delegate an isolated Phoenix subaccount of the Treasury to a trader's key (creating the subaccount if it's new). The key can trade it, never withdraw.",
    async build(c) {
      const sub = subOf(c.args[0]);
      const agent = key(c.args[1], "the trader's key");
      const a = await account(c, sub);
      const ixs = [];
      let rent = 0n;
      if (!(await phx.readTrader(c.network, a.owner.authority, sub))) {
        ixs.push(
          rise.buildRegisterTraderIxResolved({ exchange: a.exchange, trader: { payer: a.payer, authority: a.authority, traderAccount: a.child }, maxPositions: 1n, traderPdaIndex: 0, traderSubaccountIndex: sub }),
          rise.buildSyncParentToChildIxResolved({ exchange: a.exchange, trader: { authority: a.authority, parentTraderAccount: a.cross, childTraderAccount: a.child } })
        );
        const crossInfo = await c.network.connection.getAccountInfo(new PublicKey(a.cross));
        rent = BigInt(await c.network.connection.getMinimumBalanceForRentExemption(crossInfo.data.length));
      }
      ixs.push(rise.buildDelegateTraderIxResolved({ exchange: a.exchange, trader: { authority: a.authority, traderAccount: a.child }, newPositionAuthority: agent.toBase58() }));
      return {
        instructions: [...(await venuesFor(c, a)), ...(await stored(c, a, ixs))],
        budget: rent ? [{ mint: v.SOL_ASSET, amount: rent }] : [],
        summary: `${rent ? "open" : "use"} ${a.owner.name}'s Phoenix subaccount ${sub} and let key \`${agent.toBase58()}\` trade it`,
      };
    },
  },

  "phoenix-fund": {
    models: "all",
    args: [
      { name: "<sub>", about: "the trader's subaccount" },
      { name: "<amount>", about: "USDC to move from the Treasury, e.g. 500" },
    ],
    about: "Deposit USDC from the Treasury into Phoenix and move it into a trader's subaccount.",
    async build(c) {
      const sub = subOf(c.args[0]);
      const amount = v.parseUnits(c.args[1], phx.QUOTE_DECIMALS);
      if (amount <= 0n) fail("Fund with more than 0.");
      const a = await account(c, sub);
      if (!(await phx.readTrader(c.network, a.owner.authority, sub))) fail(`Subaccount ${sub} doesn't exist yet: its appointment proposal has to run first.`);
      requireVenues(a);
      const deposit = rise.buildDepositIxsResolved({ exchange: a.exchange, feePayer: a.payer, trader: { authority: a.authority, traderAccount: a.cross, usdcTokenAccount: a.tokens.usdc, phoenixTokenAccount: a.tokens.collateral }, amount });
      const move = rise.buildTransferCollateralIxResolved({ exchange: a.exchange, trader: { authority: a.authority, srcTraderAccount: a.cross, dstTraderAccount: a.child }, amount });
      return {
        instructions: [...(await stored(c, a, deposit)), ...(await stored(c, a, move))],
        // The vault's money isn't the Treasury's: no Treasury budget for it.
        budget: a.owner.vault ? [] : [{ mint: new PublicKey(phx.PINNED.usdc), amount }],
        summary: `deposit ${usd(amount)} of ${a.owner.name}'s into Phoenix for subaccount ${sub}`,
      };
    },
  },

  "phoenix-withdraw": {
    models: "all",
    args: [
      { name: "<sub>", about: "the trader's subaccount" },
      { name: "<amount|all>", about: "USDC to bring back to the Treasury, or `all`" },
    ],
    about: "Bring a trader's subaccount collateral back to the Treasury as USDC (the subaccount must have no open position for `all`).",
    async build(c) {
      const sub = subOf(c.args[0]);
      const a = await account(c, sub);
      const states = await phx.subaccounts(c.network, a.owner.authority);
      const held = BigInt(Math.floor((states[sub]?.collateral ?? 0) * 10 ** phx.QUOTE_DECIMALS)) + BigInt(Math.floor((states[phx.CROSS]?.collateral ?? 0) * 10 ** phx.QUOTE_DECIMALS));
      const all = String(c.args[1]).toLowerCase() === "all";
      const amount = all ? held : v.parseUnits(c.args[1], phx.QUOTE_DECIMALS);
      if (amount <= 0n) fail(all ? "There's nothing in that subaccount or the cross account to withdraw." : "Withdraw more than 0.");
      const back = rise.buildTransferCollateralChildToParentIxResolved({ exchange: a.exchange, trader: { authority: a.authority, childTraderAccount: a.child, parentTraderAccount: a.cross } });
      const out = rise.buildWithdrawIxsResolved({ exchange: a.exchange, feePayer: a.payer, trader: { authority: a.authority, traderAccount: a.cross, usdcTokenAccount: a.tokens.usdc, phoenixTokenAccount: a.tokens.collateral }, amount });
      // The vault's USDC account is its assets account, not an associated one: nothing to create.
      const outIxs = a.owner.vault ? phx.listOf(out).filter((ix) => ix !== out.named.createUsdcAta) : out;
      return {
        instructions: [...(await stored(c, a, back)), ...(await stored(c, a, outIxs))],
        budget: [],
        summary: `withdraw ${usd(amount)} from Phoenix (subaccount ${sub}, through the cross account) back to ${a.owner.name}`,
      };
    },
  },

  "phoenix-remove": {
    models: "all",
    args: [{ name: "<sub>", about: "the trader's subaccount" }],
    about: "Take a trader's subaccount back: it's delegated to the Treasury, so only proposals can trade it.",
    async build(c) {
      const sub = subOf(c.args[0]);
      const a = await account(c, sub);
      return {
        instructions: await stored(c, a, rise.buildDelegateTraderIxResolved({ exchange: a.exchange, trader: { authority: a.authority, traderAccount: a.child }, newPositionAuthority: a.authority })),
        budget: [],
        summary: `take back Phoenix subaccount ${sub} from its trader`,
      };
    },
  },
};
