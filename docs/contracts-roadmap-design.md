# Allowances, raises, distribution, slot candidacy and prop-firm vaults: design

Status: **built and tested locally** (section 11 says what was built and how it was tested; section 12 what is left). Decisions agreed are in section 8; the research on the vault's value is in section 9. Covers Spaces (EVM), Vortexes (Solana) and the bot.

## Goals

1. A DAO can pay people a monthly allowance that they claim themselves, without a vote each month.
2. A launch team or an existing DAO can raise money: contributions stay open for the whole period, then the DAO (or, at launch, its founder) picks how much to accept and everyone else is refunded.
3. One contract handles every token handed out (raise shares, vesting, welcome grants), tied to the member's chat account so `/claim` works from the group. It replaces `WelcomeDistributor`.
4. A Delegate DAO's council seats are separate slots, and members run for a specific one.
5. A DAO created as a prop firm has a vault: depositors' money is traded through the desk, and the vault's shares are the DAO's token.

Rules that hold everywhere:

- **Both chains**, built EVM first then Solana for each piece.
- **Money only ever lands in a DAO's Treasury.** No founder, leader or trader is ever paid out of a raise or a vault except through an allowance or a fee the DAO voted for.
- **Members claim for themselves.** The bot can claim on a member's behalf, but only into that member's own wallet.
- **One redeploy** of the testnets and devnet once all of this lands.

---

## 1. Monthly allowances

### Where it lives

On the **Treasury** (EVM) and on the hub's DAO record (Solana), not on each governance contract:

- The Treasury stays the same through model switches and token changes; a governance contract is replaced at every switch, so an allowance kept there would be lost.
- The ten models are separate contracts with no shared base: one change on the Treasury instead of ten.
- It matches the security council, which belongs to the DAO, not to the model.

### EVM

Each allowance has an id, so one person can hold several and many contractors can be paid at once:

| Field | Meaning |
|---|---|
| `recipient` | who claims it; any address (contractors included) |
| `token` | one token per allowance: the DAO token, USDC, or the native coin (`address(0)`) |
| `amount` | paid per 30-day period |
| `start`, `endsAt` | `endsAt` is required, at most 12 months after `start` |
| `lastPeriod` | the last period claimed |

- `createAllowance(recipient, token, amount, endsAt)`: only the Treasury's governance, i.e. a passed proposal (or the council's wrapper when there is one, so the council confirms new allowances).
- `updateAllowance(id, amount, endsAt)` and `revokeAllowance(id)`: the same.
- `claimAllowance(id)`: only the recipient. Pays `amount` once for the current 30-day period. A period that wasn't claimed lapses: claiming late never pays for missed months.
- No council confirmation on claims: the vote already approved the payments.
- Renewal past 12 months is a new proposal.

### Solana

The same on the hub: `create_allowance`, `update_allowance`, `revoke_allowance` signed by the treasury inside a proposal, and `claim_allowance` signed by the recipient, which the hub pays from the treasury PDA. Each allowance is an account at `[allowance, dao, id]`.

### Bot

- `/proposeaction allowance <address> <amount> <token> <months>` (and `allowancechange`, `allowancerevoke`).
- `/allowance` lists yours and when the next one is due; `/allowance claim [id]` claims it.
- The listener posts each claim in the group.

---

## 2. Raises

A raise contract per raise, cloned by a `RaiseFactory`.

### Terms (fixed when it's created)

- what contributors pay in: USDC or the native coin;
- the **soft cap** (the least the raise needs) and the **hard cap** (its stated target);
- the start and end of the contribution period;
- optional minimum and maximum per contributor;
- how many tokens the raise hands out in total (`saleSupply`), and their vesting (optional cliff, then linear);
- the decision window after the period ends (default 7 days).

### How it runs

1. **Contributions stay open for the whole period**, past the hard cap too.
2. **When the period ends:**
   - **Below the soft cap:** everyone is refunded in full.
   - **Otherwise** the decider picks the amount to accept: anything from the soft cap up to everything contributed, with no upper limit. The hard cap is the stated target, not a ceiling.
   - **No decision within the window:** everyone is refunded in full.
3. **Shares are pro rata.** Contributor *c* out of total *T*, with *A* accepted:
   - tokens: `saleSupply × c / T`, through the Distributor with the raise's vesting;
   - refund: `c × (T − A) / T`, back to the address that paid.
4. The accepted amount goes to the DAO's Treasury, never to the decider.

### Who decides

- **An existing DAO** (one of our factories'): the raise is created by a proposal, and the amount is picked by a second proposal. Its tokens are minted by the governance (which owns the token) or come from the Treasury.
- **A launch** (no DAO yet): the founder, trader or leader who set up the group decides, but can only send the money to the Treasury of the DAO the raise creates. See the launch flow below.

### Tying a contribution to a chat account

- **From the member's Protean wallet** (the bot's KMS wallet tied to their chat account): the allocation is tied to that account automatically.
- **From an outside wallet**, on the website: the contributor first links the wallet to their chat account by signing a message; the contribution carries their account id (a hash of platform and user id).
- Either way the contribution records both the paying address and the account id.

### The launch flow

The founder creates the group and sets up the DAO's terms with the bot (or the launch wizard): model and rules, token name and supply split, the raise terms, the allowances agreed as terms of joining, and the legal wrapper if any. A `LaunchFactory` creates the raise holding all of that. When the founder accepts an amount, the bot finishes everything in one go:

1. the DAO is deployed (governance, token, staking, Treasury) through the model's factory;
2. the accepted funds go to the new Treasury;
3. the token supply is minted: the raise's share and any team or community shares to the Distributor (with their vesting), the rest to the Treasury;
4. the agreed allowances are set on the Treasury;
5. refunds of the unaccepted part open;
6. the legal wrapper, if the founder chose one, moves to its next step (below).

One transaction where the network's gas limit allows, otherwise two or three that the bot sends back to back, with the money held by the raise until the Treasury exists (as Decision Markets opens its markets in a second transaction). Either way the money can only move to the new Treasury or back to contributors.

**The legal wrapper (DUNA or DAO LLC)** is applied for during setup but never finalized before the money exists: an entity with no funds can't be formed. After the raise is accepted, the bot gathers the documents and a proof of reserves (the new Treasury's address and balance, with explorer links) for the founder to forward to the registrar. The DAO's record tracks it: *applied*, then *registered* with its registration number once the founder enters it. Protean doesn't file it.

**A prop firm's launch** runs the same way, except that the accepted money is deposited into the DAO's vault (section 5): the vault is created, the money goes in, and the vault shares it mints (the DAO's token) are sent to the Distributor, shared among contributors pro rata, to claim with `/claim`.

On Solana: a `vortex-raise` program with the same rules; the launch steps are the hub's `create_dao`, the treasury transfer, the mint, the allowances, in a few transactions.

---

## 3. The Distributor (replaces WelcomeDistributor)

One per DAO token, a clone made by the factories. It holds every token the DAO has promised someone and lets them claim.

### Allocations

Each allocation has an owner (an address, an account id, or both), an amount, and a vesting schedule (none, or a cliff then linear). Sources:

- **Raise shares**, written by the raise when it's finalized.
- **Team, community and other launch shares**, written at launch.
- **Grants by proposal** at any time later.
- **Welcome grants** (below).

### Claiming

- The owning address can always claim its vested amount itself, with no trust in the bot.
- For an account id, the bot (the operator) claims on the member's behalf **into that member's current Protean wallet**, after checking they are who they say in the group. This is the one place the bot's word counts, as with `WelcomeDistributor` today.
- `/claim` in the group shows everything vested and claimable for you (raise, launch shares, grants, welcome) and claims it.
- Unclaimed tokens go back to the Treasury by proposal after a claim period set at launch.

### Welcome grants (Delegate DAOs only)

- A proposal sets the amount per grant and a total cap.
- **A council member approves each grant**, once they've checked the new member has paid their dues or done the registrations needed. The Distributor checks the approver is on the current council.
- The new member then `/claim`s it.
- Not offered on other models.

On Solana: a `vortex-distributor` program (or part of `vortex-raise`), with the council check against the delegate governance.

---

## 4. Slot candidacy (Delegate)

Today a Delegate election fills the whole council at once: members declare candidacy before a deadline, voters pick several candidates (each gets the voter's whole stake), and the top N win.

### Change

- The council has **N seats (slots)**, numbered, with optional labels (e.g. "Treasurer") set by proposal.
- **Candidacy:** during the opt-in window, a member declares for **one specific seat** per election. The window's length is a DAO setting.
- **Voting:** a voter picks at most one candidate per seat; each choice gets their whole stake, as now.
- **Winner per seat:** the most votes. A tie is settled by a random draw (Pyth Entropy on EVM, ORAO on Solana, already used by Sortition).
- **A seat nobody runs for:** the current holder stays until the next election.

On Solana the same change in the delegate program.

---

## 5. Prop-firm vaults

Only for DAOs **created as prop firms**: a launch option. Other DAOs never have one, so a DAO never has two tokens.

### The vault and its token

- An ERC-4626 vault over USDC. **Its shares are the DAO's token**: depositing mints them, redeeming burns them.
- Members vote with them like any DAO token: they stake shares in the staking contract. Shares locked by a vote can't be redeemed until the vote ends.
- **Deposits and redemptions happen in windows** (e.g. monthly), at the vault's value at the window, so traders aren't forced to close positions to pay someone out.
- Anyone can deposit, or members only if the DAO chooses.

### Trading

- Traders are added exactly as on today's desks: approved by proposal, each with a mandate (markets, size, leverage, expiry) the bot checks before it signs any order with that trader's signing key (HyperCore's "agent wallet"). Nothing new there.
- The difference from a desk: the desk trades the DAO's Treasury; the vault's desk trades the depositors' pooled money.
- Venues: HyperCore first, then Perpl; Phoenix on Solana.
- **Drawdown backstop:** trading pauses automatically when the vault's value falls past a loss limit set by vote, until a proposal resumes it.
- **Fees:** a management fee and a performance fee above the vault's previous high, set by proposal. Each fee is split between the trader(s) and the Treasury as the proposal configures (all to one, or a share each).
- The signer: the desk's bot-held signing keys now, Marvii when it exists.

### The vault's value

The vault has to know what it's worth at each window, open positions included, so deposits and redemptions are priced fairly. Researched per venue in section 9: HyperCore and Perpl can be valued on-chain without trusting the bot, and Phoenix very likely can, pending a prototype.

---

## 6. Bot changes

- **Allowances:** `/allowance`, `/allowance claim`, and the proposal actions.
- **Raises:** `/raise` (terms, progress, your contribution), `/contribute <amount>`, `/raise accept <amount>` (founder at launch; a proposal for an existing DAO), `/refund`; the website raise page from the launch design.
- **Launch:** the launch setup in the group (terms, allowances, wrapper), then the finishing steps above.
- **`/claim`:** everything claimable from the Distributor; welcome grants approved by council members with `/welcome approve <member>`.
- **Slot candidacy:** `/candidacy <seat>`, `/voteinelection` with one choice per seat, and the council shown by seat.
- **Vaults:** `/vault` (value, your shares, the next window), `/deposit`, `/redeem`, and the trader flow as on desks.
- `/deploywelcomedistributor` and `/setdistributor` go; the Distributor comes with every DAO.

---

## 7. Deployment

Nothing deploys until all of it is built and tested locally. Then one redeploy: every factory, the Treasury implementation, the new Raise, Launch and Distributor factories and the vault on each EVM testnet, and the Vortexes programs on devnet.

**Suggested build order:** allowances, then the Distributor with welcome grants, then raises with the launch flow, then slot candidacy, then vaults (after the value research).

---

## 8. Decisions agreed

1. **Allowances:** on the Treasury; unclaimed months lapse; one token per allowance, several allowances per person and many contractors at once; an end date is required (at most 12 months, renewable); no council confirmation on claims; any address can receive one.
2. **Raises:** share of the total raised; contributions stay open for the whole period; the decider picks any amount from the soft cap up, with no upper limit, and the rest is refunded pro rata; below the soft cap, or with no decision in time, everyone is refunded.
3. **Who decides:** a proposal for an existing DAO; the founder, trader or leader at launch, with the money going only to the new DAO's Treasury.
4. **Launch:** one finishing flow creates the DAO, funds the Treasury, issues the tokens to the Distributor and sets the agreed allowances. The legal wrapper is applied for but only formed after the raise: the bot prepares the documents and proof of reserves for the registrar.
   A prop firm's launch deposits the accepted money into its vault and sends the vault shares to the Distributor.
5. **Distributor:** replaces WelcomeDistributor; claims tied to the chat account; unclaimed tokens back to the Treasury by proposal.
6. **Welcome grants:** Delegate DAOs only, each approved by a council member.
7. **Slot candidacy:** most votes per seat; a tie is a random draw; an empty seat keeps its holder.
8. **Vaults:** prop-firm DAOs only, the vault token is the DAO token; ERC-4626 shares; windows for deposits and redemptions; traders added as on desks; HyperCore then Perpl; management and performance fees, each split between trader and Treasury as configured; an automatic drawdown pause.
9. **Both chains**, no deploy until everything's built.

## 9. The vault's value: research

What each venue lets a contract read, so the vault can value itself at each window:

| Venue | Readable on-chain? | How |
|---|---|---|
| **HyperCore** (from HyperEVM) | Yes | HyperEVM's read precompiles: `accountMarginSummary(perpDex, account)` (`0x…080F`) gives the account value, unrealized PnL included; `spotBalance` (`0x…0801`) gives spot USDC. Addresses and layouts from hyper-evm-lib's `HLConstants.sol` and `PrecompileLib.sol`, the same source the HyperCore integration already uses. |
| **Perpl** (Monad) | Yes | The exchange's own views: `getAccountByAddr` gives the collateral balance and a bitmap of the markets with positions; `getPosition(perp, account)` gives each position's margin, entry, size, funding (`premiumPnlCNS`) and the market's mark price with a validity flag. Value = collateral + each position's margin + its PnL at mark + funding, the sum the desk already shows. |
| **Phoenix** (Solana) | Yes, to prototype | Phoenix publishes Rust crates for on-chain use: `phoenix-rise-accounts` (the trader and market account layouts) and `phoenix-rise-math` (its own margin code, including portfolio value: collateral + unrealized PnL + unsettled funding + spot). A Vortexes vault program can read the accounts and call that code. |

What that means for the design:

- **No trust in the bot for the value**, on any venue. The vault contract (or program) computes it itself when a window opens.
- **Stale or invalid prices stop the window.** Perpl flags an invalid mark; Phoenix records when its mark was last validated. If a price is stale, the window waits rather than pricing shares wrong.
- **Nothing moves during valuation.** Money in flight between the vault and a venue (e.g. a HyperEVM to HyperCore transfer, which HyperCore processes after the EVM block) could be missed or counted twice. So the vault pauses transfers for the window, then values, then prices deposits and redemptions.
- **Risks to check in the prototype:**
  - Phoenix's maths may cost too many compute units in one Solana transaction; the fallback is valuing one trader subaccount per transaction and summing.
  - Phoenix can change its account layouts in an upgrade, so the vault pins the crate version and is upgraded with it.
  - Perpl's PnL formula needs confirming against a mainnet fork, as the other Perpl actions were.

## 10. Left to settle

Both settled while building:

1. **The launch is one transaction on EVM** (`Launcher.finish`, about 3.4M gas): the DAO, its Distributor, the Treasury funded, the shares written and the allowances set. On Solana the operator makes the DAO, its Distributor and the raise in one command; the founder's acceptance is one transaction.
2. **Phoenix valuation fits one transaction.** A window valuing two Phoenix trader accounts against the full mainnet market list (44 markets) takes about 28,000 compute units, so no per-subaccount fallback is needed. The program reads Phoenix's accounts at fixed offsets, checked against Phoenix's own `phoenix-rise-accounts` crate on a mainnet copy of its PerpAssetMap.

---

## 11. As built

**Spaces (EVM).** Treasury allowances; `Distributor`, `Raise`, `DistributionFactory`, `Launcher`; `PropFirmVault`, `HyperCoreValuer`, `PerplValuer`, `VaultFactory`; Delegate council seats with tie draws through each chain's Entropy adapter; deploy scripts. The WelcomeDistributor is gone. 659 Forge tests pass under both build profiles.

**Vortexes (Solana).** Hub allowances; `vortex-distribution` (Distributor and raises, a prop firm's raise paying into its vault); `vortex-vault` (windows, fees, drawdown, valuation from Phoenix's accounts); Delegate seats with ties drawn by ORAO. 118 tests pass.

**The bot, both chains, every platform:**

| Command | What it does |
|---|---|
| `/allowance` | Lists the treasury's allowances; `grant <address> <amount> <token> <months>`, `change`, `revoke` are proposals; `claim <id>` takes this month's payment |
| `/distributor` | `open` (anyone), then `fund`, `grant <address\|@member> <amount> [cliff=] [vest=]`, `welcome <amount> <cap>` by proposal |
| `/claim` | Everything the Distributor holds for you: your wallet's allocations, and your chat account's through the operator |
| `/welcome @member` | A council member approves a welcome grant (Telegram: reply to the member). Joining a group now asks for this instead of paying out |
| `/raise` | Status; `open ...` (EVM: one proposal with the raise, Distributor and sale tokens; Solana: opened at once, decided by the treasury), `accept <amount>` by proposal, `settle` |
| `/contribute`, `/refund` | Join a raise (tied to your chat account); take back what wasn't accepted |
| `/launch` | A founder's raise for a DAO made when they finish it (`finish <amount>`); `propfirm` makes a prop firm whose raise seeds its vault. On Solana the DAO and raise are made at once and the founder decides it |
| `/vault` | Value, `deposit`, `redeem`, `cancel`, `claim`, `window`; `pause`, `resume`, `allow` and valuers (EVM) or Phoenix venues (Solana) by proposal; Solana's `create` makes an existing DAO a prop firm |
| `/seats`, `/declarecandidacy <election> [seat]`, `/finalizeelection` | Seats with labels (`delegate-set-seat-label` / `seatlabel`), one vote per seat, tied seats drawn by lot |

**Tests.** `scripts/test-evm-funds.mjs` on anvil: 39 checks pass (allowances, Distributor, welcome grants, a raise past its hard cap, a launch, a prop firm's launch with a window, tied seats drawn). `scripts/test-evm-models.mjs` delegate and sortition: 26/26 and 21/21. `scripts/test-solana-funds.mjs` on a local validator passes: an allowance, the Distributor with a chat-account grant, a raise past its hard cap accepted by proposal (refunds and claims pro rata), a prop firm launched in one command and accepted by its founder (money in the vault, shares in the Distributor, a deposit at a window), and a tied council seat drawn by ORAO.

---

## 12. Still to do

- **Trading the vault's money from the desk.** `/desk` still trades the treasury. The vault already moves money only by proposal (`execute`) and values its venue accounts; the desk needs to appoint traders on the vault's own HyperCore, Perpl or Phoenix account.
- **Before real money:** value a live vault-owned Phoenix account on a mainnet fork (and confirm a position's asset index is its market's asset id, and Phoenix's collateral token counts 1:1); confirm HyperCore's perp account value is 6 decimals against Hyperliquid's API; confirm Perpl's PnL fields on a mainnet fork.
- **Solana ids at proposal time.** An allowance's or grant's id is fixed when it's proposed, so two such proposals running at once collide: the second fails at execution and is proposed again.
- **Solana launches** have no team shares yet (EVM's do).
- **Deployment** (section 7), when you ask for it.
