# Spin-up groups: design

Status: design only, nothing built yet. Agreed in conversation; review before any code.

## Goal

Escrow people, survey runners and launch teams (prop firms, businesses) can
spin up a group for what they're doing, on Telegram, Discord or Slack. The bot
does all the setup; the person does at most one or two clicks.

| Type | What the group is for | What the bot links it to |
|---|---|---|
| **Escrow** | The two sides of a deal and their arbitrators (at most 8 people) | The escrow ([escrow design](escrow-design.md)) |
| **Survey** | A private opportunity market among invited people | A private Opportunity Market (the private survey mode isn't built yet) |
| **Launch** | A whole community: a prop firm or a business | A new DAO, or a prop-firm DAO, through `/createdao` |

## The principle: every group lives in a space its users own

Escrow rooms, surveys and launches are never hosted in Protean's own server
or workspace. The users create the group, server or workspace, and invite the
bot. Reasons:

- **Trust.** An escrow room held by the platform operator is the opposite of
  what the parties want: Protean's admins could see and moderate everything.
- **Privacy.** Surveys are meant to be private.
- **No single point of failure.** A raided, mis-moderated or banned Protean
  server would take every escrow and survey down with it.
- **No moderation or liability** for what's said in other people's deals.
- **Slack's free plan** hides older messages; a deal record shouldn't depend
  on Protean's plan.
- **Discord's 10-server cap stops mattering.** A bot can only *create*
  servers while it's in fewer than 10, but it can be *invited* to any number.
  The user creates the server; the bot is only invited.

The trade-off: someone with no server of their own creates one before an
escrow starts. With a template link that's one or two clicks, and the guide
walks them through it.

## Why the bot can't simply create the groups

| Platform | Can a bot create the group? | What it can do |
|---|---|---|
| **Telegram** | No: the Bot API has no way to create a group or channel; only user accounts can. A "userbot" (a real account driven through the user API) could, but breaks Telegram's rules for automation and risks a ban. | A start-group link (`t.me/<bot>?startgroup=<token>&admin=<rights>`): one tap creates a group with the bot added as admin, and the token reaches the bot. Then it can set the title, description, permissions, pin messages, make invite links. |
| **Discord** | A bot can create a server (`POST /guilds`, or from a template) only while it's in fewer than 10 servers, and it then owns it. Unverified: whether it can hand ownership to a person and leave. | Create channels, private channels, threads, roles and invites in servers it's in (needs Manage Channels and Manage Roles, which the bot doesn't ask for yet). Users can make a server from our template in one click (`discord.new/<code>`). |
| **Slack** | No: apps can't create workspaces (only Enterprise Grid org admins can, inside their own org). | Create public and private channels in workspaces that installed the app (`conversations.create`, needs `channels:manage` and `groups:write`), invite members, set topics. Slack Connect channels need the other side to accept. |
| **WhatsApp** | **Yes, for small groups, through Meta's Cloud API Groups API:** at most 8 participants including the business number (so 7 people plus the bot), up to 10,000 groups per number. Needs an Official Business Account; the Cloud API, not Baileys. (Baileys, the unofficial library our WhatsApp bot uses, can also create groups as a normal account, with a userbot's ban risk: not used for this.) | Create the group, make its invite link, approve or reject each join request, remove participants. There's no direct add: people join through the link. Figures from [Unipile's guide](https://www.unipile.com/whatsapp-group-api/), to check against Meta's docs. |

## The flow

### One command everywhere

`/spinup <escrow|survey|launch> <name> [@members…]`, in a DM with the bot or in
any chat; or the same choices on the website.

1. The bot saves a pending room: type, name, members, who asked, and a
   one-time token.
2. It replies with the platform's one-tap link (below).
3. When the group exists with the bot inside, the token tells it which room
   this is. The bot then:
   - sets the name, description and permissions;
   - pins a welcome and the rules;
   - creates the invite link and DMs it to the members;
   - links the group to what it's for (escrow, private market, or a new DAO
     through `/createdao`).

### Per platform

| | Escrow, survey | Launch (prop firm, business) |
|---|---|---|
| **Telegram** | Start-group link: the user's own new group. | Same: a Telegram group is the community. |
| **Discord** | In a server the user already has: the bot creates a private channel there and invites the parties. With no server: our template link, then the bot-invite link carrying the token. | Template link (`discord.new/<code>`): a full server from our template, owned by the user. Then the bot-invite link carrying the token; after the user adds the bot, Discord sends them back to our web server with the server ID and token, and the bot adds the roles and channels (#proposals, #treasury, #trading). |
| **Slack** | A private channel in the user's own workspace (one that installed the app); the bot invites the parties. | The user creates the workspace on Slack's own page (no way around that step), then "Add to Slack" carrying the token; on install the bot creates the channels. |
| **WhatsApp** | Escrow (at most 7 people): **the bot creates the group** through the Groups API, DMs the invite link to each party and arbitrator, and approves join requests only from the invited numbers, so a leaked link lets nobody else in. Surveys of up to 7 the same way. | Bigger groups: the users create a normal WhatsApp group and add the bot. |

On WhatsApp the group is created by the bot's business number rather than the users, an exception to the principle above that's limited to small private groups: the bot is a member either way, and the members can't be added without their own tap on the link.

## The lobby: a guide, not a host

A public Protean Discord server and Slack workspace that the website sends
people to. It holds no deals and no survey data; it's a help desk and front
door.

- **Website → pick a platform and a type.**
  - **Telegram:** no lobby; the website shows the start-group link.
  - **Discord:** "Continue with Discord". Discord's login (the `guilds.join`
    scope) lets the bot add the person to the lobby straight away, and the
    request carries what they picked. Needs the bot in the lobby with
    permission to create invites, and a small login handler on the web
    server that already serves Slack installs and proposal pages.
  - **Slack:** a normal "join the Protean workspace" invite link (Slack can't
    add someone from a login); they pick a type once inside. "Sign in with
    Slack" can identify someone but can't add them to the workspace.
- **In the lobby,** the bot greets them with buttons (Escrow, Survey,
  Launch) and gives the one or two links for their own space, then watches it
  get set up. Discord's built-in onboarding (questions, roles, a start-here
  channel) covers much of the welcome.
- **Moderation:** a public lobby attracts spam, and Protean answers for it.
  Keep the welcome channel bot-only with buttons to act.
- **Slack caveats:** people expect to stay in their company's workspace;
  free-plan invite links expire and older messages are hidden (check the
  current plan limits).

## What's already there to build on

- Chat linking (`db.js`, Supabase `chat_links`): a group linked to a DAO,
  market or desk.
- The web server (Slack installs, proposal pages): the Discord invite
  redirect and login handler go here.
- Buttons and notices on every platform.
- `/createdao` and the prop-firm work for launch.

## Open decisions

1. ~~**What an escrow links to.**~~ Decided: a multisig escrow of its own,
   with the bot as the last signer and arbitrators ruling through it. See
   [escrow design](escrow-design.md).
2. **Who can spin up.** Anyone, or only verified escrow agents and launch
   partners? Setup costs gas, and on Telegram anyone can tap a link.
3. **Whether a public Slack lobby is worth it** for these users, given the
   plan limits.

## To check before building

- Telegram's start-group link: exactly which admin rights `admin=` grants.
- Discord's bot-invite redirect: that it returns the server ID with our
  token (`state`).
- Discord's `guilds.join` login adding a member to the lobby.
- Discord's current docs on bot-created servers (the 10-server cap, and
  ownership transfer).
- WhatsApp Groups API, against Meta's own docs: the 8-participant cap, join-request approval, whether interactive buttons work in groups, and template rules for messages outside the 24-hour window (deadline reminders).
- WhatsApp: applying for the Groups API and the Official Business Account (to do later), and running the Cloud API beside Baileys (two numbers) or moving the WhatsApp bot to the Cloud API. Cloud API messages are billed per conversation.

## Suggested build order

1. Telegram start-group flow (simplest, no lobby).
1b. WhatsApp: the bot creates small escrow and survey groups through the Groups API, once Meta approves the application (applying later). It's the only platform where the bot does every step, so it moves ahead of Discord and Slack once approved.
2. Discord: template + bot-invite flow, then the lobby with
   "Continue with Discord".
3. Slack: channel-in-workspace and Add to Slack flow; the lobby once its
   value is decided.
