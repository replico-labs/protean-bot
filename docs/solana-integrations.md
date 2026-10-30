# Solana integrations: research

Status: partly built (see [What's built](#whats-built)). Program IDs below
come from each project's own docs or repos, as found on 2026-10-27; **verify
every one on-chain before using it** (the project rule: never guess an
address or layout). `scripts/verify-solana-integrations.mjs` checks the
pinned ones.

Targets: Kamino Lend and Jupiter Lend, the Jupiter swap aggregator, Jito and
Marinade (liquid staking), Tensor (NFTs), Pump.fun, Phoenix perps.

## How a Vortexes DAO can call another program

From the hub's code (`programs/hub`, `crates/vortex-core`):

- A proposal stores up to **16 instructions** (`MAX_INSTRUCTIONS`; 14 for
  conviction, whose budget takes 2. It was 8, from legacy transactions, until
  a first Kamino deposit needed 10). On
  execution the hub runs each one with `invoke_signed`, **signed by the
  treasury PDA**. So every integration is a CPI from the hub.
- **The treasury is the only signer** a proposal's instructions may ask for
  (`validate_instructions`). Anything that needs a fresh keypair to sign
  (e.g. a new mint account) can't be done in a proposal.
- **The whole proposal is passed inline to `propose`** (`instructions:
  Vec<StoredInstruction>`), so it must fit in one transaction, less
  signatures, the governance accounts and the metadata URI. Each account an
  instruction touches costs 34 bytes. With legacy transactions (1,232
  bytes, what the bot sends today) that's roughly **20 account references in
  all**.
- **Execution** puts every referenced account and program in the
  transaction's remaining accounts. The bot sends legacy transactions
  (`src/solana/vortex.js send`), so about 35 accounts at most.
- **v1 transactions** (SIMD-0296 and SIMD-0385) raise the limit to **4,096
  bytes**: about 100 account references per proposal, and about 120 accounts
  per execution by size (the per-transaction account-lock limit still
  applies). Mainnet activation was reported for 15 September 2026 (epoch
  1035) by [Chainstack](https://docs.chainstack.com/docs/solana-transaction-v1.md);
  the Foundation's [upgrade page](https://solana.com/upgrades/larger-transaction-sizes)
  targeted Q3 2026. Confirm on Solana's release notes. v1 has no address
  lookup tables, and apps opt in; legacy and v0 keep working. Solana CLI
  4.2+ and Surfpool 1.5+ handle it locally.
- **Proposals execute days after they're written,** so anything priced at
  proposal time (a swap route, a quote) can be stale. The EVM side handles
  this with limit prices (fill at the limit or better, or not at all); the
  same idea applies here.

### Changes the bigger integrations need

1. **The bot sends v1 transactions** for `propose` and `execute`. Done:
   `src/solana/v1.js` builds them with `@solana/kit` (web3.js can't), and
   `send()` uses them only for a transaction too big for legacy, on networks
   where `<PREFIX>_V1_TRANSACTIONS` is on (default: mainnet on, devnet off).
   Two details: Anchor's JS coder encodes instructions into a fixed
   1,000-byte buffer, so the bot gives it one the size of a v1 transaction;
   and a v1 header always carries a loaded-accounts-data limit (the runtime
   holds a header without one to 0) and a compute limit.
2. **Check the hub with big proposals:** compute for deserializing and
   running up to 16 instructions within v1's 64 accounts, and the proposal
   account's size (it's sized from `instructions_len`). Compute budget per
   execution sized to the instructions (in v1, set in the header).
3. **Fallback only if a proposal ever needs more than 4,096 bytes:** "large
   proposals" (create, then append instructions in further transactions,
   sealed before voting). A hub upgrade; not needed for anything listed
   here.

## Per protocol

| Protocol | What a DAO would do | Program (from its docs) | Devnet | Fits a proposal today? |
|---|---|---|---|---|
| **Kamino Lend** | deposit, withdraw, borrow, repay | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` (mainnet, klend `lib.rs`; `SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh` is its staging build); main market `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` | probably | ❌ with legacy transactions (a deposit also needs refresh-reserve and refresh-obligation instructions, over 20 accounts); ✅ with v1 |
| **Jupiter Lend** (Earn) | deposit, withdraw (fTokens) | `jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9` mainnet, `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3` devnet (Jupiter's CPI guide) | ✅ | likely ✅: a CPI context of about 10 accounts; SDK `@jup-ag/lend` gives the instructions and CPI accounts |
| **Jupiter aggregator** | swap any token for any token | mainnet only | ❌ | ❌ by design: Jupiter's own docs say swaps via CPI are likely to fail (routes need lookup tables and many accounts), and a route quoted at proposal time is stale at execution. See the swap design below |
| **Jito** (JitoSOL) | stake SOL for JitoSOL, unstake | SPL stake pool: mainnet pool `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`, mint `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn`; devnet program `DPoo15wWDqpPJJtS2MUZ49aRxqz5ZaaJCJP4z8bLuib`, pool `JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ`, mint `J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi` (Jito's deployed-programs page; not the old SPL devnet deployment, which is outdated) | ✅ | ✅: `deposit_sol` is about 10 accounts, and the SPL stake pool program takes a PDA depositor |
| **Marinade** (mSOL) | stake SOL for mSOL, liquid unstake | `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`, mSOL mint `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` (mainnet) | docs say yes, address not found yet | ✅ likely: deposit is about 10 accounts |
| **Tensor** | buy, list, sell NFTs, bid | marketplace `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp` on mainnet and devnet (tensor-foundation/marketplace `declare_id`, and its client's program address); its Whitelist program `TL1ST2iRBzuGTqLn1KXnGdSnEow62BzPnGiqyRXhWtW` | partly | borderline with legacy (a buy touches 15–20 accounts, more for compressed NFTs, which also need proofs); ✅ with v1 |
| **Pump.fun** | buy and sell a coin on its bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`; its AMM after migration `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | not found | buy/sell ✅ (about 12–16 accounts); **creating a coin ❌**: it needs a new mint keypair to sign, which a proposal can't |
| **Phoenix perps** | a trading desk: the Treasury owns the trader account, traders trade it | `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih` (verified on mainnet), with Ember and Hawkeye | ❌ mainnet only; LiteSVM fixtures for local tests | ✅ the proposals (deposit, delegate, withdraw) are small; trades aren't proposals. See [Phoenix perps](#phoenix-perps) |

### Phoenix perps

Read from Phoenix's docs ([On-chain programs](https://docs.phoenix.trade/sdk/on-chain-programs),
[Accounts](https://docs.phoenix.trade/sdk/accounts),
[Trader onboarding](https://docs.phoenix.trade/sdk/register),
[LiteSVM testing](https://docs.phoenix.trade/sdk/litesvm-testing)) and its
SDK source ([rise-public](https://github.com/Ellipsis-Labs/rise-public),
`rust/ix/src/constants.rs`).

**Programs** (checked on mainnet: deployed and executable, 2026-10-27):

| Program | Address | Role |
|---|---|---|
| Phoenix (perps, "Eternal") | `EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih` | trader accounts, collateral, orders |
| Ember | `EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy` | wraps USDC into Phoenix collateral and back |
| Hawkeye | `RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj` | read-only views: margin, liquidation price, best bid/offer, funding |

The SDK also names a beta Phoenix program (`phDEVv4w6BcfkLrLNeXr8HhhgQxnxziVGXpGPcaadMf`)
with its own USDC mint; no devnet deployment is documented. SDK:
`@ellipsis-labs/rise` (TypeScript), `phoenix-rise` (Rust; `cpi` feature for
on-chain use). API: `perp-api.phoenix.trade`.

**Two authorities per trader account.** The account's `authority` owns
the collateral: it deposits, withdraws and delegates. Its
`position_authority`, set with `DelegateTrader` (signed by the authority
only), trades: orders are built for the authority's trader account and
signed by the position authority. Phoenix's docs suggest exactly this split,
"keeping collateral withdrawals controlled by the user's authority wallet".

**Registering the Treasury needs no access code.** Onboarding without a
referral code (`POST /v1/exchange/build-register-ixs`, then
`/v1/exchange/send-register-ixs`) "can register off-curve authorities such as
PDAs": the trader authority doesn't sign, we pay the fee and rent (the
operator wallet), and Phoenix's onboarder co-signs and submits. So the
Treasury PDA can be the authority without a proposal even being needed to
register. (Phoenix runs the onboarder, so it can still decline.)

**Accounts:** a trader account is a PDA of (authority, `pda_index`,
`subaccount_index`). Only `pda_index = 0` can be activated while Phoenix's
gating is on. `subaccount_index = 0` is the cross-margin account (up to 128
positions); `subaccount_index > 0` are isolated accounts, **one position
each**, with their own collateral, registered by the authority and synced
from the cross account. `DelegateTrader` sets the position authority of one
account at a time.

**The desk:**
- **By proposal** (the Treasury signs through the hub): deposit (Ember wrap,
  then Phoenix deposit), withdraw, register isolated subaccounts, and
  `DelegateTrader` to appoint or remove a trader's key.
- **Trades** are signed by a key the bot holds for each trader, as on
  HyperCore, only within the mandate. They're ordinary transactions, not
  proposals, so the hub's size limits don't apply to them.
- **Per-trader isolation:** each trader's markets live in isolated
  subaccounts delegated to that trader's key (one position per subaccount).
  The alternative is the shared cross account with a single bot-held key and
  per-market mandates, like HyperCore. Isolated subaccounts are closer to
  Perpl's separate desks: one trader's loss can't reach another's
  collateral.
- **Removing a trader:** a `DelegateTrader` proposal moves the subaccounts to
  a new key, and the bot destroys the old one.

**Testing:** Phoenix publishes LiteSVM fixtures (`phoenix-rise-litesvm-test`)
that load Phoenix, Ember and Hawkeye, create fake USDC, initialize markets
and seed makers. The program binaries can be dumped from mainnet
(`solana program dump`). That's the same LiteSVM Vortexes already uses, so
hub plus Phoenix can be tested together locally.

What's left before it's live: the hub on mainnet (after the audit), and
checking that a CPI from the hub (the Treasury signing) works for deposit,
withdraw, subaccount registration and `DelegateTrader`, in that local test.

### Swaps without CPI routes

A DAO still needs "swap X of A for at least Y of B". Two ways that suit
proposals executed days later:

1. **Direct pool swaps with a limit:** one named AMM pool, proposed with the
   minimum out. It
   fills at the limit or better at execution, or the proposal fails, like the
   EVM side's limit-price trades. Simple, one venue.
2. **A fill adapter (the better route for Jupiter):** a small Protean program
   (built: Vortexes `programs/fill`, see below).
   The proposal moves X of A into an adapter account with terms (at least Y
   of B, by a deadline). A keeper (the bot) then swaps through Jupiter in an
   ordinary top-level transaction (lookup tables, any route) with its own
   funds, and the adapter releases X of A to the keeper only if Y or more of
   B reaches the Treasury in the same transaction. If nothing fills by the
   deadline, X returns to the Treasury. The Treasury never trusts the keeper:
   it gets at least Y or keeps its tokens. Jupiter recommends this pattern
   (Flash Fill) over CPI.

### The fill program (built)

Vortexes `programs/fill` (`vortex-fill`), not a governance model:

- `open_order(id, amount, min_out, deadline)`: the treasury (a passed
  proposal) moves `amount` into the order's input vault and names its
  receiving account. It pays the rent and gets it back when the order closes.
- A keeper's own transaction: `take` (the input goes to the keeper), the
  swap (output to the order's **own output vault**), then `settle` (the
  vault must have gained at least `min_out` since the take; everything in it
  goes to the treasury). `take` runs only top-level, and only when the next
  instruction of the program is `settle` of the same order. So two orders
  can't share a swap, and a take can't stand alone.
- The output vault belongs to the order, so nothing else paying the treasury
  in that transaction counts toward the fill. That includes another order's
  refund and a proposal executed alongside, such as a lend withdrawal.
  Measuring the treasury's own account would have let a keeper count those.
- `cancel`: the treasury any time (a proposal), anyone past the deadline.

The bot: `jup-swap <from> <to> <amount> <slippage%> [days]` sets the minimum
from Jupiter's quote less the slippage. `jup-cancel <order>` cancels an
order. The keeper (`src/solana/fillKeeper.js`, `<PREFIX>_FILL_KEEPER=true`)
quotes open orders every 30 seconds. It fills an order once Jupiter's route
pays the minimum, sending all output to the treasury, simulating before it
sends. It cancels expired orders and tells the DAO's chats. The keeper keeps
nothing; it pays the fees. Tests: `tests/tests/fill.rs` in Vortexes (not run
yet: they need `anchor build`).

### Desks on Solana

The trading desk model (a trader appointed by proposal, trading within a
mandate the bot enforces) carries over to Phoenix perps (above) and to
Jupiter swaps through the fill adapter. Not designed yet.

## What's built

**Kamino and CPI.** Kamino's original deposit, withdraw, borrow and repay
instructions refuse to run inside another program unless that program is on
Kamino's whitelist (`check_refresh` → `is_forbidden_cpi_call`, klend
`utils/refresh_ix_utils.rs`): they check, from the instructions sysvar,
that refresh instructions sit right before them at the top level. Their
`_v2` variants make no such check, and Kamino's klend-interface has a CPI
example built on them. So the Kamino actions use v2 instructions (the SDK's
`useV2Ixs`), with the refreshes carried in the proposal before them. Flash
loans and obligation ownership transfers stay CPI-only for whitelisted
programs; neither is used.

**Tensor** supports CPI (its repo has a CPI test crate). Core assets and
compressed NFTs aren't covered yet, nor selling into bids (those need the
collection's whitelist proofs).

Actions are offered only where they apply: on the protocol's cluster, where
v1 transactions are on if they need them, and where the fill program is set
if they swap.

| Protocol | Actions | Proposal fits | Checked |
|---|---|---|---|
| Jito | `jito-stake`, `jito-unstake` | legacy | through the hub on a mainnet fork |
| Marinade | `marinade-stake`, `marinade-unstake` | legacy | through the hub on a mainnet fork |
| Jupiter Lend | `juplend-deposit`, `juplend-withdraw`; borrowing: `juplend-borrow`, `juplend-repay` (the bot opens the treasury's position NFT when proposing) | v1 | lending through the hub on a mainnet fork; borrowing ran on the fork and was refused by Jupiter: its USDC pool was at the utilization cap (6035), which the bot now checks when proposing; to run again, or with `HUB_TEST_JUPLEND_BORROW=<mint>` |
| Pump.fun | `pumpfun-buy`, `pumpfun-sell` | legacy (the operator opens the coin account first) | through the hub on a mainnet fork |
| Kamino Lend | `kamino-deposit`, `kamino-withdraw`, `kamino-borrow`, `kamino-repay`, each naming the market (`main` or a market address) | v1; a first SOL deposit is about 10 instructions | deposit and withdraw through the hub on a mainnet fork; the main market had borrowing switched off on mainnet (its `borrow_disabled` flag, error 6088), so borrowing is to run in another market with `HUB_TEST_KAMINO_MARKET=<address>` |
| Tensor | `tensor-buy`, `tensor-list`, `tensor-delist` (token-metadata NFTs, programmable included) | v1 for a buy (944 bytes); list and delist fit legacy | through the hub on a mainnet fork (a programmable NFT) |
| Jupiter (fill orders) | `jup-swap`, `jup-cancel` | legacy (v1 when selling SOL, which is wrapped first) | `jup-swap` through the hub on a mainnet fork, filled by the keeper |
| Phoenix perps | `/desk` (`phoenix-appoint`, `phoenix-fund`, `phoenix-withdraw`, `phoenix-remove`) | v1 for appoint (new subaccount), fund, withdraw | LiteSVM with Phoenix's programs (`scripts/test-phoenix-flow.mjs`, 23 checks); through the hub on a mainnet fork (register, appoint, fund, withdraw, remove) |

`scripts/simulate-solana-action.mjs` builds any action with a stand-in
treasury and simulates it on mainnet. `scripts/test-hub-mainnet-fork.mjs`
runs them as proposals the Treasury executes through the hub (below).

## Testing when there's no devnet

Most of these run on mainnet only. Testing doesn't need mainnet funds:

- **The hub test** (`scripts/test-hub-mainnet-fork.mjs`, built): every
  integration as a proposal a board DAO passes and its Treasury executes
  through the hub, on a mainnet fork in LiteSVM
  (`scripts/lib/mainnetFork.mjs`). The fork copies accounts and programs
  from a mainnet RPC as they're used and serves them as an RPC, so the bot
  runs unchanged: its commands propose, the timelock passes in real time,
  `execute` runs them, and each step's result is checked (balances, the
  Phoenix subaccount, the fill keeper's fill). Needs the Vortexes build
  (`VORTEXES_DEPLOY_DIR`) and a mainnet RPC; the header lists the options.
  `scripts/test-mainnet-fork-rpc.mjs` checks the fork itself offline.
- **A local validator forked from mainnet:** `solana-test-validator` with
  `--clone-upgradeable-program <id> --url mainnet-beta` (and `--clone` for
  the markets, pools and mints a test touches), or Surfpool, which forks
  mainnet state on demand. Our hub and models deploy beside them, and the
  bot's local Solana tests (`scripts/test-solana-*.mjs`) already run against
  a local validator.
- **LiteSVM** (what Vortexes' tests use) with the programs dumped from
  mainnet (`solana program dump`) and the needed accounts loaded.
- **Devnet** where it exists: Kamino (to confirm), Jupiter Lend, Jito,
  Marinade.

Then a small live run on mainnet with tiny amounts, once the mainnet
deployment and audit (see the roadmap) are done.

## Suggested order

1. **Jito and Marinade:** small instructions, devnet available, the simplest
   treasury use (idle SOL earning yield). Proves the CPI path.
2. **Jupiter Lend:** small CPI context, devnet available.
3. **The bot on v1 transactions** for propose and execute. Needed by
   everything after this.
4. **Kamino Lend.**
5. **Swaps:** the fill adapter for Jupiter.
6. **Pump.fun** buy and sell; **Tensor** buy, list and sell.
7. **Phoenix perps desk:** build and test it now in LiteSVM with Phoenix's
   fixtures and programs; go live once the hub is on mainnet. Could move
   earlier: it needs neither v1 transactions nor the fill adapter.

## To check before building

- Every program ID above, on-chain (Solscan or `solana program show`), on
  each cluster. Kamino's devnet ID conflicts between its own pages.
- Marinade's devnet addresses; Tensor's marketplace program ID and devnet
  status; whether Pump.fun has a devnet deployment.
- That each program accepts a PDA as the owner/authority where we need one
  (Kamino obligations, Jupiter Lend depositor, Tensor buyer).
- Phoenix perps: that the hub's CPI (the Treasury PDA signing) works for
  deposit, withdraw, isolated-subaccount registration and `DelegateTrader`;
  that the no-referral onboarding accepts the Treasury PDA in practice.
- That v1 is active on mainnet and devnet (Solana's release notes), and
  which JS library version builds v1 transactions.
- CPI depth: hub → protocol → (its own CPIs, e.g. to the token program) must
  stay within Solana's limit.

## Sources

- v1 transactions: [Solana: larger transaction sizes](https://solana.com/upgrades/larger-transaction-sizes), [Chainstack: transaction v1](https://docs.chainstack.com/docs/solana-transaction-v1.md), [Solana Compass](https://solanacompass.com/news/solana-v1-transactions-now-testable-locally-as-mainnet-activation-nears)

- Kamino: [klend repo](https://github.com/Kamino-Finance/klend), [klend-interface](https://docs.rs/klend-interface), [setup guide](https://www.mintlify.com/kamino-finance/klend/integration/setup)
- Jupiter Lend: [Earn CPI guide](https://developers.jup.ag/docs/lend/earn/cpi.md), [Lend docs](https://developers.jup.ag/docs/lend)
- Jupiter swaps: [Swap via CPI](https://docs.jup.ag/docs/apis/cpi), [Integration: CPI](https://docs.jup.ag/docs/cross-program-invocation-cpi), [Build](https://developers.jup.ag/docs/swap/build)
- Jito: [Deployed programs](https://go.jito.network/docs/jitosol/jitosol-liquid-staking/security/deployed-programs/), [Staking integration](https://go.jito.network/docs/jitosol/jitosol-liquid-staking/for-developers/staking-integration/)
- Marinade: [Developer docs](https://docs-beta.marinade.finance/developers/), [Liquid staking](https://docs-beta.marinade.finance/staking/liquid/)
- Tensor: [tensor_marketplace crate](https://docs.rs/tensor-marketplace), [Whitelist repo](https://github.com/tensor-foundation/whitelist)
- Pump.fun: [Solana Tracker guide](https://docs.solanatracker.io/guides/pumpfun-program.md), [Helius](https://www.helius.dev/parsed-data/pump-fun/program)
- Phoenix perps: [On-chain programs](https://docs.phoenix.trade/sdk/on-chain-programs), [Accounts](https://docs.phoenix.trade/sdk/accounts), [Trader onboarding](https://docs.phoenix.trade/sdk/register), [LiteSVM testing](https://docs.phoenix.trade/sdk/litesvm-testing), [rise-public SDK](https://github.com/Ellipsis-Labs/rise-public), [UpScalp integration pack](https://github.com/UpScalp/upscalp-phoenix-integration-pack)
