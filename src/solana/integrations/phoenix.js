import { PublicKey } from "@solana/web3.js";
import * as rise from "@ellipsis-labs/rise";
import * as v from "../vortex.js";
import * as phx from "../phoenix.js";
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

/** What the instructions need about the Treasury's Phoenix account. */
async function account(c, sub) {
  const treasury = c.d.treasury;
  const exchange = await phx.exchangeAccounts(c.network);
  const cross = await phx.traderAccount(treasury, phx.CROSS);
  if (!(await phx.readTrader(c.network, treasury, phx.CROSS))) fail("The Treasury isn't registered on Phoenix yet: run `desk register` first.");
  const child = sub === undefined ? null : await phx.traderAccount(treasury, sub);
  return { treasury: treasury.toBase58(), exchange, cross, child };
}

const stored = (ixs) => phx.listOf(ixs).map((ix) => v.stored(phx.web3Instruction(ix)));

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
      if (!(await phx.readTrader(c.network, c.d.treasury, sub))) {
        ixs.push(
          rise.buildRegisterTraderIxResolved({ exchange: a.exchange, trader: { payer: a.treasury, authority: a.treasury, traderAccount: a.child }, maxPositions: 1n, traderPdaIndex: 0, traderSubaccountIndex: sub }),
          rise.buildSyncParentToChildIxResolved({ exchange: a.exchange, trader: { authority: a.treasury, parentTraderAccount: a.cross, childTraderAccount: a.child } })
        );
        const crossInfo = await c.network.connection.getAccountInfo(new PublicKey(a.cross));
        rent = BigInt(await c.network.connection.getMinimumBalanceForRentExemption(crossInfo.data.length));
      }
      ixs.push(rise.buildDelegateTraderIxResolved({ exchange: a.exchange, trader: { authority: a.treasury, traderAccount: a.child }, newPositionAuthority: agent.toBase58() }));
      return {
        instructions: stored(ixs),
        budget: rent ? [{ mint: v.SOL_ASSET, amount: rent }] : [],
        summary: `${rent ? "open" : "use"} the Treasury's Phoenix subaccount ${sub} and let key \`${agent.toBase58()}\` trade it`,
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
      if (!(await phx.readTrader(c.network, c.d.treasury, sub))) fail(`Subaccount ${sub} doesn't exist yet: its appointment proposal has to run first.`);
      const tokens = await phx.tokenAccounts(c.network, c.d.treasury);
      const deposit = rise.buildDepositIxsResolved({ exchange: a.exchange, trader: { authority: a.treasury, traderAccount: a.cross, usdcTokenAccount: tokens.usdc, phoenixTokenAccount: tokens.collateral }, amount });
      const move = rise.buildTransferCollateralIxResolved({ exchange: a.exchange, trader: { authority: a.treasury, srcTraderAccount: a.cross, dstTraderAccount: a.child }, amount });
      return {
        instructions: [...stored(deposit), ...stored(move)],
        budget: [{ mint: new PublicKey(phx.PINNED.usdc), amount }],
        summary: `deposit ${usd(amount)} into Phoenix for subaccount ${sub}`,
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
      const states = await phx.subaccounts(c.network, c.d.treasury);
      const held = BigInt(Math.floor((states[sub]?.collateral ?? 0) * 10 ** phx.QUOTE_DECIMALS)) + BigInt(Math.floor((states[phx.CROSS]?.collateral ?? 0) * 10 ** phx.QUOTE_DECIMALS));
      const all = String(c.args[1]).toLowerCase() === "all";
      const amount = all ? held : v.parseUnits(c.args[1], phx.QUOTE_DECIMALS);
      if (amount <= 0n) fail(all ? "There's nothing in that subaccount or the cross account to withdraw." : "Withdraw more than 0.");
      const tokens = await phx.tokenAccounts(c.network, c.d.treasury);
      const back = rise.buildTransferCollateralChildToParentIxResolved({ exchange: a.exchange, trader: { authority: a.treasury, childTraderAccount: a.child, parentTraderAccount: a.cross } });
      const out = rise.buildWithdrawIxsResolved({ exchange: a.exchange, trader: { authority: a.treasury, traderAccount: a.cross, usdcTokenAccount: tokens.usdc, phoenixTokenAccount: tokens.collateral }, amount });
      return {
        instructions: [...stored(back), ...stored(out)],
        budget: [],
        summary: `withdraw ${usd(amount)} from Phoenix (subaccount ${sub}, through the cross account) back to the Treasury`,
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
        instructions: stored(rise.buildDelegateTraderIxResolved({ exchange: a.exchange, trader: { authority: a.treasury, traderAccount: a.child }, newPositionAuthority: a.treasury })),
        budget: [],
        summary: `take back Phoenix subaccount ${sub} from its trader`,
      };
    },
  },
};
