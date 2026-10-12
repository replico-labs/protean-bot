# DAO Spaces

A governance-agnostic DAO framework — an original, from-scratch on-chain governance protocol where a DAO's treasury and its governance rules are kept as two separate, swappable pieces, rather than locked together.

Every module — proposal lifecycle, voting, quorum/approval math, timelocks, and every one of the ten governance models below — is implemented from scratch, purpose-built for this framework. The companion bot — Telegram, Discord and Slack — lives in [`protean-bot`](https://github.com/replico-labs/protean-bot).

## Why this exists

Most EVM chains handle DAO governance one of two ways today:

- **Snapshot** — off-chain voting. Votes are signed messages, not transactions; nothing is enforced by the chain, and someone still has to execute the result by hand.
- **A custom-built governance system** — hard to get right, and once deployed, usually locked in. Changing the rules means migrating the entire treasury, and a DAO is stuck with whichever decision-making model it launched with.

DAO Spaces executes every governance action fully on-chain, and a DAO isn't locked into one way of deciding. It can start with a small trusted board, grow into token-weighted voting, switch to quadratic voting to reduce whale influence, adopt continuous conviction voting, let a randomly drawn council govern, or let markets decide — all without the treasury moving.

## Architecture

```
┌──────────────┐        controls        ┌──────────────┐
│  Governance   │ ─────────────────────▶ │   Treasury    │
│ (swappable —  │                        │ (stays put —  │
│  any of 10    │ ◀───────────────────── │  holds funds) │
│  models)      │      trusts            └──────────────┘
└──────────────┘
       │
       │ controls (mint rights)
       ▼
┌───────────────────┐        wraps        ┌──────────────────────┐
│  GovernanceToken    │ ◀─────────────────  │ StakedGovernanceToken │
│  (raw, liquid,      │       stake()        │ (voting power lives   │
│   transferable)     │ ─────────────────▶  │  here, lockable when  │
└───────────────────┘                       │  a model requires it) │
                                             └──────────────────────┘
```

`Treasury`'s entire trust model is one question: *"is the caller my registered `governance` address?"* That single design choice is what makes every model a genuine drop-in replacement for any other.

### Clone-based deployment (EIP-1167)

Every factory deploys **minimal proxy clones**, not full contracts. Each contract's implementation is deployed once; each new DAO gets ~45-byte clones pointing at those implementations, initialized via `initialize()` instead of a constructor.

This isn't an optimization — it's what makes deployment possible at all. Factories that `new` their child contracts embed each child's full creation bytecode, which put every factory at 26–99 KB against the EVM's 24,576-byte limit. Deploying implementations from inside a factory's own constructor does **not** help (the bytecode is embedded either way). Implementations are deployed as separate transactions, and each factory receives their addresses as constructor arguments. Factories now sit at 4–8 KB.

The OpenZeppelin-based implementations (every governance model, `GovernanceToken`, `StakedGovernanceToken`, `Treasury`) call `_disableInitializers()` in their constructor, so the implementation itself can never be initialized — only clones can. `ConditionalVault`, `ConditionalToken`, `DecisionMarketPair` and `OpportunityMarket` use a small hand-rolled `_initialized` flag with no constructor lock. That is harmless: clone + initialize happen in one transaction, every clone has its own storage, and none of these contracts use `delegatecall` or `selfdestruct`. Anyone can deploy their own copy of an implementation, so "same ABI" never proves a contract is legitimate — check the factory's registry (e.g. `OpportunityMarketFactory.isMarket`).

## Governance models

| Model | How it decides |
|---|---|
| **Token-weighted** (`Governance.sol`) | Classic one-token-one-vote, snapshot-based |
| **Delegated** | Token holders elect a council; only the council proposes and votes; members can be recalled |
| **Board (Multisig)** | N-of-M designated signers approve directly — no token at all |
| **Quadratic** | Voting weight is the square root of staked balance |
| **Optimistic** | Proposals pass by default after a challenge window, unless disputed and voted down |
| **Conviction** | Continuous support accumulates over time; committed tokens are locked |
| **Sortition** | Council seats filled by a verifiably random draw from an opt-in pool |
| **Liquid** | Direct voting always available, plus revocable, bounded transitive delegation |
| **Sowellian** | A pari-mutuel market on proposal outcomes, resolved by oracle or by a bonded human resolver with optimistic challenge and adjudication |
| **Decision Markets** | Two live trading markets (pass vs. fail) compared by TWAP over a fixed window — no oracle, resolver, or vote |

Plus **Opportunity Markets** — confidential, FHE-encrypted backing of listed opportunities (Zama fhEVM), where which opportunity you back and how much stay encrypted on-chain. Deployed on Ethereum Sepolia, not Monad; see [Opportunity Markets](#opportunity-markets).

## Contracts

| Contract | Responsibility |
|---|---|
| `governance/Governance.sol` + supporting files | Token-weighted orchestration — proposals, voting, quorum/approval, timelocks, execution |
| `governance/{delegate,board,quadratic,optimistic,conviction,sortition,liquid,sowellian,futarchy}/` | The other nine models, each self-contained |
| `governance/futarchy/{ConditionalToken,ConditionalVault,DecisionMarketPair,WMON}.sol` | Decision Markets machinery — split/merge/redeem conditional tokens, constant-product AMM |
| `governance/opportunity-market/` | `OpportunityMarket` + factory (FHE, Sepolia) |
| `token/GovernanceToken.sol` | Raw ERC20 with `ERC20Votes`; minting is governance-controlled |
| `token/StakedGovernanceToken.sol` | Vote-escrow wrapper — stake here to get voting power; optional lock used by Conviction |
| `treasury/Treasury.sol` | Holds funds; acts only on instructions from its registered `governance` |
| `factory/` | One clone-based factory per model, plus the shared `DAOFactoryLib` |
| `distribution/WelcomeDistributor.sol` | Optional capped welcome-token distribution, one claim per address |
| `wrapper/GuardWrapper.sol` | Optional security council: governance proposes an instruction, a signer threshold confirms it before it is forwarded. Signers can never initiate anything |
| `marketplace/NFTMarketplaceWrapper.sol` | Optional EIP-1271 signer for NFT marketplaces — and where a DAO's NFTs live (see [NFTs](#nfts)) |
| `randomness/` | `IRandomnessSource` + `PythEntropyRandomnessAdapter` (used by Sortition) |
| `oracles/` | `PythPriceFeedAdapter` behind `IMetricOracle` (used by Sowellian) |

## Key design decisions

- **Governance and treasury are decoupled.** A DAO can vote to move to a different model via `transferGovernance()` without funds moving.
- **Voting power requires staking, not just holding**, in every token-based model.
- **Snapshot-based, flash-loan-resistant voting** wherever a discrete vote happens. Where a model has no single voting moment (Conviction), committed tokens are locked instead.
- **Randomness and price data are provider-agnostic.** Sortition and Sowellian depend only on small interfaces; which oracle network sits behind them is a per-deployment choice. Pyth provides both on every supported chain: Entropy for randomness, Pyth price feeds for Sowellian. (The Switchboard and Chainlink adapters were removed when Switchboard shut down.)
- **One oracle adapter, many feeds.** `IMetricOracle.latestValue(bytes32 selector)` takes a per-proposal selector stored on each Sowellian proposal. `PythPriceFeedAdapter` treats it as the Pyth price feed ID, so one deployment per network serves every feed. It returns prices as 18-decimal fixed point whatever the feed's exponent, so a proposal's `targetValue` is always price × 1e18 ($3,000 → `3000e18`).
- **Sortition pays for its randomness.** Pyth Entropy charges a small native fee per request. `startSortition` is payable and forwards what it's sent; the adapter (`requestFee()`) takes the fee from that plus any credit the DAO holds there, and keeps the rest as the DAO's credit. Anyone can top up a DAO's credit with `fund(governance)`, which is how Sortition DAOs cloned before `startSortition` was payable still draw. `setRandomnessSource` abandons a round still waiting on the old provider, so a DAO is never stuck behind randomness that will never arrive.

## Security council (GuardWrapper)

A DAO can put a signer council between its governance and its assets. The DAO passes two proposals — `Treasury.transferGovernance(wrapper)` and, on the raw token, `transferOwnership(wrapper)` — after which Treasury and minting calls only work through the wrapper: governance calls `proposeInstruction(target, value, data)`, and the call is forwarded once enough signers `confirmInstruction`. Signers can confirm, revoke or reject, never initiate. Signer replacement is tenure-gated and needs no signer confirmation — the on-chain timestamp check is the proof — so a council can't entrench itself, and governance can't bypass tenure either. The bot's `/handovertowrapper` computes both handover proposals, and `/proposeaction` automatically routes Treasury and token actions through a linked wrapper after the handover.

## NFTs

`Treasury` has no ERC721/ERC1155 receiver hooks, so `safeTransferFrom` into it reverts — and every ERC1155 transfer is a safe one. Rather than widen the Treasury, **a DAO's NFTs live in its `NFTMarketplaceWrapper`**:

- NFTs are sent to the wrapper, never to the Treasury.
- The wrapper lists them (governance approves the hash the marketplace checks the signature against — for Seaport that is the order's EIP-712 digest, not the raw order hash; the wrapper answers EIP-1271 `isValidSignature`), sends them out (`transferERC721` / `transferERC1155` — which refuse the Treasury as a recipient), or calls a marketplace directly (`execute`).
- Money comes back to the Treasury: `sweepNative` and `sweepERC20` send sale proceeds there.
- Every one of those is `onlyGovernance` — a passed proposal.

## Conviction spending budgets

Conviction's bar used to grow only with native currency attached to a proposal's actions. Treasury spending goes through `Treasury.execute` calls instead, so a proposal emptying the Treasury needed the same conviction as one moving nothing. From `BUDGET_VERSION() == 2`:

- **Asset list.** The DAO keeps a list of assets (native = `address(0)`) with a weight each: the extra conviction needed to spend *all* the Treasury holds of it. Native currency and the DAO's own token start listed at 900. The list changes only by proposal: `addAsset`, `setAssetWeight`, `removeAsset`.
- **Budget.** `proposeWithBudget(actions, uri, budget)` declares how much of each listed asset the Treasury may lose. The bar is `minThresholdConviction + Σ weight × amount / holding` (an amount at or above the holding counts as all of it), fixed when the proposal is created. Plain `propose` means an empty budget.
- **Enforced at execution.** Every listed asset's Treasury balance is read before and after the actions; a drop beyond the budget (zero for an undeclared asset) reverts the whole execution. A swap counts only what left. Approvals the actions granted on listed tokens (ERC20 `approve`/`increaseAllowance`, Permit2 `approve`) are revoked afterwards.
- **Weakening the rules is expensive and slow.** A proposal that lowers or removes a weight, changes the config, treasury or staking token, hands over the Treasury (`transferGovernance`) or transfers any ownership needs `min + Σ all weights`. Listing an asset or raising a weight costs the minimum. Cuts and removals take effect `WEIGHT_CUT_DELAY` (7 days) later via `applyAssetChange`, callable by anyone.
- **Limits.** Unlisted assets aren't checked at all. After a GuardWrapper handover, spending happens when the council confirms, outside the proposal's execution, so it isn't budget-checked (the handover itself needs the highest bar). Existing Conviction DAOs keep the implementation they were cloned from; only DAOs from a factory deployed after this change have budgets.

## Decision Markets

A proposal's two outcomes — pass and fail — each get a live trading market over a fixed window. Real tokens are split into matched pass/fail conditional tokens; people trade the side they believe in; at the end, whichever market's time-weighted average price is meaningfully higher decides the outcome. Winning-side tokens redeem for real value; losing-side tokens are worthless.

Proposing takes two transactions: `propose(actions, uri, baseSeed)` (payable) takes the seed and splits it into pass/fail tokens, then `openMarkets(id)` deploys and seeds the two pools and starts the trading clock. Together they cost ~2.3M gas, more than HyperEVM's 2M small blocks hold in one transaction (~1.3M + ~0.6M apart). `openMarkets` is permissionless and runs once; until it does, the proposal can't be traded, finalized or executed, and cancelling it returns the seed to the proposer. Decision Markets factories deployed before this change (Monad testnet, Base Sepolia) do both in `propose`; the bot handles either.

Native currency is wrapped when a proposal is seeded (WMON on Monad; the factory takes the chain's canonical wrapped-native token as `WMON_ADDRESS`, so WETH on Base, WHYPE on HyperEVM). Redemption and liquidity reclaim return the **wrapped** token — call `withdraw()` on it to unwrap.

The constant-product AMM is a derivative of Uniswap V2 core (`github.com/Uniswap/v2-core`), GPL-3.0-or-later; `DecisionMarketPair.sol` carries that license. Everything else in this repository is MIT.

## Opportunity Markets

Uses Zama's fhEVM. `FHE.setCoprocessor(ZamaConfig.getEthereumCoprocessorConfig())` resolves the coprocessor by `block.chainid` at construction — no addresses to configure — but it only supports Ethereum mainnet, Sepolia, and local Anvil. On any other chain (including Monad, Base, and HyperEVM) construction reverts with `ZamaProtocolUnsupported()`. This is why Opportunity Markets live on Sepolia.

**Amounts and reward math.** Every amount is encrypted as a 64-bit integer (`euint64`), so a deposit or reward pool above 2^64 - 1 raw units is refused (`AmountTooLarge`) rather than silently truncated. That is ~18 trillion tokens for a 6-decimal stablecoin such as USDC, but only ~18.4 tokens at 18 decimals, so use a low-decimal stablecoin. `computeReward` pays `floor(stakeOnWinner × rewardPool / winningTotal)`, multiplying in 128 bits (`euint128` times the plaintext pool, then divided by the plaintext revealed total), so the product can't overflow; the result always fits back in 64 bits because a backer's stake is part of the winning total. `REWARD_MATH_VERSION()` returns 2 on this implementation. Markets cloned from the earlier implementation multiplied in 64 bits, which wrapped once stake × pool passed ~1.8e19 raw units (e.g. 5,000 USDC × 5,000 USDC paid 1,310 USDC); they keep that behaviour, since a clone's implementation never changes. Only markets from a factory deployed after this fix get the new math.

## Setup

Every import in `remappings.txt` comes from one of two places: a Foundry library in `lib/` or an npm package in `node_modules/`. Versions are the ones pinned in `foundry.lock` and `package-lock.json`.

| Import | Comes from | Version |
|---|---|---|
| `forge-std` | Foundry library (`lib/forge-std`) | v1.16.2 |
| `@openzeppelin/contracts` | Foundry library (`lib/openzeppelin-contracts`) | v5.6.1 |
| `@openzeppelin/contracts-upgradeable` | Foundry library (`lib/openzeppelin-contracts-upgradeable`) | v5.6.1 |
| `forge-fhevm` | Foundry library (`lib/forge-fhevm`) | commit `3ee696f` |
| `@fhevm/solidity` | npm | 0.13.3 |
| `encrypted-types` | npm (also installed as a dependency of `@fhevm/solidity`) | 0.0.4 |
| `@pythnetwork/pyth-sdk-solidity` | npm | 4.3.1 |
| `@pythnetwork/entropy-sdk-solidity` | npm | 2.2.1 |

**Cloning this repo:** `lib/forge-std` and `lib/openzeppelin-contracts` are committed, and the other two Foundry libraries are submodules. One command gets them all, and `npm ci` installs the exact npm versions from `package-lock.json`:

```bash
git submodule update --init --recursive
npm ci
forge build
```

**Installing each dependency yourself** (a new project, or a missing folder):

```bash
forge install foundry-rs/forge-std@v1.16.2
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.6.1
forge install zama-ai/forge-fhevm@3ee696fba62a32314fde457de28cc29f1191c4cb

npm install @fhevm/solidity@0.13.3
npm install encrypted-types@0.0.4
npm install @pythnetwork/pyth-sdk-solidity@4.3.1
npm install @pythnetwork/entropy-sdk-solidity@2.2.1
```

Current Foundry doesn't commit on `forge install` by default. Older guides add `--no-commit`, which newer versions reject. `via_ir` and the optimizer are set in `foundry.toml`, so plain `forge build` / `forge test` use them.

`remappings.txt` (committed) maps them:

```
@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/
@openzeppelin/contracts-upgradeable/=lib/openzeppelin-contracts-upgradeable/contracts/
@pythnetwork/pyth-sdk-solidity/=node_modules/@pythnetwork/pyth-sdk-solidity/
@pythnetwork/entropy-sdk-solidity/=node_modules/@pythnetwork/entropy-sdk-solidity/
@fhevm/solidity/=node_modules/@fhevm/solidity/
encrypted-types/=node_modules/encrypted-types/
forge-fhevm/=lib/forge-fhevm/src/
```

`openzeppelin-contracts-upgradeable` v5.6.1 does **not** ship `ReentrancyGuardUpgradeable`; `StakedGovernanceToken` uses a small, explicitly initialized guard of its own instead.

### `--via-ir` and contract size

Foundry compiles the whole project together, so the simplest rule is: **always build, test, and deploy with `--via-ir`** — `SortitionDAOFactory` and `DecisionMarketsDAOFactory` hit "stack too deep" in `createDAO()` without it.

Contract size depends on the chain:

| Chain | Size limit | Build with |
|---|---|---|
| Monad (testnet, mainnet) | None in practice — `DelegateGovernance` and `SowellianGovernance` (~29.2 KB unoptimized) are deployed there | the default profile, `--via-ir` |
| Base, Base Sepolia, HyperEVM | EIP-170: 24,576 bytes | `FOUNDRY_PROFILE=size-limited` (via-IR + optimizer, 200 runs). Every contract is under 15 KB; the largest are `DelegateGovernance` 14.6 KB and `SowellianGovernance` 14.5 KB |

With the optimizer on, via-IR caches `block.number`/`block.timestamp` across `vm.roll`/`vm.warp` inside a test, so tests read `vm.getBlockNumber()`/`vm.getBlockTimestamp()` instead. With those test edits the full suite passes under both profiles, which means the exact bytecode you deploy to a size-limited chain is the bytecode the tests ran against.

## Testing

```bash
forge test --via-ir                          # default profile (Monad)
FOUNDRY_PROFILE=size-limited forge test      # optimized, as deployed to Base / HyperEVM
```

Current result: **564 tests passed, 0 failed, 0 skipped** across 34 suites under both (Foundry 1.5.1, solc 0.8.33) — every governance model, every factory, the token/treasury core, GuardWrapper, the NFT wrapper (including against a real `Treasury`), adapters, the futarchy system and Opportunity Markets.

## Deployment

Each model has a deploy script that deploys its implementations, then its factory:

```bash
forge script script/Deploy<Model>DAOFactory.s.sol:Deploy<Model>DAOFactory \
  --rpc-url <RPC_URL> \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --via-ir \
  --verify
```

`<Model>` is one of: *(empty, for token-weighted)*, `Quadratic`, `Liquid`, `Optimistic`, `Delegate`, `Board`, `Sortition`, `Conviction`, `Sowellian`, `DecisionMarkets`. `DeployDecisionMarketsDAOFactory` additionally needs `WMON_ADDRESS` (the chain's canonical wrapped-native token). Opportunity Markets: `DeployOpportunityMarketFactory.s.sol` against a **Sepolia** RPC.

On **Base / Base Sepolia / HyperEVM**, prefix every deploy with `FOUNDRY_PROFILE=size-limited` (see [contract size](#--via-ir-and-contract-size)).

On **HyperEVM**, blocks come in two sizes: small (~1 s, 2M gas) and big (~1 min, 30M gas). Deploying an implementation or factory needs more than 2M gas, so the deploying address must be switched to big blocks first (a HyperCore `evmUserModify` action with `usingBigBlocks: true`), and switched back afterwards: `pip install hyperliquid-python-sdk`, then `python3 script/hyperevm_big_blocks.py on --testnet` before deploying and `python3 script/hyperevm_big_blocks.py off --testnet` after (drop `--testnet` for mainnet; it asks for the key with hidden input). DAO creation fits in small blocks: the heaviest, `DelegateDAOFactory.createDAO`, measured 1.29M gas.

`GuardWrapper` and `NFTMarketplaceWrapper` have no deploy scripts: they are per-DAO and the bot deploys them on demand (`/deployguardwrapper`, `/deploynftwrapper`).

Oracle and randomness adapters are standalone, one-time deployments per network. Each takes Pyth's own contract address, copied from Pyth's docs, and its constructor rejects an address that isn't one:

```bash
# Randomness for Sortition - PYTH_ENTROPY_ADDRESS from docs.pyth.network/entropy/contract-addresses
PYTH_ENTROPY_ADDRESS=0x... forge script script/DeployPythEntropyAdapter.s.sol:DeployPythEntropyAdapter \
  --rpc-url <RPC_URL> --account <ACCOUNT> --broadcast

# Price feeds for Sowellian - PYTH_ADDRESS from docs.pyth.network/price-feeds/contract-addresses/evm
PYTH_ADDRESS=0x... forge script script/DeployPythPriceFeedAdapter.s.sol:DeployPythPriceFeedAdapter \
  --rpc-url <RPC_URL> --account <ACCOUNT> --broadcast
```

Pyth prices are pull-based: post a signed update from Pyth's Hermes service to the Pyth contract (`updatePriceFeeds`, plus its small fee) right before `resolveViaOracle`; the bot does this for you. Entropy calls the adapter back by itself, usually within seconds, so Sortition needs no settlement keeper - just `finalizeSortition` once it's fulfilled.

DAOs are created from a deployed factory with the matching `Create<Model>DAO.s.sol` script (see each script's header for its env vars — e.g. `INITIAL_SIGNERS` for Board, `INITIAL_COUNCIL` for Delegate and Sortition, `RANDOMNESS_SOURCE` for Sortition), or through the bot's `/createdao`.

**Never pass a raw private key inline.** `export PRIVATE_KEY=...` once, reference `$PRIVATE_KEY`. Watch for editors converting `--` into an em dash (`—`) — Foundry silently ignores the mangled flag.

## Deployed addresses

Only factory addresses need to be configured anywhere; implementation addresses are baked into each factory's immutable storage at deployment.

### Monad Testnet

| Contract | Address |
|---|---|
| DAOFactory (token-weighted) | `0x8bB68e835032e58c410125e5219B8Ae7FcAcc056` |
| QuadraticDAOFactory | `0x9d109ba81002B85a48252115Ed5487F6b60C78F9` |
| LiquidDAOFactory | `0x55C89331FA2F6a71E375c6C2aAf9BbE5b9b17fFe` |
| OptimisticDAOFactory | `0x8F5a20c910aEbF287790e04799Ce0DB677705674` |
| DelegateDAOFactory | `0x3fFb77D2A380C52e04b8d22E73EDc7d47e8f975c` |
| BoardDAOFactory | `0x2367d102B71ab6c3c3b69eD7580c3Be3ACb5BE9A` |
| SortitionDAOFactory | `0x251b2371e2E98b5db9A2ceF3B687dF1A93BD24E6` |
| ConvictionDAOFactory | `0x14439Fa27258c8fd65F5805eA5617774891f173c` |
| SowellianDAOFactory | `0x075289669Ab8601dd8b15D95551644D511949056` |
| DecisionMarketsDAOFactory | `0x99DeC80E792f9C1fA92F46fe08c6763CBCCfE388` |
| PythEntropyRandomnessAdapter (Sortition) | `0x422cbB19F504D57cB909AC149e97f48Ba8c1b92D` |
| PythPriceFeedAdapter (Sowellian) | `0x6C582533290855Af7F95d4484A6bb2e8C317949e` |

This `SortitionDAOFactory` is the Pyth-era deployment (payable `startSortition`, stuck-round reset); `/createdao` points new Sortition DAOs at the Entropy adapter above. Sortition DAOs created from the earlier factory still point at the shut-down Switchboard adapter: each switches with a `sortition-set-randomness-source` proposal before its next draw, and draws from credit prefunded on the adapter (`fund(governance)`), since that implementation's `startSortition` isn't payable. A DAO whose round was already waiting on Switchboard stays stuck; its council keeps serving, but it can't draw again.


External dependencies on Monad testnet (third-party, verified against official docs):

| Dependency | Address | Source |
|---|---|---|
| WMON (canonical) | `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541` | docs.monad.xyz — Canonical Contracts |
| Pyth Entropy | `0x825c0390f379C631f3Cf11A82a37D20BddF93c07` | Pyth docs |
| Pyth price feeds | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` | Pyth docs |


### Ethereum Sepolia (Opportunity Markets)

| Contract | Address |
|---|---|
| OpportunityMarketFactory | `0xE9fF23EA5FE342568B5Db083E937f397C75c4625` |
| OpportunityMarket implementation | `0xD05974d937454B534058D3B67513edA0010A2efB` |

Markets created from this factory use the 128-bit reward math (`REWARD_MATH_VERSION() == 2`, see [Opportunity Markets](#opportunity-markets)). Markets from the earlier factory keep the 64-bit math.

### Base Sepolia (chain 84532)

Built with `FOUNDRY_PROFILE=size-limited` (EIP-170). In the bot this network is `base-sepolia` (add it to `NETWORKS`) and its variables take the `BASE_SEPOLIA_` prefix (`BASE_SEPOLIA_FACTORY_ADDRESS`, `BASE_SEPOLIA_SORTITION_RANDOMNESS_SOURCE`, ...).

| Contract | Address |
|---|---|
| DAOFactory (token-weighted) | `0x72648d7954877Dadd9B38D71EE3C70e245D29B3a` |
| QuadraticDAOFactory | `0xd85923722591C005a23840Cd95B6888ABD11a345` |
| LiquidDAOFactory | `0x10F551fF56455366AE7E9D3c3BBc96c9f058E821` |
| OptimisticDAOFactory | `0x2367d102B71ab6c3c3b69eD7580c3Be3ACb5BE9A` |
| DelegateDAOFactory | `0x5107BEfC0fEbE1E16bb8F408768bc5FF9F872658` |
| BoardDAOFactory | `0x0be87f0Cf85dbfE6dc572eb4E2FD1FD46e96F475` |
| SortitionDAOFactory | `0x14439Fa27258c8fd65F5805eA5617774891f173c` |
| ConvictionDAOFactory | `0x3fFb77D2A380C52e04b8d22E73EDc7d47e8f975c` |
| SowellianDAOFactory | `0x55C89331FA2F6a71E375c6C2aAf9BbE5b9b17fFe` |
| DecisionMarketsDAOFactory | `0x801883FD3347e5F400fF8CE24015D60449f26dAf` |
| PythEntropyRandomnessAdapter (Sortition) | `0xaB7325AFfF2A7851457c52565Cfe4DC53DC9B1Fc` |
| PythPriceFeedAdapter (Sowellian) | `0x9d109ba81002B85a48252115Ed5487F6b60C78F9` |

External dependencies on Base Sepolia:

| Dependency | Address | Source |
|---|---|---|
| WETH (canonical) | `0x4200000000000000000000000000000000000006` | OP Stack predeploy |
| Pyth Entropy | `0x41c9e39574F40Ad34c79f1C99B66A45eFB830d4c` | Pyth docs |
| Pyth price feeds | `0x5f52e4DBEA21f5b23523B6e20d50c29ae0a4EB83` | Pyth docs |

### HyperEVM testnet (chain 998)

Built with `FOUNDRY_PROFILE=size-limited` and deployed in big blocks. In the bot this network is `hyperevm-testnet` (add it to `NETWORKS`) and its variables take the `HYPEREVM_TESTNET_` prefix (`HYPEREVM_TESTNET_FACTORY_ADDRESS`, ...). The public RPC rate-limits hard; give the bot a provider endpoint as `HYPEREVM_TESTNET_RPC_URL`.

| Contract | Address |
|---|---|
| DAOFactory (token-weighted) | `0x0be87f0Cf85dbfE6dc572eb4E2FD1FD46e96F475` |
| QuadraticDAOFactory | `0xe61C9d371D3BEA6ceA5359E745593D8ebB39BEC5` |
| LiquidDAOFactory | `0xd85923722591C005a23840Cd95B6888ABD11a345` |
| OptimisticDAOFactory | `0x5107BEfC0fEbE1E16bb8F408768bc5FF9F872658` |
| DelegateDAOFactory | `0x10F551fF56455366AE7E9D3c3BBc96c9f058E821` |
| BoardDAOFactory | `0xcabF9a1c3e3e54715c52dfB45ae1AB7E1C3D3606` |
| SortitionDAOFactory | `0x867b9e9edD9dE98979c9C6a82EEc363B077B96De` |
| ConvictionDAOFactory | `0xBF49Fc7a3788c0CA53420ee6ccDA4aD9C5457362` |
| SowellianDAOFactory | `0xa9356ccA371D3b91a82f1fee3898E8ef444E512E` |
| DecisionMarketsDAOFactory | `0xAe322E1265530C58b03a2C36ab085500B9bc6624` — one-step `propose`, which needs big blocks; redeploy from the current source for the two-step version |
| PythEntropyRandomnessAdapter (Sortition) | `0xeEdE1CBa9f2A86AEB145a71167ee2020396C3BD3` |
| PythPriceFeedAdapter (Sowellian) | `0x801883FD3347e5F400fF8CE24015D60449f26dAf` |

External dependencies on HyperEVM testnet:

| Dependency | Address | Source |
|---|---|---|
| WHYPE (canonical) | `0x5555555555555555555555555555555555555555` | Hyperliquid |
| Pyth Entropy | `0x23f0e8FAeE7bbb405E7A7C3d60138FCfd43d7509` | Pyth docs |
| Pyth price feeds | `0x99fA5f405b795cA03F2AE47Cd48FEd22029892a2` | Pyth docs |

### Base mainnet, HyperEVM mainnet and Monad mainnet — not yet deployed

The bot supports these networks (see `protean-bot`'s README, "Networks"); each needs its own factories deployed before DAOs can be created there.

| Network | Chain ID | Public RPC | Build profile |
|---|---|---|---|
| Monad mainnet | 143 | `https://rpc.monad.xyz` | default |
| Base | 8453 | `https://mainnet.base.org` | `size-limited` |
| HyperEVM | 999 | `https://rpc.hyperliquid.xyz/evm` | `size-limited`, big blocks for deploys |

Chain IDs and RPCs are from viem's chain definitions. For each network, fill in:

| Contract | Address |
|---|---|
| DAOFactory (token-weighted) | |
| QuadraticDAOFactory | |
| LiquidDAOFactory | |
| OptimisticDAOFactory | |
| DelegateDAOFactory | |
| BoardDAOFactory | |
| SortitionDAOFactory | |
| ConvictionDAOFactory | |
| SowellianDAOFactory | |
| DecisionMarketsDAOFactory | |
| Randomness adapter (Sortition) | |
| Price-feed adapter (Sowellian) | |

Before deploying to any of them, verify against the chain's own docs: the canonical wrapped native token (`WMON_ADDRESS` for Decision Markets — WETH on Base, WHYPE on HyperEVM); Pyth's Entropy and price feed contract addresses on that chain, from Pyth's docs. Opportunity Markets cannot deploy on any of them (see above).

## Known gaps

- **No audit.** Sowellian, Decision Markets, and Opportunity Markets move real capital based on market or oracle resolution — test adversarially before real funds touch them.
- **Pyth fees.** Each Sortition draw pays an Entropy fee, and each oracle resolution pays a Pyth price-update fee, both in the chain's native currency. Pyth sets and can change them; read `requestFee()` / `getUpdateFee` rather than hard-coding.
- **Entropy's trust model.** The adapter uses `requestV2()`, where Entropy generates the user's share of the randomness in-contract, so a colluding validator and Entropy provider could bias a draw (Pyth's documented trade-off for that variant).
- **Proposals are calldata.** The contracts take raw target/value/calldata. The bot's verified action library (`/proposeaction`) covers every native admin function and the external protocol actions (DEXs, lending, staking, marketplaces) on each network.
- **Resolver incentives.** A correct Sowellian resolver gets their bond back, not an additional reward.
- **Rounding dust.** Pari-mutuel payouts round down; tiny residual balances are recoverable by an ordinary governance proposal.
