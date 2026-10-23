# Testing and keepers

What has been verified, how to run the end-to-end tests, the keepers, and what's still open.

## Status

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

## EVM: every model at once

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

## Slack and links

`node --experimental-test-module-mocks --test scripts/test-slack.mjs` needs no chain or workspace. It runs `/protean` with a stand-in result and a fake Slack client, and checks: labelled links and plain addresses, the buttons under a proposal for every model, the chart upload (joining the channel when needed, and the note when it can't post), and links.js's Telegram, Discord and WhatsApp forms.

## Solana

All of these run against a local validator loaded with the Vortexes programs at their `declare_id!` addresses (`anchor build` in Vortexes, then `solana-test-validator --reset --bpf-program <id> target/deploy/<program>.so ...`). Each script's header has the exact setup. Run each with `node --experimental-test-module-mocks --test <script>`.

| Script | Covers |
|---|---|
| `scripts/test-solana-local.mjs` | the commands and notifications end to end, for token-weighted, quadratic, optimistic, board, conviction and delegate (about 15 minutes) |
| `scripts/test-solana-new-models.mjs` | the same for liquid, sortition, Sowellian and decision markets, with a stand-in for ORAO and a Pyth price account loaded into the validator |
| `scripts/test-solana-switch.mjs` | the DAO token record, a switch that keeps it, `settoken` and `/migrate` |
| `scripts/test-solana-pages.mjs` | proposal pages: the edit link, live data, the once-only submission, the "too late once people vote" rule |
| `scripts/test-solana-pages-charts.mjs` | pages through the real HTTP API (GET, POST, password edits, history), `/proposal` charts, vote-close posts with charts and page links, and explorer links on replies and notices |

## Protocol addresses

`npm run verify:integrations [network ...]` reads every external protocol address over the real RPCs and checks four things:
- every contract has code
- the protocols' cross-references hold (e.g. a router's factory is the factory listed here)
- known token symbols are as expected
- protocol-specific facts, such as HyperCore's precompiles agreeing on the USDC and HYPE token indexes

Run it before enabling a network.

## Keepers

Pyth Entropy calls back by itself, usually within seconds, so randomness needs no settlement. One optional keeper finishes the job:

- **Sortition:** `npm run keeper:sortition` finalizes each Sortition DAO's round once its randomness has arrived, paying gas from the operator wallet. Anyone can also run `/finalizesortition`.
  - Run **one process per network**: set `KEEPER_NETWORK` (default: the default network).
  - It polls every 30 s.
- **Paying for randomness:** each draw costs Pyth Entropy's fee, in the chain's native currency.
  - `/startsortition` uses the DAO's credit at the Entropy adapter first, and tops up only the shortfall from the caller's wallet.
  - A DAO can prefund its credit: anyone can call the adapter's `fund(governance)`, e.g. the Treasury through a proposal. After that, draws cost callers only gas.
- **Sowellian oracle proposals** need no keeper: `/resolveviaoracle` posts Pyth's price and resolves in one go.
- **Solana** needs no keepers. ORAO answers sortition draws itself, and the bot applies due model switches.

## Known limitations

- **`/createdao` mints the initial supply to the operator wallet,** not to whoever ran the command, and records the operator as `creator` on-chain. `/tip` and welcome distributors are how tokens reach members.
- **Pyth fees come from the caller.** `/startsortition` (when the DAO's Entropy credit is short) and `/resolveviaoracle` (the price update) spend native currency from the caller's wallet. Gas sponsorship covers gas only.
- **Wrapped native is never auto-unwrapped.** Redeeming or reclaiming on a Decision Markets quote side returns the wrapped token; `/unwrap` converts it back.
- **Chat links default to a flat file** (`data/chats.json`). Set `CHAT_LINKS_STORE=supabase` to keep them in the database.

## What's not verified yet

- Anything on the mainnets (nothing deployed).
- **External protocol actions against the live protocols.** Each was tested on local chains through a real Board DAO:
  - Uniswap, Aerodrome, Lido-via-Aerodrome and Seaport ran against those protocols' real compiled contracts. HyperSwap and kHYPE-via-HyperSwap ran against Uniswap's real v3 contracts (HyperSwap v3 is a Uniswap v3 fork).
  - Aave, HyperLend, shMON, Nad.fun, Perpl, Flaunch and HyperCore ran against stand-ins with the protocols' exact function signatures.
  - HyperCore's action bytes were also compared with those hyper-evm-lib produces.
- A real Slack workspace.

## Not built yet

- Group-wide gas sponsorship with spending limits
- Phoenix perps and desks on Solana

[Back to the README](../README.md)
