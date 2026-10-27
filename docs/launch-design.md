# Launch: website tools (design)

Status: design only, nothing built yet. Agreed in conversation; review before any code.

Launch covers fundraising contracts, token distribution, a DAO registration
system and a perps whitelisting walkthrough. This doc specifies the website
tools they need. The contracts are only outlined here, as far as the pages
depend on them; each gets its own design before it's built.

## Where the website is today

`protean-today` is static HTML on Vercel: the landing page, the docs, and the
proposal pages (`/p/:network/:dao/:id`, served by `proposal.html`, reading the
bot's JSON API, with edit password and history). There is no wallet
connection and no data of its own beyond the proposal pages.

The new pages follow the same pattern: static pages that read the bot's API
and the chain, with rewrites in `vercel.json`. Only the raise, claim and
launch wizard pages need a wallet.

## The tools

| # | Tool | Path | Wallet | When |
|---|---|---|---|---|
| 1 | DAO page | `/d/:network/:dao` | no | launch |
| 2 | DAO registry | `/daos` | no | launch |
| 3 | Raise page | `/raise/:network/:raise` | to contribute | launch |
| 4 | Wallet connection | every page that signs | yes | launch |
| 5 | Claim / vesting page | `/claim/:network/:token` | to claim | launch |
| 6 | Distribution overview | on the DAO page and raise page | no | launch |
| 7 | Launch wizard | `/launch` | yes, or hand-off to chat | launch |
| 8 | Perps whitelisting walkthrough and checker | `/whitelist` | no | launch |
| 9 | Terms, risk disclosure, privacy | `/terms`, `/risk`, `/privacy` | no | launch |
| 10 | Treasury dashboard | `/d/:network/:dao/treasury` | no | soon after |
| 11 | Contract addresses and audits | `/contracts` | no | soon after |
| 12 | Survey results pages | `/s/:market` | no | soon after ([survey design](survey-design.md)) |
| 13 | Status page | `/status` | no | soon after |
| 14 | Investor / KYC gate | in the raise flow | — | only if legal advice requires it |

How they connect: the launch wizard creates a DAO; it gets a DAO page and a
registry listing. The DAO opens a raise, which investors find on its DAO page
and fund with their wallet. When the raise ends, tokens go out through the
distribution; holders claim them on the claim page. A DAO that trades perps
uses the whitelisting walkthrough to get its desk approved.

## 1. DAO page

Each DAO's public profile, and the page every other tool links to.

- **Header:** name, model, network, verified badge (see registry), the group's
  platform, a join link if the DAO makes one public.
- **Treasury:** current balances per asset, with the chain's explorer link.
  Read live from the Treasury address (`governance.treasury()`, never stored).
- **Token:** symbol, total supply, holders count, a link to the distribution.
- **Governance:** open proposals (each links to its proposal page), the last
  ten closed ones with their result, the quorum and thresholds in plain words.
- **Desk:** if it has one, its traders' mandates and positions (what `/desk`
  shows, without the trader-only parts).
- **Raises:** open and past raises, each linking to its raise page.
- **Legal:** the wrapper (DUNA, DAO LLC), if any, and its registration number.
- **Model switches:** the history, so a DAO stays one page across switches.

Data: the bot's API gains `GET /api/dao/:network/:dao` (one call that
assembles the above, cached for a minute); the page needs no other backend.

## 2. DAO registry

A searchable list of DAOs registered through Protean.

- **Columns:** name, model, network, treasury size, members, last activity,
  verified badge.
- **Filters:** network, model, verified only, has an open raise.
- **Verified:** the governance contract was made by our factory on that
  network (checked against the factory, not by its ABI: a copy of the code
  isn't proof). Further levels are an open decision (below).
- **Listing is opt-in:** a chat's DAO is listed only when its admins choose
  (`/listdao`, or a toggle in the launch wizard). Private escrow and survey
  groups stay unlisted.
- **"Is this a real Protean DAO?"** box: paste an address, get yes/no and the
  DAO page.

Data: `GET /api/daos?network=&model=&verified=` from the bot's chat links
(Supabase `chat_links`), listed DAOs only.

## 3. Raise page

A fundraise's public page and contribution flow.

- **Terms:** what the money is for, the target, minimum and maximum, the
  token price or how it's set, the deadline, per-person minimum and cap, what
  happens if the target isn't reached (refunds), and the vesting of the
  tokens bought.
- **Live:** a progress bar (raised against target, with the minimum marked),
  number of contributors, time left, the latest contributions.
- **Contribute:** connect a wallet, enter an amount, see the tokens it buys,
  accept the terms and risk disclosure, sign. Then a receipt with the
  explorer link and a link to the claim page.
- **After it ends:** succeeded or refunded, the totals, the link to claim
  tokens or refunds.
- **The DAO's side** (who's raising): a link to the DAO page, its treasury,
  and how the raised money reaches the Treasury (directly, or on milestones).

Contract (to design separately): a raise contract per raise, from a factory,
paying into the DAO's Treasury; terms fixed at creation; refunds if the
minimum isn't met by the deadline; contributions recorded on-chain for the
distribution. Prop-firm DAOs, which mint only from deposits, are a variant of
this.

## 4. Wallet connection

Today every user wallet is the bot's KMS wallet, tied to a chat account.
Outside investors need to use their own.

- **Own wallets:** an injected wallet (MetaMask, Rabby) and WalletConnect, on
  the EVM networks; a Solana wallet adapter for Vortexes DAOs.
- **Marvii:** the non-custodial wallet from the other session, once built.
- **Linking to chat:** a contributor can link their own wallet to their chat
  account (sign a message from the website, the bot records it), so their
  tokens can vote from the group. Optional.
- No custody on the website: it only asks wallets to sign.

## 5. Claim / vesting page

Per wallet, for a DAO's token:

- the total allocation and where it came from (raise, team, community);
- vested so far, claimed, claimable now;
- the unlock schedule as a step chart, with today marked;
- a **Claim** button (connect wallet, sign).

Contract (to design separately): a vesting / distribution contract per token:
allocations set when the raise ends or by proposal, cliff and linear unlock,
claim by the holder; unallocated or unclaimed tokens return to the Treasury
by proposal.

## 6. Distribution overview

On the DAO page and the raise page:

- the token's allocation (team, treasury, raise, community, others) as a
  donut chart or a single stacked bar, with amounts and %;
- the vesting timeline as a stacked area chart (tokens unlocked over time,
  per allocation);
- the top holders (addresses, with a DAO's own contracts labelled).

## 7. Launch wizard

A step-by-step way in for creators, instead of chat commands.

1. Name, symbol, network.
2. Governance model, with a plain-words explanation and suggested defaults.
3. Token supply and the distribution (team, treasury, raise, community),
   with the vesting for each.
4. Optional raise: target, minimum, price, deadline.
5. Optional legal wrapper: which one, and the details it needs (links out to
   the registration process; Protean doesn't file it).
6. Where the group lives: Telegram, Discord or Slack (the
   [spin-up flow](spinup-design.md) creates or links the group).
7. Review, then create. Ends with the DAO page and the group link.

Two ways to finish: sign from the creator's own wallet on the website, or
hand off to the group (the bot creates it, as `/createdao` does now). The
`/createdao` fix (it mints the starting supply to the operator wallet) has
to land before the wizard creates DAOs on mainnet.

## 8. Perps whitelisting walkthrough and checker

Perpl only accepts whitelisted accounts while its whitelisting is on. The
bot already reads `whitelistingEnabled()` and `whitelisted(address)` on the
exchange, and `/desk fund` warns when a desk isn't whitelisted.

- **Walkthrough:** what the whitelist is, which address needs whitelisting
  (each trader's desk, not the Treasury, for the desk; the Treasury for
  `/perps`), and the steps to request it from Perpl.
- **Checker:** pick the network, paste an address (or pick the DAO), see:
  whitelisting on or off, and whitelisted yes or no for the Treasury and
  each desk.
- **HyperCore:** no whitelist, but a section on what the Treasury needs on
  HyperCore before a desk can trade (USDC moved to perps by `desk fund`).

To check before writing it: Perpl's actual process for getting an address
whitelisted (who to ask, what they need). Not known yet.

## 9. Terms, risk disclosure, privacy

Required before taking outside money: terms of use; a risk disclosure shown
and accepted before contributing (tokens can lose all value, smart contract
risk, no guarantee of returns, the trader risk for desk DAOs); which
jurisdictions may take part; a privacy policy (what the bot stores: chat
links, KMS wallets, proposal details). Written with the legal advice that
also decides the wrapper.

## 10. Treasury dashboard (soon after)

**Who it's for:** members (what can we afford before voting), investors
(was the raise spent as promised), overseers of trading desks, the creator
and admins (reports, tax, the legal wrapper's accounts), and outsiders
checking the DAO is real.

**What it shows:**

| Section | Representation |
|---|---|
| Total value now, per chain and per asset | stat tiles, plus a stacked bar per chain |
| Value over time | line chart (daily) |
| Inflows and outflows | column chart by week or month, in and out side by side |
| Every outflow | a table: date, amount, to whom, **the proposal that approved it** (link to its page, with the vote result) |
| Desks | each desk's collateral, positions and PnL (the PnL card), against its mandate |
| Raises | raised, spent, left |
| Export | CSV of all movements, for accounts |

**What makes it ours:** it follows a DAO across chains and model switches;
every outflow is tied to the vote that approved it; it shows the DAO's own
traders against their mandates; and every DAO has one from day one, with
nothing to connect, because the bot already knows its addresses.

**Similar tools elsewhere** (for website-run DAOs): Safe's own wallet view,
Tally, DeepDAO, Coinshift, and the treasury reports large DAOs publish.
Named from memory; check before citing.

Data: history needs an indexer (the listener already reads every DAO's
events; it would also store Treasury transfers), or a provider's API per
chain. Decide which before building.

## 11–13. Contracts page, survey pages, status page

- **Contracts and audits:** every official factory and implementation address
  per network with explorer links, the audit reports, and a "verify this
  address" box (same check as the registry).
- **Survey results:** the pages specified in [survey design](survey-design.md).
- **Status:** each platform's bot and each network's listener: up or down,
  last block seen, from a health endpoint the bot exposes.

## 14. Investor / KYC gate (only if required)

If the legal advice says raises need it: accredited-investor checks,
sanctions screening, or blocking some jurisdictions, done by a provider
before the contribute step, with only a pass/fail kept. It shapes the raise
page, so decide it before building that page.

## Open decisions

1. **Custody for investors:** their own wallets, Marvii, or both? Decides the
   wallet connection and the deposit flow.
2. **What "verified" means:** made by our factories (automatic); plus a
   legal wrapper; plus a manual review.
3. **Who can run a raise:** any DAO, or only verified ones?
4. **The legal advice on public raises:** jurisdictions, KYC, and whether
   raises wait for the DUNA or DAO LLC wrapper.
5. **Treasury history source:** our own indexer (the listener) or a
   provider's API.
6. **Registry listing:** opt-in (suggested), or every DAO by default?

## Suggested build order

1. DAO page and registry: everything else links to them, and they need no
   wallet. Adds the bot API endpoints.
2. Perps whitelisting walkthrough and checker: small and useful now (once
   Perpl's process is confirmed).
3. Raise, claim and distribution pages, built with the raise and vesting
   contracts, behind the terms and risk pages.
4. Wallet connection, once the custody decision is made (with Marvii).
5. Launch wizard, after the `/createdao` fix.
6. Soon after: treasury dashboard, contracts page, survey pages, status page.
