import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as rise from "@ellipsis-labs/rise";
import { fromKit } from "./integrations/common.js";

/**
 * Phoenix perps (Ellipsis Labs' Phoenix "Rise"): the pieces the desk
 * (src/solana/deskPhoenix.js) and its proposal actions
 * (src/solana/integrations/phoenix.js) share.
 *
 * Accounts and markets come from Phoenix's own API through its SDK
 * (@ellipsis-labs/rise), and instructions from the SDK's builders, as in
 * scripts/test-phoenix-flow.mjs, which runs this flow against Phoenix's
 * mainnet programs in LiteSVM. The SDK's program addresses are checked
 * against the ones verified on mainnet (docs/solana-integrations.md); a
 * mismatch is refused rather than used.
 *
 * The DAO's Phoenix account: the Treasury is the `authority` of a
 * cross-margin account (subaccount 0), which the deposits go into, and of
 * one isolated subaccount per trader (1, 2, ...). Each isolated subaccount
 * holds one position and is delegated to its trader's key (Phoenix's
 * position authority), which can trade it but never withdraw.
 */

export const API_URL = process.env.PHOENIX_API_URL || "https://perp-api.phoenix.trade";
export const PINNED = {
  program: "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih",
  ember: "EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
/** Phoenix's quote unit: collateral is USD with 6 decimals (rise QUOTE_DECIMALS), the same as USDC. */
export const QUOTE_DECIMALS = 6;
export const CROSS = 0;
/** Isolated subaccounts per trader account (rise MAX_SUBACCOUNTS); 0 is the cross account. */
export const MAX_SUBACCOUNT = Number(rise.MAX_SUBACCOUNTS ?? 32) - 1;

const fail = (msg) => {
  throw Object.assign(new Error(msg), { userFacing: true });
};

const clients = new Map();

/** Phoenix's SDK client for `network` (its API plus the network's RPC); mainnet only. */
export function phoenixClient(network) {
  if (network.id !== "solana-mainnet") fail(`Phoenix runs on Solana mainnet only, not ${network.name}.`);
  if (rise.PHOENIX_PROGRAM_ADDRESS !== PINNED.program || rise.EMBER_PROGRAM_ADDRESS !== PINNED.ember) {
    fail("Phoenix's SDK names program addresses other than the verified ones - refusing until they're re-checked.");
  }
  if (!clients.has(network.id)) clients.set(network.id, rise.createPhoenixClient({ apiUrl: API_URL, rpcUrl: network.rpcUrl, exchangeMetadata: { stream: false } }));
  return clients.get(network.id);
}

/** The exchange's accounts, in the shape the SDK's *Resolved builders take. */
export async function exchangeAccounts(network) {
  const phx = phoenixClient(network);
  await phx.exchange.ready();
  const s = phx.exchange.snapshot().exchange;
  if (s.usdcMint !== PINNED.usdc) fail(`Phoenix's API names ${s.usdcMint} as USDC, not the verified mint - refusing.`);
  const phoenixProgramAddress = rise.PHOENIX_PROGRAM_ADDRESS;
  return {
    phoenixProgramAddress,
    logAuthorityAddress: rise.PHOENIX_LOG_AUTHORITY_ADDRESS,
    globalConfigurationAddress: s.globalConfig,
    perpAssetMap: s.perpAssetMap,
    globalTraderIndex: s.globalTraderIndex,
    activeTraderBuffer: s.activeTraderBuffer,
    canonicalMint: s.canonicalMint,
    usdcMint: s.usdcMint,
    globalVault: s.globalVault,
    withdrawQueue: s.withdrawQueue,
    emberState: rise.EMBER_STATE_ADDRESS,
    emberVault: await phx.pda.getEmberVaultAddress({ phoenixProgramAddress }),
  };
}

/** The markets Phoenix lists: symbols in upper case. */
export async function marketSymbols(network) {
  const phx = phoenixClient(network);
  await phx.exchange.ready();
  return phx.exchange.snapshot().markets.map((m) => String(m.symbol).toUpperCase());
}

/** One market's accounts and units: { symbol, marketAddress, splineCollection, tickSize, baseLotsDecimals }. */
export async function market(network, symbol) {
  const phx = phoenixClient(network);
  await phx.exchange.ready();
  const wanted = String(symbol).toUpperCase();
  const listed = phx.exchange.snapshot().markets.find((m) => String(m.symbol).toUpperCase() === wanted);
  if (!listed) fail(`Phoenix has no ${wanted} market. Markets: ${(await marketSymbols(network)).join(", ")}.`);
  const { market: m } = phx.exchange.instructionContext(listed.symbol);
  return { symbol: listed.symbol, marketAddress: m.marketPubkey, splineCollection: m.splinePubkey, tickSize: m.tickSize, baseLotsDecimals: m.baseLotsDecimals };
}

/** The Treasury's Phoenix account for subaccount `sub` (0: cross). */
export async function traderAccount(authority, sub) {
  return rise.deriveTraderAddresses(authority.toBase58(), 0, sub).traderAccount();
}

/** The Treasury's USDC and Phoenix-collateral token accounts, as Phoenix derives them. */
export async function tokenAccounts(network, authority) {
  const ex = await exchangeAccounts(network);
  return {
    usdc: await rise.getPhoenixTraderTokenAccountAddress(authority.toBase58(), ex.usdcMint),
    collateral: await rise.getPhoenixTraderTokenAccountAddress(authority.toBase58(), ex.canonicalMint),
  };
}

/** The on-chain trader account of `sub`, decoded, or null if it isn't registered. */
export async function readTrader(network, authority, sub) {
  const info = await network.connection.getAccountInfo(new PublicKey(await traderAccount(authority, sub)));
  return info ? rise.decodeTrader(new Uint8Array(info.data)) : null;
}

/**
 * The Treasury's subaccounts from Phoenix's API: { [sub]: { collateral (USD),
 * positions: [{ symbol, side, size, entry }] } }.
 */
export async function subaccounts(network, authority) {
  const phx = phoenixClient(network);
  const r = await phx.api.traders().getTraderStateSnapshot(authority.toBase58(), { traderPdaIndex: 0 }).catch((err) => {
    if (err?.status === 404) return null;
    throw err;
  });
  const out = {};
  for (const s of r?.snapshot.subaccounts ?? []) {
    out[s.subaccountIndex] = {
      collateral: Number(s.collateral) / 10 ** QUOTE_DECIMALS,
      positions: s.positions.map((p) => {
        const units = Number(p.basePositionUnits ?? p.basePositionLots);
        return { symbol: p.symbol, side: units >= 0 ? "long" : "short", size: Math.abs(units), entry: Number(p.entryPriceUsd ?? NaN) };
      }),
    };
  }
  return out;
}

/** Mark prices by symbol (upper case). */
export async function markPrices(network) {
  const phx = phoenixClient(network);
  const r = await phx.api.markets().getLatestMarketsStats();
  return Object.fromEntries(r.markets.map((m) => [String(m.symbol).toUpperCase(), Number(m.mark_price)]));
}

/** Positions with their mark and unrealized PnL (USD). */
export function withMarks(positions, marks) {
  return positions.map((p) => {
    const mark = marks[p.symbol.toUpperCase()] ?? NaN;
    return { ...p, mark, pnl: (mark - p.entry) * p.size * (p.side === "long" ? 1 : -1) };
  });
}

/** A kit instruction from the SDK as a web3.js one. */
export const web3Instruction = fromKit;

/** The SDK returns some builds as { instructions }, others as a list. */
export const listOf = (built) => built.instructions ?? built.ixs ?? (Array.isArray(built) ? built : [built]);

/**
 * Registers the Treasury on Phoenix, the way Phoenix onboards traders
 * without a referral code: its API builds the instructions, the operator
 * signs as the fee payer (the Treasury, a PDA, never signs), and the API
 * adds its onboarder's signature and sends it. Returns the signature.
 */
export async function registerWithPhoenix(network, operator, authority) {
  const phx = phoenixClient(network);
  const traderAuthority = authority.toBase58();
  const txFeePayer = operator.publicKey.toBase58();
  const built = await phx.api.exchange().buildRegisterIxs({ traderAuthority, txFeePayer, maxPositions: 128 });
  const instructions = built.instructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(ix.data),
      })
  );
  const { blockhash, lastValidBlockHeight } = await network.connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: operator.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message());
  tx.sign([operator]);
  const sent = await phx.api.exchange().sendRegisterIxs({
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    traderAuthority,
    txFeePayer,
    maxPositions: 128,
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
  });
  await network.connection.confirmTransaction({ signature: sent.signature, blockhash, lastValidBlockHeight }, "confirmed");
  return sent.signature;
}
