import { PublicKey } from "@solana/web3.js";
import * as v from "./vortex.js";

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
};
const LABEL = { tokenWeighted: "token-weighted", quadratic: "quadratic", optimistic: "optimistic", board: "board", conviction: "conviction", delegate: "delegate" };

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

/** The token a switch to a token model keeps: the DAO's own, or the one linked with it. */
function daoMint(c) {
  if (c.governance.mint) return c.governance.mint;
  if (c.link.mint) return new PublicKey(c.link.mint);
  return fail("This DAO has no token, so it can't switch to a token model from the bot yet. Switch to board or create a new DAO.");
}

/**
 * A switch: the hub's propose_switch, then the new model's setup in the
 * same proposal (the treasury signs as its authority and pays its rent).
 * Applies 2 days after it runs; the bot applies it then.
 */
function switchTo(model, extra) {
  return async (c) => {
    if (c.model === model) fail(`This DAO already runs on ${LABEL[model]}.`);
    if (c.d.record.pendingSwitch) fail("A switch is already pending. Cancel it first with the `cancelswitch` action.");
    const opts = { ...extra?.(c) };
    if (model !== "board") opts.mint = daoMint(c);
    const init = await v.initGovernanceIx(c.network, model, c.d.dao, c.d.treasury, c.d.treasury, opts);
    return {
      instructions: [await v.proposeSwitchIx(c.network, c.d, model), v.stored(init)],
      // The new model's accounts are paid from the treasury's SOL.
      budget: [{ mint: v.SOL_ASSET, amount: 100_000_000n }],
      summary: `switch this DAO to ${LABEL[model]} governance (same treasury), 2 days after it runs`,
    };
  };
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
  cancelswitch: {
    models: "all",
    args: [],
    about: "Call off a pending model switch before it applies.",
    async build(c) {
      if (!c.d.record.pendingSwitch) fail("No switch is pending.");
      return { instructions: [await v.cancelSwitchIx(c.network, c.d)], summary: "call off the pending model switch" };
    },
  },
};

export function actionApplies(action, model) {
  return action.models === "all" || action.models.includes(model);
}

/** `/listactions` for a Solana DAO of `model`. */
export function listActionsText(model, cmd) {
  const lines = [`*Actions for this ${LABEL[model]} DAO on Solana*`, ""];
  for (const [id, a] of Object.entries(ACTIONS)) {
    if (!actionApplies(a, model)) continue;
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
export function actionInfoText(id, model, cmd) {
  const a = ACTIONS[id];
  if (!a) return null;
  const lines = [`*${id}* — ${a.about}`];
  if (!actionApplies(a, model)) lines.push(`(Not available for this ${LABEL[model]} DAO.)`);
  if (a.args.length) lines.push("", ...a.args.map((x) => `\`${x.name}\` — ${x.about}`));
  lines.push("", `\`${cmd("proposeaction")} ${id}${a.args.length ? " " + a.args.map((x) => x.name).join(" ") : ""} <description>\``);
  return lines.join("\n");
}

export { MODEL_WORDS };
