import { erc20Abi, formatEther, formatUnits, getAddress, isAddress, parseEther, parseUnits } from "viem";
import { opportunityPublicClient, writeWithGasBuffer, sendNativeWithGasLimit } from "./config.js";
import { getUnderlyingTokenAddress } from "./market.js";

/**
 * /send for Opportunity Market channels: moves the market's underlying
 * token (a withdrawn stake or reward lands in the user's wallet as that
 * token) or Sepolia ETH out of the user's own wallet, on Sepolia.
 *
 * There's no gas sponsorship on Sepolia (gasSponsor.js funds Monad, Base
 * and HyperEVM only), so the wallet pays its own gas - config.js checks
 * that up front so an empty wallet gets a reason instead of a node error.
 */

export class MarketSendError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

const SEPOLIA_NATIVE = new Set(["ETH", "SEPOLIAETH", "NATIVE"]);

/** Whether `ref` means Sepolia ETH in a market channel. */
export function isSepoliaNative(ref) {
  return ref !== undefined && SEPOLIA_NATIVE.has(String(ref).toUpperCase());
}

/**
 * Whether a token reference picks the market's token: the word "market",
 * the underlying token's address, or its on-chain symbol.
 */
export async function refersToMarketToken(marketAddress, ref) {
  if (ref === undefined) return false;
  if (String(ref).toLowerCase() === "market") return true;
  const token = await getUnderlyingTokenAddress(marketAddress);
  if (isAddress(ref)) return getAddress(ref) === getAddress(token);
  const symbol = await opportunityPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => null);
  return symbol !== null && symbol.toUpperCase() === String(ref).toUpperCase();
}

export async function tokenInfo(token) {
  const [decimals, symbol] = await Promise.all([
    opportunityPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    opportunityPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "tokens"),
  ]);
  return { decimals, symbol };
}

/**
 * Whether /send in a channel goes to the market's chain (Sepolia), and
 * with what: null means it's an ordinary DAO send. With no DAO linked,
 * the market's token is the default and ETH/native means Sepolia ETH.
 * With a DAO linked too, the DAO keeps the default; "market", the
 * market token's symbol or address, or "sepolia" pick Sepolia instead.
 */
export async function marketSendMode(marketAddress, hasDao, tokenRef, cmd) {
  if (!marketAddress) return null;
  const ref = tokenRef === undefined ? undefined : String(tokenRef).toLowerCase();
  if (ref === "sepolia" || ref === "sepoliaeth") return { native: true };
  if (await refersToMarketToken(marketAddress, tokenRef)) return { native: false };
  if (hasDao) return null;
  if (ref === undefined) return { native: false };
  if (isSepoliaNative(tokenRef)) return { native: true };
  throw new MarketSendError(
    `This channel's Opportunity Market runs on Sepolia. Send its token with \`${cmd("send")} <amount|all> 0xRecipient\`, or Sepolia ETH with \`${cmd("send")} <amount> 0xRecipient ETH\`.`
  );
}

/** The user's balances on Sepolia: the market token and ETH. */
export async function marketWalletBalances(marketAddress, holder) {
  const token = await getUnderlyingTokenAddress(marketAddress);
  const { decimals, symbol } = await tokenInfo(token);
  const [raw, eth] = await Promise.all([
    opportunityPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
    opportunityPublicClient.getBalance({ address: holder }),
  ]);
  return { token: `${formatUnits(raw, decimals)} ${symbol}`, eth: `${formatEther(eth)} ETH` };
}

/**
 * Sends `amountText` (whole units, or "all" for the token) of the
 * market's token - or Sepolia ETH when `native` - from the user's wallet.
 */
export async function sendFromMarketWallet(client, marketAddress, recipient, amountText, { native = false } = {}) {
  const from = client.account.address;
  const to = getAddress(recipient);

  if (native) {
    const value = parseEther(String(amountText));
    const hash = await sendNativeWithGasLimit(client, to, value);
    await opportunityPublicClient.waitForTransactionReceipt({ hash });
    return { hash, sent: `${formatEther(value)} ETH` };
  }

  const token = await getUnderlyingTokenAddress(marketAddress);
  const { decimals, symbol } = await tokenInfo(token);
  const held = await opportunityPublicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  const amount = String(amountText).toLowerCase() === "all" ? held : parseUnits(String(amountText), decimals);
  if (amount === 0n) throw new MarketSendError(`You hold no ${symbol} on Sepolia. A stake or reward reaches your wallet after /withdraw or /withdrawreward.`);
  if (amount > held) throw new MarketSendError(`You hold ${formatUnits(held, decimals)} ${symbol} on Sepolia - not enough to send ${formatUnits(amount, decimals)}.`);

  // writeWithGasBuffer simulates the transfer and checks the wallet can pay its gas before signing.
  const hash = await writeWithGasBuffer(client, { address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await opportunityPublicClient.waitForTransactionReceipt({ hash });
  return { hash, sent: `${formatUnits(amount, decimals)} ${symbol}` };
}
