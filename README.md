# Protean — DAO Governance Bot for Telegram, Discord, Slack and WhatsApp

Turns a group chat into a fully functioning DAO. Deploy a governance system under any of ten models, get a wallet, stake, propose, vote, trade decision markets, and place confidential bets — all without leaving the chat. Runs on Telegram, Discord, Slack and WhatsApp. Deployed on Monad testnet, Base Sepolia and HyperEVM testnet; the mainnets are supported but not yet deployed.

Contracts live in the companion repo, [`Spaces`](https://github.com/replico-labs/Spaces). See its README for deployed addresses per network.

## Status

- **Contracts:** 539/539 Foundry tests pass (see Spaces).
- **Live on Monad testnet:** the full create → propose → vote → queue → execute loop has run through Telegram for token-weighted and Board DAOs, with real receipts.
- **Tested end to end on local chains** (anvil, with the real contracts deployed from source): every model's full lifecycle through the Discord and Slack handlers — the same command code Telegram uses for the shared paths — about 230 checks, including a GuardWrapper handover with a treasury payout confirmed by signers. The network layer has its own two-chain test: one bot process serving a "Monad" chain and a "Base" chain at once.
- **Deployed on Base Sepolia and HyperEVM testnet:** all ten factories plus the Pyth Entropy and price-feed adapters, built with Spaces' `size-limited` profile (addresses in Spaces' README).
- **Not yet run live:** the other eight models on Monad testnet, any DAO lifecycle on Base Sepolia or HyperEVM testnet, the mainnets (nothing deployed), real Discord and Slack workspaces, a real WhatsApp number, the FHE relayer round-trip, and Pyth Entropy / Hermes on a live chain. See [What's not verified yet](#whats-not-verified-yet).

## How wallets work

Every user gets their own independently generated wallet, created automatically the first time they need one — no external wallet app, no connect step. One wallet per user per chat platform; the same address works on every EVM network.

Each private key is **envelope-encrypted with AWS KMS** (AES-256-GCM, with a per-user data key wrapped by one symmetric KMS key) and stored in Supabase. The plaintext key only exists in memory for the instant a transaction is signed. A leaked database alone reveals nothing usable; decryption requires KMS access too.

This is still a **custodial** model — the bot's backend can decrypt any user's key. It trades some decentralization for zero-friction onboarding.

The operator wallet pays users' gas, never the amounts they send.
- **On creation:** a new wallet gets its starting gas as soon as it's created, on the chat's network. That's 0.1 MON on Monad, 0.0002 ETH on Base and 0.01 HYPE on HyperEVM by default.
- **Before each transaction:** the bot reads the wallet's balance fresh from the chain. If the balance can't cover that transaction's up-front cost, the operator tops up the shortfall (at least the network's repeat amount) before signing. Monad charges gas limit × max fee up front, so this is checked against the fees the transaction is actually sent with.
- **Other networks:** a wallet is funded on first use there.

**Legacy wallets.** Earlier versions derived every Telegram wallet from a single `MASTER_WALLET_SEED`. If a user still has funds under that old address, the bot refuses to silently create a second wallet and asks them to run `/migratewallet` first, which sweeps the native balance across (ERC20 tokens must be moved manually — the command says so).

## Networks

| Network | id | Chain | Gas token | Notes |
|---|---|---|---|---|
| Monad testnet | `monad-testnet` | 10143 | MON | the default; all ten factories and both Pyth adapters deployed |
| Monad mainnet | `monad-mainnet` | 143 | MON | not yet deployed |
| Base | `base` | 8453 | ETH | not yet deployed; contracts must be built with Spaces' `size-limited` profile |
| Base Sepolia | `base-sepolia` | 84532 | ETH | all ten factories and both Pyth adapters deployed (`size-limited`) |
| HyperEVM | `hyperevm` | 999 | HYPE | not yet deployed; `size-limited`, plus big blocks for factory deploys |
| HyperEVM testnet | `hyperevm-testnet` | 998 | HYPE | all ten factories and both Pyth adapters deployed (`size-limited`, big blocks); set a provider `HYPEREVM_TESTNET_RPC_URL`, the public RPC rate-limits hard |

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
- **Gas.** Monad charges the full gas limit, not gas used, and its `eth_estimateGas` can come back far too high (a Board execute that used ~150k was estimated at ~9.94M). So no limit is a guess (`src/gasLimit.js`): each write is simulated once with `eth_createAccessList` to get the gas it really uses (or, where a node lacks that, the smallest limit `eth_call` succeeds within, found by halving), then sent at that +15%, or +20% if a simulation capped at +15% fails, plus 25,000 gas because the simulation runs against the latest block while the transaction lands in the next one (code that settles "up to this block", like Conviction's support, can write storage the simulation skipped). A transaction that is mined but reverts is reported as an error, never as success. Contract writes, deployments, native sends, Board execute (no longer pinned at 400k) and the Sepolia market writes all use it. On HyperEVM the limit is capped at the 2M small-block limit; a transaction that genuinely needs more fails with an explanation, since its sender would have to switch to big blocks. Every model's DAO creation fits under 2M (the heaviest, Delegate, is ~1.29M).
- **The native token.** `/send 1 0x... ETH` on Base, `HYPE` on HyperEVM, `MON` on Monad — or `native` anywhere.

Opportunity Markets are separate and always on Ethereum Sepolia; Zama's FHE coprocessor doesn't exist on Monad, Base or HyperEVM.

## Commands

`/help` is model-aware: it only shows commands that apply to the current chat's governance model and linked wrappers/markets.

### Setup
- `/createdao <name> <symbol> <initialSupply> <maxSupply> [model] [network] [council...]` — deploy a DAO and link it here. Models: `tokenWeighted` (default), `quadratic`, `liquid`, `optimistic`, `delegate`, `sortition`, `conviction`, `sowellian`, `decisionMarkets`. `delegate` and `sortition` take the starting council as trailing addresses; sortition's randomness source comes from the bot's config.
- `/createboarddao <name> <signer1> <signer2> ... [network]` — deploy a Board (multisig) DAO; no token at all
- **Spaces in arguments:** a description (`/propose`, `/proposeaction`, `/vote` reasons, `/listopportunity`) is everything after the last fixed argument, so it can be plain text with spaces. A DAO name with spaces goes in quotes: `/createdao "Ark DAO" ARK 1000000 10000000` (straight or curly quotes; on Telegram and Slack). Discord's name field takes spaces as is.
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
- `/listactions` · `/proposeaction <actionId> <args...> <description>` — the verified action library: every native governance, Treasury, token and wrapper admin function, encoded for you, plus the external protocol actions available on the chat's network (see [External protocol actions](#external-protocol-actions)). After a GuardWrapper handover, Treasury and token actions are routed through the wrapper automatically. Works for every model: Sowellian and Decision Markets DAOs add their settings as `name=value` words anywhere after the action ID (below), so nobody has to hand-type calldata into `/proposecriteria` or `/proposemarket`.
- `/actioninfo <actionId>` — an action's arguments, options, and the sources its contract addresses were checked against
- `/propose <target> <value> <data> <description>` — raw calldata, for anything else
- `/vote <id> for|against|abstain [reason]` · `/queue <id>` · `/execute <id> [nativeValue]` · `/cancel <id>`

### Model-specific
| Model | Commands |
|---|---|
| Board | `/confirm <id>`, `/revoke <id>` |
| Liquid | `/delegate <address>`, `/undelegate`, `/resolvedelegations <id> [address]` |
| Optimistic | `/challenge <id>` |
| Conviction | `/support <id>`, `/withdrawsupport`, `/mysupport`, `/assets [apply <asset>]` |
| Delegate | `/startelection`, `/declarecandidacy`, `/voteinelection`, `/finalizeelection`, `/initiaterecall`, `/voterecall`, `/finalizerecall`, `/council` |
| Sortition | `/registereligible`, `/withdraweligibility`, `/startsortition`, `/finalizesortition`, `/council` |
| Sowellian | `/proposecriteria`, `/castapprovalvote`, `/finalizeapproval`, `/takeposition`, `/resolveviaoracle`, `/proposeresolution`, `/challengeresolution`, `/finalizeunchallenged`, `/castadjudicationvote`, `/finalizeadjudication`, `/claimposition` |
| Decision Markets | `/proposemarket`, `/split`, `/trade`, `/merge`, `/finalizeproposal`, `/redeem`, `/unwrap`, `/reclaimliquidity` |

**Liquid delegation.** A delegate's vote counts only their own tokens. Each delegator's weight is added by a separate on-chain call, `resolveDelegatedVote`, which anyone can make while voting is open. The bot makes these calls for you:
- **When a delegate votes through `/vote`,** it resolves everyone behind them, up to 5 delegation hops, and replies with how much weight was added.
- **The event listener** does the same for every vote seen on-chain (including votes cast outside the bot), and for anyone who delegates while a proposal is open.
- **`/resolvedelegations <id> [address]`** runs it on demand.

The operator wallet pays for these calls. Someone who votes directly before being resolved keeps their own vote.

Bonds and seeds (Optimistic challenges, Sowellian bonds and positions, Decision Markets seeds and trades) are approved automatically before the contract pulls them.

### Guard wrapper
- `/guardwrapper` — signers, threshold, tenure
- `/instruction <id>` · `/confirminstruction <id>` · `/rejectinstruction <id>` · `/revokeconfirmation <id>`

### Sowellian and Decision Markets through `/proposeaction`
```
/proposeaction treasury-transfer-eth 0xRecipient 1 measure=7d Fund the grant                      (Sowellian, human track)
/proposeaction treasury-transfer-eth 0xRecipient 1 track=oracle feed=0x<ETH/USD feed ID> goal=3000 when=min measure=30d Grow TVL
/proposeaction treasury-transfer-eth 0xRecipient 1 seed=1000 quote=5 Fund the campaign            (Decision Markets)
```
- **Sowellian:** `track=human|oracle` (default human); on the oracle track `feed=<Pyth price feed ID>` and `goal=<price>` (e.g. 3000, sent as 18 decimals) are required and `oracle=` defaults to `pyth`, this network's `PYTH_PRICE_ADAPTER`; `when=min|max` (default min), `measure=<duration>` (default 7d). `/actioninfo` lists them in a Sowellian chat.
- **Decision Markets:** `seed=<DAO tokens>` and `quote=<native>`, both required.
- `/proposecriteria` and `/proposemarket` remain for raw calls the library doesn't cover.

### Proposal pages
Every proposal gets a page on the website, `PROPOSAL_SITE_URL/p/<network>/<dao>/<id>`, with details its proposer writes there next to live on-chain data (state, votes or conviction, budget, timelock, actions).
- **After proposing**, the group sees the page link and the proposer gets a private link to add the details: a Telegram DM (or, if the bot can't message them first, a `t.me/<bot>?start=…` link that opens one), a message only they can see on Discord and Slack, or a WhatsApp DM.
- **Submitted once, never changed.** The proposer submits the details a single time, before anyone votes or backs the proposal and within 72 hours, so what people back is what they read. The page shows the details' fingerprint (sha256).
- **`/proposal <id>`** ends with the page link. Run by the proposer before they've submitted, it also re-sends their link privately.
- **How it's served:** the website is static; it reads `GET /api/proposals/<network>/<dao>/<id>` from the bot and the form `POST`s back. The routes share the Slack install page's HTTP server when "Add to Slack" is set up, otherwise the Telegram process listens on `PORT`. Only DAOs registered with the bot are served; CORS allows only `PROPOSAL_SITE_URL`. Edit links are HMAC-signed with `PROPOSAL_LINK_SECRET` and expire with the edit window.
- **Setup:** run the `proposal_details` part of `supabase/schema.sql`, then set `PROPOSAL_SITE_URL` and `PROPOSAL_LINK_SECRET` (a long random string). Without them the bot behaves as before.

### Conviction spending budgets
Conviction DAOs from the newer factory check what each proposal spends (see Spaces' README, "Conviction spending budgets"). The bot fills in the budget itself: native sent by `transferETH` or with a `Treasury.execute` step, and tokens moved by `transferERC20` or approved/transferred inside `Treasury.execute` - which covers every action in `/listactions`, the protocol integrations and raw `/propose` calls of those shapes. `/proposal` shows "May spend: 10 USDC, 0.5 MON", or a warning when a proposal weakens the rules. `/assets` lists the assets, their weights, the Treasury's holdings and pending cuts (`/assets apply <asset>` once one is due). The list changes by proposal: `conviction-add-asset`, `conviction-set-asset-weight`, `conviction-remove-asset` (native: `MON`/`ETH`/`HYPE` or `native`). Older Conviction DAOs keep proposing the old way.

### Sowellian oracle proposals (raw calls)
```
/proposecriteria <target> <value> <data> oracle <pyth|adapter> <feedId> <targetValue> min|max <measurementPeriodSeconds> <description>
```
- **Pyth:** type `pyth` (the network's `PYTH_PRICE_ADAPTER`) and the Pyth price feed ID (0x + 64 hex, from Pyth's price feed list). One adapter serves every feed. The target value is a price, e.g. `3000`, sent as 18 decimals.
- **Resolving:** Pyth is pull-based. `/resolveviaoracle` fetches the feed's latest signed update from Pyth's Hermes service (needs `PYTH_API_KEY` from Pyth Terminal; `PYTH_HERMES_URL` defaults to `https://pyth.dourolabs.app/hermes`), posts it to Pyth paying its small fee from the caller's wallet, then resolves, so the price is fresh for `maxOracleStaleness`.
- **Human track:** `human - -` in the oracle and feed slots.

### Opportunity Markets (Ethereum Sepolia, FHE-encrypted)
- `/createmarket <underlyingToken>` · `/registermarket <address>` · `/unregistermarket` (group owners/admins only)
- `/listopportunity <metadataURI>` · `/deposit <amount>` · `/back <opportunityId> <amount>` (confidential)
- `/mybalance` · `/mybet <index>` · `/allbets` · `/analytics` (deployer only, sent privately: total staked, average bet, average per bettor and largest bet, overall and per opportunity, plus each opportunity's share of all stake. Built from the bets the contract already lets the deployer decrypt; nothing new is revealed publicly)
- `/fundrewardpool` · `/resolve <id>` · `/cancelmarket` (deployer only)
- `/reclaimstake` · `/computereward` · `/revealwinningtotal` · `/withdraw` · `/withdrawreward`
- `/computereward` tells you the reward amount privately. The contract keeps it encrypted with no getter, so the bot works it out from your own decrypted bets and the public pool, winning opportunity and winning total, repeating the contract's 64-bit math exactly (and warns if that math wrapped). `/withdraw` and `/withdrawreward` report the exact amount paid: the KMS-signed cleartext the contract pays out.
- `/send <amount|all> <recipient> [ETH]` — in a market group, sends the market's token (your withdrawn stake or reward) or Sepolia ETH from your wallet. In a group with a DAO too, add `market` (or the token's symbol or address) to send the market's token. Sepolia gas isn't sponsored; an empty wallet is told how much it needs and its address.

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

HyperCore note: Core applies CoreWriter actions just after the EVM transaction. A proposal can execute successfully while Core rejects the order (tick size, no balance, no fill). The bot checks Hyperliquid's tick and lot rules before proposing, and says so in every summary.

## NFTs

The Treasury can't receive NFTs (it has no ERC721/ERC1155 receiver hooks), so **a DAO's NFTs live in its NFT wrapper** (`/deploynftwrapper`):

- Send NFTs to the wrapper's address, never to the Treasury.
- Governance lists them (`nftwrapper-approve-order-hash`), sends them out (`nftwrapper-transfer-erc721` / `-erc1155`, which refuse the Treasury as a recipient), or calls a marketplace directly (`nftwrapper-execute`).
- Sale proceeds go back to the Treasury with `nftwrapper-sweep-native` / `-erc20`.
- Every one of those is a proposal (`/proposeaction`). To buy an NFT, first move funds from the Treasury to the wrapper (`treasury-transfer-eth` / `-erc20`).

## Discord, Slack and WhatsApp

Every Telegram command also runs on Discord, Slack and WhatsApp, except `/start` (use `help`) and `/migratewallet` (legacy seed wallets only ever existed for Telegram IDs). Each platform runs as its own process sharing the same `data/` volume, wallet store and chain config as the Telegram bot. None needs `TELEGRAM_BOT_TOKEN`.

```bash
npm run discord   # DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, optional DISCORD_GUILD_ID
npm run slack     # SLACK_APP_TOKEN + either SLACK_BOT_TOKEN (one workspace) or the "Add to Slack" settings below
npm run whatsapp  # WHATSAPP_LINK_SECRET (scan a QR) or WHATSAPP_PHONE_NUMBER (pairing code)
```

- **Discord** registers 99 native slash commands on startup (Discord allows 100). `createdao`, `createboarddao`, `register`, `unregister`, `createmarket`, `registermarket` and `unregistermarket` are for members with *Manage Server* only. Long replies are split across messages.
- **Slack** uses one command, `/protean <subcommand>` (e.g. `/protean vote 3 for`). Create the app from [`docs/slack-app-manifest.yml`](docs/slack-app-manifest.yml). Joining a channel with a welcome distributor sends the newcomer their tokens, as on Telegram.
- **Slack in any workspace:** with `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` and `SLACK_PUBLIC_URL` set, the Slack process also serves an "Add to Slack" link at `<SLACK_PUBLIC_URL>/slack/install` (on `PORT`, so the service needs a public domain). Each workspace's bot token is stored encrypted under the wallets' KMS key, in Supabase's `slack_installations` table (`supabase/schema.sql`); uninstalling deletes it. Install into your own workspace through the same link, then activate public distribution. Without `SLACK_CLIENT_ID` it runs in one workspace on `SLACK_BOT_TOKEN`. Slack doesn't list Socket Mode apps in its App Directory, so share the link directly.
- **WhatsApp** runs through [Baileys](https://baileys.wiki/), an unofficial library that links the bot's own WhatsApp number as a linked device (like WhatsApp Web). Commands are ordinary messages starting with `/` (e.g. `/vote 3 for`), in a group or a DM with the bot's number; one group links to one DAO. Add the number to a group like any contact.
  - **Linking the number, by QR (like WhatsApp Web):** set `WHATSAPP_LINK_SECRET` to a long random string (e.g. `openssl rand -hex 32`) and leave `WHATSAPP_PHONE_NUMBER` unset. Open `https://<bot domain>/whatsapp/link?key=<WHATSAPP_LINK_SECRET>` on a computer or a second screen, then on the bot's phone go to *WhatsApp → Linked devices → Link a device* and scan it. The page follows WhatsApp's QR as it changes every 20 s and switches to "linked" once done. It's served on the bot's public port (the Slack install server, or the Telegram process when Slack's isn't running), and the QR is drawn by the bot itself, never sent to an outside QR service: whoever scans it links *their* WhatsApp to the bot, so keep the link private. Wrong keys are rate limited.
  - **Or by pairing code:** set `WHATSAPP_PHONE_NUMBER` (digits with country code, e.g. `2348012345678`) instead. The log prints a code; on the bot's phone open *WhatsApp → Linked devices → Link a device → Link with phone number instead* and enter it. A code lasts about 2 minutes and a new one follows. When the number is set, it's used instead of the QR.
  - The session is saved in `data/whatsapp-auth/` (override with `WHATSAPP_AUTH_DIR`), so it must be on the persistent volume; later restarts reconnect without scanning. If the device is unlinked from the phone, the saved session is cleared and linking starts again.
  - **Wallets** are keyed to the member's WhatsApp LID (its privacy ID), not their phone number, so a wallet survives a number change and the bot never stores numbers.
  - **Private replies:** WhatsApp has nothing like ephemeral messages, so results that are actually private (bets, confidential balances, rewards, handover proposals, the treasury address from `contribute`, a proposer's edit link) go to the caller's DM, with a one-line pointer in the group. Everything else is answered in the group, including `help`, `wallet`, `listactions` and `actioninfo` (which Discord shows privately only to keep channels tidy) and errors. If a DM can't be delivered, the bot asks the member to message it first.
  - Only one process may use the linked session at a time; a second one makes WhatsApp drop the first (the bot logs this and stops). Commands from the same person run one at a time; messages WhatsApp delivers more than 5 minutes late are ignored. Replies in groups with disappearing messages use the group's timer.
  - **Risk:** Baileys is not an official WhatsApp API. WhatsApp can ban numbers it judges to be automated, so use a dedicated number (not anyone's personal one). The bot only ever replies to commands, which keeps that risk low.
- **Privacy:** anything Telegram sends by DM (bets, confidential balances, rewards, handover proposals, the treasury address from `contribute`) is shown only to the caller: an ephemeral reply on Discord (which also hides the options typed), an ephemeral response on Slack, a DM on WhatsApp. So `back` takes its opportunity and amount directly — they never appear in the channel.
- **Link vs creator:** whoever runs `register` becomes the channel's *linker* (can relink/unlink); whoever runs `createdao`/`createboarddao` is the DAO's *creator* (can also `tip`, deploy wrappers and distributors). Registering an existing DAO never grants creator rights.
- **Owners and admins only:** creating, registering and unregistering a DAO or market (`createdao`, `createboarddao`, `register`, `unregister`, `createmarket`, `registermarket`, `unregistermarket`) is limited to the group's owner and admins on Telegram (anonymous admins count; a DM is allowed), *Manage Server* on Discord, workspace admins/owners on Slack, and group admins on WhatsApp (a DM is allowed).
- **Errors** name the contract's reason, e.g. `AlreadyConfirmed`.

Command logic lives in `src/platforms/commands/` (grouped as core, setup, tokens, models, sowellian, markets, opportunity); `discord.js`, `slack.js` and `whatsapp.js` only handle transport.

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
| `SORTITION_RANDOMNESS_SOURCE` | `/createdao ... sortition` | deployed `PythEntropyRandomnessAdapter` (Spaces), per network |
| `PYTH_PRICE_ADAPTER` | Sowellian oracle track (`oracle=pyth`) | deployed `PythPriceFeedAdapter` (Spaces), per network |
| `PROPOSAL_SITE_URL`, `PROPOSAL_LINK_SECRET` | proposal pages | the website's URL, e.g. `https://yoursite.com` and a long random secret for signing edit links; plus the `proposal_details` table |
| `PYTH_API_KEY` | `/resolveviaoracle` price updates | API key from Pyth Terminal; Hermes refuses price requests without one |
| `PYTH_HERMES_URL` | `/resolveviaoracle` price updates | optional, default `https://pyth.dourolabs.app/hermes` |
| `KMS_KEY_ID`, `AWS_REGION`, AWS credentials | KMS wallets | symmetric KMS key |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | KMS wallets | service_role key — RLS allows nothing else |
| `MASTER_WALLET_SEED` | legacy wallets only | keep set only while old wallets still hold funds |
| `OPPORTUNITY_MARKET_RPC_URL`, `OPPORTUNITY_MARKET_FACTORY_ADDRESS` | Opportunity Markets | Sepolia |
| `DISCORD_*`, `SLACK_*` | Discord / Slack | see above |
| `WHATSAPP_LINK_SECRET`, `WHATSAPP_PHONE_NUMBER`, `WHATSAPP_AUTH_DIR` | WhatsApp | see above |

### Keepers

Pyth Entropy calls back by itself (usually within seconds), so randomness needs no settlement. One optional keeper finishes the job:

- **Sortition** — `npm run keeper:sortition`. Finalizes each Sortition DAO's round once its randomness has arrived, paying gas from the operator wallet (anyone can also run `/finalizesortition`). **One process per network**: set `KEEPER_NETWORK` (default: the default network). Polls every 30 s.

**Paying for randomness.** Each draw costs Pyth Entropy's fee, in the chain's native currency. `/startsortition` uses the DAO's credit at the Entropy adapter first and tops up only the shortfall from the caller's wallet. A DAO can prefund its credit (anyone can call the adapter's `fund(governance)`, e.g. the Treasury through a proposal), after which draws cost callers nothing but gas.

Sowellian oracle proposals need no keeper: `/resolveviaoracle` posts Pyth's price and resolves in one go.

## Security — read before deploying anywhere real

- **Never paste private keys into chats, commands, or shell history.** Use `export PRIVATE_KEY=...` and reference `$PRIVATE_KEY`. Any key that has appeared in plaintext should be treated as burned.
- **`OPERATOR_PRIVATE_KEY`** pays gas for `/createdao`, `/claim`, keeper transactions, and user top-ups — on every enabled network. Keep it funded, but not over-funded; on mainnets especially, set the top-up amounts deliberately (`<PREFIX>_GAS_TOPUP_FIRST` etc.).
- **KMS IAM scope.** The bot's AWS credentials should only be able to `Decrypt` and `GenerateDataKey` on the one key — not manage or delete it.
- **`SUPABASE_SERVICE_ROLE_KEY`** bypasses Row Level Security by design. Treat it like a database root password.
- **`MASTER_WALLET_SEED`** (legacy) can derive every old wallet's key. Remove it once no old wallet holds funds.

## Known limitations

- **`/createdao` mints the initial supply to the operator wallet**, not the person who ran the command, and records the operator as `creator` on-chain. `/tip` and welcome distributors are how it reaches members.
- **Pyth fees come from the caller.** `/startsortition` (when the DAO's Entropy credit is short) and `/resolveviaoracle` (the price update) spend native currency from the caller's wallet on Pyth's fees; gas sponsorship covers gas only.
- **Wrapped native is never auto-unwrapped.** Redeeming or reclaiming on a Decision Markets quote side returns the wrapped token; `/unwrap` converts it back.
- **`data/chats.json` is a flat file.** Fine for now; swap for a database before scaling.

## What's not verified yet

- A DAO lifecycle on Base Sepolia or HyperEVM testnet (factories deployed, nothing run through the bot yet); anything on the mainnets (nothing deployed)
- **External protocol actions against the live protocols.** Each was tested on local chains through a real Board DAO:
  - Uniswap, Aerodrome, Lido-via-Aerodrome and Seaport ran against those protocols' real compiled contracts. HyperSwap and kHYPE-via-HyperSwap ran against Uniswap's real v3 contracts (HyperSwap v3 is a Uniswap v3 fork).
  - Aave, HyperLend, shMON, Nad.fun, Perpl, Flaunch and HyperCore ran against stand-ins with the protocols' exact function signatures.
  - HyperCore's action bytes were also compared with those produced by hyper-evm-lib.

- Real Discord and Slack workspaces
- WhatsApp against WhatsApp's real servers (tested end to end with a stand-in socket, real commands and a real DAO on a local chain)
- Pyth Entropy and Hermes price updates on a live chain (tested locally against the real Spaces contracts with Pyth's mocks and a stand-in Hermes)

## Not built yet

- Group-wide gas sponsorship with spending limits

## Architecture

```
src/
├── index.js              Telegram command handlers, model-aware /help
├── platforms/            Discord, Slack and WhatsApp front-ends over a shared command core
├── networks.js           network registry, per-call network context, block scaling, per-network gas
├── config.js             viem clients and settings that follow the current network, operator wallet
├── contracts.js          token-weighted reads/writes, wrapper/distributor deploys
├── gasSponsor.js         gas sponsorship: funding at wallet creation and per transaction
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
├── keepers/              standalone sortition keeper (finalizes draws once Pyth Entropy delivers)
└── abis/                 compiled ABIs (and bytecode for on-demand deployment)
supabase/schema.sql       wallets table, RLS enabled
docs/slack-app-manifest.yml
```

`src/abis/*.json` is copied from Spaces' Foundry output. **Whenever a contract changes, re-extract and copy its ABI/artifact here** — the bot has no compiler and silently keeps using the old one otherwise.

## Deploying persistently

The bots use long polling / sockets, so they need long-lived processes — not serverless. The bots and keepers all use `data/` (the keepers read it to find DAOs), so they must share one persistent volume. Railway attaches a volume to a single service, so there run them together in one service, leaving out any you haven't configured:

```bash
sh -c "npm start & npm run discord & npm run slack & npm run whatsapp & KEEPER_NETWORK=monad-testnet npm run keeper:sortition & KEEPER_NETWORK=base-sepolia npm run keeper:sortition & KEEPER_NETWORK=hyperevm-testnet npm run keeper:sortition & wait"
```

With "Add to Slack" enabled, give that service a public domain; Railway's `PORT` is where the install page listens. The commands:

| Service | Command |
|---|---|
| Telegram bot | `npm start` |
| Discord bot | `npm run discord` |
| Slack bot | `npm run slack` |
| WhatsApp bot | `npm run whatsapp` |
| Sortition keeper (per network) | `KEEPER_NETWORK=<id> npm run keeper:sortition` |

## Try it live

- **Telegram:** [@proteandao_bot](https://t.me/proteandao_bot)
- **Discord:** [Add to your server](https://discord.com/oauth2/authorize?client_id=1550697784259121203&permissions=3072&integration_type=0&scope=applications.commands+bot)
- **Slack:** [Add to Slack](https://protean-bot-production.up.railway.app/slack/install)
