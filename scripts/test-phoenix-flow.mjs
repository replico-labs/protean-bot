#!/usr/bin/env node
/**
 * The Phoenix perps desk's flow, against Phoenix's real programs in LiteSVM:
 * Phoenix, Ember and Hawkeye dumped from mainnet (scripts/dump-solana-program.mjs)
 * and Phoenix's own localnet fixture (markets, oracle prices, makers), shipped
 * in @ellipsis-labs/rise. A plain keypair stands in for the Treasury PDA,
 * signing what the hub signs for it in a proposal; the trader's key is a
 * separate keypair, as the bot holds it.
 *
 * Checks: the Treasury registers with its authority not signing (as a PDA
 * can't); it deposits; it opens an isolated subaccount, funds it and
 * delegates it to the trader's key; the trader's key trades it but can't
 * withdraw; re-delegating cuts the old key off; the new key closes; the
 * Treasury moves the collateral back and withdraws.
 *
 *   for p in EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih:phoenix_eternal EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy:phoenix_ember_program RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj:phoenix_hawkeye; do
 *     node scripts/dump-solana-program.mjs ${p%%:*} $PHOENIX_SO_DIR/${p##*:}.so; done
 *   PHOENIX_SO_DIR=... node scripts/test-phoenix-flow.mjs
 */
import { createRequire } from "module";
import { createHash } from "node:crypto";
import { LiteSVM, FailedTransactionMetadata } from "litesvm";
import {
  address,
  lamports,
  generateKeyPairSigner,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  AccountRole,
  getAddressEncoder,
} from "@solana/kit";
import * as rise from "@ellipsis-labs/rise";

const require = createRequire(import.meta.url);
const fixture = require("@ellipsis-labs/rise/test-fixtures/default-localnet.json");
const SO = process.env.PHOENIX_SO_DIR;
if (!SO) {
  console.error("Set PHOENIX_SO_DIR to a folder with phoenix_eternal.so, phoenix_ember_program.so and phoenix_hawkeye.so (see the header).");
  process.exit(2);
}

let failures = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures++;
};

const vm = new LiteSVM();
vm.addProgramFromFile(address(fixture.programs.phoenixEternal), `${SO}/phoenix_eternal.so`);
vm.addProgramFromFile(address(fixture.programs.ember), `${SO}/phoenix_ember_program.so`);
vm.addProgramFromFile(address("RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj"), `${SO}/phoenix_hawkeye.so`);

const signers = new Map();
for (const s of fixture.signers) {
  const k = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(createHash("sha256").update(`${fixture.keypairBaseSeed}-${s.seed}`).digest()));
  signers.set(s.seed, k);
  signers.set(k.address, k);
  if (s.initialLamports) vm.airdrop(k.address, lamports(BigInt(s.initialLamports)));
}
const payer = signers.get("payer");

const roleOf = (a) => (a.isSigner ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY);
const isSignerRole = (r) => r === AccountRole.WRITABLE_SIGNER || r === AccountRole.READONLY_SIGNER;

/** Sends kit instructions; signers are attached by address from `extra` and the fixture. Returns null or the failure text. */
async function send(instructions, { feePayer = payer, extra = [] } = {}) {
  const known = new Map([...signers, ...extra.map((k) => [k.address, k])]);
  const attached = instructions.map((ix) => ({
    ...ix,
    accounts: ix.accounts.map((a) => (isSignerRole(a.role) && known.get(a.address) ? { ...a, signer: known.get(a.address) } : a)),
  }));
  const msg = appendTransactionMessageInstructions(
    attached,
    setTransactionMessageLifetimeUsingBlockhash({ blockhash: vm.latestBlockhash(), lastValidBlockHeight: 10_000_000n }, setTransactionMessageFeePayerSigner(feePayer, createTransactionMessage({ version: 0 })))
  );
  let signed;
  try {
    signed = await signTransactionMessageWithSigners(msg);
  } catch (e) {
    return `can't be signed: ${e.message}`; // a signer the sender doesn't hold
  }
  const res = vm.sendTransaction(signed);
  vm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) return `${res.err().toString()} | ${res.meta().logs().slice(-4).join(" | ")}`;
  return null;
}
const fixtureIx = (txName, ixName) => fixture.setupTransactions.find((t) => t.name === txName).instructions.find((i) => i.name === ixName);
const kitIx = (ix, swap = {}) => ({
  programAddress: address(ix.programId),
  accounts: ix.accounts.map((a) => ({ address: address(swap[a.pubkey] ?? a.pubkey), role: roleOf(a) })),
  data: new Uint8Array(Buffer.from(ix.dataBase64, "base64")),
});

const A = fixture.addresses;
const fakeUsdc = fixture.mints.find((m) => m.name === "fakeUsdc").pubkey;
const collateral = fixture.mints.find((m) => m.name === "phoenixCollateral").pubkey;
const btc = fixture.markets.find((m) => m.symbol === "BTC");
const exchange = {
  phoenixProgramAddress: fixture.programs.phoenixEternal,
  logAuthorityAddress: A.logAuthority,
  globalConfigurationAddress: A.globalConfig,
  perpAssetMap: A.perpAssetMap,
  globalTraderIndex: A.globalTraderIndex,
  activeTraderBuffer: A.activeTraderBuffer,
  canonicalMint: collateral,
  usdcMint: fakeUsdc,
  globalVault: A.globalVault,
  withdrawQueue: A.withdrawQueue,
  emberState: A.emberState,
  emberVault: A.emberVault,
};

const traderOf = (acct) => rise.decodeTrader(new Uint8Array(vm.getAccount(address(acct)).data));
const treasury = await generateKeyPairSigner(); // stands in for the Treasury PDA
const traderKey = await generateKeyPairSigner(); // the trader's key, held by the bot
const replacementKey = await generateKeyPairSigner();
vm.airdrop(treasury.address, lamports(10_000_000_000n));
vm.airdrop(traderKey.address, lamports(1_000_000_000n));
vm.airdrop(replacementKey.address, lamports(1_000_000_000n));

const cross = await rise.getPhoenixTraderSubaccountAddress({ authority: treasury.address, traderPdaIndex: 0, subaccountIndex: 0 }).catch(async () => (await rise.deriveTraderAddresses(treasury.address, 0, 0).traderAccount()));
const child = await rise.deriveTraderAddresses(treasury.address, 0, 1).traderAccount();
const usdcAta = await rise.getPhoenixTraderTokenAccountAddress(treasury.address, fakeUsdc);
const collateralAta = await rise.getPhoenixTraderTokenAccountAddress(treasury.address, collateral);

console.log("Phoenix's localnet: exchange, BTC/ETH/SOL markets, oracle prices, makers…");
for (const tx of fixture.setupTransactions) {
  const feePayer = signers.get(tx.signerSeeds.includes("payer") ? "payer" : tx.signerSeeds[0]);
  for (const ix of tx.instructions) {
    const e = await send([kitIx(ix)], { feePayer });
    if (e) throw new Error(`fixture setup ${tx.name}:${ix.name} failed: ${e}`);
  }
}
check(true, `the fixture's ${fixture.setupTransactions.length} setup transactions run on the mainnet binaries`);

console.log("Registering the Treasury (its authority doesn't sign)…");
const register = rise.buildRegisterTraderIxResolved({ exchange, trader: { payer: payer.address, authority: treasury.address, traderAccount: cross }, maxPositions: 128n, traderPdaIndex: 0, traderSubaccountIndex: 0 });
const registerSigners = register.accounts.filter((a) => isSignerRole(a.role)).map((a) => a.address);
check(!registerSigners.includes(treasury.address), "registering doesn't ask the trader authority to sign", registerSigners.join(","));
let err = await send([register]);
check(!err, "the Treasury's cross account registers", err);
// Activation: Phoenix's onboarder in production (its no-referral API); the fixture's admin here.
err = await send([kitIx(fixtureIx("seedTaker0Collateral", "enableTaker0TraderCapabilities"), { [fixture.actors.find((a) => a.name === "taker0").traderAccount]: cross })]);
check(!err, "and is activated (all trading capabilities)", err);

console.log("Funding: USDC into the cross account through Ember…");
err = await send([
  await rise.buildCreateAssociatedTokenAccountIdempotent({ payer: payer.address, owner: treasury.address, mint: fakeUsdc }),
  { programAddress: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), accounts: [{ address: address(fakeUsdc), role: AccountRole.WRITABLE }, { address: usdcAta, role: AccountRole.WRITABLE }, { address: payer.address, role: AccountRole.READONLY_SIGNER }], data: Uint8Array.from([7, ...new Uint8Array(new BigUint64Array([2_000_000_000n]).buffer)]) },
]);
check(!err, "the Treasury holds 2,000 fake USDC", err);
const deposit = rise.buildDepositIxsResolved({ exchange, trader: { authority: treasury.address, traderAccount: cross, usdcTokenAccount: usdcAta, phoenixTokenAccount: collateralAta }, amount: 1_000_000_000n });
const depositIxs = deposit.instructions ?? deposit.ixs ?? deposit;
err = await send(depositIxs, { feePayer: treasury });
check(!err, "the Treasury deposits 1,000 (Ember wrap, then Phoenix deposit)", err);
const collateralOf = (acct) => BigInt(traderOf(acct).state.quoteLotCollateral);
check(collateralOf(cross) === 1_000_000_000n, `the cross account holds 1,000 in collateral (${collateralOf(cross)})`);

console.log("An isolated subaccount for the trader, funded and delegated…");
err = await send([
  rise.buildRegisterTraderIxResolved({ exchange, trader: { payer: treasury.address, authority: treasury.address, traderAccount: child }, maxPositions: 1n, traderPdaIndex: 0, traderSubaccountIndex: 1 }),
  rise.buildSyncParentToChildIxResolved({ exchange, trader: { authority: treasury.address, parentTraderAccount: cross, childTraderAccount: child } }),
  rise.buildTransferCollateralIxResolved({ exchange, trader: { authority: treasury.address, srcTraderAccount: cross, dstTraderAccount: child }, amount: 500_000_000n }),
], { feePayer: treasury });
check(!err, "the Treasury registers isolated subaccount 1, syncs it from the cross account and moves 500 into it", err);
check(collateralOf(child) === 500_000_000n && collateralOf(cross) === 500_000_000n, `500 / 500 (${collateralOf(child)} / ${collateralOf(cross)})`);
err = await send([rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: treasury.address, traderAccount: child }, newPositionAuthority: traderKey.address })], { feePayer: treasury });
check(!err, "the Treasury delegates the subaccount to the trader's key", err);

console.log("The trader's key trades it…");
const marketParams = { tickSize: btc.tickSizeInQuoteLotsPerBaseLot, baseLotsDecimals: btc.baseLotDecimals };
const order = (key, side, price, size, extraFlags = {}) =>
  rise.buildPlaceMarketOrderIxResolved({
    exchange,
    market: { marketAddress: btc.orderbook, splineCollection: btc.spline },
    trader: { authority: treasury.address, positionAuthority: key.address, traderAccount: child },
    orderPacket: rise.buildMarketOrderPacketFromMarketParams({ side, priceLimitUsd: price, baseUnits: size, minBaseUnitsToFill: size, ...extraFlags }, marketParams),
  });
const buy = order(traderKey, rise.Side.Bid, "101000", "0.001");
const buySigners = buy.accounts.filter((a) => isSignerRole(a.role)).map((a) => a.address);
check(buySigners.includes(traderKey.address) && !buySigners.includes(treasury.address), "the order is signed by the trader's key, not the Treasury", buySigners.join(","));
err = await send([buy], { feePayer: traderKey });
check(!err, "the trader's key buys 0.001 BTC on the Treasury's subaccount", err);
check(traderOf(child).state.globalPositionSequenceNumber === 1 && collateralOf(child) < 500_000_000n, `a position is open and the taker fee came out of the subaccount (${collateralOf(child)})`);

console.log("…but can't take the money…");
const thiefAta = await rise.getPhoenixTraderTokenAccountAddress(traderKey.address, collateral);
err = await send([
  await rise.buildCreateAssociatedTokenAccountIdempotent({ payer: traderKey.address, owner: traderKey.address, mint: collateral }),
  rise.buildWithdrawFundsIxResolved({ exchange, trader: { authority: traderKey.address, traderAccount: child, destinationTokenAccount: thiefAta }, amount: 100_000_000n }),
], { feePayer: traderKey });
check(Boolean(err), "the trader's key withdrawing from the subaccount is refused", "it succeeded");
err = await send([rise.buildWithdrawFundsIxResolved({ exchange, trader: { authority: treasury.address, traderAccount: child, destinationTokenAccount: thiefAta }, amount: 100_000_000n })], { feePayer: traderKey });
check(/can't be signed/.test(err ?? ""), "and the trader's key can't name the Treasury as authority: the Treasury must sign", err ?? "it succeeded");
err = await send([rise.buildTransferCollateralIxResolved({ exchange, trader: { authority: treasury.address, positionAuthority: traderKey.address, srcTraderAccount: child, dstTraderAccount: cross }, amount: 1_000_000n })], { feePayer: traderKey });
console.log(`    (the trader's key moving collateral between the Treasury's own subaccounts: ${err ? "refused" : "allowed"})`);

console.log("Replacing the trader's key…");
err = await send([rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: treasury.address, traderAccount: child }, newPositionAuthority: replacementKey.address })], { feePayer: treasury });
check(!err, "the Treasury re-delegates the subaccount to a new key", err);
err = await send([order(traderKey, rise.Side.Ask, "99000", "0.001")], { feePayer: traderKey });
check(Boolean(err), "the old key can't trade any more", "it traded");
err = await send([order(replacementKey, rise.Side.Ask, "99000", "0.001")], { feePayer: replacementKey });
check(!err, "the new key closes the 0.001 BTC long", err);

console.log("The Treasury takes the money back…");
const before = collateralOf(child);
err = await send([rise.buildTransferCollateralChildToParentIxResolved({ exchange, trader: { authority: treasury.address, childTraderAccount: child, parentTraderAccount: cross } })], { feePayer: treasury });
check(!err && collateralOf(child) === 0n, `the Treasury moves the subaccount's ${before} back to the cross account`, err ?? `left ${collateralOf(child)}`);
// Phoenix makes a withdrawal wait 150 slots after a deposit (its own tests' WITHDRAW_COOLDOWN_SLOTS); a desk's
// withdrawal proposal executes days later anyway.
vm.warpToSlot(vm.getClock().slot + 151n);
const usdcBefore = BigInt(Buffer.from(vm.getAccount(usdcAta).data).readBigUInt64LE(64));
const withdraw = rise.buildWithdrawIxsResolved({ exchange, trader: { authority: treasury.address, traderAccount: cross, usdcTokenAccount: usdcAta, phoenixTokenAccount: collateralAta }, amount: 400_000_000n });
err = await send(withdraw.instructions ?? withdraw.ixs ?? withdraw, { feePayer: treasury });
const usdcAfter = BigInt(Buffer.from(vm.getAccount(usdcAta).data).readBigUInt64LE(64));
check(!err && usdcAfter - usdcBefore === 400_000_000n, `the Treasury withdraws 400 USDC (Phoenix withdraw, then Ember unwrap): ${usdcBefore} -> ${usdcAfter}`, err);

// Each Treasury step becomes a proposal, whose stored instructions must fit a legacy propose transaction
// (876 bytes with a 1-character description; scripts/simulate-solana-action.mjs).
const storedBytes = (ixs) => 4 + ixs.reduce((n, ix) => n + 36 + 34 * ix.accounts.length + 4 + ix.data.length, 0);
const steps = {
  "fund (Ember wrap + Phoenix deposit)": depositIxs,
  "open a trader's subaccount (register + sync + move collateral)": [
    rise.buildRegisterTraderIxResolved({ exchange, trader: { payer: treasury.address, authority: treasury.address, traderAccount: child }, maxPositions: 1n, traderPdaIndex: 0, traderSubaccountIndex: 1 }),
    rise.buildSyncParentToChildIxResolved({ exchange, trader: { authority: treasury.address, parentTraderAccount: cross, childTraderAccount: child } }),
    rise.buildTransferCollateralIxResolved({ exchange, trader: { authority: treasury.address, srcTraderAccount: cross, dstTraderAccount: child }, amount: 1n }),
  ],
  "appoint / remove (DelegateTrader)": [rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: treasury.address, traderAccount: child }, newPositionAuthority: traderKey.address })],
  "withdraw (subaccount back + Phoenix withdraw + Ember unwrap)": [rise.buildTransferCollateralChildToParentIxResolved({ exchange, trader: { authority: treasury.address, childTraderAccount: child, parentTraderAccount: cross } }), ...(withdraw.instructions ?? withdraw.ixs ?? withdraw)],
};
for (const [step, ixs] of Object.entries(steps)) console.log(`    proposal "${step}": ${ixs.length} instruction(s), ${storedBytes(ixs)} bytes stored${storedBytes(ixs) <= 876 ? "" : " - too big for a legacy propose"}`);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll Phoenix flow checks passed.");
process.exit(failures ? 1 : 0);
