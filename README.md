# Protean — DAO Governance Bot for Telegram, Discord and Slack

Turns a group chat into a fully functioning DAO. Deploy a governance system under any of ten models, get a wallet, stake, propose, vote, trade decision markets, and place confidential bets — all without leaving the chat. Runs on Telegram, Discord and Slack, and on Monad, Base and HyperEVM.

Contracts live in the companion repo, [`Spaces`](https://github.com/replico-labs/Spaces). See its README for deployed addresses per network.

## Status

- **Contracts:** 539/539 Foundry tests pass (see Spaces).
- **Live on Monad testnet:** the full create → propose → vote → queue → execute loop has run through Telegram for token-weighted and Board DAOs, with real receipts.
- **Tested end to end on local chains** (anvil, with the real contracts deployed from source): every model's full lifecycle through the Discord and Slack handlers — the same command code Telegram uses for the shared paths — about 230 checks, including a GuardWrapper handover with a treasury payout confirmed by signers. The network layer has its own two-chain test: one bot process serving a "Monad" chain and a "Base" chain at once.
- **Not yet run live:** the other eight models on Monad testnet, anything on Base or HyperEVM (no factories deployed there yet), real Discord and Slack workspaces, the FHE relayer round-trip, and Switchboard's Crossbar round-trip. See [What's not verified yet](#whats-not-verified-yet).

## How wallets work

Every user gets their own independently generated wallet, created automatically the first time they need one — no external wallet app, no connect step. One wallet per user per chat platform; the same address works on every EVM network.

Each private key is **envelope-encrypted with AWS KMS** (AES-256-GCM, with a per-user data key wrapped by one symmetric KMS key) and stored in Supabase. The plaintext key only exists in memory for the instant a transaction is signed. A leaked database alone reveals nothing usable; decryption requires KMS access too.

This is still a **custodial** model — the bot's backend can decrypt any user's key. It trades some decentralization for zero-friction onboarding.

New wallets start empty, so the operator wallet sends a small gas top-up before a user's first transaction (and again when they run low). The amount is per network: 0.1 MON on Monad, 0.0002 ETH on Base, 0.01 HYPE on HyperEVM by default.

**Legacy wallets.** Earlier versions derived every Telegram wallet from a single `MASTER_WALLET_SEED`. If a user still has funds under that old address, the bot refuses to silently create a second wallet and asks them to run `/migratewallet` first, which sweeps the native balance across (ERC20 tokens must be moved manually — the command says so).

## Networks

| Network | id | Chain | Gas token | Notes |
|---|---|---|---|---|
| Monad testnet | `monad-testnet` | 10143 | MON | the default; all ten factories deployed |
| Monad mainnet | `monad-mainnet` | 143 | MON | |
| Base | `base` | 8453 | ETH | contracts must be built with Spaces' `size-limited` profile |
| Base Sepolia | `base-sepolia` | 84532 | ETH | same |
| HyperEVM | `hyperevm` | 999 | HYPE | same, plus big blocks for factory deploys |
| HyperEVM testnet | `hyperevm-testnet` | 998 | HYPE | same |

**Each chat's DAO lives on one network**, chosen when it's created or linked:

```
/createdao ArkDAO ARK 1000000 10000000 quadratic base
/createboarddao ArkBoard 0xA... 0xB... hyperevm
/register 0xGovernance... tokenWeighted base
```

The network word can go anywhere after the model; without one, the bot's default network is used. From then on every command in that chat reads and writes that chain. `/network` shows which one. Chats registered before networks existed are Monad testnet.

**Enabling a network** takes, per network: an entry in `NETWORKS`, factory addresses under that network's prefix (`BASE_FACTORY_ADDRESS`, `BASE_QUADRATIC_FACTORY_ADDRESS`, ...), and native gas in the operator wallet. An RPC is optional (`BASE_RPC_URL`; viem's public RPC otherwise). See `.env.example`.

What changes between networks, handled automatically:

- **Block-counted voting periods are rescaled.** Several governance periods are counted in blocks, and the defaults were written for Monad's 400 ms blocks: 50,400 blocks is ~5.6 h on Monad but ~28 h on Base. New DAOs get their block-counted fields scaled to the same wall-clock length (10,080 on Base, 20,160 on HyperEVM). Periods counted in seconds (timelocks, execution windows, Sowellian's challenge period) are unchanged.
- **Gas.** Every write estimates gas and adds a 50% buffer, because Monad charges the full gas limit, not gas used. On HyperEVM the buffer is capped at the 2M small-block limit; a transaction that genuinely needs more fails with an explanation, since its sender would have to switch to big blocks. Every model's DAO creation fits under 2M (the heaviest, Delegate, is ~1.29M).
- **The native token.** `/send 1 0x... ETH` on Base, `HYPE` on HyperEVM, `MON` on Monad — or `native` anywhere.

Opportunity Markets are separate and always on Ethereum Sepolia; Zama's FHE coprocessor doesn't exist on Monad, Base or HyperEVM.

## Commands

`/help` is model-aware: it only shows commands that apply to the current chat's governance model and linked wrappers/markets.

### Setup
- `/createdao <name> <symbol> <initialSupply> <maxSupply> [model] [network] [council...]` — deploy a DAO and link it here. Models: `tokenWeighted` (default), `quadratic`, `liquid`, `optimistic`, `delegate`, `sortition`, `conviction`, `sowellian`, `decisionMarkets`. `delegate` and `sortition` take the starting council as trailing addresses; sortition's randomness source comes from the bot's config.
- `/createboarddao <name> <signer1> <signer2> ... [network]` — deploy a Board (multisig) DAO; no token at all
- `/register <address> [model] [network]` / `/unregister` — link or unlink an existing DAO. `/register` checks the address really is that model's contract on that network.
- `/network` — which chain this chat's DAO is on, and which networks the bot supports
- `/deploywelcomedistributor <amountPerClaim> <cap>` / `/setdistributor <address>` — welcome tokens for new members; `/claim` (also automatic on join)
- `/deploynftwrapper` — the DAO's NFT wrapper (see [NFTs](#nfts))
- `/deployguardwrapper <requiredApprovals> <tenureSeconds> <signer...>` / `/registerguardwrapper <address>` / `/handovertowrapper <address>` — a security council (see [Guard wrapper](#guard-wrapper))

### Wallet and tokens
- `/wallet` · `/migratewallet` · `/balance [address]`
- `/tip <amount> <recipient> [token]` — hand out the DAO's operator-held supply (creator only)
- `/send <amount> <recipient> [token|native]` — send tokens or native currency you hold
- `/tokenbalance [token] [address|treasury]` · `/registertoken <ticker> <address>` · `/treasuryassets`
- `/stake <amount>` · `/unstake <amount>`

### The DAO
- `/dao` — name, token, treasury, full model-specific config
- `/treasury` · `/contribute` (treasury address, sent privately)
- `/proposals` · `/proposal <id>` — list, or full detail rendered for each model's own vote shape

### Proposing and deciding
- `/listactions` · `/proposeaction <actionId> <args...> <description>` — the verified action library: every native governance, Treasury, token and wrapper admin function, encoded for you, plus the external protocol actions available on the chat's network (see [External protocol actions](#external-protocol-actions)). After a GuardWrapper handover, Treasury and token actions are routed through the wrapper automatically.
- `/actioninfo <actionId>` — an action's arguments, options, and the sources its contract addresses were checked against
- `/propose <target> <value> <data> <description>` — raw calldata, for anything else
- `/vote <id> for|against|abstain [reason]` · `/queue <id>` · `/execute <id> [nativeValue]` · `/cancel <id>`

### Model-specific
| Model | Commands |
|---|---|
| Board | `/confirm <id>`, `/revoke <id>` |
| Liquid | `/delegate <address>`, `/undelegate` |
| Optimistic | `/challenge <id>` |
| Conviction | `/support <id>`, `/withdrawsupport`, `/mysupport` |
| Delegate | `/startelection`, `/declarecandidacy`, `/voteinelection`, `/finalizeelection`, `/initiaterecall`, `/voterecall`, `/finalizerecall`, `/council` |
| Sortition | `/registereligible`, `/withdraweligibility`, `/startsortition`, `/settlesortition`, `/finalizesortition`, `/council` |
| Sowellian | `/proposecriteria`, `/deploychainlinkoracle`, `/castapprovalvote`, `/finalizeapproval`, `/takeposition`, `/resolveviaoracle`, `/proposeresolution`, `/challengeresolution`, `/finalizeunchallenged`, `/castadjudicationvote`, `/finalizeadjudication`, `/claimposition` |
| Decision Markets | `/proposemarket`, `/split`, `/trade`, `/merge`, `/finalizeproposal`, `/redeem`, `/unwrap`, `/reclaimliquidity` |

Bonds and seeds (Optimistic challenges, Sowellian bonds and positions, Decision Markets seeds and trades) are approved automatically before the contract pulls them.

### Guard wrapper
- `/guardwrapper` — signers, threshold, tenure
- `/instruction <id>` · `/confirminstruction <id>` · `/rejectinstruction <id>` · `/revokeconfirmation <id>`

### Sowellian oracle proposals
```
/proposecriteria <target> <value> <data> oracle <adapter|switchboard> <feedId|-> <targetValue> min|max <measurementPeriodSeconds> <description>
```
- **Switchboard:** type the literal word `switchboard` (uses the network's `SWITCHBOARD_ORACLE_ADAPTER`) and pass the real 32-byte Switchboard `feedId`. One adapter serves every feed.
- **Chainlink:** run `/deploychainlinkoracle <chainlinkFeedAddress>` first, then pass the returned adapter address and `-` as the feed ID. Chainlink needs one adapter per feed, because each Chainlink feed is its own contract.
- **Human track:** `human - -` in the oracle and feed slots.

### Opportunity Markets (Ethereum Sepolia, FHE-encrypted)
- `/createmarket <underlyingToken>` · `/registermarket <address>` · `/unregistermarket`
- `/listopportunity <metadataURI>` · `/deposit <amount>` · `/back <opportunityId> <amount>` (confidential)
- `/mybalance` · `/mybet <index>` · `/allbets` · `/analytics` (deployer only, sent privately: total staked, average bet, average per bettor and largest bet, overall and per opportunity, plus each opportunity's share of all stake. Built from the bets the contract already lets the deployer decrypt; nothing new is revealed publicly)
- `/fundrewardpool` · `/resolve <id>` · `/cancelmarket` (deployer only)
- `/reclaimstake` · `/computereward` · `/revealwinningtotal` · `/withdraw` · `/withdrawreward`

`/registermarket` only accepts addresses the configured `OpportunityMarketFactory` reports as its own (`isMarket`).

## External protocol actions

`/proposeaction` can also propose actions on outside protocols. The DAO's funds sit in its Treasury, so each action is one proposal made of several `Treasury.execute(target, value, data)` steps (approve, then act), with the protocol seeing the Treasury as the caller. NFT actions go through the DAO's NFT wrapper instead. After a GuardWrapper handover, every step is routed through the wrapper like any other Treasury action. An action is offered only on networks where its protocol is deployed.

Arguments are positional, then `name=value` options (`/actioninfo` lists them), then the description. Minimum-out amounts are fixed when proposing, and deadlines default to 30 days, so a price that moves too far before execution makes the proposal revert rather than fill badly.

| Protocol | Networks | Actions |
|---|---|---|
| Uniswap v4 | Monad, Monad testnet (Monad-maintained), Base, Base Sepolia | `uniswap-swap`, `uniswap-add-liquidity`, `uniswap-remove-liquidity`, `uniswap-collect-fees` |
| Aave v3 | Monad, Base, Base Sepolia | `aave-supply`, `aave-withdraw`, `aave-borrow`, `aave-repay`, `aave-collateral` |
| shMON (FastLane) | Monad | `shmon-stake`, `shmon-unstake-instant`, `shmon-request-unstake`, `shmon-complete-unstake` |
| Nad.fun | Monad, Monad testnet | `nadfun-buy`, `nadfun-sell` |
| Perpl | Monad, Monad testnet | `perpl-deposit`, `perpl-withdraw`, `perpl-open`, `perpl-close` |
| OpenSea (Seaport 1.6) | Monad, Base, HyperEVM | `opensea-list`, `opensea-update-listing`, `opensea-cancel-listing`, `opensea-buy` — needs `OPENSEA_API_KEY` |
| Aerodrome | Base | `aerodrome-swap`, `aerodrome-add-liquidity`, `aerodrome-remove-liquidity` |
| Lido wstETH | Base | `lido-buy-wsteth`, `lido-sell-wsteth` — through Aerodrome, with the minimum set from Lido's own wstETH/stETH rate feed |
| Flaunch | Base, Base Sepolia | `flaunch-buy`, `flaunch-sell` — planned by Flaunch's SDK (pinned), current-generation coins only |
| HyperLend | HyperEVM ⚠ | `hyperlend-supply`, `hyperlend-withdraw`, `hyperlend-borrow`, `hyperlend-repay`, `hyperlend-collateral` |
| HyperCore | HyperEVM ⚠, HyperEVM testnet ⚠ | `hypercore-deposit-hype`, `hypercore-deposit-usdc`, `hypercore-order`, `hypercore-cancel`, `hypercore-usd-transfer`, `hypercore-withdraw` |
| HyperSwap (v3) | HyperEVM | `hyperswap-swap` |
| Kinetiq kHYPE | HyperEVM ⚠ | `kinetiq-buy-khype`, `kinetiq-sell-khype` — through HyperSwap, with the minimum set from Kinetiq's own kHYPE→HYPE rate |

⚠ marks deployments whose addresses or encodings come from a source other than the protocol's own (each shows the warning in `/actioninfo`):
- HyperLend's registry address is from DefiLlama.
- HyperCore's encodings are from hyper-evm-lib, which Obsidian Audits maintains.
- Kinetiq's kHYPE and rate contract are from DefiLlama and a community CLI.

**Check addresses before enabling a network:** `npm run verify:integrations [network ...]`. It reads every address over the real RPCs and checks four things:
- every contract has code;
- the protocols' cross-references hold (for example, that a router's factory is the factory listed here);
- known token symbols are as expected;
- protocol-specific facts, such as HyperCore's precompiles agreeing on the USDC and HYPE token indexes.

It sends nothing. It hasn't been run against the real networks yet (see below).

**Not available, and why:**
- **Avantis (Base).** It became Veranta in September 2026. Its v2 contracts' ABIs are not published, and trading goes through off-chain signed intents that a Treasury contract can't sign.
- **Staking directly with Kinetiq (HyperEVM).** No official source for the staking contract's interface was reachable. `kinetiq-buy-khype` covers the same need through HyperSwap.
- **HyperSwap v2.** Its router adds a `referral` argument, and HyperSwap doesn't publish that router's ABI. Swaps use HyperSwap v3.
- **Lido direct staking on Base.** The CCIP direct-staking contracts publish no verifiable interface. `lido-buy-wsteth` covers the same need through Aerodrome.
- **Flaunch on HyperEVM.** Flaunch isn't deployed there.

HyperCore note: Core applies CoreWriter actions just after the EVM transaction. A proposal can execute successfully while Core rejects the order (tick size, no balance, no fill). The bot checks Hyperliquid's tick and lot rules before proposing, and says so in every summary.

## NFTs

The Treasury can't receive NFTs (it has no ERC721/ERC1155 receiver hooks), so **a DAO's NFTs live in its NFT wrapper** (`/deploynftwrapper`):

- Send NFTs to the wrapper's address, never to the Treasury.
- Governance lists them (`nftwrapper-approve-order-hash`), sends them out (`nftwrapper-transfer-erc721` / `-erc1155`, which refuse the Treasury as a recipient), or calls a marketplace directly (`nftwrapper-execute`).
- Sale proceeds go back to the Treasury with `nftwrapper-sweep-native` / `-erc20`.
- Every one of those is a proposal (`/proposeaction`). To buy an NFT, first move funds from the Treasury to the wrapper (`treasury-transfer-eth` / `-erc20`).

## Discord and Slack

Every Telegram command also runs on Discord and Slack, except `/start` (use `help`) and `/migratewallet` (legacy seed wallets only ever existed for Telegram IDs). Each platform runs as its own process sharing the same `data/` volume, wallet store and chain config as the Telegram bot. Neither needs `TELEGRAM_BOT_TOKEN`.

```bash
npm run discord   # DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, optional DISCORD_GUILD_ID
npm run slack     # SLACK_APP_TOKEN + either SLACK_BOT_TOKEN (one workspace) or the "Add to Slack" settings below
```

- **Discord** registers 98 native slash commands on startup (Discord allows 100 per bot). `/register` and `/unregister` default to members with *Manage Server*. Long replies are split across messages.
- **Slack** uses one command, `/protean <subcommand>` (e.g. `/protean vote 3 for`). Create the app from [`docs/slack-app-manifest.yml`](docs/slack-app-manifest.yml). Joining a channel with a welcome distributor sends the newcomer their tokens, as on Telegram.
- **Slack in any workspace:** with `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` and `SLACK_PUBLIC_URL` set, the Slack process also serves an "Add to Slack" link at `<SLACK_PUBLIC_URL>/slack/install` (on `PORT`, so the service needs a public domain). Each workspace's bot token is stored encrypted under the wallets' KMS key, in Supabase's `slack_installations` table (`supabase/schema.sql`); uninstalling deletes it. Install into your own workspace through the same link, then activate public distribution. Without `SLACK_CLIENT_ID` it runs in one workspace on `SLACK_BOT_TOKEN`. Slack doesn't list Socket Mode apps in its App Directory, so share the link directly.
- **Privacy:** anything Telegram sends by DM (bets, confidential balances, rewards, handover proposals, the treasury address from `contribute`) is shown only to the caller: an ephemeral reply on Discord (which also hides the options typed), an ephemeral response on Slack. So `back` takes its opportunity and amount directly — they never appear in the channel.
- **Link vs creator:** whoever runs `register` becomes the channel's *linker* (can relink/unlink); whoever runs `createdao`/`createboarddao` is the DAO's *creator* (can also `tip`, deploy wrappers and distributors). Registering an existing DAO never grants creator rights. Server/workspace admins can always relink.
- **Errors** name the contract's reason, e.g. `AlreadyConfirmed`.

Command logic lives in `src/platforms/commands/` (grouped as core, setup, tokens, models, sowellian, markets, opportunity); `discord.js` and `slack.js` only handle transport.

## Notifications

Every platform's process polls its linked DAOs (every 20 s) and posts proposal created / queued / executed / cancelled, plus model-specific events, to the linked chat. Each network is polled separately, and ranges are fetched in ≤90-block chunks (Monad testnet caps `eth_getLogs` at 100 blocks), saving progress after each chunk.

## Setup

```bash
npm install
cp .env.example .env
# If using KMS wallets: run supabase/schema.sql once in your Supabase SQL editor
npm start
```

| Variable | Required for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | the Telegram bot | from BotFather |
| `RPC_URL` | optional | Monad testnet; viem's public RPC by default |
| `NETWORKS`, `DEFAULT_NETWORK` | more than one network | see [Networks](#networks) |
| `OPERATOR_PRIVATE_KEY` | `/createdao`, `/claim`, gas top-ups, keepers | a funded hot wallet on every enabled network — see Security |
| `FACTORY_ADDRESS` + `<MODEL>_FACTORY_ADDRESS` | `/createdao` per model | per network with a prefix (`BASE_FACTORY_ADDRESS`); a model with no address can't be created there, but can still be `/register`ed |
| `SORTITION_RANDOMNESS_SOURCE` | `/createdao ... sortition` | deployed `SwitchboardRandomnessAdapter`, per network |
| `SWITCHBOARD_ORACLE_ADAPTER` | `switchboard` shorthand in `/proposecriteria` | deployed `SwitchboardPriceFeedAdapter` (optional), per network |
| `SWITCHBOARD_ADDRESS` | keepers | Switchboard's own proxy, not our adapter, per network |
| `KMS_KEY_ID`, `AWS_REGION`, AWS credentials | KMS wallets | symmetric KMS key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | KMS wallets | service_role key — RLS allows nothing else |
| `MASTER_WALLET_SEED` | legacy wallets only | keep set only while old wallets still hold funds |
| `OPPORTUNITY_MARKET_RPC_URL`, `OPPORTUNITY_MARKET_FACTORY_ADDRESS` | Opportunity Markets | Sepolia |
| `DISCORD_*`, `SLACK_*` | Discord / Slack | see above |

### Keepers

Switchboard is pull-based: someone has to submit randomness settlements and price updates. Two standalone keepers do it, paying gas from the operator wallet. Neither needs a chat token. **Each keeper process serves one network** — set `KEEPER_NETWORK` (default: the default network) and that network's `SWITCHBOARD_ADDRESS`; run one per network that has Sortition or Sowellian DAOs.

- **Sortition randomness** — `npm run keeper:sortition`. `startSortition()` only *requests* randomness; after the settlement delay the keeper fetches the signed result and settles it (anyone can also do this with `/settlesortition`). Polls every 30 s.
- **Sowellian price feeds** — `npm run keeper:switchboard`. Finds oracle-track proposals whose measurement period has ended and whose oracle is the Switchboard adapter, pushes a fresh signed update from Crossbar, and resolves them in the same cycle (so the data is inside `maxOracleStaleness`). Skips Chainlink, which updates itself. Polls every 60 s. Optional: `SWITCHBOARD_FEED_IDS` (feeds to keep fresh on a timer), `SWITCHBOARD_REFRESH_SECONDS` (default 300), `SWITCHBOARD_NETWORK` (Crossbar's `testnet`/`mainnet`; defaults from the chain), `CROSSBAR_URL`.

## Security — read before deploying anywhere real

- **Never paste private keys into chats, commands, or shell history.** Use `export PRIVATE_KEY=...` and reference `$PRIVATE_KEY`. Any key that has appeared in plaintext should be treated as burned.
- **`OPERATOR_PRIVATE_KEY`** pays gas for `/createdao`, `/claim`, keeper transactions, and user top-ups — on every enabled network. Keep it funded, but not over-funded; on mainnets especially, set the top-up amounts deliberately (`<PREFIX>_GAS_TOPUP_FIRST` etc.).
- **KMS IAM scope.** The bot's AWS credentials should only be able to `Decrypt` and `GenerateDataKey` on the one key — not manage or delete it.
- **`SUPABASE_SERVICE_ROLE_KEY`** bypasses Row Level Security by design. Treat it like a database root password.
- **`MASTER_WALLET_SEED`** (legacy) can derive every old wallet's key. Remove it once no old wallet holds funds.

## Known limitations

- **`/createdao` mints the initial supply to the operator wallet**, not the person who ran the command, and records the operator as `creator` on-chain. `/tip` and welcome distributors are how it reaches members.
- **Chainlink coverage is limited.** Not every metric has a Chainlink feed on every chain; Switchboard covers far more.
- **Wrapped native is never auto-unwrapped.** Redeeming or reclaiming on a Decision Markets quote side returns the wrapped token; `/unwrap` converts it back.
- **`data/chats.json` is a flat file.** Fine for now; swap for a database before scaling.

## What's not verified yet

- The other eight governance models through real Telegram sessions on Monad testnet (they pass on local chains through the shared command code)
- Anything on Base or HyperEVM — no factories deployed there yet
- **External protocol actions against the live protocols.** Each was tested on local chains through a real Board DAO:
  - Uniswap, Aerodrome, Lido-via-Aerodrome and Seaport ran against those protocols' real compiled contracts. HyperSwap and kHYPE-via-HyperSwap ran against Uniswap's real v3 contracts (HyperSwap v3 is a Uniswap v3 fork).
  - Aave, HyperLend, shMON, Nad.fun, Perpl, Flaunch and HyperCore ran against stand-ins with the protocols' exact function signatures.
  - HyperCore's action bytes were also compared with those produced by hyper-evm-lib.

  `npm run verify:integrations` has not been run against the real networks.
- Real Discord and Slack workspaces
- The FHE relayer round-trip for confidential bets and decryption (Opportunity Markets)
- Switchboard's Crossbar round-trip for sortition settlement and price updates

## Not built yet

- **Avantis/Veranta actions**, and **direct staking with Lido (Base) or Kinetiq (HyperEVM)**. They are blocked on unpublished or unreachable interfaces; see [External protocol actions](#external-protocol-actions).
- Group-wide gas sponsorship with spending limits

## Architecture

```
src/
├── index.js              Telegram command handlers, model-aware /help
├── platforms/            Discord + Slack front-ends over a shared command core
├── networks.js           network registry, per-call network context, block scaling, per-network gas
├── config.js             viem clients and settings that follow the current network, operator wallet
├── contracts.js          token-weighted reads/writes, gas top-ups, wrapper/distributor deploys
├── governance/           one adapter per model + shared helpers (common.js, index.js registry)
├── actionLibrary.js      verified native actions for /proposeaction
├── proposalBuilder.js    action encoding + GuardWrapper routing, shared by every platform
├── wrapper.js            GuardWrapper reads/writes
├── eventListener.js      chat notifications, per platform and per network
├── db.js                 chat ↔ DAO / model / network / wrapper / market links (flat JSON)
├── walletResolver.js     KMS-first wallet resolution, legacy migration guard
├── kmsWallet.js          KMS envelope encryption
├── walletStore.js        Supabase persistence for encrypted keys
├── wallet.js             legacy seed-derived wallets
├── opportunityMarket/    Sepolia config, market actions, FHE encryption, user + public decrypt
├── keepers/              standalone Switchboard keepers (sortition randomness, Sowellian price feeds)
└── abis/                 compiled ABIs (and bytecode for on-demand deployment)
supabase/schema.sql       wallets table, RLS enabled
docs/slack-app-manifest.yml
```

`src/abis/*.json` is copied from Spaces' Foundry output. **Whenever a contract changes, re-extract and copy its ABI/artifact here** — the bot has no compiler and silently keeps using the old one otherwise.

## Deploying persistently

The bots use long polling / sockets, so they need long-lived processes — not serverless. The bots and keepers all use `data/` (the keepers read it to find DAOs), so they must share one persistent volume. Railway attaches a volume to a single service, so there run them together in one service, leaving out any you haven't configured:

```bash
sh -c "npm start & npm run discord & npm run slack & KEEPER_NETWORK=monad-testnet npm run keeper:sortition & wait"
```

With "Add to Slack" enabled, give that service a public domain; Railway's `PORT` is where the install page listens. The commands:

| Service | Command |
|---|---|
| Telegram bot | `npm start` |
| Discord bot | `npm run discord` |
| Slack bot | `npm run slack` |
| Sortition keeper (per network) | `KEEPER_NETWORK=<id> npm run keeper:sortition` |
| Price-feed keeper (per network) | `KEEPER_NETWORK=<id> npm run keeper:switchboard` |

## Try it live

[**@proteandao_bot**](https://t.me/proteandao_bot) — when it's deployed and running.
