// Slack replies and how links look on every platform, without a chain or a workspace:
// the /protean handler is run with a stand-in command result and a fake Slack client, and
// what it would send Slack is checked - labelled links, plain addresses, the buttons under a
// proposal, the chart upload (joining the channel first when needed) and the note when the
// chart can't be posted. Also checks links.js's Telegram, Discord and WhatsApp forms, the
// explorer-link line and every model's buttons.
//
// node --experimental-test-module-mocks --test scripts/test-slack.mjs
import { test, mock } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..") + "/").href;
const at = (p) => new URL(p, root).href;

const { link, renderLinks, telegramLinks, addressLine } = await import(at("src/links.js"));
const { proposalButtons, BUTTON_COMMANDS } = await import(at("src/buttons.js"));
const { withTxTracking, trackTx, takeTxLinks } = await import(at("src/txLinks.js"));

const PAGE = "https://site.test/p/monad-testnet/0x1111111111111111111111111111111111111111/3";
const TX = "https://testnet.monadexplorer.com/tx/0xabc";
const WALLET = "0x2222222222222222222222222222222222222222";

let result;
const real = await import(at("src/platforms/commands.js"));
mock.module(at("src/platforms/commands.js"), { namedExports: { ...real, runCommand: async () => result } });
mock.module(at("src/db.js"), { namedExports: { ...(await import(at("src/db.js"))), recordSlackTeam() {} } });
const slack = await import(at("src/platforms/slack.js"));
const { toDiscordMarkdown } = await import(at("src/platforms/discord.js"));

/** Runs `/protean <text>` against `client`, returning everything sent through respond(). */
async function slash(text, client) {
  const sent = [];
  await slack.handleSlashCommand({
    command: { text, channel_id: "C1", user_id: "U1", team_id: "T1", channel_name: "general" },
    ack: async () => {},
    respond: async (m) => sent.push(m),
    client,
  });
  return sent;
}

function fakeClient({ uploadErrors = [], joinError = null } = {}) {
  const calls = { uploads: 0, joins: 0 };
  return {
    calls,
    files: {
      uploadV2: async () => {
        calls.uploads++;
        const e = uploadErrors.shift();
        if (e) throw Object.assign(new Error(e), { data: { error: e } });
      },
    },
    conversations: {
      join: async () => {
        calls.joins++;
        if (joinError) throw Object.assign(new Error(joinError), { data: { error: joinError } });
      },
    },
  };
}

const proposalResult = () => ({
  text: `✅ Proposal #3 created via \`transfer\`.\nProposer: \`0x2222…2222\`\n\n📄 ${link("Proposal page", PAGE)} - the proposer is adding the details there.\n\n🔗 ${link("View transaction", TX)}`,
  buttons: proposalButtons({ model: "tokenWeighted", id: 3, page: PAGE }),
  image: { png: Buffer.from("png"), name: "proposal-3.png" },
  privateFollowUp: `📝 Add the details: ${link("open your edit page", PAGE + "?edit=tok")} (only you have this link).`,
});

test("links.js: one [label](url) form, shown each platform's way", () => {
  const text = `Hi 👋 ${link("View transaction", TX)} and ${link("Proposal page", PAGE)}`;
  assert.strictEqual(link("Proposal page", null), "Proposal page", "no URL: just the label");
  assert.strictEqual(renderLinks(text, "slack"), `Hi 👋 <${TX}|View transaction> and <${PAGE}|Proposal page>`);
  assert.strictEqual(renderLinks(text, "discord"), `Hi 👋 [View transaction](<${TX}>) and [Proposal page](<${PAGE}>)`);
  assert.strictEqual(renderLinks(text, "whatsapp"), `Hi 👋 View transaction: ${TX} and Proposal page: ${PAGE}`);
  assert.strictEqual(renderLinks(text, "telegram"), text, "Telegram's Markdown reads [label](url) itself");
  const tg = telegramLinks(text);
  assert.strictEqual(tg.text, "Hi 👋 View transaction and Proposal page");
  // 👋 is two UTF-16 units: "Hi 👋 " is 6.
  assert.deepStrictEqual(tg.entities, [
    { type: "text_link", offset: 6, length: 16, url: TX },
    { type: "text_link", offset: 27, length: 13, url: PAGE },
  ]);
  assert.strictEqual(telegramLinks("no links here"), null);
  assert.strictEqual(addressLine("Treasury", WALLET, "https://x.test/address/" + WALLET), `Treasury: \`${WALLET}\` · [explorer](https://x.test/address/${WALLET})`);
  assert.strictEqual(slack.slackText(addressLine("Treasury", WALLET, null)), `Treasury: ${WALLET}`, "Slack: no backticks");
  assert.strictEqual(toDiscordMarkdown(`*Bold* ${link("View transaction", TX)}`), `**Bold** [View transaction](<${TX}>)`);
});

test("explorer links: one transaction is 'View transaction', several are numbered", async () => {
  assert.strictEqual(await withTxTracking(async () => (trackTx(TX), takeTxLinks())), `\n\n🔗 [View transaction](${TX})`);
  const two = await withTxTracking(async () => (trackTx(TX), trackTx(TX + "2"), takeTxLinks()));
  assert.strictEqual(two, `\n\n🔗 Transactions: [1](${TX}) · [2](${TX}2)`);
});

test("buttons: every model that votes gets its vote buttons on a new proposal", () => {
  const first = (model) => proposalButtons({ model, id: 3 })[0].map((b) => b.cmd);
  for (const model of ["tokenWeighted", "quadratic", "liquid", "delegate", "sortition"]) {
    assert.deepStrictEqual(first(model), ["vote 3 for", "vote 3 against", "vote 3 abstain"], model);
  }
  assert.deepStrictEqual(first("sowellian"), ["castapprovalvote 3 for", "castapprovalvote 3 against", "castapprovalvote 3 abstain"]);
  assert.deepStrictEqual(proposalButtons({ model: "sowellian", id: 3, state: "ApprovalVoting" })[0].map((b) => b.cmd)[0], "castapprovalvote 3 for");
  assert.ok(BUTTON_COMMANDS.has("castapprovalvote"));
  assert.deepStrictEqual(first("optimistic"), ["challenge 3"]);
  assert.deepStrictEqual(first("conviction"), ["support 3"]);
  assert.deepStrictEqual(first("board"), ["confirm 3"]);
  // Once voting is over there's nothing to vote on: only Status (and Details).
  assert.deepStrictEqual(proposalButtons({ model: "tokenWeighted", id: 3, state: "Defeated" }).flat().map((b) => b.label), ["🔄 Status"]);
  assert.deepStrictEqual(proposalButtons({ model: "tokenWeighted", id: 3, state: "Succeeded" })[0].map((b) => b.cmd), ["queue 3"]);
});

test("slackText: labelled links, addresses without code formatting, commands kept as code", () => {
  const t = slack.slackText(`Wallet: \`${WALLET}\` · \`0x2222…2222\` · \`So1anaAddre55So1anaAddre55So1anaAddre55\` · run \`/protean vote 3 for\` · ${link("Proposal page", PAGE)}`);
  assert.strictEqual(t, `Wallet: ${WALLET} · 0x2222…2222 · So1anaAddre55So1anaAddre55So1anaAddre55 · run \`/protean vote 3 for\` · <${PAGE}|Proposal page>`);
});

test("/protean proposal reply: labelled links, vote buttons, chart, private edit link", async () => {
  result = proposalResult();
  const client = fakeClient();
  const sent = await slash("proposeaction transfer 1 0xabc test", client);
  assert.strictEqual(sent.length, 3, "working note, the reply, the private edit link");
  const [, reply, follow] = sent;
  assert.strictEqual(reply.response_type, "in_channel");
  assert.strictEqual(reply.unfurl_links, false);
  assert.ok(reply.text.includes(`<${PAGE}|Proposal page>`) && reply.text.includes(`<${TX}|View transaction>`), reply.text);
  assert.ok(!reply.text.includes("](") && reply.text.includes("Proposer: 0x2222…2222"), reply.text);
  assert.strictEqual(reply.blocks[0].text.text, reply.text);
  const buttons = reply.blocks[1].elements;
  assert.deepStrictEqual(buttons.map((b) => b.text.text), ["✅ For", "❌ Against", "➖ Abstain", "🔄 Status", "📄 Details"]);
  assert.deepStrictEqual(buttons.slice(0, 3).map((b) => b.value), ["c:vote 3 for", "c:vote 3 against", "c:vote 3 abstain"]);
  assert.strictEqual(buttons[4].url, PAGE);
  assert.strictEqual(client.calls.uploads, 1, "the chart is posted");
  assert.strictEqual(follow.response_type, "ephemeral");
  assert.ok(follow.text.includes(`<${PAGE}?edit=tok|open your edit page>`), follow.text);
});

test("chart: joins the channel when the app isn't in it, then posts", async () => {
  result = proposalResult();
  const client = fakeClient({ uploadErrors: ["not_in_channel"] });
  const sent = await slash("proposal 3", client);
  assert.strictEqual(client.calls.joins, 1);
  assert.strictEqual(client.calls.uploads, 2);
  assert.ok(!sent.some((m) => /chart couldn't/.test(m.text)), "nothing to report: it got posted");
});

test("chart: says why when it can't be posted", async () => {
  result = proposalResult();
  let sent = await slash("proposal 3", fakeClient({ uploadErrors: ["missing_scope"] }));
  assert.ok(sent.some((m) => m.response_type === "ephemeral" && /files:write or channels:join/.test(m.text)), "missing permission: reinstall");
  sent = await slash("proposal 3", fakeClient({ uploadErrors: ["not_in_channel"], joinError: "method_not_supported_for_channel_type" }));
  assert.ok(sent.some((m) => m.response_type === "ephemeral" && /\/invite @Protean DAO/.test(m.text)), "private channel: invite the app");
});

test("long replies go out as plain text, still with labelled links", async () => {
  result = { ...proposalResult(), text: "x".repeat(3100) + ` ${link("Proposal page", PAGE)}`, image: null, privateFollowUp: undefined };
  const [, reply] = await slash("proposal 3", fakeClient());
  assert.strictEqual(reply.blocks, undefined);
  assert.ok(reply.text.endsWith(`<${PAGE}|Proposal page>`));
});
