# Architecture

How the bot is put together: source layout, wallets, networks and gas, chat links and security.

## Source map

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
docs/                     the guides linked from the README, and the Slack app manifest
scripts/                  end-to-end tests, local deploys, integration checks
```

`src/abis/*.json` is copied from Spaces' Foundry output. **Whenever a contract changes, re-extract its ABI and artifact and copy them here.** The bot has no compiler, so otherwise it silently keeps using the old ones.

## Wallets and KMS

Every member gets their own wallet, created automatically the first time they need one. There's no external wallet app and no connect step. Each member has one wallet per chat platform, and the same address works on every EVM network.

- **Encryption:** each private key is envelope-encrypted with AWS KMS (AES-256-GCM, a per-user data key wrapped by one symmetric KMS key) and stored in Supabase. The plaintext key exists in memory only for the instant a transaction is signed. A leaked database alone reveals nothing usable; decryption also needs KMS access.
- **Custody:** this is still a **custodial** model. The bot's backend can decrypt any member's key, trading some decentralization for zero-friction onboarding.
- **Solana wallets:** each member also gets a Solana wallet, encrypted with the same KMS key and stored on the same Supabase row (`wallets.solana`). `/wallet` shows both addresses.
- **Legacy wallets:** earlier versions derived every Telegram wallet from one `MASTER_WALLET_SEED`. If a member still has funds at that old address, the bot won't silently create a second wallet. It asks them to run `/migratewallet` first, which sweeps the native balance across. ERC-20 tokens must be moved by hand, and the command says so.

## Networks and gas

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

## Chat links

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

## Security

- **Never paste private keys** into chats, commands or shell history. Use `export PRIVATE_KEY=...` and reference `$PRIVATE_KEY`. Treat any key that has appeared in plaintext as burned.
- **`OPERATOR_PRIVATE_KEY`** pays gas for `/createdao`, `/claim`, keeper transactions and member top-ups, on every enabled network. Keep it funded but not over-funded. On mainnets especially, set the top-up amounts deliberately (`<PREFIX>_GAS_TOPUP_FIRST` etc.).
- **KMS IAM scope:** the bot's AWS credentials should only be able to `Decrypt` and `GenerateDataKey` on the one key, not manage or delete it.
- **`SUPABASE_SERVICE_ROLE_KEY`** bypasses Row Level Security by design. Treat it like a database root password.
- **`MASTER_WALLET_SEED`** (legacy) can derive every old wallet's key. Remove it once no old wallet holds funds.
- **Logs are redacted** (`src/logRedaction.js`, loaded first by every process). The Telegram token, any env value named like a key, token or secret, and key-like parts of RPC URLs are blanked before a line is written. Still, don't paste raw logs publicly, and rotate anything logged before this was added.

[Back to the README](../README.md)
