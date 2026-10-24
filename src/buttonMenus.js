/**
 * Second-step menus behind some proposal buttons (buttons.js), for actions
 * one press shouldn't do alone:
 *
 * - `ask amount <command> <args>`: how much to put in (taking a Sowellian
 *   position, splitting, trading a decision market). Offers 10%, 25%, 50%
 *   and all of what the presser holds for it, read when they press, as
 *   buttons that run the command with that amount. EVM decision-market
 *   trades also get a minimum out 1% under the pool's own quote
 *   (DecisionMarketPair.getAmountOut, the same call the contract's trade
 *   checks against); Solana's trade applies 1% itself.
 * - `ask sure <command> <args>`: a confirmation for actions that post a
 *   bond (proposing or challenging a Sowellian resolution).
 *
 * Each platform shows the menu to the presser (ephemeral on Discord and
 * Slack) and runs whichever button they press next like any other.
 */
import { formatUnits, parseUnits } from "viem";
import { publicClient } from "./config.js";
import { getChatDAO, getChatModel, getChatNetwork } from "./db.js";
import { runOnNetwork } from "./networks.js";
import { getUserAddress } from "./walletResolver.js";
import { getProposal as getMarketsProposal, getProposalVaults } from "./governance/decisionMarkets.js";
import { isSolanaChat, solanaSpendable } from "./solana/commands.js";

const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const GOVERNANCE_TOKEN = [{ type: "function", name: "governanceToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const VAULT_UNDERLYING = [{ type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
// From Spaces' DecisionMarketPair.sol: token0 is the base side, token1 the quote side.
const PAIR = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getAmountOut", stateMutability: "view", inputs: [{ name: "amountIn", type: "uint256" }, { name: "zeroForOne", type: "bool" }], outputs: [{ type: "uint256" }] },
];

const SHARES = [10, 25, 50, 100];
const SLIPPAGE_BPS = 100n; // 1%
const AMOUNT_COMMANDS = new Set(["takeposition", "split", "trade"]);

/** `ask ...` button words -> { text, buttons } to show the presser. Throws a plain Error with a message to show on bad input. */
export async function buttonMenu(ctx, args) {
  const [kind, name, ...rest] = args;
  if (kind === "sure") return sureMenu(ctx, name, rest);
  if (kind === "amount" && AMOUNT_COMMANDS.has(name)) {
    // EVM balances are read on the chat's network, as its commands run.
    if (isSolanaChat(ctx)) return amountMenu(ctx, name, rest, true);
    return runOnNetwork(getChatNetwork(ctx.chatId, ctx.platform), () => amountMenu(ctx, name, rest, false));
  }
  throw new Error("That button doesn't do anything any more.");
}

const OUTCOME = { success: "met its goal", failure: "didn't meet its goal" };

function sureMenu(ctx, name, args) {
  const [id, outcome] = args;
  const status = [{ label: "🔄 Status", cmd: `proposal ${id}` }];
  if (name === "challengeresolution") {
    return {
      text: `⚔️ Challenge the proposed outcome of proposal #${id}? This posts the DAO's challenge bond from your wallet and opens a vote on what really happened. You lose the bond if the vote goes against you.`,
      buttons: [[{ label: "⚔️ Yes, challenge it", cmd: `challengeresolution ${id}` }], status],
    };
  }
  if (name === "proposeresolution" && OUTCOME[outcome]) {
    return {
      text: `📣 Propose that proposal #${id} ${OUTCOME[outcome]}? This posts the DAO's resolution bond from your wallet. Anyone can challenge it, and you lose the bond if a challenge wins.`,
      buttons: [[{ label: `📣 Yes, it ${OUTCOME[outcome]}`, cmd: `proposeresolution ${id} ${outcome}` }], status],
    };
  }
  throw new Error("That button doesn't do anything any more.");
}

/** `raw * pct%` as a decimal string with at most `places` decimals, rounded down; null if that rounds to 0. */
export function share(raw, decimals, pct, places = 6) {
  const part = (raw * BigInt(pct)) / 100n;
  const [whole, frac = ""] = formatUnits(part, decimals).split(".");
  const cut = frac.slice(0, places).replace(/0+$/, "");
  const text = cut ? `${whole}.${cut}` : whole;
  return /^0(\.0*)?$/.test(text) ? null : text;
}

const WHAT = {
  takeposition: (a) => `How much do you want to put behind *${a[1] === "yes" ? "YES (it works)" : "NO (it doesn't)"}* on proposal #${a[0]}?`,
  split: (a) => `How much do you want to split into pass and fail balances for proposal #${a[0]}?`,
  trade: (a) => `How much do you want to ${a[2] === "buy" ? "spend buying" : "sell"} in the *${a[1]}* market of proposal #${a[0]}?`,
};

async function amountMenu(ctx, name, args, solana) {
  if (!/^\d+$/.test(args[0] ?? "")) throw new Error("That button doesn't do anything any more.");
  const have = solana ? await solanaSpendable(ctx, name, args) : await evmSpendable(ctx, name, args);
  const status = [{ label: "🔄 Status", cmd: `proposal ${args[0]}` }];
  const typed = `\`${ctx.cmd(name)} ${args.join(" ")} <amount>\``;
  if (!have || have.raw <= 0n) return { text: have?.empty ?? "You have nothing to use for that yet.", buttons: [status] };

  const choices = [];
  for (const pct of SHARES) {
    const amount = share(have.raw, have.decimals, pct);
    if (!amount || choices.some((c) => c.amount === amount)) continue;
    choices.push({ pct, amount });
  }
  const row = [];
  for (const { pct, amount } of choices) {
    const cmd = solana || name !== "trade" ? `${name} ${args.join(" ")} ${amount}` : await evmTradeCommand(args, amount, have);
    // Telegram carries at most 64 bytes per button (buttons.js); a huge balance can't be a button.
    if (Buffer.byteLength(`c:${cmd}`) > 64) continue;
    row.push({ label: `${pct === 100 ? "All" : `${pct}%`}: ${amount}`, cmd });
  }
  return {
    text: `${WHAT[name](args)} You have ${share(have.raw, have.decimals, 100) ?? "0"} ${have.unit}.${name === "trade" ? " Each choice accepts at most 1% slippage." : ""}\nOr type ${typed}.`,
    buttons: [row.slice(0, 2), row.slice(2), status].filter((r) => r.length),
  };
}

async function evmSpendable(ctx, name, args) {
  const governance = getChatDAO(ctx.chatId, ctx.platform);
  if (!governance) throw new Error("This chat isn't linked to a DAO any more.");
  const me = await getUserAddress(ctx.userId, ctx.platform).catch(() => null);
  const balanceOf = async (token) => (me ? publicClient.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [me] }) : 0n);
  const symbolOf = (token) => publicClient.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "tokens");
  const id = args[0];

  if (name === "takeposition") {
    if (getChatModel(ctx.chatId, ctx.platform) !== "sowellian") throw new Error("This DAO doesn't take positions.");
    const token = await publicClient.readContract({ address: governance, abi: GOVERNANCE_TOKEN, functionName: "governanceToken" });
    const [raw, symbol] = await Promise.all([balanceOf(token), symbolOf(token)]);
    return { raw, decimals: 18, unit: symbol, empty: `You have no ${symbol} to put in.` };
  }
  if (getChatModel(ctx.chatId, ctx.platform) !== "decisionMarkets") throw new Error("This DAO has no decision markets.");
  if (name === "split") {
    const side = args[1] === "base" ? "base" : "quote";
    const { baseVault, quoteVault } = await getProposalVaults(governance, id);
    const token = await publicClient.readContract({ address: side === "base" ? baseVault : quoteVault, abi: VAULT_UNDERLYING, functionName: "underlying" });
    const [raw, symbol] = await Promise.all([balanceOf(token), symbolOf(token)]);
    return { raw, decimals: 18, unit: symbol, empty: `You have no ${symbol} to split.` };
  }
  // trade <id> pass|fail buy|sell: buying sells the market's quote token (token1), selling its base (token0).
  const [, market, dir] = args;
  const p = await getMarketsProposal(governance, id);
  const pool = market === "fail" ? p.failPool : p.passPool;
  if (!pool || /^0x0+$/.test(pool)) throw new Error(`Proposal #${id}'s markets aren't open yet.`);
  const tokenIn = await publicClient.readContract({ address: pool, abi: PAIR, functionName: dir === "buy" ? "token1" : "token0" });
  const [raw, symbol] = await Promise.all([balanceOf(tokenIn), symbolOf(tokenIn)]);
  const side = dir === "buy" ? "quote" : "base";
  return { raw, decimals: 18, unit: symbol, pool, zeroForOne: dir !== "buy", empty: `You have no ${market} ${side} tokens to ${dir === "buy" ? "spend" : "sell"}. Split some first: \`${ctx.cmd("split")} ${id} ${side} <amount>\`.` };
}

/** The EVM trade command for `amount`: base|quote is the side sold, then a minimum out 1% under the pool's quote. */
async function evmTradeCommand(args, amount, have) {
  const [id, market, dir] = args;
  const amountIn = parseUnits(amount, 18);
  const out = await publicClient.readContract({ address: have.pool, abi: PAIR, functionName: "getAmountOut", args: [amountIn, have.zeroForOne] });
  const minOut = share((out * (10_000n - SLIPPAGE_BPS)) / 10_000n, 18, 100, 4) ?? "0";
  return `trade ${id} ${market} ${dir === "buy" ? "quote" : "base"} ${amount} ${minOut}`;
}
