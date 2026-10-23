# Protean: DAO Governance Bot for Telegram, Discord, Slack and WhatsApp

Protean turns a group chat into a working DAO. A group deploys a governance system under any of ten models, and its members get wallets, stake, propose, vote, trade decision markets and place confidential bets without leaving the chat.

- **Contracts:** EVM contracts are in [`Spaces`](https://github.com/replico-labs/Spaces) and Solana programs in [`Vortexes`](https://github.com/replico-labs/Vortexes). Their READMEs list the deployed addresses.
- **Try it:** [Telegram](https://t.me/proteandao_bot) · [Discord](https://discord.com/oauth2/authorize?client_id=1550697784259121203&permissions=3072&integration_type=0&scope=applications.commands+bot) · [Slack](https://protean-bot-production.up.railway.app/slack/install)

**Contents**
1. [Overview and architecture](#1-overview-and-architecture)
2. [Quick start and prerequisites](#2-quick-start-and-prerequisites)
3. [Core systems](#3-core-systems)
4. [Governance models and features](#4-governance-models-and-features)
5. [Testing and keepers](#5-testing-and-keepers)
6. [Platform notes](#6-platform-notes)

---

## 1. Overview and architecture

### What Protean is

- **One command set on four platforms:** Telegram, Discord, Slack and WhatsApp.
- **Ten governance models,** each its own contract:
  - token-weighted, quadratic, liquid, optimistic
  - delegate (an elected council), sortition (a council drawn by lot)
  - conviction, board (a multisig)
  - Sowellian, decision markets (futarchy)
- **Three EVM testnets plus Solana devnet:** Monad testnet, Base Sepolia and HyperEVM testnet, and Solana devnet through Vortexes. The mainnets are supported but nothing is deployed on them yet.
- **Confidential prediction markets** (Opportunity Markets), on Ethereum Sepolia with Zama FHE.
- **A wallet for every member,** created on first use and paid for gas by the bot.

### Supported networks

| Network | id | Chain | Gas token | State |
|---|---|---|---|---|
| Monad testnet | `monad-testnet` | 10143 | MON | default; all ten factories and both Pyth adapters deployed |
| Base Sepolia | `base-sepolia` | 84532 | ETH | all ten factories and both Pyth adapters deployed (`size-limited` build) |
| HyperEVM testnet | `hyperevm-testnet` | 998 | HYPE | all ten factories and both Pyth adapters deployed (`size-limited`, big blocks); set a provider `HYPEREVM_TESTNET_RPC_URL`, since the public RPC rate-limits hard |
| Monad | `monad-mainnet` | 143 | MON | not deployed |
| Base | `base` | 8453 | ETH | not deployed; needs Spaces' `size-limited` build |
| HyperEVM | `hyperevm` | 999 | HYPE | not deployed; `size-limited`, plus big blocks for factory deploys |
| Solana devnet | `solana` / `solana-devnet` | — | SOL | all ten Vortexes models; off unless `SOLANA_ENABLED=true` |

Opportunity Markets always run on Ethereum Sepolia, because Zama's FHE coprocessor doesn't exist on the other chains.

### Status

- **Contracts:** 539/539 Foundry tests pass (see Spaces).
- **Monad testnet:** all ten models' full lifecycles pass `scripts/test-evm-models.mjs`: 174 steps, every proposal paying out of its treasury. Create → propose → vote → queue → execute has also run through Telegram for token-weighted and Board DAOs.
- **Base Sepolia:** the same eleven flows (all ten models plus Sowellian's Pyth-price route) pass, for about 0.0024 ETH of operator gas.
- **HyperEVM testnet:** the same eleven flows pass (189 steps, about 0.0074 HYPE), on small blocks, with the two-step Decision Markets factory. Fast timings there are 3x as long (`HYPEREVM_TESTNET_FAST_SCALE`), since each step takes about three times as long as on Monad or Base.
- **Local chains:** every model's lifecycle has run through the Discord and Slack handlers on anvil, with the real contracts deployed from source. That's about 230 checks, including a GuardWrapper handover with a treasury payout confirmed by signers. A separate two-chain test has one bot process serve two chains at once.
- **Running live:**
  - Discord: a real server has run an optimistic DAO's proposals and treasury transfers.
  - WhatsApp: runs as its own Railway service.
  - Pyth Entropy and Hermes prices: both have run on Monad testnet.
  - Opportunity Markets: one has run end to end through Telegram on Sepolia, FHE relayer included.
- **Not yet run live:** anything on a mainnet, and a real Slack workspace. See [What's not verified yet](#whats-not-verified-yet).

### Source map

```
src/
├── index.js              Telegram: command handlers, buttons, model-aware /help
├── platforms/            Discord, Slack and WhatsApp front-ends over a shared command core
│   └── commands/         the shared commands (core, setup, tokens, models, switch, sowellian, markets, opportunity)
├── networks.js           network registry, per-call network context, block scaling, per-network gas
├── config.js             viem clients that follow the current network, operator wallet, writeWithGasBuffer
├── gasLimit.js           measured gas limits (simulation, +15/20%, HyperEVM's 2M cap)
├── gasSponsor.js         gas sponsorship: at wallet creation and before each transaction
├── rpcFallback.js        backup RPCs, tried in order
├── contracts.js          token-weighted reads/writes, wrapper and distributor deploys
├── governance/           one adapter per model + shared helpers (common.js, index.js registry)
├── modelSwitch.js        /switchmodel: the switch proposal's actions and checks
├── actionLibrary.js      verified native actions for /proposeaction
├── proposalBuilder.js    action encoding + GuardWrapper routing, shared by every platform
├── integrations/         external protocol actions (Uniswap, Aave, Perpl, HyperCore, ...)
├── perps.js              /perps on Perpl and HyperCore
├── desk.js               trading desk: appointed trader, mandate checks, Perpl DelegatedAccount
├── wrapper.js            GuardWrapper reads/writes
├── proposalPages.js      proposal pages: details store, signed edit links, the JSON API
├── buttons.js            buttons under proposals, on every platform
├── charts.js             vote charts (PNG)
├── txLinks.js            explorer links for the transactions a command sends
├── eventListener.js      chat notifications, per platform and per network
├── db.js, chatStore.js   chat links: DAO, network, model, wrappers, market (file or Supabase)
├── walletResolver.js     KMS-first wallet resolution, legacy migration guard
├── kmsWallet.js          KMS envelope encryption
├── walletStore.js        Supabase persistence for encrypted keys
├── wallet.js             legacy seed-derived wallets
├── solana/               Vortexes: commands, actions, listener, pages, charts, wallets
├── opportunityMarket/    Sepolia config, market actions, FHE encryption, user and public decrypt
├── keepers/              standalone sortition keeper
└── abis/                 compiled ABIs (and bytecode for on-demand deployment)
supabase/schema.sql       wallets, chat_links, proposal_details, slack_installations (RLS on)
docs/slack-app-manifest.yml
scripts/                  end-to-end tests, local deploys, integration checks
```

`src/abis/*.json` is copied from Spaces' Foundry output. **Whenever a contract changes, re-extract its ABI and artifact and copy them here.** The bot has no compiler, so otherwise it silently keeps using the old ones.

---

## 2. Quick start and prerequisites

### Prerequisites

- **Node.js 22**
- **A Telegram bot token** from BotFather, and/or the Discord, Slack or WhatsApp settings in [Platform notes](#6-platform-notes)
- **An operator wallet** (`OPERATOR_PRIVATE_KEY`), funded on every enabled network. It deploys DAOs and pays members' gas.
- **Factory addresses** for each network, from Spaces' README
- **For member wallets:** an AWS KMS symmetric key and a Supabase project
- **Optional:** a Solana operator key (`SOLANA_OPERATOR_KEY`) for Solana DAOs, Pyth API key, proposal-page website

### Install and run

```bash
npm install
cp .env.example .env          # fill it in (table below)
# Run supabase/schema.sql once in your Supabase SQL editor
npm start                     # Telegram
npm run discord               # Discord
npm run slack                 # Slack
npm run whatsapp              # WhatsApp
KEEPER_NETWORK=monad-testnet npm run keeper:sortition   # optional, one per network
```

`npm run dev` restarts the Telegram bot on file changes.

### Environment

| Variable | Needed for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | the Telegram bot | from BotFather |
| `RPC_URL`, `RPC_URLS`, `RPC_PUBLIC_FALLBACK` | optional | Monad testnet RPC (viem's public one by default); backup RPCs in order; the public RPC is always the last resort unless `false` |
| `NETWORKS`, `DEFAULT_NETWORK` | more than one network | see [Networks and gas](#networks-and-gas) |
| `OPERATOR_PRIVATE_KEY` | `/createdao`, `/claim`, gas top-ups, keepers | a funded hot wallet on every enabled network; see [Security](#security) |
| `FACTORY_ADDRESS`, `<MODEL>_FACTORY_ADDRESS` | `/createdao` per model | per network with a prefix (`BASE_FACTORY_ADDRESS`); a model with no address can't be created there, but can still be `/register`ed |
| `SORTITION_RANDOMNESS_SOURCE` | sortition DAOs | the deployed `PythEntropyRandomnessAdapter`, per network |
| `PYTH_PRICE_ADAPTER` | Sowellian's oracle track | the deployed `PythPriceFeedAdapter`, per network |
| `PYTH_API_KEY`, `PYTH_HERMES_URL` | `/resolveviaoracle` | a Pyth Terminal key; Hermes defaults to `https://pyth.dourolabs.app/hermes` |
| `KMS_KEY_ID`, `AWS_REGION`, AWS credentials | member wallets | one symmetric KMS key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | member wallets, pages, chat links | the service_role key; RLS allows nothing else |
| `CHAT_LINKS_STORE` | optional | `supabase` keeps chat links in the database; see [Chat links](#chat-links) |
| `PROPOSAL_SITE_URL`, `PROPOSAL_LINK_SECRET` | proposal pages | the website's URL and a long random secret for edit links |
| `PROPOSAL_DETAILS_GRACE_HOURS` | optional | how long details stay editable after proposing (default 6) |
| `SOLANA_ENABLED`, `SOLANA_OPERATOR_KEY`, `SOLANA_DEVNET_RPC_URL` | Solana DAOs | see `.env.example` |
| `MASTER_WALLET_SEED` | legacy wallets only | keep it only while old wallets still hold funds |
| `OPPORTUNITY_MARKET_RPC_URL`, `OPPORTUNITY_MARKET_FACTORY_ADDRESS` | Opportunity Markets | Sepolia |
| `DISCORD_*`, `SLACK_*`, `WHATSAPP_*` | those platforms | see [Platform notes](#6-platform-notes) |
| `<PREFIX>_FAST_TIMINGS`, `<PREFIX>_FAST_SCALE` | testing | short governance periods on testnets; see [Testing](#5-testing-and-keepers) |

`.env.example` lists every variable, including the per-network prefixes and the deployed factory addresses.

### Deploying persistently

The bots use long polling and sockets, so they need long-lived processes, not serverless. The bots and keepers all read `data/` (the keepers find DAOs there), so they must share one persistent volume.

Railway attaches a volume to a single service, so run them together in one service, leaving out any you haven't configured:

```bash
sh -c "npm start & npm run discord & npm run slack & npm run whatsapp & KEEPER_NETWORK=monad-testnet npm run keeper:sortition & KEEPER_NETWORK=base-sepolia npm run keeper:sortition & KEEPER_NETWORK=hyperevm-testnet npm run keeper:sortition & wait"
```

With "Add to Slack", proposal pages or WhatsApp's QR link page, give that service a public domain. Railway's `PORT` is where they listen.

---

## 3. Core systems

### Wallets and KMS

Every member gets their own wallet, created automatically the first time they need one. There's no external wallet app and no connect step. Each member has one wallet per chat platform, and the same address works on every EVM network.

- **Encryption:** each private key is envelope-encrypted with AWS KMS (AES-256-GCM, a per-user data key wrapped by one symmetric KMS key) and stored in Supabase. The plaintext key exists in memory only for the instant a transaction is signed. A leaked database alone reveals nothing usable; decryption also needs KMS access.
- **Custody:** this is still a **custodial** model. The bot's backend can decrypt any member's key, trading some decentralization for zero-friction onboarding.
- **Solana wallets:** each member also gets a Solana wallet, encrypted with the same KMS key and stored on the same Supabase row (`wallets.solana`). `/wallet` shows both addresses.
- **Legacy wallets:** earlier versions derived every Telegram wallet from one `MASTER_WALLET_SEED`. If a member still has funds at that old address, the bot won't silently create a second wallet. It asks them to run `/migratewallet` first, which sweeps the native balance across. ERC-20 tokens must be moved by hand, and the command says so.

### Networks and gas

**Each chat's DAO lives on one network,** chosen when it's created or linked:

```
/createdao ArkDAO ARK 1000000 10000000 quadratic base
/createboarddao ArkBoard 0xA... 0xB... hyperevm
/register 0xGovernance... tokenWeighted base
```

- **Creating a DAO requires a network word,** anywhere after the supplies (or after the name for `/createboarddao`). Without one, the bot refuses and lists the codes it accepts: the enabled networks, plus `solana` when Solana is on.
- **`/register`** falls back to the bot's default network.
- **After that,** every command in the chat reads and writes that chain. `/network` shows which one. Chats registered before networks existed are on Monad testnet.

**To enable a network,** set three things for it:
- an entry in `NETWORKS`
- factory addresses under the network's prefix (`BASE_FACTORY_ADDRESS`, `BASE_QUADRATIC_FACTORY_ADDRESS`, ...)
- native gas in the operator wallet

An RPC is optional (`BASE_RPC_URL`); viem's public RPC is used otherwise.

**Handled automatically between networks:**

- **Block-counted periods are rescaled.** The defaults were written for Monad's 400 ms blocks: 50,400 blocks is about 5.6 h on Monad but about 28 h on Base. New DAOs get their block-counted fields scaled to the same wall-clock length (10,080 on Base, 20,160 on HyperEVM). Periods counted in seconds (timelocks, execution windows, Sowellian's challenge period) are unchanged.
- **The native token:** `/send 1 0x... ETH` on Base, `HYPE` on HyperEVM, `MON` on Monad, or `native` anywhere.

**Gas sponsorship.** The operator wallet pays members' gas, never the amounts they send.
- **On creation:** a new wallet gets its starting gas straight away on the chat's network. By default that's 0.1 MON on Monad, 0.0002 ETH on Base and 0.01 HYPE on HyperEVM.
- **Before each transaction:** the bot reads the wallet's balance fresh from the chain. If it can't cover the transaction's up-front cost, the operator tops up the shortfall before signing, at least the network's repeat amount. Monad charges gas limit × max fee up front, so the check uses the fees the transaction is actually sent with.
- **Other networks:** a wallet is funded on first use there.
- **Solana:** the bot tops up a member's Solana wallet with a little SOL when they need fees or rent.

**Gas limits are measured, never guessed** (`src/gasLimit.js`).
- **Why:** Monad charges the full gas limit, not the gas used, and its `eth_estimateGas` can be far too high. A Board execute that used about 150k was estimated at about 9.94M.
- **How the limit is set:**
  1. Each write is simulated once with `eth_createAccessList` to get the gas it really uses. On nodes without that, the bot halves its way down to the smallest limit `eth_call` succeeds within.
  2. It's sent at that plus 15%, or plus 20% if a simulation capped at 15% fails.
  3. Then 25,000 gas is added, because the simulation runs against the latest block while the transaction lands in the next. Code that settles "up to this block", like Conviction's support, can write storage the simulation skipped.
- **Reverts:** a transaction that is mined but reverts is reported as an error, never as success.
- **Where it applies:** contract writes, deployments, native sends, Board execute and the Sepolia market writes.
- **HyperEVM:**
  - The limit is capped at the 2M small-block limit. A transaction that really needs more fails with an explanation, because its sender would have to switch to big blocks.
  - Every model's DAO creation fits under 2M; the heaviest, Conviction, is about 1.38M.
  - A Decision Markets proposal goes out as two transactions (`propose` + `openMarkets`) on DAOs with the two-step contract, because one call was about 2.3M gas. Older Decision Markets DAOs do it in one, and the bot handles both.
  - The operator keeps at most 8 transactions waiting, the most HyperEVM's mempool accepts from one address, and should stay on small blocks.

**Backup RPCs.** List backups in `RPC_URLS`, comma-separated (per network with a prefix: `BASE_RPC_URLS`).
- The chain's public RPC is always the last resort unless `RPC_PUBLIC_FALLBACK=false`.
- Requests go to the first RPC that's up.
- One that times out, refuses or runs out of credits is skipped for a minute (logged once), then tried again.
- A reverted call is an answer, not a failure, so it doesn't switch RPCs.

### Chat links

Each chat's links (DAO, network, model, tokens, wrappers and market) are stored in one of two places:
- **By default:** `data/chats.json` on the volume, shared by every service under a lock file.
- **With `CHAT_LINKS_STORE=supabase`:** rows in Supabase's `chat_links` table, so a lost volume doesn't unlink every chat.

To switch to Supabase:
1. Run the `chat_links` part of `supabase/schema.sql` in the SQL editor.
2. Set `CHAT_LINKS_STORE=supabase` on every service and redeploy. The first service to start imports `data/chats.json` and logs "imported N chats". The file is left as it was.

How it behaves:
- **Commands don't wait on the database.** Each service keeps the links in memory, re-read every 10 s.
- **Changes are saved straight away,** and retried until they land if Supabase is briefly down.
- **A service that starts while Supabase is unreachable** uses its last copy (`data/chats.supabase-cache.json`) and catches up.
- **A missing table stops the service,** with a message saying which SQL to run.

### Proposal pages

Every proposal gets a page on the website, `PROPOSAL_SITE_URL/p/<network>/<dao>/<id>`. It shows the details its proposer writes there, next to live on-chain data: state, votes or conviction, budget, timelock and actions. This works for EVM and Solana DAOs alike.

- **After proposing,** the group sees the page link, and the proposer gets a private link to add the details:
  - Telegram: a DM, or a `t.me/<bot>?start=…` link that opens one if the bot can't message them first
  - Discord and Slack: a message only they can see
  - WhatsApp: a DM
- **Edit password and history:**
  - With the first upload, the proposer chooses an edit password (8+ characters). Any later edit needs the private link *and* that password, so a forwarded link alone can't change anything. Only a scrypt hash of the password is stored.
  - 5 wrong passwords lock editing for 15 minutes.
  - Every saved version is kept (`proposal_detail_versions`, up to 20) and listed on the page under History, with its time and sha256 fingerprint, so readers see exactly what changed.
- **When details can change:** uploads and edits are allowed during a grace period after proposing (`PROPOSAL_DETAILS_GRACE_HOURS`, default 6), even once voting has started. After that, only while nobody has voted on or backed the proposal, up to 72 hours. Then the details are final.
- **`/proposal <id>`** ends with the page link. When the proposer runs it while they can still edit, it also re-sends their private link.
- **Solana DAOs** get their pages at `/p/solana-devnet/<governance account>/<id>`.
  - The address is the governance account, not the DAO, so pages stay right after a model switch (the new governance numbers its proposals from 1 again).
  - Live data comes straight from the Vortexes programs. Instructions are described in words, and addresses link to Solana's explorer.
- **Board DAOs:** proposing counts as the proposer's own confirmation, so details stay open until a second signer confirms.
- **How it's served:**
  - The website is static. It reads `GET /api/proposals/<network>/<dao>/<id>` from the bot, and its form `POST`s back.
  - The routes share the Slack install page's HTTP server when "Add to Slack" is set up; otherwise the Telegram process listens on `PORT`.
  - Only DAOs linked to a chat are served, and CORS allows only `PROPOSAL_SITE_URL`.
  - Edit links are HMAC-signed with `PROPOSAL_LINK_SECRET` and expire with the edit window.
- **Setup:**
  1. Run the `proposal_details` and `proposal_detail_versions` parts of `supabase/schema.sql`. Re-run it on an existing database: it adds the password and version columns.
  2. Set `PROPOSAL_SITE_URL` and `PROPOSAL_LINK_SECRET`.
  Without them, the bot works as before, with no page links.

### Buttons and the help menu

- **Buttons under proposals,** on Telegram, Discord and Slack, for EVM and Solana DAOs alike.
  - A new proposal gets the buttons its model needs:
    - **For / Against / Abstain:** token-weighted, quadratic, liquid, and delegate and sortition councils
    - **Challenge:** optimistic
    - **Support:** conviction
    - **Confirm:** board
  - Every proposal also gets **Status** and a **Details** link to its page.
  - `/proposal <id>` shows what fits the proposal's state now: the vote buttons while it's open, **Queue** once it has passed, **Execute** once it's queued.
  - A button runs the same command as typing it, as whoever pressed it, with their own wallet and the same checks; the chat sees who pressed what. On Discord and Slack, errors (already voted, no stake) go only to the presser.
  - Only `vote`, `challenge`, `support`, `confirm`, `queue`, `execute`, `proposal` and `help` can come from a button.
  - Slack needs `interactivity` on in the app manifest (it is, in `docs/slack-app-manifest.yml`).
- **`/help` is a menu:**
  - It opens with a line about the chat's DAO and a button per topic (Setup, Wallet, The DAO, Proposing, Deciding, Council, …), showing only what applies to the model.
  - A topic button swaps the message in place to that topic's commands, with a button back; **Everything** posts the whole list.
  - Typed, it's `/help <topic>` or `/help all`, on WhatsApp too.
  - On Discord and Slack, help is shown only to whoever asked.
- **Telegram's command menu** (the **/** button and autocomplete) is set at startup: the everyday commands in groups, a short list in private chats. Every other command still works typed.
- **Discord** registers its slash commands itself; **Slack** has the one `/protean` command from the manifest.

### Explorer links

Every reply to a command that sends a transaction ends with a 🔗 link to it on the network's explorer. That covers creating a DAO, tips and sends, staking, proposing, votes, challenges, support, confirmations, queue, execute, elections, trades and the rest.

- **EVM:** links are recorded where every transaction leaves the bot (`writeWithGasBuffer`, `deployWithGasLimit`, native sends; see `src/txLinks.js`), so new commands get them too.
- **Solana:** links are recorded in `send()` in `src/solana/vortex.js`, which every Vortexes transaction goes through.
- **Opportunity Markets:** transactions link Sepolia Etherscan, and `/migratewallet` links its transfer.
- **Notifications** link the transaction they report, and `/wallet` links your address.
- **Explorers:**
  - Monad testnet: `testnet.monadexplorer.com`
  - Base Sepolia: `sepolia.basescan.org`
  - HyperEVM testnet: `testnet.hyperevm-explorer.xyz`
  - Solana: `explorer.solana.com` with the cluster
  - mainnets: viem's defaults

  Override one with `<PREFIX>_EXPLORER_URL`, e.g. `BASE_SEPOLIA_EXPLORER_URL`.

### Notifications and vote charts

Every platform's process polls its linked DAOs and posts to the linked chat:
- proposals created, queued, executed and cancelled
- model-specific events: challenges, elections and recalls, council draws, Sowellian approvals and resolutions, decision-market outcomes, model switches

**EVM:**
- Polled every 20 s, each network separately, with **one `eth_getLogs` per block range for all of that network's DAOs** (every address and event in one filter). So RPC use doesn't grow with the number of DAOs, which matters on plans that bill per call.
- Ranges are up to 90 blocks (Monad testnet caps `eth_getLogs` at 100), or the RPC's own limit, which the listener learns from its error (QuickNode's free plan: 5).
- Each DAO's progress is saved after every range.

**Solana:** polled every 30 s. Each poll reads the governance account's new transactions and decodes the program's events from their logs. A new-proposal notice also links the proposal's page.

**Vote charts.** When a vote ends, the listener posts the result with a chart (a PNG), e.g. *"Voting on proposal #3 has closed: Succeeded"*.
- **What the chart shows:** For / Against / Abstain bars with each side's share, the votes cast and the quorum, titled with the details the proposer wrote on the page.
- **What's tracked:** every proposal the listener saw created (token-weighted, quadratic, liquid, delegate, sortition, optimistic challenges, Sowellian approval votes, Decision Markets' pass/fail prices), up to 50 open per DAO, for 30 days.
- **Cost:** a proposal is read only once its end has passed (its end block on EVM, its end time on Solana; once a minute where the end isn't known), so open votes cost almost no RPC.
- **`/proposal <id>`** sends the same chart with its answer, for every model that has one. Conviction shows its progress toward the threshold; Board has none.
- **Same on both chains:** EVM and Solana proposals get the same charts (`src/solana/charts.js` hands Vortexes proposals to `src/charts.js`).
- **Sending:** Telegram, Discord and WhatsApp send the chart as a photo. Slack uploads it, which needs the `files:write` scope (in the manifest). An existing install must be reinstalled to get that scope; without it the text still goes out and the chart is skipped, logged once.
- **Drawing:** charts are SVG rendered with resvg, with fonts bundled in `assets/fonts`, so there's nothing to install on the server. `barChartPng()` is general, for future market, futarchy and PnL cards.

### Security

- **Never paste private keys** into chats, commands or shell history. Use `export PRIVATE_KEY=...` and reference `$PRIVATE_KEY`. Treat any key that has appeared in plaintext as burned.
- **`OPERATOR_PRIVATE_KEY`** pays gas for `/createdao`, `/claim`, keeper transactions and member top-ups, on every enabled network. Keep it funded but not over-funded. On mainnets especially, set the top-up amounts deliberately (`<PREFIX>_GAS_TOPUP_FIRST` etc.).
- **KMS IAM scope:** the bot's AWS credentials should only be able to `Decrypt` and `GenerateDataKey` on the one key, not manage or delete it.
- **`SUPABASE_SERVICE_ROLE_KEY`** bypasses Row Level Security by design. Treat it like a database root password.
- **`MASTER_WALLET_SEED`** (legacy) can derive every old wallet's key. Remove it once no old wallet holds funds.
- **Logs are redacted** (`src/logRedaction.js`, loaded first by every process). The Telegram token, any env value named like a key, token or secret, and key-like parts of RPC URLs are blanked before a line is written. Still, don't paste raw logs publicly, and rotate anything logged before this was added.

---

## 4. Governance models and features

`/help` only shows the commands that apply to the chat's model and its linked wrappers and markets.

### The ten models

| Model | How it decides | Model-specific commands |
|---|---|---|
| Token-weighted | staked tokens vote; quorum + approval | — |
| Quadratic | as token-weighted, with square-root weights | — |
| Liquid | members can hand their vote to someone else | `/delegate <address>`, `/undelegate`, `/resolvedelegations <id> [address]` |
| Optimistic | passes unless challenged with a bond; only challenged proposals are voted on | `/challenge <id>` |
| Conviction | support builds up over time; passes once it reaches a threshold | `/support <id>`, `/withdrawsupport`, `/mysupport`, `/assets [apply <asset>]` |
| Delegate | an elected council votes, with fixed terms | `/startelection`, `/declarecandidacy`, `/voteinelection`, `/finalizeelection`, `/initiaterecall`, `/voterecall`, `/finalizerecall`, `/council` |
| Sortition | a council drawn by lot with Pyth Entropy | `/registereligible`, `/withdraweligibility`, `/startsortition`, `/finalizesortition`, `/council` |
| Board | a signer multisig; no token | `/confirm <id>`, `/revoke <id>` |
| Sowellian | approval vote, then YES/NO positions on whether it meets a measured goal | see [Sowellian and Decision Markets](#sowellian-and-decision-markets) |
| Decision Markets | futarchy: pass and fail markets decide, no voting | see [Sowellian and Decision Markets](#sowellian-and-decision-markets) |

Bonds and seeds (optimistic challenges, Sowellian bonds and positions, Decision Markets seeds and trades) are approved automatically before the contract pulls them.

**Liquid delegation (EVM).** A delegate's vote counts only their own tokens. Each delegator's weight is added by a separate on-chain call, `resolveDelegatedVote`, which anyone can make while voting is open. The bot makes these calls for you, paid by the operator wallet:
- **When a delegate votes through `/vote`,** it resolves everyone behind them, up to 5 delegation hops, and says how much weight was added.
- **The event listener** does the same for every vote it sees on-chain (including votes cast outside the bot), and for anyone who delegates while a proposal is open.
- **`/resolvedelegations <id> [address]`** runs it on demand.

Someone who votes directly before being resolved keeps their own vote.

### Commands

**Setup**
- `/createdao <name> <symbol> <initialSupply> <maxSupply> [model] <network> [council...]`: deploy a DAO and link it here.
  - Models: `tokenWeighted` (default), `quadratic`, `liquid`, `optimistic`, `delegate`, `sortition`, `conviction`, `sowellian`, `decisionMarkets`.
  - `delegate` and `sortition` take the starting council as trailing addresses. Sortition's randomness source comes from the bot's config.
- `/createboarddao <name> <signer1> <signer2> ... <network>`: a Board (multisig) DAO, with no token.
- `/register <address> [model] [network]` / `/unregister`: link or unlink an existing DAO. `/register` checks the address really is that model's contract on that network.
- `/network`: the chat's chain, and the networks the bot supports.
- `/deploywelcomedistributor <amountPerClaim> <cap>` / `/setdistributor <address>`: welcome tokens for new members. They're sent automatically on join, or with `/claim`.
- `/deploynftwrapper`: the DAO's NFT wrapper (see [NFTs](#nfts)).
- `/deployguardwrapper <requiredApprovals> <tenureSeconds> <signer...>` / `/registerguardwrapper <address>` / `/handovertowrapper <address>`: a security council (see [Guard wrapper](#guard-wrapper)).
- **Spaces in arguments:**
  - A description (in `/propose`, `/proposeaction`, `/vote` reasons, `/listopportunity`) is everything after the last fixed argument, so it can be plain text with spaces.
  - A DAO name with spaces goes in quotes, straight or curly: `/createdao "Ark DAO" ARK 1000000 10000000`. Discord's name field takes spaces as is.

**Wallet and tokens**
- `/wallet` · `/migratewallet` · `/balance [address]`
- `/tip <amount> <recipient> [token]`: hand out the DAO's operator-held supply (creator only)
- `/send <amount> <recipient> [token|native]`: send tokens or native currency you hold
- `/tokenbalance [token] [address|treasury]` · `/registertoken <ticker> <address>` · `/treasuryassets`
- `/stake <amount>` · `/unstake <amount>`

**The DAO**
- `/dao`: name, token, treasury and the full model-specific config
- `/treasury` · `/contribute` (the treasury address, sent privately)
- `/proposals` · `/proposal <id>`: a list, or one proposal in full, shown in its model's own vote shape, with its chart and page

**Proposing and deciding**
- `/listactions` · `/proposeaction <actionId> <args...> <description>`: the verified action library.
  - It covers every native governance, Treasury, token and wrapper admin function, encoded for you, plus the [external protocol actions](#external-protocol-actions) available on the chat's network.
  - After a GuardWrapper handover, Treasury and token actions are routed through the wrapper automatically.
  - It works for every model; Sowellian and Decision Markets add their settings as `name=value` words.
- `/actioninfo <actionId>`: an action's arguments, options, and the sources its contract addresses were checked against.
- `/propose <target> <value> <data> <description>`: raw calldata, for anything else.
- `/vote <id> for|against|abstain [reason]` · `/queue <id>` · `/execute <id> [nativeValue]` · `/cancel <id>`
- `/switchmodel <model> [council or signers…] [description]`: move the DAO to another model (below).

### Switching models

**EVM: `/switchmodel <model>`** creates one proposal on the DAO's current governance.
- **When it executes,** the target model's factory deploys only a new governance contract on the DAO's existing Treasury and staking contract. The Treasury, token and staking contract are handed to it in the same transaction.
- **Nobody re-stakes:** balances and voting power carry straight over.
- **Arguments:** Delegate and Sortition take a starting council, and Board its signers, as addresses after the model. Sowellian and Decision Markets DAOs add their usual `name=value` settings.
- **The new governance** starts with the same rules a new DAO of that model gets.
- **Checked before proposing:**
  - the current governance must still control the Treasury
  - the target factory must support switching
  - the deploy is simulated as the governance itself

  So a switch that would fail is refused before anyone votes. The reply shows the new governance's address.
- **After it executes,** the event listener sees the Treasury's new governance (`predecessorOf` on the factory that deployed it), moves the chat's link to it and posts a notice.
- **The old governance stays on record.** Stake still backing a proposal on an old Conviction governance stays locked until its owner runs `/withdrawsupport`, which still reaches the old governance after the switch.

Limits:
- **The network's factories must be the current ones** (Spaces with `createForSwitch`). Until they are, `/switchmodel` says so.
- **DAOs from older factories** have their staking contract owned by that factory, so it isn't handed over (voting works the same), and they can't switch into Conviction.
- **A DAO whose Treasury sits behind a GuardWrapper** can't switch through the bot yet.
- **A Board DAO that never had a token** can't switch to a token model. One that came from a token model finds its token again through the governance it replaced.

**Solana:** the `switch…` actions in `/proposeaction` (see [Solana](#solana-vortexes)).

### Guard wrapper

A security council in front of the Treasury.
- `/guardwrapper`: its signers, threshold and tenure
- `/instruction <id>` · `/confirminstruction <id>` · `/rejectinstruction <id>` · `/revokeconfirmation <id>`

### NFTs

The Treasury can't receive NFTs (it has no ERC-721/ERC-1155 receiver hooks), so **a DAO's NFTs live in its NFT wrapper** (`/deploynftwrapper`):
- Send NFTs to the wrapper's address, never to the Treasury.
- Governance can, by proposal (`/proposeaction`):
  - list them (`nftwrapper-approve-order-hash`)
  - send them out (`nftwrapper-transfer-erc721` / `-erc1155`, which refuse the Treasury as a recipient)
  - call a marketplace directly (`nftwrapper-execute`)
- Sale proceeds go back to the Treasury with `nftwrapper-sweep-native` / `-erc20`.
- To buy an NFT, first move funds from the Treasury to the wrapper (`treasury-transfer-eth` / `-erc20`).

### Sowellian and Decision Markets

Through `/proposeaction`, with settings as `name=value` words:

```
/proposeaction treasury-transfer-eth 0xRecipient 1 measure=7d Fund the grant                      (Sowellian, human track)
/proposeaction treasury-transfer-eth 0xRecipient 1 track=oracle feed=ETH/USD goal=3000 when=min measure=30d Grow TVL
/proposeaction treasury-transfer-eth 0xRecipient 1 seed=1000 quote=5 Fund the campaign            (Decision Markets)
```

- **Sowellian:**
  - `track=human|oracle` (default `human`).
  - On the oracle track, `feed=<pair>` and `goal=<price>` are required.
    - The feed is looked up in Pyth's feed list on Hermes. A plain pair like `ETH/USD` means `Crypto.ETH/USD`; name another in full (e.g. `FundingRate.Hyperliquid.ETH/USD`) or give a raw feed ID.
    - The goal is a price, e.g. 3000, sent as 18 decimals.
  - `oracle=` defaults to `pyth`, the network's `PYTH_PRICE_ADAPTER`.
  - `when=min|max` (default `min`) and `measure=<duration>` (default `7d`).
  - `/feeds <search>` (e.g. `/feeds eur`) lists Pyth's feeds and what to type for each. The proposal reply names the feed it resolved to and its price at the time.
- **Decision Markets:** `seed=<DAO tokens>` and `quote=<native>` are both required.
- **Sowellian commands:** `/proposecriteria`, `/castapprovalvote`, `/finalizeapproval`, `/takeposition`, `/resolveviaoracle`, `/proposeresolution`, `/challengeresolution`, `/finalizeunchallenged`, `/castadjudicationvote`, `/finalizeadjudication`, `/claimposition`
- **Decision Markets commands:** `/proposemarket`, `/split`, `/trade`, `/merge`, `/finalizeproposal`, `/redeem`, `/unwrap`, `/reclaimliquidity`

**Raw Sowellian oracle proposals,** for calls the library doesn't cover:
```
/proposecriteria <target> <value> <data> oracle <pyth|adapter> <feedId> <targetValue> min|max <measurementPeriodSeconds> <description>
```
- **Pyth:** type `pyth` (the network's `PYTH_PRICE_ADAPTER`) and the feed ID (0x + 64 hex). One adapter serves every feed.
- **Human track:** `human - -` in the oracle and feed slots.
- **Resolving:** Pyth is pull-based. `/resolveviaoracle` fetches the feed's latest signed update from Hermes (needs `PYTH_API_KEY`), posts it to Pyth paying its small fee from the caller's wallet, then resolves. So the price is fresh within `maxOracleStaleness`.

`/proposemarket` likewise remains for raw Decision Markets calls.

### Conviction spending budgets

Conviction DAOs from the newer factory check what each proposal spends (see Spaces' README, "Conviction spending budgets").
- **The bot fills in the budget itself,** from:
  - native sent by `transferETH` or by a `Treasury.execute` step
  - tokens moved by `transferERC20`, or approved or transferred inside `Treasury.execute`

  That covers every action in `/listactions`, the protocol integrations, and raw `/propose` calls of those shapes.
- **`/proposal`** shows "May spend: 10 USDC, 0.5 MON", or a warning when a proposal weakens the rules.
- **`/assets`** lists the assets, their weights, the Treasury's holdings and pending cuts; run `/assets apply <asset>` once a cut is due.
- **The asset list changes by proposal:** `conviction-add-asset`, `conviction-set-asset-weight`, `conviction-remove-asset` (native: `MON`/`ETH`/`HYPE` or `native`).

Older Conviction DAOs keep proposing the old way.

### Opportunity Markets (Ethereum Sepolia, FHE-encrypted)

Confidential prediction markets. Individual bets stay encrypted; only the winning opportunity and its total are ever revealed.

- **Set up** (group owners and admins): `/createmarket <underlyingToken>` · `/registermarket <address>` · `/unregistermarket`. `/registermarket` only accepts markets the configured `OpportunityMarketFactory` reports as its own (`isMarket`).
- **Bet:** `/listopportunity <metadataURI>` · `/deposit <amount>` · `/back <opportunityId> <amount>` (confidential)
- **Check:** `/mybalance` · `/mybet <index>` · `/allbets`
- **`/analytics`** (deployer only, sent privately): total staked, average bet, average per bettor and largest bet, overall and per opportunity, plus each opportunity's share of all stake. It's built from the bets the contract already lets the deployer decrypt, so nothing new is revealed publicly.
- **Run the market** (deployer only): `/fundrewardpool` · `/resolve <id>` · `/cancelmarket`
- **Collect:** `/reclaimstake` · `/computereward` · `/revealwinningtotal` · `/withdraw` · `/withdrawreward`
  - **`/computereward`** tells you your reward privately. The contract keeps it encrypted with no getter, so the bot works it out from your own decrypted bets and the public pool, winning opportunity and winning total. It repeats the contract's 64-bit math exactly, and warns if that math wrapped.
  - **`/withdraw` and `/withdrawreward`** report the exact amount paid: the KMS-signed cleartext the contract pays out.
- **`/send <amount|all> <recipient> [ETH]`** in a market group sends the market's token (your withdrawn stake or reward) or Sepolia ETH.
  - In a group with a DAO too, add `market` (or the token's symbol or address) to send the market's token.
  - Sepolia gas isn't sponsored. An empty wallet is told how much it needs, and its address.

### Solana (Vortexes)

Solana DAOs run on Vortexes, the Solana version of Spaces: one hub program holds every DAO's treasury, and the DAO's governance program decides. It's off unless `SOLANA_ENABLED=true`; with it off, nothing changes on any platform.

```
/createdao ArkDAO ARK 1000000 10000000 solana
/createdao ArkDAO ARK 1000000 10000000 conviction solana
/createdao ArkDAO ARK 1000000 10000000 delegate solana <council address> <council address>
/createdao ArkDAO ARK 1000000 10000000 sortition solana <council address> <council address>
/createdao ArkDAO ARK 1000000 10000000 decisionmarkets solana
/createboarddao ArkBoard <solana address> <solana address> solana
/register <dao address> solana
```

All ten models work on **Solana devnet** (`solana` and `solana-devnet` both mean devnet until mainnet is deployed). In a Solana DAO's chat:

| Command | Does |
|---|---|
| `/dao`, `/treasury` | the treasury (SOL and tokens), rules, council or signers |
| `/wallet`, `/balance` | your Solana wallet, its SOL, tokens and stake |
| `/stake`, `/unstake <amount>` | stake the DAO's token (every model but board and decision markets) |
| `/migrate` | after a model switch: move your stake from the models the DAO ran before into the current one |
| `/tip <amount> <address\|treasury>` | hand out the starting tokens (the DAO's creator) |
| `/propose <recipient> <amount> <SOL\|token> <description>` | a payment from the treasury, in SOL, the DAO's token or any token by mint |
| `/listactions`, `/actioninfo`, `/proposeaction` | transfer SOL or tokens, mint tokens, board signers, conviction assets, switch to another model |
| `/vote <id> for\|against\|abstain`, `/queue <id>` | token-weighted, quadratic, liquid, delegate and sortition councils, optimistic once challenged, Sowellian's approval vote (`success\|failure` in its adjudication) |
| `/delegate <address>`, `/undelegate` | liquid: hand your stake's vote to another member (one hop); voting yourself overrides them |
| `/challenge <id>` | optimistic: dispute a proposal with a bond, forcing a vote |
| `/support <id>`, `/withdrawsupport`, `/mysupport`, `/assets` | conviction |
| `/council`, `/startelection`, `/declarecandidacy`, `/voteinelection`, `/finalizeelection`, `/initiaterecall`, `/voterecall`, `/finalizerecall` | delegate |
| `/council`, `/registereligible`, `/withdraweligibility`, `/startsortition`, `/finalizesortition` | sortition: opt into the draw pool; draw the next council once the term ends |
| `/castapprovalvote`, `/finalizeapproval`, `/takeposition <id> yes\|no <amount>`, `/resolveviaoracle`, `/proposeresolution`, `/challengeresolution`, `/finalizeunchallenged`, `/castadjudicationvote`, `/finalizeadjudication`, `/claimposition` | Sowellian |
| `/split`, `/trade <id> pass\|fail buy\|sell <amount>`, `/merge`, `/finalizeproposal`, `/redeem`, `/reclaimliquidity` | decision markets |
| `/confirm`, `/revoke <id>` | board signers |
| `/execute <id>`, `/cancel <id>`, `/proposals`, `/proposal <id>` | as on EVM, with charts and pages |

- **Tokens:**
  - The DAO's token has 6 decimals, and its whole initial supply goes to the bot's Solana wallet, handed out with `/tip`.
  - There's no fixed maximum: the treasury is the mint authority, so new tokens can only be minted by a passed proposal (the `mint` action).
  - The token is on record at the hub, and every model is set up only with that token, so a switch can't quietly change it. The `settoken <mint>` action changes it deliberately.
  - A DAO created before the record existed gets it recorded by its next switch to a token model; the bot adds that step to the switch proposal.
- **Defaults** match the EVM ones:
  - 10% quorum, 60% approval, ~5.6 h votes, a 1-day timelock, 7 days to run
  - optimistic challenges post a 100-token bond
  - delegate councils serve 2-day terms, and a majority of seats passes a proposal
  - boards need a majority of signers
  - conviction's bar is the larger of 1% of supply and 20% of all staked tokens, plus the proposal's spending budget (SOL and the DAO's token each weigh a quarter of supply)

  `SOLANA_DEVNET_FAST_TIMINGS=true` shortens every period to minutes, for testing.
- **Liquid:** delegation is one hop with running totals, so there's no keeper.
  - A delegate's vote carries their delegators' stake at once.
  - A delegator who votes themselves overrides it, before or after the delegate votes.
  - While a vote that counted someone's stake is open, they can't undelegate or move tokens.
- **Sortition:** councils are drawn with [ORAO VRF](https://github.com/orao-network/solana-vrf).
  - `/startsortition` asks ORAO for randomness (the bot's wallet pays ORAO's small fee) and freezes the pool.
  - `/finalizesortition` seats the council once ORAO answers, usually within seconds.
  - A draw ORAO never answers can be restarted after an hour (2 minutes with fast timings).
  - The first council is the one named at creation; later councils have the same size.
- **Sowellian:**
  - Proposals take the EVM settings as `name=value` words: `track=human|oracle`, `feed=SOL/USD` (or a Pyth feed ID), `goal=<price>`, `when=min|max`, `measure=7d`.
  - Proposing, resolving and challenging each post a 100-token bond.
  - The oracle is always Pyth. Resolving reads the feed's sponsored price account, or a `PriceUpdateV2` account given to `/resolveviaoracle`, so no Pyth fee is paid.
  - `/claimposition` collects winnings, refunds and bonds together.
- **Decision markets:**
  - They trade the DAO's token against SOL; the bot wraps and unwraps SOL as needed.
  - Proposals need `seed=<tokens> quote=<SOL>`: both markets' starting liquidity, from the proposer's own wallet.
  - Members need their own SOL to split.
  - The bot never puts the treasury's money into a market.
- **Switching models:**
  - The `switch…` actions (`switchtokenweighted`, `switchquadratic`, `switchboard <signers>`, `switchdelegate <members>`, …) move the DAO to another model with the same treasury and token, through the hub (`propose_switch`, then `apply_switch`).
  - The switch applies 2 days after its proposal runs. The bot applies it then, the next time anyone uses the DAO or from the notifier, and updates the chat. Until then, `cancelswitch` can stop it.
  - Each model keeps deposits in its own vault, so stake stays in the old vault after a switch. `/migrate` finds it in every model the DAO ran before (from the DAO's address alone) and moves it to the current one.
    - First it takes back Conviction support, or leaves an old Sortition draw pool, if that holds the stake.
    - If the current model has no staking, the stake goes back to the wallet.
    - Stake still locked by an open vote is reported and left for later.
- **Not on Solana:** the EVM-only extras (wrappers, distributors, integrations). Those commands say so in a Solana chat; Opportunity Market commands work as usual.

### Perps (`/perps`)

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

### Trading desk (`/desk`)

`/perps` trades only by vote. A **trading desk** lets the group appoint a trader by proposal. The trader then trades from the chat with no vote per trade, inside limits the group agreed to, and can never take the money. It runs on Perpl (Monad) for now.

| Command | Who | What it does |
|---|---|---|
| `/desk` | anyone | the desk: trader and mandate, collateral, open positions with PnL, pending appointments |
| `/desk apply <markets\|all> max=<size> [lev=2] [days=30]` | the would-be trader | proposes appointing themselves, e.g. `/desk apply BTC,ETH max=500 lev=3 days=30` (max = the largest position, in the collateral token) |
| `/desk fund <amount>` / `/desk withdraw <amount>` | anyone | proposes moving collateral from the Treasury into the desk, or back |
| `/desk remove` | anyone | proposes removing the trader |
| `/desk long\|short <market> <size> at <limitPrice> [3x]` | the trader | opens or adds to a position, straight away |
| `/desk close <market> <size\|all> at <limitPrice>` | the trader | closes or reduces one, straight away |
| `/desk resign` | the trader | steps down (on-chain) |

**How it's built.** The desk is a Perpl [DelegatedAccount](https://github.com/PerplFoundation/delegated-account), made by Perpl's own factory. It's an exchange account **owned by the Treasury**, with the trader's bot wallet as its **operator**.
- **The operator can only trade.** It can call only the exchange's trading functions through the desk: orders, margin top-ups, deposits, liquidation buys. Withdrawing and rescuing tokens are the owner's alone, and both always pay the owner, the Treasury.
- **The trader consents.** `/desk apply` has the trader's wallet sign Perpl's EIP-712 `AssignOperator` consent. The proposal then creates the desk with them as operator (`perpl-desk-create`), or adds them to the existing desk, replacing the current trader (`perpl-desk-appoint`).
- **The new desk is picked up automatically.** When the proposal executes, the listener reads the desk's address from the receipt (the factory's `DelegatedAccountCreated` event, with this Treasury as owner) and announces the trader. `/desk link <address>` links a desk by hand; it only accepts a Perpl-factory desk on this exchange owned by this Treasury.
- **Funding, withdrawing and removing** are ordinary proposals (`perpl-desk-fund`, `-withdraw`, `-remove`). The bot checks every desk address it puts into a proposal against Perpl's beacon, this exchange, and this Treasury as owner.

**The mandate** (markets, largest position, leverage, days) is written into the appointment proposal, so voters see what they agree to. Its clock starts when the proposal executes. On every trade the bot checks that:
- the trader is still the operator on-chain
- the mandate hasn't ended (closing stays allowed after it ends)
- the market is in the mandate
- the leverage is within it
- the whole position, at the limit price, is within `max`

Orders are immediate-or-cancel at the limit price, signed by the trader's own wallet. Every trade is posted in the chat with what filled.

**What is enforced where:**
- **The mandate is enforced by the bot,** not by Perpl's contract, which has no such limits. It holds because the trader's key stays in the bot's KMS wallet store and is never handed out, so every trade goes through these checks.
- **What holds on-chain no matter what:**
  - the trader can never withdraw
  - the DAO can only lose what it moved into the desk
  - only a proposal can fund the desk, withdraw from it, or appoint and remove its trader

Perpl's whitelist applies to the desk's address while whitelisting is on; `/desk fund` warns.

**HyperCore desk: on hold until one check is run.**
- **The plan:** the Treasury registers the trader's wallet as an API wallet (CoreWriter action 9), and the bot signs the trader's orders. An API wallet can even set leverage, which a contract can't.
- **The catch:** Hyperliquid's API also has `agentSendAsset`, "transfer tokens on behalf of the principal via an agent wallet". If an API wallet can send the principal's funds anywhere, a HyperCore desk can't promise the trader never withdraws.
- **The check:** `HL_TESTNET_KEY=0x... node scripts/hl-agent-check.mjs`, with a throwaway Hyperliquid testnet wallet holding a few testnet USDC, settles it in a minute.
  - It tries all three transfer routes from an API wallet.
  - It checks that revoking an API wallet (`approveAgent` to the zero address with the same name) actually stops it.

Phoenix (Solana) desks aren't built yet.

### External protocol actions

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

---

## 5. Testing and keepers

### EVM: every model at once

```bash
node scripts/test-evm-models.mjs --network monad-testnet          # about 20 minutes
node scripts/test-evm-models.mjs --network base-sepolia --models board,conviction
```

It runs all ten models' lifecycles side by side through the bot's own adapters, with a fresh DAO per model. It covers:
- proposals voted (or confirmed, supported, challenged, traded) through to execution, with a real treasury payment
- delegate elections and recalls
- a sortition draw
- a challenged optimistic vote
- a Sowellian adjudication
- a Sowellian proposal resolved by a live Pyth price (`sowellianOracle`): the ETH/USD feed looked up on Hermes, a signed update posted, and the price read through `PYTH_PRICE_ADAPTER`
- a decision-market finalization

It uses the bot's `.env`: the operator key, factory addresses, `SORTITION_RANDOMNESS_SOURCE`, `PYTH_PRICE_ADAPTER`, and `PYTH_API_KEY` if your Hermes needs one. It creates its DAOs with fast timings whatever the bot's own setting, and writes a report of every failed step and its revert to `data/evm-tests/`. Throwaway member wallets get their leftover gas swept back to the operator.

**On a local chain first:**
1. Start `anvil --chain-id 10143 --block-time 1`.
2. Build Spaces: `FOUNDRY_PROFILE=size-limited forge build`, plus `forge build test/PythAdapters.t.sol` for the stand-in Entropy.
3. Run `node scripts/deploy-local-evm.mjs > local.env`.
4. Run the test with those variables, `BLOCK_TIME_MS=1000`, and an anvil account as `OPERATOR_PRIVATE_KEY`.

**Model switching:** `scripts/test-evm-switch.mjs` runs switching end to end on anvil, through the same code `/switchmodel` uses. One DAO goes token-weighted → quadratic → board → conviction → token-weighted, each a real proposal that passes and executes. It checks that the Treasury, token and staking contract follow and nobody's stake moves.
- Start anvil with `--code-size-limit 100000 --prune-history`.
- Deploy with `deploy-local-evm.mjs`.
- Run `node --env-file=local.env scripts/test-evm-switch.mjs`.

**Trying flows by hand:** `<PREFIX>_FAST_TIMINGS=true` (`FAST_TIMINGS` on Monad testnet) gives the bot's own new DAOs the same short periods. Testnets only. `<PREFIX>_FAST_SCALE` multiplies them: `0.5` gives ~1-minute votes and 30-second timelocks, `0.25` ~30 seconds and 15 seconds (`FAST_SCALE` on Monad testnet). It only affects DAOs created after it's set.

### Solana

All of these run against a local validator loaded with the Vortexes programs at their `declare_id!` addresses (`anchor build` in Vortexes, then `solana-test-validator --reset --bpf-program <id> target/deploy/<program>.so ...`). Each script's header has the exact setup. Run each with `node --experimental-test-module-mocks --test <script>`.

| Script | Covers |
|---|---|
| `scripts/test-solana-local.mjs` | the commands and notifications end to end, for token-weighted, quadratic, optimistic, board, conviction and delegate (about 15 minutes) |
| `scripts/test-solana-new-models.mjs` | the same for liquid, sortition, Sowellian and decision markets, with a stand-in for ORAO and a Pyth price account loaded into the validator |
| `scripts/test-solana-switch.mjs` | the DAO token record, a switch that keeps it, `settoken` and `/migrate` |
| `scripts/test-solana-pages.mjs` | proposal pages: the edit link, live data, the once-only submission, the "too late once people vote" rule |
| `scripts/test-solana-pages-charts.mjs` | pages through the real HTTP API (GET, POST, password edits, history), `/proposal` charts, vote-close posts with charts and page links, and explorer links on replies and notices |

### Protocol addresses

`npm run verify:integrations [network ...]` reads every external protocol address over the real RPCs and checks four things:
- every contract has code
- the protocols' cross-references hold (e.g. a router's factory is the factory listed here)
- known token symbols are as expected
- protocol-specific facts, such as HyperCore's precompiles agreeing on the USDC and HYPE token indexes

Run it before enabling a network.

### Keepers

Pyth Entropy calls back by itself, usually within seconds, so randomness needs no settlement. One optional keeper finishes the job:

- **Sortition:** `npm run keeper:sortition` finalizes each Sortition DAO's round once its randomness has arrived, paying gas from the operator wallet. Anyone can also run `/finalizesortition`.
  - Run **one process per network**: set `KEEPER_NETWORK` (default: the default network).
  - It polls every 30 s.
- **Paying for randomness:** each draw costs Pyth Entropy's fee, in the chain's native currency.
  - `/startsortition` uses the DAO's credit at the Entropy adapter first, and tops up only the shortfall from the caller's wallet.
  - A DAO can prefund its credit: anyone can call the adapter's `fund(governance)`, e.g. the Treasury through a proposal. After that, draws cost callers only gas.
- **Sowellian oracle proposals** need no keeper: `/resolveviaoracle` posts Pyth's price and resolves in one go.
- **Solana** needs no keepers. ORAO answers sortition draws itself, and the bot applies due model switches.

### Known limitations

- **`/createdao` mints the initial supply to the operator wallet,** not to whoever ran the command, and records the operator as `creator` on-chain. `/tip` and welcome distributors are how tokens reach members.
- **Pyth fees come from the caller.** `/startsortition` (when the DAO's Entropy credit is short) and `/resolveviaoracle` (the price update) spend native currency from the caller's wallet. Gas sponsorship covers gas only.
- **Wrapped native is never auto-unwrapped.** Redeeming or reclaiming on a Decision Markets quote side returns the wrapped token; `/unwrap` converts it back.
- **Chat links default to a flat file** (`data/chats.json`). Set `CHAT_LINKS_STORE=supabase` to keep them in the database.

### What's not verified yet

- Anything on the mainnets (nothing deployed).
- **External protocol actions against the live protocols.** Each was tested on local chains through a real Board DAO:
  - Uniswap, Aerodrome, Lido-via-Aerodrome and Seaport ran against those protocols' real compiled contracts. HyperSwap and kHYPE-via-HyperSwap ran against Uniswap's real v3 contracts (HyperSwap v3 is a Uniswap v3 fork).
  - Aave, HyperLend, shMON, Nad.fun, Perpl, Flaunch and HyperCore ran against stand-ins with the protocols' exact function signatures.
  - HyperCore's action bytes were also compared with those hyper-evm-lib produces.
- A real Slack workspace.

### Not built yet

- Group-wide gas sponsorship with spending limits
- Phoenix perps and desks on Solana

---

## 6. Platform notes

Every Telegram command also runs on Discord, Slack and WhatsApp, except `/start` (use `help`) and `/migratewallet` (legacy seed wallets only ever existed for Telegram IDs).
- Each platform runs as its own process, sharing the same `data/` volume, wallet store and chain config as the Telegram bot. None needs `TELEGRAM_BOT_TOKEN`.
- Command logic lives in `src/platforms/commands/`; `discord.js`, `slack.js` and `whatsapp.js` only handle transport.

```bash
npm run discord   # DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, optional DISCORD_GUILD_ID
npm run slack     # SLACK_APP_TOKEN + either SLACK_BOT_TOKEN (one workspace) or the "Add to Slack" settings below
npm run whatsapp  # WHATSAPP_LINK_SECRET (scan a QR) or WHATSAPP_PHONE_NUMBER (pairing code)
```

### On every platform

- **Privacy:** anything Telegram sends by DM is shown only to the caller: an ephemeral reply on Discord (which also hides the options typed), an ephemeral response on Slack, a DM on WhatsApp. That covers bets, confidential balances, rewards, handover proposals and the treasury address from `contribute`. So `back` takes its opportunity and amount directly; they never appear in the channel.
- **Linker vs creator:**
  - Whoever runs `register` becomes the channel's *linker*, who can relink and unlink.
  - Whoever runs `createdao`/`createboarddao` is the DAO's *creator*, who can also `tip`, deploy wrappers and deploy distributors.
  - Registering an existing DAO never grants creator rights.
- **Owners and admins only:** creating, registering and unregistering a DAO or market (`createdao`, `createboarddao`, `register`, `unregister`, `createmarket`, `registermarket`, `unregistermarket`) is limited to:
  - Telegram: the group's owner and admins. Anonymous admins count, and a DM is allowed.
  - Discord: members with *Manage Server*.
  - Slack: workspace admins and owners.
  - WhatsApp: group admins. A DM is allowed.
- **Errors** name the contract's reason, e.g. `AlreadyConfirmed`.

### Discord

- **Registers 62 native slash commands on startup** (Discord allows 100).
  - The specialist ones are subcommands of four group commands, with the same names as elsewhere: `/market …` (Opportunity Market, e.g. `/market back`), `/sowellian …`, `/decision-market …` and `/guard …`. The bot's replies on Discord name them that way.
  - Registration refuses to start with more than 100, so new commands get grouped rather than silently dropped.
- **Long replies** are split across messages.
- **Copied values:** backticks in pasted command values are dropped (Discord's Copy Text keeps them).
- **`/propose`'s fields** read target/value/data for EVM and recipient/amount/asset for Solana.

### Slack

- **One command:** `/protean <subcommand>`, e.g. `/protean vote 3 for`.
- **Creating the app:** use [`docs/slack-app-manifest.yml`](docs/slack-app-manifest.yml). It turns on interactivity for buttons and the `files:write` scope for charts.
- **Copied formatting** in arguments (backticks, code blocks, bold and italic, links, escapes) is stripped.
- **Welcome tokens:** joining a channel with a welcome distributor sends the newcomer their tokens, as on Telegram.
- **Any workspace:**
  - With `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` and `SLACK_PUBLIC_URL` set, the Slack process also serves an "Add to Slack" link at `<SLACK_PUBLIC_URL>/slack/install`. It listens on `PORT`, so the service needs a public domain.
  - Each workspace's bot token is stored encrypted under the wallets' KMS key, in Supabase's `slack_installations` table. Uninstalling deletes it.
  - Install into your own workspace through the same link, then activate public distribution.
  - Without `SLACK_CLIENT_ID`, it runs in one workspace on `SLACK_BOT_TOKEN`.
  - Slack doesn't list Socket Mode apps in its App Directory, so share the link directly.

### WhatsApp

WhatsApp runs through [Baileys](https://baileys.wiki/), an unofficial library that links the bot's own WhatsApp number as a linked device, like WhatsApp Web.
- **Using it:** commands are ordinary messages starting with `/` (e.g. `/vote 3 for`), in a group or a DM with the bot's number. One group links to one DAO. Add the number to a group like any contact.
- **Linking the number by QR:**
  1. Set `WHATSAPP_LINK_SECRET` to a long random string (e.g. `openssl rand -hex 32`) and leave `WHATSAPP_PHONE_NUMBER` unset.
  2. Open `https://<bot domain>/whatsapp/link?key=<WHATSAPP_LINK_SECRET>` on a computer or a second screen.
  3. On the bot's phone, go to *WhatsApp → Linked devices → Link a device* and scan it.

  The page follows WhatsApp's QR as it changes every 20 s and switches to "linked" once done. The bot draws the QR itself and never sends it to an outside service. Whoever scans it links *their* WhatsApp to the bot, so keep the link private. Wrong keys are rate limited.
- **Or by pairing code:** set `WHATSAPP_PHONE_NUMBER` (digits with country code, e.g. `2348012345678`) instead. The log prints a code; on the bot's phone open *Linked devices → Link a device → Link with phone number instead* and enter it. A code lasts about 2 minutes, and a new one follows. When the number is set, it's used instead of the QR.
- **Session:** saved in `data/whatsapp-auth/` (override with `WHATSAPP_AUTH_DIR`), so it must be on the persistent volume. Later restarts reconnect without scanning. If the device is unlinked from the phone, the saved session is cleared and linking starts again.
- **Wallets** are keyed to the member's WhatsApp LID (its privacy ID), not their phone number. So a wallet survives a number change, and the bot never stores numbers.
- **Private replies:** WhatsApp has nothing like ephemeral messages.
  - Results that are actually private go to the caller's DM, with a one-line pointer in the group: bets, confidential balances, rewards, handover proposals, the treasury address from `contribute`, a proposer's edit link.
  - Everything else is answered in the group, including errors, `help`, `wallet`, `listactions` and `actioninfo` (which Discord shows privately only to keep channels tidy).
  - If a DM can't be delivered, the bot asks the member to message it first.
- **No buttons:** WhatsApp has no bot buttons, so commands are typed there.
- **One process at a time:** only one process may use the linked session. A second one makes WhatsApp drop the first; the bot logs this and stops.
- **Timing:** commands from the same person run one at a time. Messages WhatsApp delivers more than 5 minutes late are ignored. Replies in groups with disappearing messages use the group's timer.
- **Risk:** Baileys is not an official WhatsApp API, and WhatsApp can ban numbers it judges to be automated. Use a dedicated number, not anyone's personal one. The bot only ever replies to commands, which keeps that risk low.
