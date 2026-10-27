# Trading and external protocols

Perps, the trading desk, and the external protocol actions `/proposeaction` can call.

## Perps (`/perps`)

One command for perpetuals on whichever exchange the chat's network has: **Perpl** on Monad and **HyperCore** on HyperEVM.
- Base has none: Avantis has no public docs or SDK to build against.
- Solana DAOs trade perps through the **Phoenix desk** below (`/desk`), on mainnet only; `/perps` in a Solana chat points there.

| Command | What it does |
|---|---|
| `/perps` | the Treasury's collateral and open positions (size, entry, mark, PnL, margin) |
| `/perps markets` | mark prices (HyperCore: top 20 by volume, with hourly funding) |
| `/perps long\|short <market> <size> at <limitPrice> [3x] [description]` | proposes opening or adding to a position |
| `/perps close <market> <size\|all> at <limitPrice> [description]` | proposes closing or reducing one; the side is read from the position |
| `/perps deposit <amount>` / `/perps withdraw <amount>` | proposes moving collateral (HyperCore: USDC into the perp balance / perp → spot) |

- **Reads answer straight away.** Everything else becomes a normal proposal, through the same `perpl-*` / `hypercore-*` actions as `/proposeaction`, so the Treasury only trades by vote.
- **Orders are immediate-or-cancel at the limit price.** A proposal executes hours or days after it's written, and the limit stops a stale one filling at a bad price.
- **Without a description,** one is written from the order.
- **Perpl:** positions and prices come from the exchange contract. The Treasury must be whitelisted by Perpl while whitelisting is on, and `/perps` warns when it isn't.
- **HyperCore:**
  - Positions and prices come from Hyperliquid's public info API.
  - A market name is resolved there, then checked against HyperCore's own precompile before anything is proposed.
  - Leverage can't be set from a contract (CoreWriter has no leverage action), so orders use the account's current setting for that market, and `3x` is refused with that explanation.

## Trading desk (`/desk`)

`/perps` trades only by vote. A **trading desk** lets the group appoint traders by proposal. Each trader then trades from the chat with no vote per trade, inside limits the group agreed to, and can never take the money. It runs on **Perpl** (Monad) and **HyperCore** (HyperEVM), with the same commands.

**Several traders.** A desk can have as many traders as the group appoints, each with their own mandate. `/desk` numbers them, and commands that need one take that number or the trader's address.
- **Perpl:** each trader gets their own desk account, funded separately, so one trader's losses never touch another's collateral.
- **HyperCore:** traders share the Treasury's one HyperCore account, where each market holds a single position. So each market belongs to one trader at most: an application for a market another trader has is refused, and a trader opens and closes only in their own markets. `total` counts the whole desk, since they share one cross margin.

| Command | Who | What it does |
|---|---|---|
| `/desk` | anyone | the desk: its traders (numbered) and mandates, collateral, open positions with PnL (HyperCore: each labelled with its trader), pending appointments; with a PnL card (an image of each position's PnL) |
| `/desk mine` | a trader | their own positions (Perpl: their desk; HyperCore: their markets), how much of `max` each uses, markets they hold nothing in, the desk `total` used, and today's PnL against `loss`; with a PnL card of their own |
| `/desk apply <markets\|all> max=<size> [total=<size>] [loss=<size>] [lev=2] [days=30]` | the would-be trader | proposes appointing themselves (a trader applying again proposes a new mandate for themselves), e.g. `/desk apply BTC,ETH max=500 total=800 loss=50 lev=3 days=30` (max = the largest position in one market, total = all positions together, loss = the most they may lose in a day; all in the collateral token) |
| `/desk fund <amount> [for=<n>]` / `/desk withdraw <amount> [for=<n>]` | anyone | proposes moving collateral from the Treasury into a trader's desk, or back (Perpl; `for=` is needed once there are several desks. HyperCore has one account, so it's ignored) |
| `/desk remove [n]` | anyone | proposes removing a trader (`n` is needed once there are several) |
| `/desk long\|short <market> <size> at <limitPrice> [3x]` | the trader | opens or adds to a position, straight away |
| `/desk close <market> <size\|all> at <limitPrice>` | the trader | closes or reduces one, straight away |
| `/desk resign` | the trader | steps down (Perpl: on-chain; HyperCore: the bot destroys the desk's agent key) |
| `/desk pause` / `/desk resume` | chat admins, or the DAO's creator | stops new positions for every trader at once, without waiting for a vote; closing stays allowed |

**How it's built on Perpl.** Each trader's desk is a Perpl [DelegatedAccount](https://github.com/PerplFoundation/delegated-account), made by Perpl's own factory. It's an exchange account **owned by the Treasury**, with the trader's bot wallet as its **operator**.
- **The operator can only trade.** It can call only the exchange's trading functions through the desk: orders, margin top-ups, deposits, liquidation buys. Withdrawing and rescuing tokens are the owner's alone, and both always pay the owner, the Treasury.
- **The trader consents.** `/desk apply` has the trader's wallet sign Perpl's EIP-712 `AssignOperator` consent. The proposal adds them to their own desk if they already have one (a new mandate), or to a desk whose trader has gone (`perpl-desk-appoint`), and otherwise creates a new desk with them as operator (`perpl-desk-create`).
- **The new desk is picked up automatically.** When the proposal executes, the listener reads the desk's address from the receipt (the factory's `DelegatedAccountCreated` event, with this Treasury as owner and the trader as operator) and announces the trader. `/desk link <address>` links a desk by hand; it only accepts a Perpl-factory desk on this exchange owned by this Treasury.
- **Funding, withdrawing and removing** are ordinary proposals (`perpl-desk-fund`, `-withdraw`, `-remove`). The bot checks every desk address it puts into a proposal against Perpl's beacon, this exchange, and this Treasury as owner.

**The mandate** (markets, largest position, optional total, optional daily loss, leverage, days) is written into the appointment proposal, so voters see what they agree to. Its clock starts when the proposal executes. On every trade the bot checks that:
- the trader is still the operator on-chain (HyperCore: their agent is still approved)
- the desk isn't paused, and the mandate hasn't ended (closing stays allowed either way)
- the market is in the mandate
- the leverage is within it
- the whole position, at the limit price, is within `max`
- with `total`, all positions together are within it: cross margin means a loss in one market eats every market's collateral
- with `loss`, the trader hasn't lost that much today (UTC): what the bot's own closes realized today, plus the change in their open positions' PnL since the bot first looked today. Past it, they can only close until 00:00 UTC. The bot counts this itself: a Perpl close counts at the trader's limit price (the worst it could fill at), a HyperCore close at its fill price, and liquidations and funding payments aren't seen. It's a stand-in for an on-chain drawdown limit, not one.

Orders are immediate-or-cancel at the limit price, signed by the trader's own wallet. Every trade is posted in the chat with what filled.

**Notices in the chat.** The listener posts when a trader is appointed (the proposal executed and the trader is the operator on-chain, or on HyperCore their agent is listed) and when one is removed, each with **📈 Desk** and **👤 My trading** buttons; `desk pause` and `resume` reply with the same buttons. Pending appointments are rechecked every minute, a desk with none every ten.

**What is enforced where:**
- **The mandate is enforced by the bot,** not by Perpl's contract, which has no such limits. It holds because the trader's key stays in the bot's KMS wallet store and is never handed out, so every trade goes through these checks.
- **What holds on-chain no matter what:**
  - the trader can never withdraw
  - the DAO can only lose what it moved into the desk
  - only a proposal can fund the desk, withdraw from it, or appoint and remove its trader

Perpl's whitelist applies to the desk's address while whitelisting is on; `/desk fund` warns.

### HyperCore desk

Hyperliquid has no trade-only account a contract can own, and its API wallets ("agents") can't be limited to trading: the SDK even has `agentSendAsset`, a transfer signed by the agent. So on HyperCore the trader never gets a key at all.
- **The desk is the Treasury's own HyperCore account.** `desk fund` proposes moving USDC from the Treasury on HyperEVM to its HyperCore perps balance (`hypercore-deposit-usdc`); `desk withdraw` proposes moving it to the spot balance (`hypercore-usd-transfer`). Both are votes.
- **The bot holds the agent key.** `desk apply` makes a fresh agent key for the appointment, stored encrypted with KMS like a member's wallet (platform `hl-agent`). The appointment proposal has the Treasury approve that agent through CoreWriter (`hypercore-approve-agent`, action 9), with the mandate in its description. Each trader's agent has a name of its own (`protean-desk-1`, `-2`, ...); a trader applying again keeps theirs.
- **The trader trades from the chat,** and the bot signs each order with the agent key only after the mandate checks above. Orders are immediate-or-cancel at the trader's limit price; leverage is set per order (cross margin), which an agent can do and a contract can't.
- **Replacing, removing, resigning.** Approving a new agent under the same name replaces the old one on HyperCore, so a trader's new appointment revokes their previous agent. `desk remove <n>` proposes approving a throwaway address under that trader's agent name. In both cases the bot destroys the old key once the proposal executes. `desk resign` destroys the key straight away.
- **What Hyperliquid itself enforces** (checked on testnet with `HL_TESTNET_KEY=0x... node scripts/hl-agent-check.mjs`):
  - an agent can't send its principal's funds to anyone else: `agentSendAsset` only moves them within the account and its sub-accounts, and `usdSend`/`withdraw3` only act for whoever signs them, so an agent's signature reaches only its own empty account;
  - approving a new agent under the same name cuts the old one off straight away (how the bot replaces and removes traders);
  - each agent has an expiry (`validUntil`; about 90 days after approval on testnet);
  - only one agent change at a time: while a removal is still being processed, another change is refused ("pending agent removal").

  Sub-accounts weren't tested: testnet allows them only after $100k of trading volume.
- **How the bot follows it:**
  - A mandate ends when its agent expires, if that comes before its own last day. `/desk` and `/desk mine` show the date, and an application for more than 90 days says so up front. Once the agent has expired, closing needs a new appointment or a `perps close` proposal, since the agent signs every order.
  - CoreWriter actions fail silently, so an executed appointment HyperCore never lists (refused while another agent change was pending, or past the account's agent limit) shows in `/desk` as waiting. After 10 minutes the bot drops it, destroys its unused key and tells the chat to propose it again.
  - A removal HyperCore refuses still can't trade: the bot destroys the key either way, so the agent just sits unused until it expires.
- **What a breach could cost:** if the bot's keys leaked, they could trade the desk badly but, by the checks above, not move its money out. Even so, keep on HyperCore only what the desk (and `/perps`) need: the Treasury on HyperEVM is out of HyperCore's reach.
- **Hyperliquid limits how many named agents an account can have.** An appointment past that limit executes on HyperEVM but doesn't take effect on HyperCore, and is dropped as above. The exact limit isn't checked here.
- **Not live-tested yet:** the CoreWriter encoding is from hyper-evm-lib (`CoreWriterLib.addApiWallet`), and orders are signed by Hyperliquid's own SDK (`@nktkas/hyperliquid`), but no desk has run against Hyperliquid itself. `scripts/test-hypercore-desk.mjs` runs the whole flow on a local chain against a stand-in Hyperliquid API; `scripts/test-perpl-desk.mjs` does the same for Perpl against stand-in Perpl contracts.

### Phoenix desk (Solana)

`/desk` in a chat linked to a Solana DAO on mainnet (`src/solana/deskPhoenix.js`). The same commands as above, plus `/desk register`.

- **Registering:** `/desk register` puts the Treasury on Phoenix once, through Phoenix's onboarding API for apps without a referral code. That path takes a PDA as the trader authority (the Treasury never signs); the operator pays.
- **One isolated subaccount per trader.** The Treasury's cross account (subaccount 0) receives deposits; each trader gets their own isolated subaccount (1, 2, ...). On-chain, a trader's losses stop at what their subaccount holds, and an isolated subaccount holds one market's position at a time.
- **The trader's key is the bot's.** Appointing a trader makes a fresh Solana key, kept encrypted like user wallets (walletStore `phoenix-agent`). The appointment proposal (`phoenix-appoint`) delegates the subaccount to it as Phoenix's position authority. The bot checks each order against the mandate, then signs it with that key; the operator pays the fee.
- **What Phoenix enforces regardless of the bot** (checked against Phoenix's mainnet programs in LiteSVM, `scripts/test-phoenix-flow.mjs`): the key can trade its subaccount but can't withdraw from it, can't sign for the Treasury, and can't pull the cross account's collateral into its subaccount. Re-delegating cuts the old key off at once.
- **Money moves by proposal:** `desk fund` (`phoenix-fund`: USDC wrapped by Phoenix's Ember, deposited into the cross account, then moved into the subaccount) and `desk withdraw` (`phoenix-withdraw`: the subaccount's collateral back to the cross account, withdrawn and unwrapped to USDC). These proposals need v1 transactions (973 and 1,792 bytes).
- **Removing a trader:** `desk remove` (`phoenix-remove`) delegates the subaccount back to the Treasury itself, so only proposals can trade it, and the bot destroys the key. `desk resign` destroys the key at once; the position then waits for a new appointment or a removal.
- **Leverage** is what the position would be against the subaccount's collateral, checked against the mandate's `lev`. Orders are immediate-or-cancel at the trader's limit price.
- **Not live-tested yet:** the instructions are the ones the LiteSVM test runs, but the desk itself (Phoenix's API for accounts, markets, positions and registration) hasn't run against mainnet. It needs the hub on mainnet first.

## External protocol actions

`/proposeaction` can also propose actions on outside protocols.
- **How they run:** the DAO's funds sit in its Treasury, so each action is one proposal made of several `Treasury.execute(target, value, data)` steps (approve, then act). The protocol sees the Treasury as the caller.
- **NFT actions** go through the DAO's NFT wrapper instead.
- **After a GuardWrapper handover,** every step is routed through the wrapper.
- **Availability:** an action is offered only on networks where its protocol is deployed.
- **Arguments:** positional, then `name=value` options (`/actioninfo` lists them), then the description.
- **Price protection:** minimum-out amounts are fixed when proposing, and deadlines default to 30 days. A price that moves too far before execution makes the proposal revert rather than fill badly.

| Protocol | Networks | Actions |
|---|---|---|
| Uniswap v4 | Monad, Monad testnet (Monad-maintained), Base, Base Sepolia | `uniswap-swap`, `uniswap-add-liquidity`, `uniswap-remove-liquidity`, `uniswap-collect-fees` |
| Aave v3 | Monad, Base, Base Sepolia | `aave-supply`, `aave-withdraw`, `aave-borrow`, `aave-repay`, `aave-collateral` |
| shMON (FastLane) | Monad | `shmon-stake`, `shmon-unstake-instant`, `shmon-request-unstake`, `shmon-complete-unstake` |
| Nad.fun | Monad, Monad testnet | `nadfun-buy`, `nadfun-sell` |
| Perpl | Monad, Monad testnet | `perpl-deposit`, `perpl-withdraw`, `perpl-open`, `perpl-close` |
| OpenSea (Seaport 1.6) | Monad, Base, HyperEVM | `opensea-list`, `opensea-update-listing`, `opensea-cancel-listing`, `opensea-buy`; needs `OPENSEA_API_KEY` |
| Aerodrome | Base | `aerodrome-swap`, `aerodrome-add-liquidity`, `aerodrome-remove-liquidity` |
| Lido wstETH | Base | `lido-buy-wsteth`, `lido-sell-wsteth`; through Aerodrome, with the minimum set from Lido's own wstETH/stETH rate feed |
| Flaunch | Base, Base Sepolia | `flaunch-buy`, `flaunch-sell`; planned by Flaunch's SDK (pinned), current-generation coins only |
| HyperLend | HyperEVM ⚠ | `hyperlend-supply`, `hyperlend-withdraw`, `hyperlend-borrow`, `hyperlend-repay`, `hyperlend-collateral` |
| HyperCore | HyperEVM ⚠, HyperEVM testnet ⚠ | `hypercore-deposit-hype`, `hypercore-deposit-usdc`, `hypercore-order`, `hypercore-cancel`, `hypercore-usd-transfer`, `hypercore-withdraw` |
| HyperSwap (v3) | HyperEVM | `hyperswap-swap` |
| Kinetiq kHYPE | HyperEVM ⚠ | `kinetiq-buy-khype`, `kinetiq-sell-khype`; through HyperSwap, with the minimum set from Kinetiq's own kHYPE→HYPE rate |

⚠ marks deployments whose addresses or encodings come from a source other than the protocol's own. Each shows the warning in `/actioninfo`:
- HyperLend's registry address is from DefiLlama.
- HyperCore's encodings are from hyper-evm-lib, maintained by Obsidian Audits.
- Kinetiq's kHYPE and rate contracts are from DefiLlama and a community CLI.

**HyperCore note:** Core applies CoreWriter actions just after the EVM transaction, so a proposal can execute while Core rejects the order (tick size, no balance, no fill). The bot checks Hyperliquid's tick and lot rules before proposing, and says so in every summary.

[Back to the README](../README.md)
