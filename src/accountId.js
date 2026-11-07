import { keccak256, toBytes, toHex } from "viem";

/**
 * A member's chat account as the Distributor and raises know it: 32 bytes,
 * keccak256 of "<platform>:<userId>" (e.g. "telegram:12345"). The same on
 * both chains (bytes32 on EVM, [u8; 32] on Solana), so a contribution or
 * grant made to someone's account can be claimed from whatever wallet the
 * bot holds for them later. Platform user ids aren't secret; what makes a
 * claim safe is that only the bot's operator can claim for an account, and
 * it does so only for the person it has just seen run /claim.
 */
export function accountId(platform, userId) {
  return keccak256(toBytes(`${platform}:${userId}`));
}

/** The same as 32 raw bytes, for Solana instructions. */
export function accountIdBytes(platform, userId) {
  return Array.from(toBytes(accountId(platform, userId)));
}

export const NO_ACCOUNT = toHex(new Uint8Array(32));

/**
 * A user named in a command: a platform mention (<@123>, <@U123|name>), a
 * bare numeric id, or (Telegram) whoever the message replies to. Null if none.
 */
export function mentionedUserId(word, replyToUserId) {
  if (replyToUserId) return String(replyToUserId);
  if (!word) return null;
  const m = String(word).match(/^<@!?([A-Za-z0-9]+)(?:\|[^>]*)?>$/);
  if (m) return m[1];
  if (/^\d{4,}$/.test(word)) return String(word);
  return null;
}
