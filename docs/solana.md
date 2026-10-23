# Solana (Vortexes)

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

[Back to the README](../README.md)
