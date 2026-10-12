import { formatUnits } from "viem";
import { getUnderlyingTokenAddress } from "./market.js";
import { getMyReward } from "./decrypt.js";
import { tokenInfo } from "./send.js";

/**
 * What /computereward, /withdraw and /withdrawreward tell the user about
 * the amount involved, so they know what they're claiming and can /send
 * it on. `cmd(name)` renders a command for the platform.
 */

async function marketToken(marketAddress) {
  return tokenInfo(await getUnderlyingTokenAddress(marketAddress));
}

/** After computeReward: the reward this wallet will be able to withdraw. */
export async function rewardComputedText(client, marketAddress, cmd) {
  try {
    const result = await getMyReward(client, marketAddress);
    if (!result) return `✅ Reward computed. Use \`${cmd("withdrawreward")}\` to collect it.`;
    const { decimals, symbol } = await marketToken(marketAddress);
    const amount = `${formatUnits(result.reward, decimals)} ${symbol}`;
    const lines = [
      result.reward === 0n
        ? `✅ Reward computed: *0 ${symbol}* - none of your bets backed the winning opportunity.`
        : `✅ Reward computed: *${amount}* (from ${formatUnits(result.qualifying, decimals)} ${symbol} you staked on the winner).`,
    ];
    if (result.overflowed) {
      lines.push(
        "⚠️ This market was created before the reward-math fix: your stake times the reward pool passed its 64-bit limit, so its math wrapped around - this is the amount it will actually pay. Markets from the updated factory don't have this problem."
      );
    }
    if (result.reward > 0n) lines.push(`Use \`${cmd("withdrawreward")}\` to move it to your wallet, then \`${cmd("send")}\` to send it anywhere.`);
    return lines.join("\n");
  } catch (err) {
    // Reading the amount needs Zama's relayer; the reward itself is already computed on-chain.
    console.error("[opportunityMarket] Couldn't work out the reward amount:", err.message);
    return `✅ Reward computed. Couldn't read the amount right now (Zama's relayer didn't answer) - \`${cmd("withdrawreward")}\` shows the exact amount when it pays out.`;
  }
}

/** After a stake or reward withdrawal: the exact amount paid out (the KMS-signed cleartext). */
export async function withdrawnText(marketAddress, kind, amount, walletAddress, cmd) {
  const { decimals, symbol } = await marketToken(marketAddress);
  const what = kind === "reward" ? "Reward" : "Stake";
  if (amount === 0n) return `✅ ${what} withdrawal settled: *0 ${symbol}* - there was nothing to pay out.`;
  const whole = formatUnits(amount, decimals);
  return [
    `✅ ${what} withdrawn: *${whole} ${symbol}* sent to your wallet \`${walletAddress}\` on Sepolia.`,
    `Send it on with \`${cmd("send")} ${whole} 0xRecipient\` (or \`${cmd("send")} all 0xRecipient\`).`,
  ].join("\n");
}
