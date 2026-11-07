import { PublicKey } from "@solana/web3.js";
import * as v from "./vortex.js";
import * as sf from "./funds.js";

/**
 * Proposal actions for a Solana DAO's money (src/solana/funds.js builds
 * them): allowances, the Distributor, accepting a raise, the prop-firm
 * vault and council seat labels. Same shape as src/solana/actions.js.
 */

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
const whole = (text, what) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) fail(`${what} must be a whole number.`);
  return n;
};

/** `sol` (None) or a mint: { mint | null, decimals, label }. */
async function asset(c, word) {
  const w = String(word ?? "").toLowerCase();
  if (w === "sol") return { mint: null, decimals: 9, label: "SOL" };
  if (w === "token") {
    if (!c.governance.mint) fail("This DAO has no token of its own - give a mint address.");
    return { mint: c.governance.mint, decimals: (await v.mintInfo(c.network, c.governance.mint)).decimals, label: c.link.symbol ?? "tokens" };
  }
  const mint = key(word, "the token's mint");
  return { mint, decimals: (await v.mintInfo(c.network, mint)).decimals, label: `of \`${mint.toBase58()}\`` };
}

async function daoMint(c) {
  const mint = (await v.readDaoToken(c.network, c.d.dao)) ?? c.governance.mint;
  if (!mint) fail("This DAO has no token.");
  return mint;
}

/** fees=<address>:<bps>,<address>:<bps> (adding up to 10000), or none. */
function feeSplits(text) {
  if (!text) return [];
  const splits = String(text)
    .split(",")
    .map((part) => {
      const [who, bps] = part.split(":");
      return { recipient: key(who, "a fee recipient"), bps: whole(bps, "Each fee share (in basis points)") };
    });
  if (splits.reduce((n, s) => n + s.bps, 0) !== 10_000) fail("fees= shares add up to 10000 (basis points).");
  return splits;
}

export const FUNDS_ACTIONS = {
  allowancegrant: {
    models: "all",
    args: [
      { name: "<recipient>", about: "a Solana address" },
      { name: "<amount>", about: "paid each month, e.g. 500" },
      { name: "<asset>", about: "`sol`, `token` (this DAO's) or a mint address" },
      { name: "<months>", about: "1 to 12" },
    ],
    about: "A monthly allowance: the recipient claims `amount` from the treasury once every 30 days until it ends; a month not claimed lapses.",
    async build(c) {
      const [to, amount, which, months] = c.args;
      const recipient = key(to, "the recipient");
      const a = await asset(c, which);
      const raw = v.parseUnits(amount, a.decimals);
      const { instruction, id, endsAt } = await sf.allowanceGrantIx(c.network, c.d, { recipient, mint: a.mint, amount: raw, months: whole(months, "<months>") });
      return {
        instructions: [instruction],
        budget: [{ mint: v.SOL_ASSET, amount: 3_000_000n }],
        summary: `pay \`${recipient.toBase58()}\` ${v.formatUnits(raw, a.decimals)} ${a.label} a month until ${new Date(endsAt * 1000).toUTCString()} (allowance #${id}; it claims each month with \`allowance claim ${id}\`)`,
      };
    },
  },
  allowancechange: {
    models: "all",
    args: [
      { name: "<id>", about: "the allowance" },
      { name: "<amount>", about: "the new monthly amount" },
      { name: "<months>", about: "how long from now, 1 to 12" },
    ],
    about: "Change an allowance's monthly amount and end. The month already paid stays paid.",
    async build(c) {
      const id = whole(c.args[0], "<id>");
      const list = await sf.listAllowances(c.network, c.d);
      const a = list.find((x) => x.id === id);
      if (!a) fail(`There's no allowance #${id}.`);
      const decimals = a.mint ? (await v.mintInfo(c.network, a.mint)).decimals : 9;
      const raw = v.parseUnits(c.args[1], decimals);
      return { instructions: [await sf.allowanceChangeIx(c.network, c.d, id, raw, whole(c.args[2], "<months>"))], summary: `make allowance #${id} ${v.formatUnits(raw, decimals)} a month for ${c.args[2]} months from now` };
    },
  },
  allowancerevoke: {
    models: "all",
    args: [{ name: "<id>", about: "the allowance" }],
    about: "End an allowance.",
    async build(c) {
      const id = whole(c.args[0], "<id>");
      return { instructions: [await sf.allowanceRevokeIx(c.network, c.d, id)], summary: `end allowance #${id}` };
    },
  },

  distributorfund: {
    models: v.TOKEN_MODELS,
    args: [{ name: "<amount>", about: "DAO tokens to move from the treasury" }],
    about: "Move DAO tokens from the treasury into its Distributor, for grants, a raise's buyers and welcome grants.",
    async build(c) {
      const mint = await daoMint(c);
      const { address } = await sf.requireDistributor(c.network, c.d, mint);
      const { decimals } = await v.mintInfo(c.network, mint);
      const raw = v.parseUnits(c.args[0], decimals);
      return { instructions: [await sf.distributorFundIx(c.network, c.d, address, mint, raw)], budget: [{ mint, amount: raw }], summary: `move ${v.formatUnits(raw, decimals)} ${c.link.symbol ?? "tokens"} into the Distributor` };
    },
  },
  distributorgrant: {
    models: v.TOKEN_MODELS,
    args: [
      { name: "<recipient>", about: "a Solana address, or account:<hex> for a member's chat account" },
      { name: "<amount>", about: "DAO tokens" },
    ],
    options: ["cliff", "vest"],
    about: "Grant DAO tokens from the Distributor, vesting over `vest=<days>` after `cliff=<days>` if given. The owner claims with /claim.",
    async build(c) {
      const mint = await daoMint(c);
      const { address } = await sf.requireDistributor(c.network, c.d, mint);
      const { decimals } = await v.mintInfo(c.network, mint);
      const [to, amount] = c.args;
      const isAccount = /^account:[0-9a-f]{64}$/i.test(to);
      const raw = v.parseUnits(amount, decimals);
      const cliffDays = whole(c.options?.cliff ?? 0, "cliff=");
      const vestDays = whole(c.options?.vest ?? 0, "vest=");
      const ix = await sf.allocateIx(c.network, c.d, address, {
        owner: isAccount ? PublicKey.default : key(to, "the recipient"),
        account: isAccount ? sf.accountBytes(to.slice(8)) : undefined,
        amount: raw,
        cliffDays,
        vestDays,
      });
      return {
        instructions: [ix],
        budget: [{ mint: v.SOL_ASSET, amount: 3_000_000n }],
        summary: `grant ${v.formatUnits(raw, decimals)} ${c.link.symbol ?? "tokens"} to ${isAccount ? "a member's chat account" : `\`${to}\``}${vestDays ? `, vesting over ${vestDays} days${cliffDays ? ` after a ${cliffDays}-day cliff` : ""}` : ""}`,
      };
    },
  },
  distributorwelcome: {
    models: v.TOKEN_MODELS,
    args: [
      { name: "<amount>", about: "each welcome grant" },
      { name: "<cap>", about: "all welcome grants together" },
    ],
    about: "Welcome grants for new members: a member of the Delegate council approves each one (/welcome).",
    async build(c) {
      const mint = await daoMint(c);
      const { address } = await sf.requireDistributor(c.network, c.d, mint);
      const { decimals } = await v.mintInfo(c.network, mint);
      const raw = v.parseUnits(c.args[0], decimals);
      const cap = v.parseUnits(c.args[1], decimals);
      return { instructions: [await sf.setWelcomeIx(c.network, c.d, address, raw, cap)], summary: `welcome grants of ${v.formatUnits(raw, decimals)} each, up to ${v.formatUnits(cap, decimals)} in all, approved by a council member` };
    },
  },

  raiseaccept: {
    models: "all",
    args: [
      { name: "<raise>", about: "the raise's address" },
      { name: "<amount>", about: "how much to accept: from the soft cap up to everything contributed" },
    ],
    about: "Accept an amount of the DAO's raise: the money goes to the treasury (or a prop firm's vault), the sale's tokens to the Distributor, and the rest is refunded pro rata.",
    async build(c) {
      const raise = key(c.args[0], "the raise");
      const r = await sf.readRaise(c.network, raise);
      if (r.phase !== "deciding") fail(r.phase === "open" || r.phase === "upcoming" ? "The raise hasn't ended yet." : `The raise is ${r.phase}.`);
      const raw = v.parseUnits(c.args[1], r.decimals);
      if (raw < BigInt(r.terms.softCap.toString()) || raw > BigInt(r.total.toString())) fail("Accept at least the soft cap and at most what was contributed.");
      const { instructions } = await sf.acceptIxs(c.network, c.d, raise, raw);
      return { instructions, summary: `accept ${v.formatUnits(raw, r.decimals)} of the ${v.formatUnits(BigInt(r.total.toString()), r.decimals)} raised (the rest goes back pro rata)` };
    },
  },

  vaultcreate: {
    models: v.TOKEN_MODELS,
    args: [{ name: "<asset mint>", about: "what depositors put in, e.g. USDC's mint" }],
    options: ["fees", "mgmt", "perf", "drawdown", "interval", "open", "raise"],
    about:
      "Make this DAO a prop firm: a vault whose shares are the DAO's token (which must have no supply yet). Deposits and redemptions are priced at windows (`interval=<days>`, 30), fees `mgmt=<bps>` a year and `perf=<bps>` of gains split by `fees=<address>:<bps>,...`, trading pauses `drawdown=<bps>` below the high. `raise=<n>` lets the bot's raise #n seed it.",
    async build(c) {
      const assetMint = key(c.args[0], "the asset's mint");
      const shareMint = await daoMint(c);
      const o = c.options ?? {};
      const config = sf.vaultConfig({
        intervalDays: o.interval ? whole(o.interval, "interval=") : 30,
        managementBps: o.mgmt ? whole(o.mgmt, "mgmt=") : 200,
        performanceBps: o.perf ? whole(o.perf, "perf=") : 2000,
        maxDrawdownBps: o.drawdown ? whole(o.drawdown, "drawdown=") : 2000,
        openToAll: o.open !== "false",
        fast: c.network.fastTimings,
      });
      const seeder = o.raise ? sf.fundsAddresses(c.network, c.d.dao).raise(sf.raiseCreateKey(c.d.dao, o.raise).publicKey) : PublicKey.default;
      const ix = await sf.createVaultIx(c.network, c.d, { shareMint, assetMint, config, feeSplits: feeSplits(o.fees), seeder });
      return { instructions: [ix], budget: [{ mint: v.SOL_ASSET, amount: 20_000_000n }], summary: `open the DAO's prop-firm vault over \`${assetMint.toBase58()}\`, its shares the DAO's token${o.raise ? " (seeded by the coming raise)" : ""}` };
    },
  },
  vaultpause: {
    models: "all",
    args: [],
    about: "Pause the vault's trading (the bot stops signing traders' orders).",
    async build(c) {
      const x = await sf.requireVault(c.network, c.d);
      return { instructions: [await sf.vaultPauseIx(c.network, c.d, x.address)], summary: "pause the vault's trading" };
    },
  },
  vaultresume: {
    models: "all",
    args: [],
    about: "Resume the vault's trading after a drawdown pause.",
    async build(c) {
      const x = await sf.requireVault(c.network, c.d);
      return { instructions: [await sf.vaultResumeIx(c.network, c.d, x.address)], summary: "resume the vault's trading" };
    },
  },
  vaultallow: {
    models: "all",
    args: [{ name: "<address>", about: "who may deposit" }],
    about: "Let an address deposit in a vault that isn't open to all.",
    async build(c) {
      const x = await sf.requireVault(c.network, c.d);
      const who = key(c.args[0], "the depositor");
      return { instructions: [await sf.vaultAllowIx(c.network, c.d, x.address, who)], budget: [{ mint: v.SOL_ASSET, amount: 2_000_000n }], summary: `let \`${who.toBase58()}\` deposit in the vault` };
    },
  },
  vaultvenues: {
    models: "all",
    args: [
      { name: "<perp asset map>", about: "Phoenix's PerpAssetMap account" },
      { name: "<trader,...>", about: "the vault's Phoenix trader accounts (cross and subaccounts), comma-separated" },
    ],
    about: "The Phoenix accounts the vault is valued from. Register each before moving money into it; a window reads all of them.",
    async build(c) {
      const x = await sf.requireVault(c.network, c.d);
      const map = key(c.args[0], "the PerpAssetMap");
      const traders = String(c.args[1] ?? "").split(",").filter(Boolean).map((t) => key(t, "a trader account"));
      if (!traders.length) fail("Name at least one Phoenix trader account.");
      return { instructions: [await sf.vaultVenuesIx(c.network, c.d, x.address, map, traders, [])], summary: `value the vault from ${traders.length} Phoenix account(s)` };
    },
  },

  seatlabel: {
    models: ["delegate"],
    args: [
      { name: "<seat>", about: "the seat's number, from 1" },
      { name: "<label>", about: "one word, e.g. Treasurer (up to 32 characters)" },
    ],
    about: "Name a council seat.",
    async build(c) {
      const seat = whole(c.args[0], "<seat>");
      if (seat < 1) fail("Seats are numbered from 1.");
      const label = String(c.args[1] ?? "");
      if (!label || label.length > 32) fail("A label is 1 to 32 characters.");
      return { instructions: [await sf.seatLabelIx(c.network, c.d, seat - 1, label)], summary: `name seat ${seat} "${label}"` };
    },
  },
};
