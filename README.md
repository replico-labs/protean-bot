# Protean: DAO Governance Bot for Telegram, Discord, Slack and WhatsApp

Protean turns a group chat into a working DAO. A group deploys a governance system under any of ten models, and its members get wallets, stake, propose, vote, trade decision markets and place confidential bets without leaving the chat.

- **Contracts:** EVM contracts are in [`Spaces`](https://github.com/replico-labs/Spaces) and Solana programs in [`Vortexes`](https://github.com/replico-labs/Vortexes). Their READMEs list the deployed addresses.
- **Try it:** [Telegram](https://t.me/proteandao_bot) · [Discord](https://discord.com/oauth2/authorize?client_id=1550697784259121203&permissions=3072&integration_type=0&scope=applications.commands+bot) · [Slack](https://protean-bot-production.up.railway.app/slack/install)

## What it is

- **One command set on four platforms:** Telegram, Discord, Slack and WhatsApp.
- **Ten governance models,** each its own contract:
  - token-weighted, quadratic, liquid, optimistic
  - delegate (an elected council), sortition (a council drawn by lot)
  - conviction, board (a multisig)
  - Sowellian, decision markets (futarchy)
- **Three EVM testnets plus Solana devnet:** Monad testnet, Base Sepolia and HyperEVM testnet, and Solana devnet through Vortexes. The mainnets are supported but nothing is deployed on them yet.
- **Confidential prediction markets** (Opportunity Markets), on Ethereum Sepolia with Zama FHE.
- **A wallet for every member,** created on first use and paid for gas by the bot.


## Supported networks

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


## Prerequisites

- **Node.js 22**
- **A Telegram bot token** from BotFather, and/or the Discord, Slack or WhatsApp settings in [Platform notes](docs/platforms.md)
- **An operator wallet** (`OPERATOR_PRIVATE_KEY`), funded on every enabled network. It deploys DAOs and pays members' gas.
- **Factory addresses** for each network, from Spaces' README
- **For member wallets:** an AWS KMS symmetric key and a Supabase project
- **Optional:** a Solana operator key (`SOLANA_OPERATOR_KEY`) for Solana DAOs, Pyth API key, proposal-page website

## Install and run

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

## Environment

| Variable | Needed for | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | the Telegram bot | from BotFather |
| `RPC_URL`, `RPC_URLS`, `RPC_PUBLIC_FALLBACK` | optional | Monad testnet RPC (viem's public one by default); backup RPCs in order; the public RPC is always the last resort unless `false` |
| `NETWORKS`, `DEFAULT_NETWORK` | more than one network | see [Networks and gas](docs/architecture.md#networks-and-gas) |
| `OPERATOR_PRIVATE_KEY` | `/createdao`, `/claim`, gas top-ups, keepers | a funded hot wallet on every enabled network; see [Security](docs/architecture.md#security) |
| `FACTORY_ADDRESS`, `<MODEL>_FACTORY_ADDRESS` | `/createdao` per model | per network with a prefix (`BASE_FACTORY_ADDRESS`); a model with no address can't be created there, but can still be `/register`ed |
| `SORTITION_RANDOMNESS_SOURCE` | sortition DAOs | the deployed `PythEntropyRandomnessAdapter`, per network |
| `PYTH_PRICE_ADAPTER` | Sowellian's oracle track | the deployed `PythPriceFeedAdapter`, per network |
| `PYTH_API_KEY`, `PYTH_HERMES_URL` | `/resolveviaoracle` | a Pyth Terminal key; Hermes defaults to `https://pyth.dourolabs.app/hermes` |
| `KMS_KEY_ID`, `AWS_REGION`, AWS credentials | member wallets | one symmetric KMS key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | member wallets, pages, chat links | the service_role key; RLS allows nothing else |
| `CHAT_LINKS_STORE` | optional | `supabase` keeps chat links in the database; see [Chat links](docs/architecture.md#chat-links) |
| `PROPOSAL_SITE_URL`, `PROPOSAL_LINK_SECRET` | proposal pages | the website's URL and a long random secret for edit links |
| `PROPOSAL_DETAILS_GRACE_HOURS` | optional | how long details stay editable after proposing (default 6) |
| `SOLANA_ENABLED`, `SOLANA_OPERATOR_KEY`, `SOLANA_DEVNET_RPC_URL` | Solana DAOs | see `.env.example` |
| `MASTER_WALLET_SEED` | legacy wallets only | keep it only while old wallets still hold funds |
| `OPPORTUNITY_MARKET_RPC_URL`, `OPPORTUNITY_MARKET_FACTORY_ADDRESS` | Opportunity Markets | Sepolia |
| `DISCORD_*`, `SLACK_*`, `WHATSAPP_*` | those platforms | see [Platform notes](docs/platforms.md) |
| `<PREFIX>_FAST_TIMINGS`, `<PREFIX>_FAST_SCALE` | testing | short governance periods on testnets; see [Testing](docs/testing-and-keepers.md) |

`.env.example` lists every variable, including the per-network prefixes and the deployed factory addresses.

## Deploying persistently

The bots use long polling and sockets, so they need long-lived processes, not serverless. The bots and keepers all read `data/` (the keepers find DAOs there), so they must share one persistent volume.

Railway attaches a volume to a single service, so run them together in one service, leaving out any you haven't configured:

```bash
sh -c "npm start & npm run discord & npm run slack & npm run whatsapp & KEEPER_NETWORK=monad-testnet npm run keeper:sortition & KEEPER_NETWORK=base-sepolia npm run keeper:sortition & KEEPER_NETWORK=hyperevm-testnet npm run keeper:sortition & wait"
```

With "Add to Slack", proposal pages or WhatsApp's QR link page, give that service a public domain. Railway's `PORT` is where they listen.

## Running the tests

```bash
node scripts/test-evm-models.mjs --network monad-testnet   # every EVM model's lifecycle on a live testnet
node --env-file=local.env scripts/test-evm-switch.mjs       # model switching, on anvil
node --experimental-test-module-mocks --test scripts/test-solana-local.mjs   # Solana, on a local validator
node --experimental-test-module-mocks --test scripts/test-slack.mjs        # Slack replies, buttons, charts and links; no chain needed
```

Each script's header has its setup. [Testing and keepers](docs/testing-and-keepers.md) covers what each one checks, local chains, fast timings and the keepers.

## Documentation

| Doc | What's in it |
|---|---|
| [Architecture](docs/architecture.md) | source map, wallets and KMS, networks and gas, sponsorship, RPC fallbacks, chat links, security |
| [Commands](docs/commands.md) | every command, buttons under proposals, the `/help` menu |
| [Governance models](docs/governance-models.md) | the ten models, `/switchmodel`, Guard wrapper, NFTs, Sowellian and Decision Markets, conviction budgets |
| [Proposals and notifications](docs/proposals-and-notifications.md) | proposal pages, explorer links, chat notifications, vote charts |
| [Solana](docs/solana.md) | Vortexes DAOs: commands, actions, switching, pages and charts |
| [Opportunity Markets](docs/opportunity-markets.md) | confidential prediction markets on Sepolia |
| [Trading](docs/trading.md) | `/perps`, the trading desk, external protocol actions |
| [Testing and keepers](docs/testing-and-keepers.md) | what's verified, every test script, keepers, known limitations, what's not built yet |
| [Platforms](docs/platforms.md) | Discord, Slack and WhatsApp setup and differences |

`src/abis/*.json` is copied from Spaces' Foundry output. **Whenever a contract changes, re-extract its ABI and artifact and copy them here.** The bot has no compiler, so otherwise it silently keeps using the old ones.
