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
| `/stake`, `/unstake <amount> [old mint]` | stake the DAO's token in its stake pool (read by every model but board and decision markets); unstake from the current pool, or an old token's after a token change |
| `/convert <amount> [old mint]` | after a token change: swap old stake for stake in the new token, through the DAO's converter |
| `/migrate` | where your stake is: it stays put through switches; after a token change it lists what's left in old pools |
| `/tip <amount> <address\|treasury>` | hand out the starting tokens (the DAO's creator) |
| `/propose <recipient> <amount> <SOL\|token> <description>` | a payment from the treasury, in SOL, the DAO's token or any token by mint |
| `/listactions`, `/actioninfo`, `/proposeaction` | transfer SOL or tokens, mint tokens, board signers, conviction assets, switch to another model, change the token (`settoken`), converters (`openconverter`, `fundconverter`, `closeconverter`), the security council (`councilon`, `counciloff`) |
| `/council [confirm\|reject <id> \| on <signers> <required> <days> <description> \| off <description>]` | the security council (any model; delegate and sortition also show their own council) |
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
  - The token is on record at the hub with its **stake pool** (`vortex-stake`). Members stake once, every token model reads that pool, and stake never moves at a switch.
  - **Changing the token** keeps the governance: `settoken <mint>`, or `settoken new:<supply>` for a new token (its supply minted to the treasury, which alone can mint more). Works on any model, board included. Open proposals keep the pool they were made with; new ones use the new token's.
  - Add `rate=N:D fund=<amount>` to open a converter in the same proposal: `/convert <amount>` then swaps a member's old stake for N/D as much new stake (the old tokens go to the treasury). The change and its converter fit one Solana transaction only with a short description; otherwise propose the converter after the change executes with `openconverter <old mint> rate=N:D fund=<amount>`. `fundconverter <old mint> <amount>` tops it up and `closeconverter <old mint>` returns what's left. Without one, members `/unstake <amount> <old mint>` and stake the new token.
  - Locks need the member: a vote, Conviction support, a liquid delegation or joining a sortition draw pool locks stake only in an instruction the member signs.
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
  - The `switch…` actions (`switchtokenweighted`, `switchquadratic`, `switchboard <signers>`, `switchdelegate <members>`, …) move the DAO to any model, the running one included (a fresh setup with new rules or signers), with the same treasury, token and stake, through the hub (`propose_switch`, then `apply_switch`).
  - Every switch sets up a fresh governance account for the next epoch, so going back to a model the DAO ran before starts clean.
  - The switch applies 2 days after its proposal runs. The bot applies it then, the next time anyone uses the DAO or from the notifier, and updates the chat. Until then, `cancelswitch` can stop it.
  - A board DAO without a token gives itself one first (`settoken`), then switches to a token model.
- **Security council:** `/council on <signers> <required> <tenure-days> <description>` proposes one; it lives on the hub's DAO record, so it stays through switches.
  - While it's on, `/execute <id>` on a passed proposal hands it to the council instead of running it. Signers `/council confirm <id>` (or `reject`), then `/execute <id>` runs it.
  - `/council off <description>` turns it off; the council confirms that proposal too. If it won't, a proposal that only replaces the signers (`/council on …` again) runs without them once their tenure is over.
- **Money** (`src/solana/funds.js`, `fundsCommands.js`, `fundsActions.js`), the same commands as on EVM:
  - `/allowance`: the hub's monthly allowances, in SOL or a token. Grants, changes and revocations are proposals; the recipient claims each month.
  - `/distributor open` (the operator pays and runs it; one per DAO token), then `fund`, `grant` and `welcome` by proposal; `/claim`; `/welcome @member` by a Delegate council member.
  - `/raise open <currency mint> <softCap> <hardCap> <days|30m> <forSale>` opens a raise decided by the treasury: `/raise accept <amount>` is a proposal that also tops the Distributor up with the sale's tokens. `/contribute`, `/raise settle`, `/refund`.
  - `/launch <model> <name> <symbol> <supply> <forSale|propfirm> <currency mint> <softCap> <hardCap> <days> solana`: the operator makes the DAO, fills its Distributor (the rest of the supply goes to the treasury) and opens a raise the founder decides with `/launch finish <amount>`. With `propfirm` the token has no supply: the operator makes the vault first (it takes over minting), and the raise's money becomes its first shares.
  - `/vault`: `deposit`, `redeem`, `cancel`, `claim`, `window`; `pause`, `resume`, `allow` and `venues` (its Phoenix accounts) by proposal; `vault create` makes an existing DAO with no supply a prop firm. With fast timings windows are two minutes apart.
  - Delegate seats: `/declarecandidacy <election> [seat]`, one vote per seat, `/seats`, and `/finalizeelection` asking ORAO to draw a tied seat (run it again once ORAO answers).
  - The programs (vortex-distribution, vortex-vault) aren't on devnet yet; the commands say so until they are.
- **Not on Solana:** NFT wrappers and the EVM integrations. Those commands say so in a Solana chat; Opportunity Market commands work as usual.

[Back to the README](../README.md)
