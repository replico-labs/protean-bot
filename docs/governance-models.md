# Governance models

The ten models, switching between them, and the features some models add.

## The ten models

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

## Switching models

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

**Solana:** the `switch…` actions in `/proposeaction` (see [Solana](solana.md)).

## Guard wrapper

A security council in front of the Treasury.
- `/guardwrapper`: its signers, threshold and tenure
- `/instruction <id>` · `/confirminstruction <id>` · `/rejectinstruction <id>` · `/revokeconfirmation <id>`

## NFTs

The Treasury can't receive NFTs (it has no ERC-721/ERC-1155 receiver hooks), so **a DAO's NFTs live in its NFT wrapper** (`/deploynftwrapper`):
- Send NFTs to the wrapper's address, never to the Treasury.
- Governance can, by proposal (`/proposeaction`):
  - list them (`nftwrapper-approve-order-hash`)
  - send them out (`nftwrapper-transfer-erc721` / `-erc1155`, which refuse the Treasury as a recipient)
  - call a marketplace directly (`nftwrapper-execute`)
- Sale proceeds go back to the Treasury with `nftwrapper-sweep-native` / `-erc20`.
- To buy an NFT, first move funds from the Treasury to the wrapper (`treasury-transfer-eth` / `-erc20`).

## Sowellian and Decision Markets

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

## Conviction spending budgets

Conviction DAOs from the newer factory check what each proposal spends (see Spaces' README, "Conviction spending budgets").
- **The bot fills in the budget itself,** from:
  - native sent by `transferETH` or by a `Treasury.execute` step
  - tokens moved by `transferERC20`, or approved or transferred inside `Treasury.execute`

  That covers every action in `/listactions`, the protocol integrations, and raw `/propose` calls of those shapes.
- **`/proposal`** shows "May spend: 10 USDC, 0.5 MON", or a warning when a proposal weakens the rules.
- **`/assets`** lists the assets, their weights, the Treasury's holdings and pending cuts; run `/assets apply <asset>` once a cut is due.
- **The asset list changes by proposal:** `conviction-add-asset`, `conviction-set-asset-weight`, `conviction-remove-asset` (native: `MON`/`ETH`/`HYPE` or `native`).

Older Conviction DAOs keep proposing the old way.

[Back to the README](../README.md)
