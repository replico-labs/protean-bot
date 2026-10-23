# Platforms

Every Telegram command also runs on Discord, Slack and WhatsApp, except `/start` (use `help`) and `/migratewallet` (legacy seed wallets only ever existed for Telegram IDs).
- Each platform runs as its own process, sharing the same `data/` volume, wallet store and chain config as the Telegram bot. None needs `TELEGRAM_BOT_TOKEN`.
- Command logic lives in `src/platforms/commands/`; `discord.js`, `slack.js` and `whatsapp.js` only handle transport.

```bash
npm run discord   # DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, optional DISCORD_GUILD_ID
npm run slack     # SLACK_APP_TOKEN + either SLACK_BOT_TOKEN (one workspace) or the "Add to Slack" settings below
npm run whatsapp  # WHATSAPP_LINK_SECRET (scan a QR) or WHATSAPP_PHONE_NUMBER (pairing code)
```

## On every platform

- **Privacy:** anything Telegram sends by DM is shown only to the caller: an ephemeral reply on Discord (which also hides the options typed), an ephemeral response on Slack, a DM on WhatsApp. That covers bets, confidential balances, rewards, handover proposals and the treasury address from `contribute`. So `back` takes its opportunity and amount directly; they never appear in the channel.
- **Linker vs creator:**
  - Whoever runs `register` becomes the channel's *linker*, who can relink and unlink.
  - Whoever runs `createdao`/`createboarddao` is the DAO's *creator*, who can also `tip`, deploy wrappers and deploy distributors.
  - Registering an existing DAO never grants creator rights.
- **Owners and admins only:** creating, registering and unregistering a DAO or market (`createdao`, `createboarddao`, `register`, `unregister`, `createmarket`, `registermarket`, `unregistermarket`) is limited to:
  - Telegram: the group's owner and admins. Anonymous admins count, and a DM is allowed.
  - Discord: members with *Manage Server*.
  - Slack: workspace admins and owners.
  - WhatsApp: group admins. A DM is allowed.
- **Errors** name the contract's reason, e.g. `AlreadyConfirmed`.

## Discord

- **Registers 62 native slash commands on startup** (Discord allows 100).
  - The specialist ones are subcommands of four group commands, with the same names as elsewhere: `/market …` (Opportunity Market, e.g. `/market back`), `/sowellian …`, `/decision-market …` and `/guard …`. The bot's replies on Discord name them that way.
  - Registration refuses to start with more than 100, so new commands get grouped rather than silently dropped.
- **Long replies** are split across messages.
- **Copied values:** backticks in pasted command values are dropped (Discord's Copy Text keeps them).
- **`/propose`'s fields** read target/value/data for EVM and recipient/amount/asset for Solana.

## Slack

- **One command:** `/protean <subcommand>`, e.g. `/protean vote 3 for`.
- **Creating the app:** use [`slack-app-manifest.yml`](slack-app-manifest.yml). It turns on interactivity for buttons and the `files:write` scope for charts.
- **Copied formatting** in arguments (backticks, code blocks, bold and italic, links, escapes) is stripped.
- **Welcome tokens:** joining a channel with a welcome distributor sends the newcomer their tokens, as on Telegram.
- **Any workspace:**
  - With `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` and `SLACK_PUBLIC_URL` set, the Slack process also serves an "Add to Slack" link at `<SLACK_PUBLIC_URL>/slack/install`. It listens on `PORT`, so the service needs a public domain.
  - Each workspace's bot token is stored encrypted under the wallets' KMS key, in Supabase's `slack_installations` table. Uninstalling deletes it.
  - Install into your own workspace through the same link, then activate public distribution.
  - Without `SLACK_CLIENT_ID`, it runs in one workspace on `SLACK_BOT_TOKEN`.
  - Slack doesn't list Socket Mode apps in its App Directory, so share the link directly.

## WhatsApp

WhatsApp runs through [Baileys](https://baileys.wiki/), an unofficial library that links the bot's own WhatsApp number as a linked device, like WhatsApp Web.
- **Using it:** commands are ordinary messages starting with `/` (e.g. `/vote 3 for`), in a group or a DM with the bot's number. One group links to one DAO. Add the number to a group like any contact.
- **Linking the number by QR:**
  1. Set `WHATSAPP_LINK_SECRET` to a long random string (e.g. `openssl rand -hex 32`) and leave `WHATSAPP_PHONE_NUMBER` unset.
  2. Open `https://<bot domain>/whatsapp/link?key=<WHATSAPP_LINK_SECRET>` on a computer or a second screen.
  3. On the bot's phone, go to *WhatsApp → Linked devices → Link a device* and scan it.

  The page follows WhatsApp's QR as it changes every 20 s and switches to "linked" once done. The bot draws the QR itself and never sends it to an outside service. Whoever scans it links *their* WhatsApp to the bot, so keep the link private. Wrong keys are rate limited.
- **Or by pairing code:** set `WHATSAPP_PHONE_NUMBER` (digits with country code, e.g. `2348012345678`) instead. The log prints a code; on the bot's phone open *Linked devices → Link a device → Link with phone number instead* and enter it. A code lasts about 2 minutes, and a new one follows. When the number is set, it's used instead of the QR.
- **Session:** saved in `data/whatsapp-auth/` (override with `WHATSAPP_AUTH_DIR`), so it must be on the persistent volume. Later restarts reconnect without scanning. If the device is unlinked from the phone, the saved session is cleared and linking starts again.
- **Wallets** are keyed to the member's WhatsApp LID (its privacy ID), not their phone number. So a wallet survives a number change, and the bot never stores numbers.
- **Private replies:** WhatsApp has nothing like ephemeral messages.
  - Results that are actually private go to the caller's DM, with a one-line pointer in the group: bets, confidential balances, rewards, handover proposals, the treasury address from `contribute`, a proposer's edit link.
  - Everything else is answered in the group, including errors, `help`, `wallet`, `listactions` and `actioninfo` (which Discord shows privately only to keep channels tidy).
  - If a DM can't be delivered, the bot asks the member to message it first.
- **No buttons:** WhatsApp has no bot buttons, so commands are typed there.
- **One process at a time:** only one process may use the linked session. A second one makes WhatsApp drop the first; the bot logs this and stops.
- **Timing:** commands from the same person run one at a time. Messages WhatsApp delivers more than 5 minutes late are ignored. Replies in groups with disappearing messages use the group's timer.
- **Risk:** Baileys is not an official WhatsApp API, and WhatsApp can ban numbers it judges to be automated. Use a dedicated number, not anyone's personal one. The bot only ever replies to commands, which keeps that risk low.

[Back to the README](../README.md)
