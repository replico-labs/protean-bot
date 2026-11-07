import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as v from "./vortex.js";
import { INTEGRATION_ACTIONS } from "./integrations/index.js";
import { FUNDS_ACTIONS } from "./fundsActions.js";

/**
 * Verified actions a Solana DAO can propose with /proposeaction - the
 * Solana counterpart of actionLibrary.js. Every instruction is built from
 * the Vortexes programs' IDLs (or SPL Token's own builders) in vortex.js,
 * so nothing here encodes bytes by hand.
 *
 * Each action: { models, args: [{ name, about }], about, build(ctx) },
 * where build gets { network, d, model, governance, link, args } and
 * returns { instructions, budget?, summary }.
 */

const MODEL_WORDS = {
  tokenweighted: "tokenWeighted",
  quadratic: "quadratic",
  optimistic: "optimistic",
  conviction: "conviction",
  board: "board",
  delegate: "delegate",
  liquid: "liquid",
  sortition: "sortition",
  sowellian: "sowellian",
  decisionmarkets: "decisionMarkets",
  futarchy: "decisionMarkets",
};
const LABEL = {
  tokenWeighted: "token-weighted",
  quadratic: "quadratic",
  optimistic: "optimistic",
  board: "board",
  conviction: "conviction",
  delegate: "delegate",
  liquid: "liquid",
  sortition: "sortition",
  sowellian: "Sowellian",
  decisionMarkets: "decision markets",
};

const fail = (msg) => {
  throw Object.assign(new Error(msg), { userFacing: true });
};

function key(text, what) {
  try {
    return new PublicKey(text);
  } catch {
    return fail(`"${text}" isn't a Solana address (${what}).`);
  }
}

/** "a,b,c" -> distinct keys. */
function keyList(text, what) {
  const keys = String(text ?? "").split(",").filter(Boolean).map((k) => key(k, what));
  if (keys.length === 0) fail(`Give at least one ${what}, comma-separated.`);
  if (new Set(keys.map((k) => k.toBase58())).size !== keys.length) fail(`The same ${what} is listed twice.`);
  return keys;
}

/**
 * The token a switch to a token model keeps: the one on record at the hub,
 * else (DAOs created before the record existed) the DAO's own or the one
 * linked with it, which the switch then records. `recorded` says which.
 */
async function daoMint(c) {
  const recorded = await v.readDaoToken(c.network, c.d.dao);
  if (recorded) return { mint: recorded, recorded: true };
  return fail("This DAO has no token on record, so a token model has nothing to vote with. Give it one first: the `settoken` action (an existing token's mint, or `new <supply>` for a new one).");
}

/**
 * A switch: the hub's propose_switch, then the new model's setup in the
 * same proposal (the treasury signs as its authority and pays its rent).
 * Applies 2 days after it runs; the bot applies it then.
 */
function switchTo(model, extra) {
  return async (c) => {
    if (c.d.record.pendingSwitch) fail("A switch is already pending. Cancel it first with the `cancelswitch` action.");
    // Every switch sets up a fresh governance for the next epoch: another
    // model, or a fresh copy of this one (new rules, signers or council).
    const opts = { ...extra?.(c), epoch: c.d.record.epoch + 1 };
    if (model !== "board") opts.mint = (await daoMint(c)).mint;
    const init = await v.initGovernanceIx(c.network, model, c.d.dao, c.d.treasury, c.d.treasury, opts);
    const same = c.model === model;
    return {
      instructions: [await v.proposeSwitchIx(c.network, c.d, model), v.stored(init)],
      // The new model's accounts are paid from the treasury's SOL.
      budget: [{ mint: v.SOL_ASSET, amount: 100_000_000n }],
      summary: `${same ? `start a fresh ${LABEL[model]} setup for this DAO` : `switch this DAO to ${LABEL[model]} governance`} (same treasury${opts.mint ? `, token \`${opts.mint.toBase58()}\` and everyone's stake` : ""}), 2 days after it runs${c.d.record.council ? "; the security council confirms it first" : ""}`,
    };
  };
}

/** `rate=N:D` (N new tokens per D old; `rate=N` means N:1), or null. */
function parseRate(text) {
  if (!text) return null;
  const m = String(text).match(/^(\d+)(?::(\d+))?$/);
  if (!m || BigInt(m[1]) === 0n || (m[2] && BigInt(m[2]) === 0n)) fail("rate= is new tokens per old, as whole numbers: rate=1 (one for one), rate=2:1 or rate=1:10.");
  return { num: BigInt(m[1]), den: BigInt(m[2] ?? "1") };
}

export const ACTIONS = {
  transfersol: {
    models: "all",
    args: [
      { name: "<amount>", about: "SOL, e.g. 0.5" },
      { name: "<recipient>", about: "a Solana address" },
    ],
    about: "Pay SOL from the treasury (the same as `propose <recipient> <amount> SOL`).",
    async build(c) {
      const [amount, to] = c.args;
      const recipient = key(to, "the recipient");
      const raw = v.parseUnits(amount, 9);
      const { instructions, budget } = await v.paymentInstructions(c.network, c.d, { recipient, raw });
      return { instructions, budget, summary: `pay ${v.formatUnits(raw, 9)} SOL to \`${recipient.toBase58()}\`` };
    },
  },

  transfertoken: {
    models: "all",
    args: [
      { name: "<token>", about: "`token` for this DAO's own token, or any token's mint address" },
      { name: "<amount>", about: "whole tokens, e.g. 100 or 2.5" },
      { name: "<recipient>", about: "a Solana address (the treasury opens their token account if needed)" },
    ],
    about: "Pay tokens from the treasury (the same as `propose <recipient> <amount> <token>`).",
    async build(c) {
      const [token, amount, to] = c.args;
      const own = token.toLowerCase() === "token";
      if (own && !c.governance.mint) fail("A board DAO has no token of its own - give the token's mint address instead.");
      const mint = own ? c.governance.mint : key(token, "the token's mint");
      const { decimals } = await v.mintInfo(c.network, mint);
      const recipient = key(to, "the recipient");
      const raw = v.parseUnits(amount, decimals);
      const { instructions, budget } = await v.paymentInstructions(c.network, c.d, { recipient, raw, mint });
      const label = own || (c.governance.mint && mint.equals(c.governance.mint)) ? c.link.symbol ?? "tokens" : `of token \`${mint.toBase58()}\``;
      return { instructions, budget, summary: `pay ${v.formatUnits(raw, decimals)} ${label} to \`${recipient.toBase58()}\`` };
    },
  },

  mint: {
    models: v.TOKEN_MODELS,
    args: [
      { name: "<amount>", about: "whole tokens, e.g. 1000 or 2.5" },
      { name: "<recipient>", about: "a Solana address, or `treasury`" },
    ],
    about: "Mint new DAO tokens (the treasury is the token's mint authority for DAOs the bot created).",
    async build(c) {
      const [amount, to] = c.args;
      const mint = c.governance.mint;
      const { decimals } = await v.mintInfo(c.network, mint);
      const recipient = to.toLowerCase() === "treasury" ? c.d.treasury : key(to, "the recipient");
      const raw = v.parseUnits(amount, decimals);
      const { instructions, budget } = await v.mintInstructions(c.network, c.d, { mint, recipient, raw });
      return { instructions, budget, summary: `mint ${v.formatUnits(raw, decimals)} new ${c.link.symbol ?? "tokens"} to \`${recipient.toBase58()}\`` };
    },
  },

  addsigner: {
    models: ["board"],
    args: [{ name: "<address>", about: "the new signer's Solana address" }],
    about: "Add a board signer.",
    async build(c) {
      const signer = key(c.args[0], "the signer");
      if (c.governance.signers.some((s) => s.equals(signer))) fail("They're already a signer.");
      return { instructions: [await v.boardIx(c.network, c.d, "addSigner", signer)], summary: `add \`${signer.toBase58()}\` as a signer` };
    },
  },

  removesigner: {
    models: ["board"],
    args: [{ name: "<address>", about: "the signer to remove" }],
    about: "Remove a board signer (the board must keep at least as many signers as confirmations it needs).",
    async build(c) {
      const signer = key(c.args[0], "the signer");
      if (!c.governance.signers.some((s) => s.equals(signer))) fail("They aren't a signer.");
      return { instructions: [await v.boardIx(c.network, c.d, "removeSigner", signer)], summary: `remove signer \`${signer.toBase58()}\`` };
    },
  },

  setapprovals: {
    models: ["board"],
    args: [{ name: "<count>", about: "how many signers must confirm" }],
    about: "Change how many signers must confirm a proposal (the timelock and execution window stay).",
    async build(c) {
      const n = Number(c.args[0]);
      if (!Number.isInteger(n) || n < 1 || n > c.governance.signers.length) fail(`The count must be a whole number from 1 to ${c.governance.signers.length}.`);
      const config = { ...c.governance.config, requiredApprovals: n };
      return { instructions: [await v.boardIx(c.network, c.d, "updateConfig", config)], summary: `require ${n} of ${c.governance.signers.length} signers to confirm` };
    },
  },

  addasset: {
    models: ["conviction"],
    args: [
      { name: "<mint>", about: "the token's mint address" },
      { name: "<weight>", about: "conviction added for spending all of it, in DAO tokens" },
    ],
    about: "Protect another token with spending budgets: proposals then need more conviction the more of it they spend.",
    async build(c) {
      const mint = key(c.args[0], "the token's mint");
      await v.mintInfo(c.network, mint);
      if (c.governance.assets.some((a) => a.mint.equals(mint))) fail("That token is already listed.");
      const { decimals } = await v.mintInfo(c.network, c.governance.mint);
      const weight = v.parseUnits(c.args[1], decimals);
      return { instructions: [await v.addAssetIx(c.network, c.d, mint, weight)], summary: `list token \`${mint.toBase58()}\` with weight ${v.formatUnits(weight, decimals)}` };
    },
  },

  switchtokenweighted: { models: "all", args: [], about: "Switch to token-weighted voting, keeping the treasury and token.", build: switchTo("tokenWeighted") },
  switchquadratic: { models: "all", args: [], about: "Switch to quadratic voting, keeping the treasury and token.", build: switchTo("quadratic") },
  switchoptimistic: { models: "all", args: [], about: "Switch to optimistic governance, keeping the treasury and token.", build: switchTo("optimistic") },
  switchconviction: { models: "all", args: [], about: "Switch to conviction voting with spending budgets, keeping the treasury and token.", build: switchTo("conviction") },
  switchboard: {
    models: "all",
    args: [{ name: "<signer,signer,...>", about: "the board's Solana addresses, comma-separated" }],
    about: "Switch to a board (multisig) of these signers, keeping the treasury.",
    build: switchTo("board", (c) => ({ signers: keyList(c.args[0], "signer") })),
  },
  switchdelegate: {
    models: "all",
    args: [{ name: "<member,member,...>", about: "the first council's Solana addresses, comma-separated" }],
    about: "Switch to an elected council, starting with these members, keeping the treasury and token.",
    build: switchTo("delegate", (c) => ({ council: keyList(c.args[0], "council member") })),
  },
  switchliquid: { models: "all", args: [], about: "Switch to liquid voting (members can delegate their vote), keeping the treasury and token.", build: switchTo("liquid") },
  switchsortition: {
    models: "all",
    args: [{ name: "<member,member,...>", about: "the first council's Solana addresses, comma-separated (later councils of the same size are drawn by lot)" }],
    about: "Switch to a council drawn by lot, starting with these members, keeping the treasury and token.",
    build: switchTo("sortition", (c) => ({ council: keyList(c.args[0], "council member") })),
  },
  switchsowellian: { models: "all", args: [], about: "Switch to Sowellian governance (approval vote, YES/NO positions, measured outcomes), keeping the treasury and token.", build: switchTo("sowellian") },
  switchdecisionmarkets: { models: "all", args: [], about: "Switch to decision markets (pass/fail markets against SOL decide), keeping the treasury and token.", build: switchTo("decisionMarkets") },
  settoken: {
    models: "all",
    args: [{ name: "<mint|new:supply>", about: "the token's mint address, or `new:<supply>` for a new token (its whole supply minted to the treasury, which alone can mint more)" }],
    options: ["rate", "fund"],
    about: "Change the DAO's token without changing its governance: new proposals vote with the new token's stake, open ones keep the old. Works on any model, board included. Add `rate=N:D` (N new per D old) and `fund=<amount>` anywhere to open a converter members swap their old stake through.",
    async build(c) {
      const first = String(c.args[0]);
      const options = c.options ?? {};
      let mint;
      let known = null;
      let prepare;
      if (first.toLowerCase().startsWith("new:")) {
        // A new mint, created (by the operator, its supply to the treasury) only once the proposer may propose.
        const supply = first.slice(4);
        if (!/^\d+$/.test(supply) || BigInt(supply) === 0n) fail("`new:<supply>`: the new token's supply in whole tokens, e.g. `new:1000000`.");
        const mintKeypair = Keypair.generate();
        mint = mintKeypair.publicKey;
        known = { decimals: v.TOKEN_DECIMALS, programId: TOKEN_PROGRAM_ID };
        prepare = async () => {
          await v.createTokenForTreasury(c.network, c.d, supply, mintKeypair);
        };
      } else {
        mint = key(first, "the token's mint");
        await v.mintInfo(c.network, mint);
      }
      const created = Boolean(known);
      const current = await v.readDaoToken(c.network, c.d.dao);
      if (current?.equals(mint)) fail("That's already the DAO's token.");
      const instructions = [];
      // Its stake pool: anyone may open one (it does nothing until the DAO points at it), so the operator opens it
      // when the proposal is made rather than inside it, which keeps the proposal within one transaction.
      const makeMint = prepare;
      prepare = async ({ operator, send }) => {
        if (makeMint) await makeMint();
        if (!(await c.network.connection.getAccountInfo(c.d.poolOf(mint)))) await send([await v.createPoolIx(c.network, c.d.dao, operator, mint, known?.programId)]);
      };
      instructions.push(v.stored(await v.setDaoTokenIx(c.network, c.d.dao, c.d.gp, c.d.treasury, c.d.treasury, mint, c.d.record.epoch)));
      const rate = parseRate(options.rate);
      let converterLine = "";
      if (rate) {
        if (!current) fail("There's no old token to convert from.");
        const raw = options.fund ? v.parseUnits(options.fund, (known ?? (await v.mintInfo(c.network, mint))).decimals) : 0n;
        instructions.push(await v.openConverterIx(c.network, c.d, current, mint, rate.num, rate.den, raw, known?.programId));
        converterLine = raw > 0n ? `; opens a converter (${rate.num}:${rate.den}) funded with ${v.formatUnits(raw, (known ?? (await v.mintInfo(c.network, mint))).decimals)} new tokens` : `; opens a converter (${rate.num}:${rate.den}) to fund later`;
      } else if (options.fund) fail("fund= goes with rate=.");
      return {
        instructions,
        prepare,
        budget: [{ mint: v.SOL_ASSET, amount: 10_000_000n }],
        // A legacy transaction holds the token change and its converter with a short description only.
        oversize: rate
          ? (room) =>
              `The token change and its converter don't fit in one Solana transaction with that description${room > 0 ? `: keep it under ${room} characters` : ""}. Or leave \`rate=\` out and, once the change has executed, propose the converter on its own: \`/proposeaction openconverter ${current.toBase58()} rate=${options.rate}${options.fund ? ` fund=${options.fund}` : ""} <description>\`.`
          : null,
        summary:
          (current ? `change the DAO's token from \`${current.toBase58()}\` to \`${mint.toBase58()}\`` : `give the DAO the token \`${mint.toBase58()}\``) +
          (created ? " (a new token; its supply is already in the treasury)" : "") +
          converterLine,
      };
    },
  },
  openconverter: {
    models: "all",
    args: [{ name: "<old mint>", about: "the old token the converter takes" }],
    options: ["rate", "fund"],
    about: "Open a converter from an old token into the current one, at `rate=N:D` (N new per D old), funded with `fund=<amount>` new tokens from the treasury. Members then swap their old stake with /convert.",
    async build(c) {
      const from = key(c.args[0], "the old token's mint");
      const options = c.options ?? {};
      const rate = parseRate(options.rate);
      if (!rate) fail("Give the rate: `rate=N:D`, N new tokens per D old, e.g. `rate=1:1`.");
      const current = await v.readDaoToken(c.network, c.d.dao);
      if (!current) fail("This DAO has no token yet.");
      if (current.equals(from)) fail("That's the DAO's current token: a converter takes an old one.");
      if (!(await c.network.connection.getAccountInfo(c.d.poolOf(from)))) fail("That token was never this DAO's: it has no stake pool here.");
      const existing = await v.readConverter(c.network, c.d, from, current);
      if (existing?.open) fail("There's already a converter from that token: top it up with `fundconverter`.");
      if (existing) fail("The converter from that token was closed, and a closed one can't be reopened.");
      const { decimals, programId } = await v.mintInfo(c.network, current);
      const raw = options.fund ? v.parseUnits(options.fund, decimals) : 0n;
      return {
        instructions: [await v.openConverterIx(c.network, c.d, from, current, rate.num, rate.den, raw, programId)],
        budget: [{ mint: v.SOL_ASSET, amount: 5_000_000n }],
        summary: `open a converter from \`${from.toBase58()}\` into the current token (${rate.num}:${rate.den})${raw > 0n ? `, funded with ${v.formatUnits(raw, decimals)} from the treasury` : ", to fund later"}`,
      };
    },
  },
  fundconverter: {
    models: "all",
    args: [
      { name: "<old mint>", about: "the old token the converter takes" },
      { name: "<amount>", about: "how many current tokens to add from the treasury" },
    ],
    about: "Top up the converter from an old token with current tokens from the treasury.",
    async build(c) {
      const from = key(c.args[0], "the old token's mint");
      const current = await v.readDaoToken(c.network, c.d.dao);
      const conv = current && (await v.readConverter(c.network, c.d, from, current));
      if (!conv?.open) fail("There's no open converter from that token into the current one.");
      const info = await v.mintInfo(c.network, current);
      const raw = v.parseUnits(String(c.args[1]), info.decimals);
      if (raw <= 0n) fail("Give an amount above 0.");
      return {
        instructions: [await v.fundConverterIx(c.network, c.d, from, current, raw, info)],
        summary: `add ${v.formatUnits(raw, info.decimals)} to the converter from \`${from.toBase58()}\``,
      };
    },
  },
  closeconverter: {
    models: "all",
    args: [{ name: "<old mint>", about: "the old token the converter takes" }],
    about: "Close the converter from an old token into the current one; what's left in it goes back to the treasury.",
    async build(c) {
      const from = key(c.args[0], "the old token's mint");
      const current = await v.readDaoToken(c.network, c.d.dao);
      const conv = current && (await v.readConverter(c.network, c.d, from, current));
      if (!conv?.open) fail("There's no open converter from that token into the current one.");
      return { instructions: [await v.closeConverterIx(c.network, c.d, from, current)], summary: `close the converter from \`${from.toBase58()}\` (what's left returns to the treasury)` };
    },
  },
  councilon: {
    models: "all",
    args: [
      { name: "<signer,signer,...>", about: "the council's Solana addresses, comma-separated (up to 10)" },
      { name: "<required>", about: "how many must confirm each passed proposal" },
      { name: "<tenure-days>", about: "days before the DAO can replace them without their confirmation" },
    ],
    about: "Put a security council in front of the treasury: every passed proposal then waits for it. It belongs to the DAO, so it stays through model switches. With a council already on, this replaces it (the council confirms, or after its tenure anyone can run it).",
    async build(c) {
      const signers = keyList(c.args[0], "council signer");
      if (signers.length > 10) fail("A council has at most 10 signers.");
      const required = Number(c.args[1]);
      if (!Number.isInteger(required) || required < 1 || required > signers.length) fail(`<required> must be a whole number from 1 to ${signers.length}.`);
      const days = Number(c.args[2]);
      if (!Number.isFinite(days) || days < 0) fail("<tenure-days> must be a number of days, e.g. 90.");
      const replacing = Boolean(c.d.record.council);
      return {
        instructions: [await v.setCouncilIx(c.network, c.d, signers, required, Math.round(days * 86_400))],
        summary: `${replacing ? "replace the security council with" : "turn on a security council of"} ${signers.length} (${required} must confirm each passed proposal; replaceable without them after ${days} days)`,
      };
    },
  },
  counciloff: {
    models: "all",
    args: [],
    about: "Turn the security council off. The council itself must confirm this proposal; if it won't, replace its signers once their tenure ends (`councilon`) first.",
    async build(c) {
      if (!c.d.record.council) fail("This DAO has no security council.");
      return { instructions: [await v.clearCouncilIx(c.network, c.d)], summary: "turn the security council off" };
    },
  },
  cancelswitch: {
    models: "all",
    args: [],
    about: "Call off a pending model switch before it applies.",
    async build(c) {
      if (!c.d.record.pendingSwitch) fail("No switch is pending.");
      return { instructions: [await v.cancelSwitchIx(c.network, c.d)], summary: "call off the pending model switch" };
    },
  },

  // Allowances, the Distributor, raises, the prop-firm vault, seat labels (src/solana/fundsActions.js).
  ...FUNDS_ACTIONS,

  // Protocol integrations (src/solana/integrations): staking, lending, trading.
  ...INTEGRATION_ACTIONS,
};

/** Whether `action` applies to a `model` DAO, on `network` if given (protocol actions exist only where the protocol is). */
export function actionApplies(action, model, network) {
  if (network && action.networks && !action.networks.includes(network.id)) return false;
  if (network && action.needsV1Transactions && !network.v1Transactions) return false;
  if (network && action.needsFillProgram && !network.fillProgram) return false;
  return action.models === "all" || action.models.includes(model);
}

/** `/listactions` for a Solana DAO of `model`. */
export function listActionsText(model, cmd, network) {
  const lines = [`*Actions for this ${LABEL[model]} DAO on Solana*`, ""];
  for (const [id, a] of Object.entries(ACTIONS)) {
    if (!actionApplies(a, model, network)) continue;
    lines.push(`\`${id}${a.args.length ? " " + a.args.map((x) => x.name).join(" ") : ""}\` — ${a.about}`);
  }
  lines.push(
    "",
    `Propose one: \`${cmd("proposeaction")} <action> <args...> <description>\`. Details: \`${cmd("actioninfo")} <action>\`.`,
    `Payments also work with \`${cmd("propose")}\`. A model switch applies 2 days after its proposal runs; the bot applies it then.`
  );
  return lines.join("\n");
}

/** `/actioninfo <id>`, or null for an unknown action. */
export function actionInfoText(id, model, cmd, network) {
  const a = ACTIONS[id];
  if (!a) return null;
  const lines = [`*${id}* — ${a.about}`];
  if (!actionApplies(a, model, network)) lines.push(`(Not available for this ${LABEL[model]} DAO${network && a.networks && !a.networks.includes(network.id) ? ` on ${network.name}` : ""}.)`);
  if (a.args.length) lines.push("", ...a.args.map((x) => `\`${x.name}\` — ${x.about}`));
  lines.push("", `\`${cmd("proposeaction")} ${id}${a.args.length ? " " + a.args.map((x) => x.name).join(" ") : ""} <description>\``);
  return lines.join("\n");
}

export { MODEL_WORDS };
