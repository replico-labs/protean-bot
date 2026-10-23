# Proposals and notifications

Proposal pages on the website, explorer links, chat notifications and vote charts.

## Proposal pages

Every proposal gets a page on the website, `PROPOSAL_SITE_URL/p/<network>/<dao>/<id>`. It shows the details its proposer writes there, next to live on-chain data: state, votes or conviction, budget, timelock and actions. This works for EVM and Solana DAOs alike.

- **After proposing,** the group sees the page link, and the proposer gets a private link to add the details:
  - Telegram: a DM, or a `t.me/<bot>?start=…` link that opens one if the bot can't message them first
  - Discord and Slack: a message only they can see
  - WhatsApp: a DM
- **Edit password and history:**
  - With the first upload, the proposer chooses an edit password (8+ characters). Any later edit needs the private link *and* that password, so a forwarded link alone can't change anything. Only a scrypt hash of the password is stored.
  - 5 wrong passwords lock editing for 15 minutes.
  - Every saved version is kept (`proposal_detail_versions`, up to 20) and listed on the page under History, with its time and sha256 fingerprint, so readers see exactly what changed.
- **When details can change:** uploads and edits are allowed during a grace period after proposing (`PROPOSAL_DETAILS_GRACE_HOURS`, default 6), even once voting has started. After that, only while nobody has voted on or backed the proposal, up to 72 hours. Then the details are final.
- **`/proposal <id>`** ends with the page link. When the proposer runs it while they can still edit, it also re-sends their private link.
- **Solana DAOs** get their pages at `/p/solana-devnet/<governance account>/<id>`.
  - The address is the governance account, not the DAO, so pages stay right after a model switch (the new governance numbers its proposals from 1 again).
  - Live data comes straight from the Vortexes programs. Instructions are described in words, and addresses link to Solana's explorer.
- **Board DAOs:** proposing counts as the proposer's own confirmation, so details stay open until a second signer confirms.
- **How it's served:**
  - The website is static. It reads `GET /api/proposals/<network>/<dao>/<id>` from the bot, and its form `POST`s back.
  - The routes share the Slack install page's HTTP server when "Add to Slack" is set up; otherwise the Telegram process listens on `PORT`.
  - Only DAOs linked to a chat are served, and CORS allows only `PROPOSAL_SITE_URL`.
  - Edit links are HMAC-signed with `PROPOSAL_LINK_SECRET` and expire with the edit window.
- **Setup:**
  1. Run the `proposal_details` and `proposal_detail_versions` parts of `supabase/schema.sql`. Re-run it on an existing database: it adds the password and version columns.
  2. Set `PROPOSAL_SITE_URL` and `PROPOSAL_LINK_SECRET`.
  Without them, the bot works as before, with no page links.

## Explorer links

Every reply to a command that sends a transaction ends with a 🔗 link to it on the network's explorer. That covers creating a DAO, tips and sends, staking, proposing, votes, challenges, support, confirmations, queue, execute, elections, trades and the rest.

- **EVM:** links are recorded where every transaction leaves the bot (`writeWithGasBuffer`, `deployWithGasLimit`, native sends; see `src/txLinks.js`), so new commands get them too.
- **Solana:** links are recorded in `send()` in `src/solana/vortex.js`, which every Vortexes transaction goes through.
- **Opportunity Markets:** transactions link Sepolia Etherscan, and `/migratewallet` links its transfer.
- **Notifications** link the transaction they report, and `/wallet` links your address.
- **Explorers:**
  - Monad testnet: `testnet.monadexplorer.com`
  - Base Sepolia: `sepolia.basescan.org`
  - HyperEVM testnet: `testnet.hyperevm-explorer.xyz`
  - Solana: `explorer.solana.com` with the cluster
  - mainnets: viem's defaults

  Override one with `<PREFIX>_EXPLORER_URL`, e.g. `BASE_SEPOLIA_EXPLORER_URL`.

## Notifications and vote charts

Every platform's process polls its linked DAOs and posts to the linked chat:
- proposals created, queued, executed and cancelled
- model-specific events: challenges, elections and recalls, council draws, Sowellian approvals and resolutions, decision-market outcomes, model switches

**EVM:**
- Polled every 20 s, each network separately, with **one `eth_getLogs` per block range for all of that network's DAOs** (every address and event in one filter). So RPC use doesn't grow with the number of DAOs, which matters on plans that bill per call.
- Ranges are up to 90 blocks (Monad testnet caps `eth_getLogs` at 100), or the RPC's own limit, which the listener learns from its error (QuickNode's free plan: 5).
- Each DAO's progress is saved after every range.

**Solana:** polled every 30 s. Each poll reads the governance account's new transactions and decodes the program's events from their logs. A new-proposal notice also links the proposal's page.

**Vote charts.** When a vote ends, the listener posts the result with a chart (a PNG), e.g. *"Voting on proposal #3 has closed: Succeeded"*.
- **What the chart shows:** For / Against / Abstain bars with each side's share, the votes cast and the quorum, titled with the details the proposer wrote on the page.
- **What's tracked:** every proposal the listener saw created (token-weighted, quadratic, liquid, delegate, sortition, optimistic challenges, Sowellian approval votes, Decision Markets' pass/fail prices), up to 50 open per DAO, for 30 days.
- **Cost:** a proposal is read only once its end has passed (its end block on EVM, its end time on Solana; once a minute where the end isn't known), so open votes cost almost no RPC.
- **`/proposal <id>`** sends the same chart with its answer, for every model that has one. Conviction shows its progress toward the threshold; Board has none.
- **Same on both chains:** EVM and Solana proposals get the same charts (`src/solana/charts.js` hands Vortexes proposals to `src/charts.js`).
- **Sending:** Telegram, Discord and WhatsApp send the chart as a photo. Slack uploads it, which needs the `files:write` scope (in the manifest). An existing install must be reinstalled to get that scope; without it the text still goes out and the chart is skipped, logged once.
- **Drawing:** charts are SVG rendered with resvg, with fonts bundled in `assets/fonts`, so there's nothing to install on the server. `barChartPng()` is general, for future market, futarchy and PnL cards.

[Back to the README](../README.md)
