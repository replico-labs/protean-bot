# Protean Escrow (design)

Status: design only, nothing built yet. Agreed in conversation; review before any code.

An escrow is a small multisig vault for a deal between two sides, run from a
private group the users own (see [spin-up groups](spinup-design.md)). The
parties hold signer keys; the bot holds one more signer key and signs only
on the arbitrators' ruling. Arbitrators hold no key: they rule through bot
commands.

## Who's in an escrow

| | 1 v 1 | 2 v 2 |
|---|---|---|
| Party signers | 1 per side | 2 per side |
| Bot signer | 1 | 1 |
| Signers in all | 3 | 5 |
| Threshold | 2-of-3 | 3-of-5 |
| Arbitrators (no key) | 2 | 2 |
| People in the group | 4 (+ up to 4 others; 3 on WhatsApp) | 6 (+ up to 2 others; 1 on WhatsApp) |

- **A group has at most 8 people** on Telegram, Discord and Slack, and **7 on WhatsApp**, where the bot's business number takes one of the Groups API's 8 seats. Both sizes fit: 1 v 1 with 2 arbitrators is 4 people, 2 v 2 is 6. On WhatsApp the bot creates the group itself and admits only the invited numbers (see [spin-up groups](spinup-design.md)).
- **Sides are the same size.** With 1 v 2 (4 signers) no threshold works:
  3-of-4 means the single-signer side can't win a dispute even with the bot,
  2-of-4 means the two-signer side can release without the bot. A side
  wanting another person adds them to the group without a key.
- **Arbitrators can't be signers,** both sides accept them at setup, and they
  are fixed once the escrow is funded.
- **The parties' keys are their own:** Marvii, or their own wallet on the
  signing page. If the bot held the party keys too, the multisig would be on
  paper only. The bot's key is a separate KMS key per escrow, so a leak
  exposes one escrow.

What the threshold means:
- Both sides agree (1 v 1: both signers; 2 v 2: 3 of the 4 party signers,
  which always includes both sides): the vault moves without the bot.
- One side alone can never reach the threshold.
- The bot alone can never reach it either. With a ruling, the bot plus the
  winning side reaches it (1 v 1: 1 + 1; 2 v 2: 2 + 1).

## The two kinds of deal

### OTC: tokens or NFTs on both sides

Both legs are on the escrow's chain, so the contract can see them itself.

1. **Setup:** the terms name exactly what each side puts in: the token's
   contract address and amount, or the NFT's contract and token id (and the
   amount, for ERC-1155). Never a name or symbol: anyone can make a token
   called USDC.
2. **Deposits:** each side deposits its leg into the vault. The deal page and
   the group show each leg as the contract reads it ("✅ 1,000 USDC
   received", "⏳ NFT #42 not yet").
3. **Confirmation:** once both legs are in, the parties confirm: they check
   the vault holds what was agreed and sign. That's the point of an OTC: the
   swap happens only when both sides say so. The swap executes at the
   threshold (1 v 1: both parties; 2 v 2: 3 of the 4 party signers), in one
   transaction: each side gets the other's leg.
4. **A leg that never arrives by the deadline:** the deal never started. The
   side that deposited takes back its own deposit, with no arbitrator: the
   contract sees that the other leg isn't there.
5. **Both legs in, but a side won't confirm:** either side raises a dispute
   and the arbitrators rule (below). In OTC a ruling either completes the
   swap or unwinds it (each side gets its own leg back); an NFT can't be
   split.

The contract guards against:
- **fee-on-transfer and rebasing tokens:** it counts what actually arrived,
  and a leg short of the terms isn't complete;
- **look-alike tokens and NFTs:** the deal page shows the exact contract
  address with an explorer link, and flags anything not on a known list;
- **NFT standards:** ERC-721 and ERC-1155, accepting safe transfers for both;
- assets on another chain: OTC needs both legs on the escrow's chain.

### Everything else: services, goods, work, fiat

The chain can't see whether the receiver did their part.

1. **Setup:** the terms in words (what's delivered, by when), the amount, the
   deadline. Both sides sign the terms.
2. **The funder deposits.**
3. **Delivery:** the receiver does their part off-chain.
4. **Release:** both sides sign the release (threshold without the bot), and
   the funds go to the receiver.
5. **A dispute:** either side raises one (the funder says it wasn't
   delivered; the receiver says it was, and the funder won't release).
   The arbitrators rule.

**The funder is refunded only when the arbitrators rule that the receiver
didn't do their part.** A tie, a missed deadline or silence never refunds by
default. Every outcome comes from both sides agreeing, or from a ruling.

## Disputes and rulings

1. **Raising one:** `/escrow dispute <reason>`. The group and the deal page
   are told; each side can add evidence (files, messages) on the deal page.
2. **The two arbitrators rule:** `/escrow rule <0|25|50|75|100> [reason]`,
   the share released to the receiver (100 = release in full, 0 = refund in
   full; OTC rulings are complete or unwind only).
3. **Agreement:** both arbitrators give the same ruling, within the response
   deadline.
4. **A 1–1 tie, or no ruling in time:** it goes to a reserve arbitrator from
   Protean's verified escrow agents. Each has a response deadline; if they
   miss it, it moves to the next agent on the list. The reserve's ruling is
   final. There's always a ruling, never a default outcome.
5. **The objection window:** the ruling is posted in the group with its
   reason. After a short window, the bot prepares the ruled outcome and adds
   its signature.
6. **The winning side signs too,** reaching the threshold: 1 v 1, the bot and
   one signer; 2 v 2, the bot and both of that side's signers.

The bot never decides anything itself. It signs only the outcome the
arbitrators ruled, or a joint instruction of both sides, and every signature
is recorded with its reason.

## The contract

A dedicated escrow contract per deal, from a factory, not the Board model.
Board's signers can vote mid-deal to add or remove signers or change the
threshold, which an escrow must not allow. Fixed at creation, on-chain:

- the sides (1 v 1 or 2 v 2), their signers, the bot's signer and the
  threshold, never changeable after funding;
- the deal kind: OTC (each leg's exact asset and amount) or other (the amount
  and token);
- the only recipients: the two sides. Funds can go to the receiver, back to
  the funder, or split in 25% steps between them, never anywhere else;
- the deadlines: deposits, response deadlines, the objection window before
  the bot's signature counts;
- events for every step (deposit, confirmation, dispute, ruling, signature,
  payout), which feed the deal page and the group's notices.

It reuses Board's confirm pattern, so it's small, but it needs its own tests
and an audit before mainnet. The arbitrators and reserve agents aren't on
chain: they act through the bot, which signs.

## The bot

| Command | Who | What it does |
|---|---|---|
| `/escrow new <otc\|deal> …` | anyone | starts the setup: sides, signers, arbitrators, terms, deadlines |
| `/escrow` | anyone in the group | the escrow's status: legs or deposit, confirmations, deadlines, dispute |
| `/escrow deposit` | a party | deposits their leg (signs with their own key) |
| `/escrow confirm` | a party signer | confirms the swap (OTC) or the release |
| `/escrow withdraw` | the depositing side | takes back their own deposit when the other OTC leg missed its deadline |
| `/escrow dispute <reason>` | a party | raises a dispute |
| `/escrow rule <0-100> [reason]` | an arbitrator | gives their ruling |

Notices: each deposit, confirmation, dispute and ruling posts in the group
with buttons (Confirm, Dispute, Rule), and reminders go out before every
deadline.

## The website

- **Signing page** (`/e/:network/:escrow/sign`): for parties signing with
  their own wallet rather than Marvii. It shows the exact terms, or the
  exact assets, being signed.
- **Deal page** (`/e/:network/:escrow`): the record both sides rely on, not
  chat history: terms, signers and arbitrators, each leg or deposit as the
  contract reads it, confirmations, the dispute with its evidence, rulings
  with their reasons, and every transaction with its explorer link. Private:
  only the group's members can open it.

## Still to decide

1. **The setup flow:** who proposes the terms, and how the other side
   accepts them (both sign the terms on the signing page, or by command).
2. **The deadlines' defaults:** deposits, arbitrator responses, the
   reserve's response, the objection window.
3. **Fees,** if Protean or the arbitrators charge any, and who pays them.
4. **Which chains first.**

## Suggested build order

1. The escrow contract and its tests: both kinds, both sizes, rulings,
   deadlines.
2. The bot: setup, commands, notices and buttons, the per-escrow bot key,
   the reserve arbitrator rotation.
3. The deal page and the signing page (or Marvii, if it's ready first).
4. The spin-up flow for escrow groups.
5. Audit before mainnet.
