# Protean — DAO Governance Telegram Bot

Turns a Telegram group into a fully functioning DAO. Deploy a governance system under any of ten models, get a wallet, stake, propose, vote, trade decision markets, and place confidential bets — all without leaving the chat.

Contracts live in the companion repo, [`Spaces`](https://github.com/replico-labs/Spaces). See its README for deployed addresses per network.

## Status

Every command is wired to real, deployed contracts on Monad testnet (Opportunity Markets on Ethereum Sepolia). The contract suite passes 468/468 tests. The bot itself has been verified structurally — real ABIs, real SDK interfaces, mocked network responses — but **has not yet been run end-to-end against the live deployment through real Telegram sessions**. See [What's not fully verified yet](#whats-not-fully-verified-yet) before relying on it for anything real.

## How wallets work

Every Telegram user gets their own independently generated wallet, created automatically the first time they need one — no external wallet app, no connect step.

Each private key is **envelope-encrypted with AWS KMS** (AES-256-GCM, with a per-user data key wrapped by one symmetric KMS key) and stored in Supabase. The plaintext key only exists in memory for the instant a transaction is signed. A leaked database alone reveals nothing usable; decryption requires KMS access too.

This is still a **custodial** model — the bot's backend can decrypt any user's key. It trades some decentralization for zero-friction onboarding.

**Legacy wallets.** Earlier versions derived every wallet from a single `MASTER_WALLET_SEED`. If a user still has funds under that old address, the bot refuses to silently create a second wallet for them and asks them to run `/migratewallet` first, which sweeps native MON across (ERC20 tokens must be moved manually — the command says so).

## Commands

`/help` is model-aware: it only shows commands that apply to the governance model the current group uses.

### Setup
- `/createdao <name> <symbol> <initialSupply> <maxSupply> [model] [council...]` — deploy a DAO and link it here. Models: `tokenWeighted` (default), `quadratic`, `liquid`, `optimistic`, `delegate`, `sortition`, `conviction`, `sowellian`, `decisionMarkets`. `delegate` and `sortition` take the starting council as trailing addresses; sortition's randomness source comes from the bot's config automatically.
- `/createboarddao <name> <signer1> <signer2> ...` — deploy a Board (multisig) DAO; no token at all
- `/register <address> [model]` / `/unregister` — link or unlink an existing DAO (admin)
- `/setdistributor <address>` — link a welcome-token distributor (admin)

### Wallet
- `/wallet` — your wallet address
- `/migratewallet` — move funds from a legacy derived wallet to your KMS wallet
- `/claim` — claim welcome tokens (also automatic on join, if a distributor is linked)

### DAO info
- `/dao` — name, token, treasury, full model-specific config
- `/treasury` · `/contribute` · `/balance [address]`

### Proposals (shared across models)
- `/proposals` · `/proposal <id>` — list, or full detail rendered correctly for each model's own vote shape
- `/propose <target> <value> <data> <description>` · `/queue <id>` · `/execute <id>` · `/cancel <id>`
- `/vote <id> for|against|abstain [reason]`
- `/stake <amount>` · `/unstake <amount>`

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

### Sowellian oracle proposals
```
/proposecriteria <target> <value> <data> oracle <adapter|switchboard> <feedId|-> <targetValue> min|max <measurementPeriodSeconds> <description>
```
- **Switchboard:** type the literal word `switchboard` (uses `SWITCHBOARD_ORACLE_ADAPTER`) and pass the real 32-byte Switchboard `feedId`. One adapter serves every feed.
- **Chainlink:** run `/deploychainlinkoracle <chainlinkFeedAddress>` first, then pass the returned adapter address and `-` as the feed ID. Chainlink needs one adapter per feed, because each Chainlink feed is its own contract.
- **Human track:** `human - -` in the oracle and feed slots.

### Opportunity Markets (Ethereum Sepolia, FHE-encrypted)
- `/createmarket <underlyingToken>` · `/registermarket <address>` · `/unregistermarket`
- `/listopportunity <metadataURI>` · `/deposit <amount>` · `/back <opportunityId> <amount>` (confidential)
- `/mybalance` · `/mybet <index>` · `/allbets` (deployer only)
- `/fundrewardpool` · `/resolve <id>` · `/cancelmarket` (deployer only)
- `/reclaimstake` · `/computereward` · `/revealwinningtotal` · `/withdraw` · `/withdrawreward`

## Setup

```bash
npm install
cp .env.example .env
# If using KMS wallets: run supabase/schema.sql once in your Supabase SQL editor
npm start
```

| Variable | Required for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | everything | from BotFather |
| `RPC_URL` | everything | Monad testnet public RPC by default |
| `OPERATOR_PRIVATE_KEY` | `/createdao`, `/claim`, gas top-ups | a funded hot wallet — see Security |
| `FACTORY_ADDRESS` + `<MODEL>_FACTORY_ADDRESS` | `/createdao` per model | a model with no address set can't be created, but can still be `/register`ed |
| `SORTITION_RANDOMNESS_SOURCE` | `/createdao ... sortition` | deployed `SwitchboardRandomnessAdapter` |
| `SWITCHBOARD_ORACLE_ADAPTER` | `switchboard` shorthand in `/proposecriteria` | deployed `SwitchboardPriceFeedAdapter` (optional) |
| `SWITCHBOARD_ADDRESS` | both keepers | Switchboard's own proxy, not our adapter |
| `KMS_KEY_ID`, `AWS_REGION`, AWS credentials | KMS wallets | symmetric KMS key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | KMS wallets | service_role key — RLS allows nothing else |
| `MASTER_WALLET_SEED` | legacy wallets only | keep set only while old wallets still hold funds |
| `OPPORTUNITY_MARKET_RPC_URL`, `OPPORTUNITY_MARKET_FACTORY_ADDRESS` | Opportunity Markets | Sepolia |

### Running the sortition keeper

`startSortition()` only *requests* randomness. Switchboard is pull-based: after the settlement delay, someone must fetch the signed result and submit it. Any user can do this manually with `/settlesortition`, or you can run the background keeper so it happens automatically:

```bash
npm run keeper:sortition
```

Run it as its own long-lived process alongside the bot (a second Railway service, pm2, systemd). It polls every 30 seconds and pays gas from the operator wallet.

### Running the Switchboard price-feed keeper

Sowellian oracle-track proposals resolve with `resolveViaOracle()`, which rejects feed data older than the DAO's `maxOracleStaleness`. Switchboard feeds are pull-based, so nothing refreshes them on its own. This keeper finds proposals whose measurement period has ended and whose oracle is the Switchboard adapter, pushes a fresh signed update from Crossbar, and resolves them:

```bash
npm run keeper:switchboard
```

It polls every 60 seconds, skips Chainlink-backed proposals, and pays gas plus Switchboard's per-update fee from the operator wallet. Optional: `SWITCHBOARD_FEED_IDS` (comma-separated feed IDs to keep fresh on a timer), `SWITCHBOARD_REFRESH_SECONDS` (default 300), `SWITCHBOARD_NETWORK` (`testnet` default, or `mainnet`), `CROSSBAR_URL`.

Both keepers only need `OPERATOR_PRIVATE_KEY`, `SWITCHBOARD_ADDRESS` and `RPC_URL`; neither needs `TELEGRAM_BOT_TOKEN`.

## Security — read before deploying anywhere real

- **Never paste private keys into chats, commands, or shell history.** Use `export PRIVATE_KEY=...` and reference `$PRIVATE_KEY`. Any key that has appeared in plaintext should be treated as burned.
- **`OPERATOR_PRIVATE_KEY`** pays gas for `/createdao`, `/claim`, keeper settlement, and small first-transaction top-ups for user wallets. Keep it funded, but not over-funded.
- **KMS IAM scope.** The bot's AWS credentials should only be able to `Decrypt` and `GenerateDataKey` on the one key — not manage or delete it.
- **`SUPABASE_SERVICE_ROLE_KEY`** bypasses Row Level Security by design. Treat it like a database root password.
- **`MASTER_WALLET_SEED`** (legacy) can derive every old wallet's key. Remove it once no old wallet holds funds.

## Discord and Slack

Every Telegram command also runs on Discord and Slack, except `/start` (use `help`) and `/migratewallet` (legacy seed wallets only ever existed for Telegram IDs). Each platform runs as its own process sharing the same `data/` volume, wallet store and chain config as the Telegram bot. Neither needs `TELEGRAM_BOT_TOKEN`.

```bash
npm run discord   # DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, optional DISCORD_GUILD_ID
npm run slack     # SLACK_BOT_TOKEN, SLACK_APP_TOKEN (Socket Mode - no public URL needed)
```

- **Discord** registers 97 native slash commands on startup (Discord allows 100 per bot). `/register` and `/unregister` default to members with *Manage Server*. Long replies are split across messages.
- **Slack** uses one command, `/protean <subcommand>` (e.g. `/protean vote 3 for`). Create the app from [`docs/slack-app-manifest.yml`](docs/slack-app-manifest.yml). Joining a channel with a welcome distributor sends the newcomer their tokens, as on Telegram.
- **Privacy:** anything Telegram sends by DM (bets, confidential balances, rewards, handover proposals, the treasury address from `contribute`) is shown only to the caller: an ephemeral reply on Discord (which also hides the options typed), an ephemeral response on Slack. So `back` takes its opportunity and amount directly - they never appear in the channel.
- One channel links to one DAO. Each user gets their own wallet per platform.
- **Link vs creator:** whoever runs `register` becomes the channel's *linker* (can relink/unlink); whoever runs `createdao`/`createboarddao` is the DAO's *creator* (can also `tip`, deploy wrappers and distributors). Registering an existing DAO never grants creator rights. Server/workspace admins can always relink.
- Notifications for proposal created/queued/executed/cancelled post to linked channels.

`help` shows only the commands that apply to the channel's DAO model and linked wrappers/markets. Command logic lives in `src/platforms/commands/` (grouped as core, setup, tokens, models, sowellian, markets, opportunity); `discord.js` and `slack.js` only handle transport.

## Known limitations

- **`/createdao` mints the initial supply to the operator wallet**, not the person who ran the command, and records the operator as `creator` (cosmetic — no permissions are gated on it). Distributing that supply to the community is currently a manual step.
- **`/propose` takes raw target/value/calldata** — unforgiving for non-technical users until the transaction compiler exists.
- **Chainlink coverage is limited.** Not every metric has a Chainlink feed on every chain; Switchboard covers far more.
- **WMON is never auto-unwrapped.** Redeeming or reclaiming on a Decision Markets quote side returns WMON; `/unwrap` converts it back to MON.

## What's not fully verified yet

Verified: every file compiles, every command calls a real exported function with the right argument shapes, contract tests pass. Not yet verified against live infrastructure:

- The full create → propose → vote → queue → execute loop through real Telegram sessions
- The FHE relayer round-trip for confidential bets and decryption (Opportunity Markets)
- Switchboard's Crossbar round-trip for sortition settlement
- A real oracle-track Sowellian resolution

A reasonable first live test: `/wallet` → `/createdao` → `/stake` → `/propose` → `/vote` → `/queue` → `/execute`.

## Not built yet

- **Transaction compiler** — structured actions (transfer, swap, approve) compiled to calldata, wrapped through `Treasury.execute()`
- **Event listener** — proactive chat messages for on-chain events; everything today is pull-based
- **`/deploydistributor`**, in-chat tipping, and group-wide gas sponsorship with spending limits

## Architecture

```
src/
├── index.js              Telegram command handlers, model-aware /help
├── platforms/            Discord + Slack front-ends over a shared command core
├── config.js             chain, viem clients, operator wallet, factory + oracle addresses
├── contracts.js          original-model reads/writes, gas top-ups
├── db.js                 chat ↔ DAO / model / market links (flat JSON — swap before scaling)
├── walletResolver.js     KMS-first wallet resolution, legacy migration guard
├── kmsWallet.js          KMS envelope encryption
├── walletStore.js        Supabase persistence for encrypted keys
├── wallet.js             legacy seed-derived wallets
├── governance/           one adapter per model + shared helpers (common.js, index.js registry)
├── opportunityMarket/    Sepolia config, market actions, FHE encryption, user + public decrypt
├── keepers/              standalone Switchboard keepers (sortition randomness, Sowellian price feeds)
└── abis/                 compiled ABIs (and adapter bytecode for on-demand deployment)
supabase/schema.sql       wallets table, RLS enabled
```

## Deploying persistently

The bot uses long polling, so it needs a long-lived process — not serverless. Railway or Render work: `npm install` to build, `npm start` to run, env vars set in the dashboard. Run the sortition keeper as a second service with `npm run keeper:sortition`.

## Try it live

[**@proteandao_bot**](https://t.me/proteandao_bot) — when it's deployed and running.
