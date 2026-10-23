# Opportunity Markets (Ethereum Sepolia, FHE-encrypted)

Confidential prediction markets. Individual bets stay encrypted; only the winning opportunity and its total are ever revealed.

- **Set up** (group owners and admins): `/createmarket <underlyingToken>` · `/registermarket <address>` · `/unregistermarket`. `/registermarket` only accepts markets the configured `OpportunityMarketFactory` reports as its own (`isMarket`).
- **Bet:** `/listopportunity <metadataURI>` · `/deposit <amount>` · `/back <opportunityId> <amount>` (confidential)
- **Check:** `/mybalance` · `/mybet <index>` · `/allbets`
- **`/analytics`** (deployer only, sent privately): total staked, average bet, average per bettor and largest bet, overall and per opportunity, plus each opportunity's share of all stake. It's built from the bets the contract already lets the deployer decrypt, so nothing new is revealed publicly.
- **Run the market** (deployer only): `/fundrewardpool` · `/resolve <id>` · `/cancelmarket`
- **Collect:** `/reclaimstake` · `/computereward` · `/revealwinningtotal` · `/withdraw` · `/withdrawreward`
  - **`/computereward`** tells you your reward privately. The contract keeps it encrypted with no getter, so the bot works it out from your own decrypted bets and the public pool, winning opportunity and winning total. It repeats the contract's 64-bit math exactly, and warns if that math wrapped.
  - **`/withdraw` and `/withdrawreward`** report the exact amount paid: the KMS-signed cleartext the contract pays out.
- **`/send <amount|all> <recipient> [ETH]`** in a market group sends the market's token (your withdrawn stake or reward) or Sepolia ETH.
  - In a group with a DAO too, add `market` (or the token's symbol or address) to send the market's token.
  - Sepolia gas isn't sponsored. An empty wallet is told how much it needs, and its address.

[Back to the README](../README.md)
