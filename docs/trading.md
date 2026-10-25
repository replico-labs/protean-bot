# Trading and external protocols

Perps, the trading desk, and the external protocol actions `/proposeaction` can call.

## Perps (`/perps`)

One command for perpetuals on whichever exchange the chat's network has: **Perpl** on Monad and **HyperCore** on HyperEVM.
- Base has none: Avantis has no public docs or SDK to build against.
- Solana DAOs will use **Phoenix**, which isn't built yet. New Phoenix accounts need an access or referral code, and it runs on mainnet only.

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
| `/desk` | anyone | the desk: its traders (numbered) and mandates, collateral, open positions with PnL (HyperCore: each labelled with its trader), pending appointments |
| `/desk mine` | a trader | their own positions (Perpl: their desk; HyperCore: their markets), how much of `max` each uses, markets they hold nothing in, and the desk `total` used |
| `/desk apply <markets\|all> max=<size> [total=<size>] [lev=2] [days=30]` | the would-be trader | proposes appointing themselves (a trader applying again proposes a new mandate for themselves), e.g. `/desk apply BTC,ETH max=500 total=800 lev=3 days=30` (max = the largest position in one market, total = all positions together, both in the collateral token) |
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

**The mandate** (markets, largest position, optional total, leverage, days) is written into the appointment proposal, so voters see what they agree to. Its clock starts when the proposal executes. On every trade the bot checks that:
- the trader is still the operator on-chain (HyperCore: their agent is still approved)
- the desk isn't paused, and the mandate hasn't ended (closing stays allowed either way)
- the market is in the mandate
- the leverage is within it
- the whole position, at the limit price, is within `max`
- with `total`, all positions together are within it: cross margin means a loss in one market eats every market's collateral

Orders are immediate-or-cancel at the limit price, signed by the trader's own wallet. Every trade is posted in the chat with what filled.

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
- **What a breach could cost:** if the bot's keys leaked, or `agentSendAsset` turns out to let an agent move funds, what's exposed is what the Treasury holds on HyperCore, not the Treasury on HyperEVM, which HyperCore can't reach. Keep on HyperCore only what the desk (and `/perps`) need. `HL_TESTNET_KEY=0x... node scripts/hl-agent-check.mjs` checks on Hyperliquid testnet whether an agent can move its principal's funds, and whether replacing it stops it.
- **Hyperliquid limits how many named agents an account can have.** An appointment past that limit would execute on HyperEVM but not take effect on HyperCore; `/desk` then keeps showing it as proposed. The exact limit isn't checked here.
- **Not live-tested yet:** the CoreWriter encoding is from hyper-evm-lib (`CoreWriterLib.addApiWallet`), and orders are signed by Hyperliquid's own SDK (`@nktkas/hyperliquid`), but no desk has run against Hyperliquid itself. `scripts/test-hypercore-desk.mjs` runs the whole flow on a local chain against a stand-in Hyperliquid API.

Phoenix (Solana) desks aren't built yet.

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
