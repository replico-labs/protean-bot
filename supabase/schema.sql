-- Run this once in your Supabase project's SQL editor (Database > SQL Editor)
-- before deploying the KMS-backed wallet system.

create table if not exists wallets (
  platform text not null,
  platform_user_id text not null,
  address text not null unique,
  encrypted_private_key text not null,
  encrypted_data_key text not null,
  iv text not null,
  auth_tag text not null,
  created_at timestamptz not null default now(),
  primary key (platform, platform_user_id)
);

-- Platform-aware from the start (platform, platform_user_id), not just
-- Telegram - Discord and Slack are expected to reuse this same table
-- later without a schema change, just a different `platform` value.

-- Defense in depth: enable Row Level Security with NO permissive
-- policies. This table should only ever be read or written by the bot's
-- backend, using the Supabase service_role key, which bypasses RLS by
-- design. Enabling RLS with no policies means that even if the public
-- anon key were ever leaked or misused, nobody could read or write a
-- single row through Supabase's client-facing API - only the service
-- role, held only by the backend, can touch this table at all.
alter table wallets enable row level security;

-- Slack: one row per workspace that installed the bot through
-- "Add to Slack" (only used when SLACK_CLIENT_ID is set). The whole
-- installation - including that workspace's bot token - is
-- envelope-encrypted under the same KMS key as the wallets above.
create table if not exists slack_installations (
  install_key text primary key,          -- "T:<team id>", or "E:<enterprise id>" for org-wide installs
  team_id text,
  enterprise_id text,
  encrypted_installation text not null,
  encrypted_data_key text not null,
  iv text not null,
  auth_tag text not null,
  updated_at timestamptz not null default now()
);

-- Same as wallets: RLS on with no policies, so only the backend's
-- service_role key can read or write it.
alter table slack_installations enable row level security;

-- Proposal pages: details a proposer writes on the website for each
-- proposal (see src/proposalPages.js). One row per proposal, created by
-- the bot when the proposal is made; the bot fills in the rest when the
-- proposer saves the form with their signed edit link.
create table if not exists proposal_details (
  network text not null,               -- networks.js id, e.g. "monad-testnet"
  dao text not null,                   -- governance address, lowercase
  proposal_id text not null,
  model text not null,
  chat_platform text,                  -- where it was proposed: telegram, discord, slack, whatsapp
  title text,
  summary text,
  body text,
  links jsonb not null default '[]',
  content_hash text,                   -- sha256 of the saved details
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (network, dao, proposal_id)
);

-- Same as the tables above: only the bot's service_role key reads or
-- writes it. The website reads through the bot's API, never directly.
alter table proposal_details enable row level security;
