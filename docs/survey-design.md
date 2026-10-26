# Survey groups: rewards and statistics (design)

Status: design only, nothing built yet. Agreed in conversation; review before any code.

Survey groups are private Opportunity Markets (Sepolia, Zama FHE) run in a
group the users own (see [spin-up groups](spinup-design.md)). Members back
options with encrypted stakes. This doc covers two things the market doesn't
do yet: **reward structures beyond "winner only"**, and **statistics and
charts** that don't expose anyone's bet.

## What the market does today

- `resolve(id)` names **one** winning option; only the deployer can call it.
- The reward pool is split among backers of that option, by stake
  (`computeReward`: stake × pool ÷ winning total, on encrypted values).
- Everyone gets their own stake back (`reclaimStake`).
- Public on-chain: deposits and their amounts, the list of bettors, each
  bettor's number of bets and when they were placed (`Backed` events), the
  options and who listed them, the reward pool, the winner, and the winner's
  total.
- Encrypted: which option each bet backs, each bet's amount, each option's
  running total, balances.

## Reward structures

Chosen by the deployer when creating the market.

| Mode | Who gets paid |
|---|---|
| **1. Winner only** (today) | backers of the one winning option, by stake |
| **2. Several winners** | backers of each winning option. The structure fixes how many winners and each one's slice of the pool (e.g. 60/30/10, or even); each slice is shared by stake among that option's backers |
| **3. Everyone who took part** | every bettor: equal shares (pool ÷ bettors), or by stake (your share of all money bet) |
| **4. Mixed** | a split between 3 and 2 (or 1), e.g. 30% to everyone, 70% to the winners |
| **5. Spread your stake** (later) | everyone spreads their stake across options and is scored by how much they put on what happened (a proper scoring rule). A bigger change: last |

### Sealed, then revealed at resolution

Announcing the structure up front steers behaviour: with "everyone gets
paid" people bet carelessly; with "three winners" they spread bets to catch
one. For a survey that skews the opinion being measured. Choosing it freely
at the end lets the deployer pick, after seeing the totals, whatever pays
their own side. So:

1. **At creation** the deployer picks the structure. The contract stores only
   a commitment: `keccak256(abi.encode(structure, salt))`.
2. **During the market** bettors see "rewards: decided by the deployer, sealed
   at creation", not the structure.
3. **At resolution** the deployer reveals the structure and salt with the
   winners; the contract checks them against the commitment and refuses
   anything else. Payouts follow the revealed structure.

A deployer can instead **announce** it (e.g. a paid-for-participation
feedback survey that wants people to join). Either way it's fixed at
creation. Sealed is the default for surveys.

What this doesn't remove: the deployer still names the winners, so markets
still trust the deployer on the outcome. Resolution by vote or oracle could
come later.

### Contract changes

- `initialize` takes the reward commitment (or the announced structure).
- `resolve(winnerIds[], structure, salt)`: checks the commitment, records the
  winners and each slice; the number of winners must match the structure.
- Reveal each winning option's total (as `finalizeWinningTotal` does for one
  today), and the grand total when "everyone by stake" is used.
- `computeReward`: for each winning option, stake on it × its slice ÷ its
  total; plus the participation share (equal: plaintext pool ÷ bettors; by
  stake: stake × share ÷ grand total). Division is only by revealed
  plaintext totals, as now.
- Cost: a reward loops over a bettor's bets once per winning option. Fine for
  small groups with up to 12 options; `finalizeWinningTotal`'s note about
  batching before large markets applies here too.
- Gaming "everyone gets paid": a minimum bet to qualify, one share per
  wallet. Bot wallets are tied to platform accounts, which helps but doesn't
  stop sybils fully.

## Statistics and charts

The rule is **reveal totals, never individuals**. Availability:

- ✅ today (public)
- 🔓 needs every option's total revealed at the end
- 🔢 needs an encrypted backer count per option, revealed the same way
- 📸 needs mid-market snapshots
- 🎯 needs mode 5
- 👤 shown only to the person (they can decrypt their own bets)

### Result

| Statistic | Representation | Needs |
|---|---|---|
| Money share per option (implied probability) | horizontal bars, sorted, % and amount, winners highlighted | 🔓 |
| People share per option | a second bar beside each money bar | 🔢 |
| Money vs people gap | dumbbell chart (two dots per option) | 🔓🔢 |
| Winners | headline card | ✅ |
| Winners' share of all money | one big number with a short bar | 🔓 (roughly ✅: winner total ÷ deposits) |

### Conviction

| Statistic | Representation | Needs |
|---|---|---|
| Average stake per backer, per option | a label on each result bar | 🔓🔢 |
| Median stake, concentration (top backers' share) | — | hard under encryption: left out at first |
| Hedging (bettors with more than one bet) | one number | ✅ partly (bets per bettor are public, not which options) |

### Certainty

| Statistic | Representation | Needs |
|---|---|---|
| Margin between the top two | text on the headline card | 🔓 |
| Spread (entropy) | a scale from "split" to "unanimous"; one word in chat | 🔓 |

### Participation

| Statistic | Representation | Needs |
|---|---|---|
| Bettors, bets, turnout, deposited, reward pool | stat tiles (a row of big numbers) | ✅ |
| Bets over time | column chart by hour or day | ✅ |
| Cumulative bettors | line chart | ✅ |
| Deposit sizes | histogram | ✅ |

### Change over time

| Statistic | Representation | Needs |
|---|---|---|
| Each option's share at each snapshot | line chart, or 100% stacked area | 📸 |
| Biggest swing | annotation on that chart | 📸 |

Snapshots leak: two snapshots one bet apart give away that bet. Reveal only
after at least N new bets since the last one, or at fixed times.

### After resolution

| Statistic | Representation | Needs |
|---|---|---|
| Pool split (pool, winners, average payout) | stat tiles | ✅ |
| Your stake, reward and return | personal card, by DM | 👤 |
| Your accuracy across markets | line chart plus one score (Brier) | 👤 (🎯 for the full version) |
| Group accuracy across markets | line chart | 🔓 |
| Calibration (said 70%, happened 70%?) | calibration plot with the diagonal | 🔓🎯, many markets |

### Segments (optional)

Results by member tag (team, role, cohort): small multiples or grouped bars.
Needs tags and per-segment encrypted totals, and only above the minimum
group size.

### Where each goes

- **Chat, at resolution:** one image: headline card, result bars, stat tiles.
- **Chat, while open:** participation only (tiles, activity timeline); no
  opinion statistics unless snapshots are on.
- **Web page:** everything, interactive (hover, money/people toggle), plus
  trends, histogram and history across markets.
- **DM:** the personal card and track record.

### Privacy floor

With very few bettors, per-option totals nearly expose individuals: no
per-option breakdown below a minimum number of bettors.

## Open decisions

1. **"Everyone" rewards:** equal shares, by stake, or the deployer's choice?
   Suggested: the deployer's choice.
2. **The 12-option cap** (`MAX_OPPORTUNITIES`): enough for surveys? Each
   option adds encrypted work to every bet, so more options cost more gas.
3. **The minimum group size** for breakdowns. Suggested: 5.
4. **Mid-market snapshots:** none at first, or after every N new bets?
5. **Reveal every option's total at the end:** suggested yes. It's what most
   of the statistics need.

## Suggested build order

1. Charts from what's public today: participation tiles, activity timeline,
   winner card. No contract change.
2. Contract: sealed reward structures (modes 1–4), several winners, every
   option's total revealed at the end. Tests, ABI into the bot.
3. Bot: create with a structure (sealed or announced), resolve with several
   winners, the results image.
4. Encrypted backer counts: people share, average stakes.
5. The web page and personal cards.
6. Later: snapshots, mode 5, calibration and track records.
