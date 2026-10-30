#!/usr/bin/env node
/**
 * Whether a DAO's Treasury could trade on Magic Eden: lists the
 * marketplace (AuctionHouse) accounts of Magic Eden's M2 program on
 * mainnet with their notary settings.
 *
 * M2 (github.com/magicoss/m2, Auction House based) checks a notary's
 * signature on trades when the marketplace's `requiresNotary` is set: on
 * `nprob` percent of them, chosen by the clock (utils/generic.rs
 * assert_valid_notary). Magic Eden's server is the notary, and a
 * proposal executes long after it's written, so it can't co-sign: with
 * the notary required, a Treasury's trades would fail (all of them at
 * nprob 100). Trades without the notary also pay M2's default fees.
 *
 * Layout from M2's IDL (src/idl/m2.json, account AuctionHouse): an 8-byte
 * Anchor discriminator, five public keys (auctionHouseTreasury,
 * treasuryWithdrawalDestination, authority, creator, notary), bump,
 * treasuryBump, sellerFeeBasisPoints (u16), buyerReferralBp (u16),
 * sellerReferralBp (u16), requiresNotary (bool), nprob (u8).
 *
 *   node scripts/check-magic-eden.mjs
 *
 * RPC: SOLANA_MAINNET_RPC_URL (from .env too), else the public endpoint.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { getBase58Decoder } from "@solana/kit";

const M2 = new PublicKey("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K");
const DISCRIMINATOR = createHash("sha256").update("account:AuctionHouse").digest().subarray(0, 8);
const conn = new Connection(process.env.SOLANA_MAINNET_RPC_URL || clusterApiUrl("mainnet-beta"), "confirmed");

const houses = await conn.getProgramAccounts(M2, { filters: [{ memcmp: { offset: 0, bytes: getBase58Decoder().decode(DISCRIMINATOR) } }] }).catch(async (err) => {
  console.error(`getProgramAccounts failed (${err.message}); some public RPCs refuse it - set SOLANA_MAINNET_RPC_URL to another RPC.`);
  process.exit(1);
});
if (!houses.length) {
  console.log("No AuctionHouse accounts found under M2.");
  process.exit(1);
}
for (const { pubkey, account } of houses) {
  const d = account.data;
  const key = (i) => new PublicKey(d.subarray(8 + 32 * i, 40 + 32 * i)).toBase58();
  const at = 8 + 5 * 32;
  const fee = d.readUInt16LE(at + 2);
  const requiresNotary = d[at + 8] !== 0;
  const nprob = d[at + 9];
  console.log(`\nAuctionHouse ${pubkey.toBase58()}`);
  console.log(`  authority ${key(2)}, notary ${key(4)}`);
  console.log(`  seller fee ${fee / 100}%`);
  console.log(`  requiresNotary ${requiresNotary}, nprob ${nprob}`);
  console.log(
    !requiresNotary
      ? "  -> no notary needed: a Treasury could trade here."
      : nprob >= 100
        ? "  -> the notary must sign every trade: a Treasury can't trade here."
        : `  -> the notary must sign ${nprob}% of trades: a Treasury's proposal would fail that often.`
  );
}
