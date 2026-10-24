// Slack replies and how links look on every platform, without a chain or a workspace:
// the /protean handler is run with a stand-in command result and a fake Slack client, and
// what it would send Slack is checked - labelled links, plain addresses, the buttons under a
// proposal, the chart upload (joining the channel first when needed) and the note when the
// chart can't be posted. Also checks links.js's Telegram, Discord and WhatsApp forms, the
// explorer-link line, every model's buttons through its states, the amount and "are you sure"
// menus behind some of them (buttonMenus.js, against a stand-in chain) and buttons on
// listener notices.
//
// node --experimental-test-module-mocks --test scripts/test-slack.mjs
import { test, mock } from "node:test";
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..") + "/").href;
const at = (p) => new URL(p, root).href;

const { link, renderLinks, telegramLinks, addressLine } = await import(at("src/links.js"));
const { proposalButtons, BUTTON_COMMANDS, encodeButton, decodeButton } = await import(at("src/buttons.js"));
const { withTxTracking, trackTx, takeTxLinks } = await import(at("src/txLinks.js"));

const PAGE = "https://site.test/p/monad-testnet/0x1111111111111111111111111111111111111111/3";
const TX = "https://testnet.monadexplorer.com/tx/0xabc";
const WALLET = "0x2222222222222222222222222222222222222222";

let result;
const real = await import(at("src/platforms/commands.js"));
mock.module(at("src/platforms/commands.js"), { namedExports: { ...real, runCommand: async () => result } });
// A stand-in EVM chain for the amount menus: the DAO, its markets and the presser's balances.
const GOV = "0x1111111111111111111111111111111111111111";
const POOL = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x5555555555555555555555555555555555555555";
let chatModel = "sowellian";
let balance = 1234n * 10n ** 18n + 5n * 10n ** 17n; // 1234.5
const fakeChain = {
  async readContract({ functionName, args }) {
    switch (functionName) {
      case "governanceToken":
      case "underlying":
      case "token0":
      case "token1":
        return TOKEN;
      case "balanceOf":
        return balance;
      case "symbol":
        return "ARK";
      case "getAmountOut":
        return args[0] * 2n; // two out per one in
      default:
        throw new Error(`unexpected read ${functionName}`);
    }
  },
};
mock.module(at("src/config.js"), { namedExports: { ...(await import(at("src/config.js"))), publicClient: fakeChain } });
mock.module(at("src/walletResolver.js"), { namedExports: { ...(await import(at("src/walletResolver.js"))), getUserAddress: async () => WALLET } });
mock.module(at("src/governance/decisionMarkets.js"), {
  namedExports: { ...(await import(at("src/governance/decisionMarkets.js"))), getProposal: async () => ({ passPool: POOL, failPool: POOL }), getProposalVaults: async () => ({ baseVault: POOL, quoteVault: POOL }) },
});
mock.module(at("src/solana/commands.js"), { namedExports: { ...(await import(at("src/solana/commands.js"))), isSolanaChat: () => false } });
mock.module(at("src/db.js"), {
  namedExports: { ...(await import(at("src/db.js"))), recordSlackTeam() {}, getChatDAO: () => GOV, getChatModel: () => chatModel, getChatNetwork: () => "monad-testnet" },
});
const { buttonMenu, share } = await import(at("src/buttonMenus.js"));
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

const cmds = (rows) => rows.flat().filter((x) => x.cmd).map((x) => x.cmd);

test("buttons: Sowellian through its phases, on EVM and Solana", () => {
  const at3 = (state) => cmds(proposalButtons({ model: "sowellian", id: 3, state })).filter((c) => c !== "proposal 3");
  assert.deepStrictEqual(at3("ApprovalVoting"), ["castapprovalvote 3 for", "castapprovalvote 3 against", "castapprovalvote 3 abstain", "finalizeapproval 3"]);
  assert.deepStrictEqual(at3("ApprovalClosed"), ["finalizeapproval 3"]);
  assert.deepStrictEqual(at3("PositionsOpen"), ["ask amount takeposition 3 yes", "ask amount takeposition 3 no"]);
  for (const s of ["ResolutionPending", "AwaitingResolution"]) {
    assert.deepStrictEqual(at3(s), ["resolveviaoracle 3", "ask sure proposeresolution 3 success", "ask sure proposeresolution 3 failure"], s);
  }
  const tracked = (track) => cmds(proposalButtons({ model: "sowellian", id: 3, state: "ResolutionPending", track })).filter((c) => c !== "proposal 3");
  assert.deepStrictEqual(tracked("oracle"), ["resolveviaoracle 3"], "oracle track: settle from the oracle only");
  assert.deepStrictEqual(tracked("human"), ["ask sure proposeresolution 3 success", "ask sure proposeresolution 3 failure"], "human track: propose an outcome only");
  assert.deepStrictEqual(at3("ResolutionProposed"), ["ask sure challengeresolution 3", "finalizeunchallenged 3"]);
  assert.deepStrictEqual(at3("Adjudicating"), ["castadjudicationvote 3 success", "castadjudicationvote 3 failure", "finalizeadjudication 3"]);
  assert.deepStrictEqual(at3("Finalized"), ["claimposition 3"]);
  assert.deepStrictEqual(at3("Resolved"), ["claimposition 3"]);
  assert.deepStrictEqual(at3("Queued"), ["execute 3"], "Solana: positions closed, ready to run");
  assert.deepStrictEqual(at3("Measuring"), []);
});

test("buttons: decision markets trade, settle and redeem", () => {
  const dm = (state, solana = false) => cmds(proposalButtons({ model: "decisionMarkets", id: 3, state, solana })).filter((c) => c !== "proposal 3");
  const trading = ["ask amount trade 3 pass buy", "ask amount trade 3 fail buy", "ask amount trade 3 pass sell", "ask amount trade 3 fail sell", "ask amount split 3 quote", "ask amount split 3 base"];
  assert.deepStrictEqual(dm("new"), trading);
  assert.deepStrictEqual(dm("Trading", true), trading);
  assert.deepStrictEqual(dm("Open"), [...trading, "finalizeproposal 3"], "EVM Open also covers trading having ended");
  assert.deepStrictEqual(dm("TradingClosed", true), ["finalizeproposal 3"]);
  assert.deepStrictEqual(dm("Queued"), ["execute 3", "redeem 3 base", "redeem 3 quote"]);
  assert.deepStrictEqual(dm("Queued", true), ["execute 3", "redeem 3"]);
  assert.deepStrictEqual(dm("Failed"), ["redeem 3 base", "redeem 3 quote"]);
  assert.deepStrictEqual(dm("Defeated", true), ["redeem 3"]);
});

test("buttons: every payload fits Telegram's 64 bytes and only runs allowed commands", () => {
  const states = ["new", "Pending", "Active", "Succeeded", "Queued", "ChallengeWindow", "ApprovalVoting", "ApprovalClosed", "PositionsOpen", "ResolutionPending", "AwaitingResolution", "ResolutionProposed", "Adjudicating", "Finalized", "Resolved", "Open", "Trading", "TradingClosed", "Failed", "Defeated"];
  for (const model of ["tokenWeighted", "quadratic", "liquid", "optimistic", "delegate", "sortition", "conviction", "board", "sowellian", "decisionMarkets"]) {
    for (const state of states) {
      for (const solana of [false, true]) {
        for (const cmd of cmds(proposalButtons({ model, id: 99999, state, solana }))) {
          const decoded = decodeButton(encodeButton(cmd));
          assert.ok(decoded && BUTTON_COMMANDS.has(decoded[0]), `${model} ${state}: ${cmd}`);
        }
      }
    }
  }
  assert.deepStrictEqual(decodeButton("c:trade 3 pass quote 12.5 24.75"), ["trade", ["3", "pass", "quote", "12.5", "24.75"]]);
  assert.strictEqual(decodeButton("c:trade 3 pass; rm"), null);
});

const slackCtx = { platform: "slack", chatId: "C1", userId: "U1", cmd: (n) => `/protean ${n}` };

test("amount menu: shares of what you hold, as buttons that run the command", async () => {
  chatModel = "sowellian";
  balance = 1234n * 10n ** 18n + 5n * 10n ** 17n;
  assert.strictEqual(share(balance, 18, 25), "308.625");
  assert.strictEqual(share(1n, 18, 10), null, "too small to offer");
  const menu = await buttonMenu(slackCtx, ["amount", "takeposition", "3", "yes"]);
  assert.match(menu.text, /YES \(it works\)\* on proposal #3\? You have 1234\.5 ARK/);
  assert.match(menu.text, /\/protean takeposition 3 yes <amount>/);
  assert.deepStrictEqual(cmds(menu.buttons), ["takeposition 3 yes 123.45", "takeposition 3 yes 308.625", "takeposition 3 yes 617.25", "takeposition 3 yes 1234.5", "proposal 3"]);
  assert.deepStrictEqual(menu.buttons.flat().map((x) => x.label).slice(0, 4), ["10%: 123.45", "25%: 308.625", "50%: 617.25", "All: 1234.5"]);
});

test("amount menu: EVM trades carry a minimum out 1% under the pool's quote", async () => {
  chatModel = "decisionMarkets";
  balance = 100n * 10n ** 18n;
  const menu = await buttonMenu(slackCtx, ["amount", "trade", "3", "pass", "buy"]);
  // Buying spends the quote side; the stand-in pool pays 2 per 1, so 10 in -> 20 out, minimum 19.8.
  assert.deepStrictEqual(cmds(menu.buttons).slice(0, 4), ["trade 3 pass quote 10 19.8", "trade 3 pass quote 25 49.5", "trade 3 pass quote 50 99", "trade 3 pass quote 100 198"]);
  assert.match(menu.text, /at most 1% slippage/);
  const sell = await buttonMenu(slackCtx, ["amount", "trade", "3", "fail", "sell"]);
  assert.strictEqual(cmds(sell.buttons)[0], "trade 3 fail base 10 19.8");
  const split = await buttonMenu(slackCtx, ["amount", "split", "3", "quote"]);
  assert.strictEqual(cmds(split.buttons)[0], "split 3 quote 10");
});

test("amount menu: nothing to spend says how to get some", async () => {
  chatModel = "decisionMarkets";
  balance = 0n;
  const menu = await buttonMenu(slackCtx, ["amount", "trade", "3", "pass", "buy"]);
  assert.match(menu.text, /no pass quote tokens to spend\. Split some first: `\/protean split 3 quote <amount>`/);
  assert.deepStrictEqual(cmds(menu.buttons), ["proposal 3"]);
});

test("are-you-sure menu for actions that post a bond", async () => {
  const challenge = await buttonMenu(slackCtx, ["sure", "challengeresolution", "3"]);
  assert.match(challenge.text, /posts the DAO's challenge bond/);
  assert.strictEqual(cmds(challenge.buttons)[0], "challengeresolution 3");
  const propose = await buttonMenu(slackCtx, ["sure", "proposeresolution", "3", "failure"]);
  assert.match(propose.text, /didn't meet its goal\? This posts the DAO's resolution bond/);
  assert.strictEqual(cmds(propose.buttons)[0], "proposeresolution 3 failure");
  await assert.rejects(buttonMenu(slackCtx, ["sure", "send", "3"]), /doesn't do anything/);
});

test("Slack: an ask button shows its menu only to the presser", async () => {
  const sent = [];
  await slack.handleButton({
    ack: async () => {},
    body: { user: { id: "U1" }, channel: { id: "C1" } },
    action: { value: encodeButton("ask sure challengeresolution 3") },
    respond: async (m) => sent.push(m),
    client: fakeClient(),
  });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].response_type, "ephemeral");
  assert.deepStrictEqual(sent[0].blocks[1].elements.map((e) => e.value), [encodeButton("challengeresolution 3"), encodeButton("proposal 3")]);
});

test("Slack: listener notices carry their buttons", async () => {
  const posted = [];
  const notify = slack.createSlackNotify({ client: { chat: { postMessage: async (m) => posted.push(m) } } }, null);
  await notify("C1", `📝 New proposal #3 created.\n🔗 ${link("View transaction", TX)}`, { buttons: proposalButtons({ model: "tokenWeighted", id: 3, page: PAGE }) });
  assert.ok(posted[0].text.includes(`<${TX}|View transaction>`));
  assert.deepStrictEqual(posted[0].blocks[1].elements.map((e) => e.text.text), ["✅ For", "❌ Against", "➖ Abstain", "🔄 Status", "📄 Details"]);
});
