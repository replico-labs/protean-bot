# Commands

Every command, and the buttons and help menu that run them. `/help` only shows the commands that apply to the chat's model and its linked wrappers and markets.

**Setup**
- `/createdao <name> <symbol> <initialSupply> <maxSupply> [model] <network> [council...]`: deploy a DAO and link it here.
  - Models: `tokenWeighted` (default), `quadratic`, `liquid`, `optimistic`, `delegate`, `sortition`, `conviction`, `sowellian`, `decisionMarkets`.
  - `delegate` and `sortition` take the starting council as trailing addresses. Sortition's randomness source comes from the bot's config.
- `/createboarddao <name> <signer1> <signer2> ... <network>`: a Board (multisig) DAO, with no token.
- `/register <address> [model] [network]` / `/unregister`: link or unlink an existing DAO. `/register` checks the address really is that model's contract on that network.
- `/network`: the chat's chain, and the networks the bot supports.
- `/launch <model> <name> <symbol> <supply> <forSale> <softCap> <hardCap> <days>`: start a new DAO from a raise. When it ends the founder accepts an amount (`/launch finish <amount>`) and the DAO is made with the money in its Treasury, the sale's tokens in its Distributor and the rest of the supply in its Treasury. `propfirm` instead of the tokens for sale makes a prop firm: its token is its vault's shares, minted from the money. On Solana, add `<currency mint>` before the caps and `solana` at the end.
- `/deploynftwrapper`: the DAO's NFT wrapper (see [NFTs](governance-models.md#nfts)).
- `/deployguardwrapper <requiredApprovals> <tenureSeconds> <signer...>` / `/registerguardwrapper <address>` / `/handovertowrapper <address>`: a security council (see [Guard wrapper](governance-models.md#guard-wrapper)).
- **Spaces in arguments:**
  - A description (in `/propose`, `/proposeaction`, `/vote` reasons, `/listopportunity`) is everything after the last fixed argument, so it can be plain text with spaces.
  - A DAO name with spaces goes in quotes, straight or curly: `/createdao "Ark DAO" ARK 1000000 10000000`. Discord's name field takes spaces as is.

**Wallet and tokens**
- `/wallet` · `/migratewallet` · `/balance [address]`
- `/tip <amount> <recipient> [token]`: hand out the DAO's operator-held supply (creator only)
- `/send <amount> <recipient> [token|native]`: send tokens or native currency you hold
- `/tokenbalance [token] [address|treasury]` · `/registertoken <ticker> <address>` · `/treasuryassets`
- `/stake <amount>` · `/unstake <amount>`

**The DAO**
- `/dao`: name, network, the governance, token and treasury addresses in full (each linked to the explorer), and the full model-specific config. Solana DAOs also show the DAO and governance accounts.
- `/treasury` · `/contribute` (the treasury address, sent privately; with an amount, a contribution to the chat's raise)
- `/proposals` · `/proposal <id>`: a list, or one proposal in full, shown in its model's own vote shape, with its chart and page

**Proposing and deciding**
- `/listactions` · `/proposeaction <actionId> <args...> <description>`: the verified action library.
  - It covers every native governance, Treasury, token and wrapper admin function, encoded for you, plus the [external protocol actions](trading.md#external-protocol-actions) available on the chat's network.
  - After a GuardWrapper handover, Treasury and token actions are routed through the wrapper automatically.
  - It works for every model; Sowellian and Decision Markets add their settings as `name=value` words.
- `/actioninfo <actionId>`: an action's arguments, options, and the sources its contract addresses were checked against.
- `/propose <target> <value> <data> <description>`: raw calldata, for anything else.
- `/vote <id> for|against|abstain [reason]` · `/queue <id>` · `/execute <id> [nativeValue]` · `/cancel <id>`
- `/switchmodel <model> [council or signers…] [description]`: move the DAO to another model (below).

## Money: allowances, the Distributor, raises and vaults

Built in `src/funds.js` (EVM) and `src/solana/funds.js` (Solana); the commands are in `src/platforms/commands/funds.js` and `src/solana/fundsCommands.js`. Design: `docs/contracts-roadmap-design.md`.

- `/allowance`: the treasury's monthly allowances. `grant <address> <amount> <token|native> <months>` (Solana: `sol`, `token` or a mint), `change <id> <amount> <months>` and `revoke <id>` are proposals; `claim <id>` is the recipient taking this month's payment. A month not claimed lapses; an allowance runs at most 12 months.
- `/distributor`: everything the DAO has promised someone. `open` makes it (anyone; the bot's operator runs it), then `fund <amount>`, `grant <address|@member> <amount> [cliff=<days>] [vest=<days>]` and `welcome <amount> <cap>` are proposals. A grant to a @member goes to their chat account, so they can claim it from whatever wallet the bot holds for them.
- `/claim`: takes what the Distributor holds for you: grants, a raise you joined, a welcome grant.
- `/welcome @member` (Telegram: reply to them): a council member approves a new member's welcome grant. When someone joins a group whose Distributor gives welcome grants, the bot asks the council to.
- `/raise`: the DAO's raise. `open <softCap> <hardCap> <days> <tokensForSale> [currency=<token>] [min=] [max=] [cliff=] [vest=] [decide=<days>]` (Solana: `open <currency mint> <softCap> <hardCap> <days|30m|12h> <tokensForSale>`), `accept <amount>` by proposal when it ends, `settle` once accepted. Contributions go past the hard cap; the DAO accepts anything from the soft cap up and everyone gets tokens and refunds pro rata.
- `/contribute <amount>` and `/refund`: join the raise; take back what wasn't accepted (everything if it didn't go ahead).
- `/vault`: a prop firm's vault, whose shares are the DAO's token. `deposit <amount>` and `redeem <shares>` are priced at the next window; `cancel` before it, `claim` after; `window` processes a due window. By proposal: `pause`, `resume`, `allow <address>`, and the venues it's valued from (EVM: `valuer hypercore` or `valuer perpl <desk> <marketIds>` per Perpl desk; Solana: `venues <perpAssetMap> <trader,...>`). On Solana `vault create <asset mint> [raise=1]` makes an existing DAO with no token supply a prop firm. A prop firm's `/desk` trades the vault's money (see trading.md).
- Delegate council seats: `/seats [election]`, `/declarecandidacy <election> [seat]`, `/voteinelection` with one candidate per seat, `/finalizeelection` (a tied seat is drawn by lot: run it again once the draw is in). `delegate-set-seat-label` (Solana: `seatlabel`) names a seat.

## Buttons and the help menu

- **Buttons under proposals,** on Telegram, Discord and Slack, for EVM and Solana DAOs alike. They come on the proposer's reply, on `/proposal <id>`, and on the listener's notices: a new proposal, a vote closing, a proposal queued, and model events like a challenge or a resolution (see [notifications](proposals-and-notifications.md#notifications-and-vote-charts)).
  - Each shows what fits the proposal's state at that moment:
    - **For / Against / Abstain:** token-weighted, quadratic, liquid, delegate and sortition councils, and optimistic once challenged
    - **Challenge:** optimistic, during its window
    - **Support:** conviction
    - **Confirm:** board
    - **Queue** once a vote has passed, **Execute** once it's queued
  - **Sowellian,** phase by phase:
    - approval vote: **For / Against / Abstain** (`castapprovalvote`), and **Close approval vote** once it can be
    - positions open: **Back YES / Back NO**, which ask how much (below)
    - once measurement is over: **Resolve from the oracle** on the oracle track, or **It worked / It didn't** on the human track to propose the outcome (asks first: it posts a bond). On EVM the contract's phase still reads Executed then, so the buttons check the measurement deadline against the chain's clock.
    - resolution proposed: **Challenge** (asks first: it posts a bond) or **Lock it in**
    - adjudicating: **It worked / It didn't** (`castadjudicationvote`) and **Close the vote**
    - resolved: **Claim winnings**
  - **Decision Markets:**
    - while trading: **Buy pass / Buy fail / Sell pass / Sell fail**, and **Split quote / Split tokens** to get pass and fail balances to trade with, all of which ask how much
    - once trading ends: **Settle markets**
    - once settled: **Redeem** (EVM: tokens and quote separately)
  - **"How much?"** A button that spends shows the presser a second message with **10% / 25% / 50% / All** of what they hold for it, read when they press, plus how to type any other amount. EVM trades carry a minimum out 1% under the pool's own quote (`getAmountOut`); Solana trades apply 1% themselves. With nothing to spend, it says how to get some (e.g. split first).
  - **"Are you sure?"** Proposing or challenging a Sowellian resolution posts a bond, so its button first explains that and asks.
  - These second messages go only to the presser on Discord and Slack; on Telegram they're posted in the group, addressed to the presser (a group bot can't show a message to one member).
  - Every proposal also gets **Status** and a **Details** link to its page. Once it's over (Defeated, Executed, Expired…) only those remain.
  - A button runs the same command as typing it, as whoever pressed it, with their own wallet and the same checks; the chat sees who pressed what. On Discord and Slack, errors (already voted, no stake) go only to the presser.
  - Only the commands listed in `BUTTON_COMMANDS` (`src/buttons.js`) can come from a button, so a forged button can't run anything else.
  - Still typed only: delegate elections (`declarecandidacy`, `voteinelection`), merging, and anything with an address.
  - Slack needs `interactivity` on in the app manifest (it is, in [`slack-app-manifest.yml`](slack-app-manifest.yml)).
- **`/help` is a menu:**
  - It opens with a line about the chat's DAO and a button per topic (Setup, Wallet, The DAO, Proposing, Deciding, Council, …), showing only what applies to the model.
  - A topic button swaps the message in place to that topic's commands, with a button back; **Everything** posts the whole list.
  - Typed, it's `/help <topic>` or `/help all`, on WhatsApp too.
  - On Discord and Slack, help is shown only to whoever asked.
- **Telegram's command menu** (the **/** button and autocomplete) is set at startup: the everyday commands in groups, a short list in private chats. Every other command still works typed.
- **Discord** registers its slash commands itself; **Slack** has the one `/protean` command from the manifest.

[Back to the README](../README.md)
