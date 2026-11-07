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
 * withdraw, or pull the cross account's collateral into its subaccount;
 * re-delegating cuts the old key off; the new key closes; delegating back
 * to the Treasury (desk remove) cuts it off too; the Treasury moves the
 * collateral back and withdraws.
 *
 *   for p in EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih:phoenix_eternal EMBERpYNE6ehWmXymZZS2skiFmCa9V5dp14e1iduM5qy:phoenix_ember_program RiSeVw3ZjNfsaXPRb4mgaqYaEEt41pNNJoDvVh7pgQj:phoenix_hawkeye; do
 *     node scripts/dump-solana-program.mjs ${p%%:*} $PHOENIX_SO_DIR/${p##*:}.so; done
 *   PHOENIX_SO_DIR=... node scripts/test-phoenix-flow.mjs
 *
 * With VORTEX_SO_DIR (vortex_vault.so and Vortexes' scripts/hub-stub as
 * hub_stub.so), it also runs a prop firm's desk: the vault's PDA as the
 * Phoenix authority, each move a vault.execute signed through the treasury.
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
err = await send([rise.buildTransferCollateralIxResolved({ exchange, trader: { authority: treasury.address, positionAuthority: traderKey.address, srcTraderAccount: cross, dstTraderAccount: child }, amount: 1_000_000n })], { feePayer: traderKey });
check(Boolean(err), "the trader's key can't pull the cross account's collateral into its own subaccount", "it moved 1 USDC from the cross account");

console.log("Replacing the trader's key…");
err = await send([rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: treasury.address, traderAccount: child }, newPositionAuthority: replacementKey.address })], { feePayer: treasury });
check(!err, "the Treasury re-delegates the subaccount to a new key", err);
err = await send([order(traderKey, rise.Side.Ask, "99000", "0.001")], { feePayer: traderKey });
check(Boolean(err), "the old key can't trade any more", "it traded");
err = await send([order(replacementKey, rise.Side.Ask, "99000", "0.001")], { feePayer: replacementKey });
check(!err, "the new key closes the 0.001 BTC long", err);

console.log("Taking the subaccount back (desk remove: delegated to the Treasury itself)…");
err = await send([rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: treasury.address, traderAccount: child }, newPositionAuthority: treasury.address })], { feePayer: treasury });
check(!err && traderOf(child).positionAuthority === treasury.address, "the Treasury delegates the subaccount back to itself", err ?? traderOf(child).positionAuthority);
err = await send([order(replacementKey, rise.Side.Bid, "101000", "0.001")], { feePayer: replacementKey });
check(Boolean(err), "and the trader's key can't trade it any more", "it traded");

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

// A prop firm: the same flow with its vault's PDA as the Phoenix authority. Each step is what a desk
// proposal stores (src/solana/integrations/phoenix.js): vault.execute around every instruction the
// vault signs (sf.asVault), the treasury paying rent, the USDC from and back to the vault's assets
// account. A stand-in for the hub (Vortexes' scripts/hub-stub) signs as the treasury PDA, as an
// executed proposal does; the vault is Vortexes' real program.
const VSO = process.env.VORTEX_SO_DIR;
let vaultSteps = null;
if (!VSO) console.log("\n(VORTEX_SO_DIR unset: skipping the prop firm's vault desk; it needs vortex_vault.so and hub_stub.so)");
else {
  console.log("\nA prop firm's desk: the vault's PDA trades, every move through vault.execute…");
  const { PublicKey } = await import("@solana/web3.js");
  const { AccountLayout, MintLayout } = await import("@solana/spl-token");
  const { getSolanaNetwork } = await import("../src/solana/config.js");
  const sf = await import("../src/solana/funds.js");
  const v = await import("../src/solana/vortex.js");
  const { web3Instruction } = await import("../src/solana/phoenix.js");
  const { default: BN } = await import("bn.js");
  const net = getSolanaNetwork("solana-devnet"); // only for its program ids: nothing here touches devnet
  const HUB = net.programs.hub, VAULT = net.programs.vault;
  vm.addProgramFromFile(address(VAULT.toBase58()), `${VSO}/vortex_vault.so`);
  vm.addProgramFromFile(address(HUB.toBase58()), `${VSO}/hub_stub.so`);

  const dao = PublicKey.unique();
  const tPda = PublicKey.findProgramAddressSync([Buffer.from("treasury"), dao.toBuffer()], HUB)[0];
  const [vPda, vBump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), dao.toBuffer()], VAULT);
  const assets = PublicKey.findProgramAddressSync([Buffer.from("vault_assets"), vPda.toBuffer()], VAULT)[0];
  const usdcProgram = new PublicKey(vm.getAccount(address(fakeUsdc)).programAddress);
  vm.airdrop(address(tPda.toBase58()), lamports(5_000_000_000n));
  const now = Number(vm.getClock().unixTimestamp);
  const vaultProgram = v.programFor(net, "vault");
  const state = {
    dao, treasury: tPda, assetMint: new PublicKey(fakeUsdc), assetTokenProgram: usdcProgram, assetDecimals: 6,
    shareMint: PublicKey.unique(), shareTokenProgram: usdcProgram, assets, escrow: PublicKey.unique(), seeder: PublicKey.default,
    config: sf.vaultConfig(), feeSplits: [], perpAssetMap: PublicKey.default, phoenixTraders: [], extraTokens: [],
    epoch: new BN(0), nextWindowAt: new BN(now + 10 * 86_400),
    lastMoveAt: new BN(0), lastFeeAt: new BN(now), highWater: new BN(0),
    paused: false, seeded: true, pendingDepositAssets: new BN(0), owedAssets: new BN(0),
    initialRate: new BN(1), bump: vBump,
  };
  // The shares: a mint the vault controls, 3,000 issued (one per dollar).
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 1, mintAuthority: vPda, supply: 3_000_000_000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData);
  vm.setAccount({ address: address(state.shareMint.toBase58()), lamports: 10_000_000n, data: new Uint8Array(mintData), programAddress: address(usdcProgram.toBase58()), executable: false, space: BigInt(mintData.length) });
  // Room for the longest venue and fee lists, as create_vault allocates (Vault::INIT_SPACE).
  const VAULT_SPACE = 1_500;
  const vaultBytes = async (x) => {
    const d = Buffer.alloc(VAULT_SPACE);
    (await vaultProgram.coder.accounts.encode("vault", x)).copy(d);
    return new Uint8Array(d);
  };
  vm.setAccount({ address: address(vPda.toBase58()), lamports: 20_000_000n, data: await vaultBytes(state), programAddress: address(VAULT.toBase58()), executable: false, space: BigInt(VAULT_SPACE) });
  const tok = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: new PublicKey(fakeUsdc), owner: vPda, amount: 3_000_000_000n, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, tok);
  vm.setAccount({ address: address(assets.toBase58()), lamports: 10_000_000n, data: new Uint8Array(tok), programAddress: address(usdcProgram.toBase58()), executable: false, space: BigInt(tok.length) });
  const assetsBalance = () => Buffer.from(vm.getAccount(address(assets.toBase58())).data).readBigUInt64LE(64);
  check(assetsBalance() === 3_000_000_000n, "the vault holds 3,000 USDC in its assets account");

  // A stored proposal instruction as the hub runs it: relay(dao, data) with the program and its accounts.
  const RELAY = createHash("sha256").update("global:relay").digest().subarray(0, 8);
  const COMPUTE = { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: Uint8Array.from([2, ...new Uint8Array(new Uint32Array([1_400_000]).buffer)]) };
  const relayed = (ix) => {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(ix.data.length);
    return {
      programAddress: address(HUB.toBase58()),
      accounts: [{ address: address(ix.programId.toBase58()), role: AccountRole.READONLY }, ...ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: roleOf({ isSigner: k.isSigner && !k.pubkey.equals(tPda), isWritable: k.isWritable }) }))],
      data: new Uint8Array(Buffer.concat([RELAY, dao.toBuffer(), len, Buffer.from(ix.data)])),
    };
  };
  const byProposal = async (built, { skip = [] } = {}) => {
    const ixs = (built.instructions ?? built.ixs ?? (Array.isArray(built) ? built : [built])).filter((ix) => !skip.includes(ix));
    for (const ix of ixs) {
      const w = await sf.asVault(net, { treasury: tPda }, vPda, web3Instruction(ix));
      const e = await send([COMPUTE, relayed(w)]);
      if (e) return e;
    }
    return null;
  };
  const vAuth = vPda.toBase58(), tAuth = tPda.toBase58();
  const vCross = await rise.deriveTraderAddresses(vAuth, 0, 0).traderAccount();
  const vChild = await rise.deriveTraderAddresses(vAuth, 0, 1).traderAccount();
  const vCollateralAta = await rise.getPhoenixTraderTokenAccountAddress(vAuth, collateral);

  err = await send([rise.buildRegisterTraderIxResolved({ exchange, trader: { payer: payer.address, authority: vAuth, traderAccount: vCross }, maxPositions: 128n, traderPdaIndex: 0, traderSubaccountIndex: 0 })]);
  if (!err) err = await send([kitIx(fixtureIx("seedTaker0Collateral", "enableTaker0TraderCapabilities"), { [fixture.actors.find((a) => a.name === "taker0").traderAccount]: vCross })]);
  check(!err, "the vault's cross account registers and is activated", err);

  const vDeposit = rise.buildDepositIxsResolved({ exchange, feePayer: tAuth, trader: { authority: vAuth, traderAccount: vCross, usdcTokenAccount: assets.toBase58(), phoenixTokenAccount: vCollateralAta }, amount: 1_000_000_000n });
  const wrapped = await sf.asVault(net, { treasury: tPda }, vPda, web3Instruction(vDeposit.named.emberDeposit));
  check(wrapped.programId.equals(VAULT) && !wrapped.keys.some((k) => k.isSigner && k.pubkey.equals(vPda)), "the Ember wrap is a vault.execute, and the vault isn't asked to sign the proposal");
  const plain = await sf.asVault(net, { treasury: tPda }, vPda, web3Instruction(vDeposit.named.createPhoenixAta));
  check(!plain.programId.equals(VAULT), "creating the vault's collateral account isn't (the treasury pays; the vault signs nothing)");
  err = await byProposal(vDeposit);
  check(!err && collateralOf(vCross) === 1_000_000_000n && assetsBalance() === 2_000_000_000n, `the vault deposits 1,000 from its assets account (${collateralOf(vCross)} on Phoenix, ${assetsBalance()} left)`, err);

  err = await byProposal([
    rise.buildRegisterTraderIxResolved({ exchange, trader: { payer: tAuth, authority: vAuth, traderAccount: vChild }, maxPositions: 1n, traderPdaIndex: 0, traderSubaccountIndex: 1 }),
    rise.buildSyncParentToChildIxResolved({ exchange, trader: { authority: vAuth, parentTraderAccount: vCross, childTraderAccount: vChild } }),
    rise.buildTransferCollateralIxResolved({ exchange, trader: { authority: vAuth, srcTraderAccount: vCross, dstTraderAccount: vChild }, amount: 500_000_000n }),
    rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: vAuth, traderAccount: vChild }, newPositionAuthority: traderKey.address }),
  ]);
  check(!err && collateralOf(vChild) === 500_000_000n, "the vault opens subaccount 1 (the treasury paying its rent), funds it with 500 and delegates it to the trader's key", err);

  // The vault's value, as its windows and drawdown checks read it, from Phoenix's real accounts.
  const setVenues = await sf.vaultVenuesIx(net, { treasury: tPda }, vPda, new PublicKey(exchange.perpAssetMap), [new PublicKey(vCross), new PublicKey(vChild)], []);
  err = await send([relayed({ programId: setVenues.programId, keys: setVenues.accounts, data: setVenues.data })]);
  check(!err, "the vault names its cross account and the trader's subaccount as venues (set_venues, by proposal)", err);
  const readVault = async () => vaultProgram.coder.accounts.decode("vault", Buffer.from(vm.getAccount(address(vPda.toBase58())).data));
  const writeVault = async (x) => vm.setAccount({ address: address(vPda.toBase58()), lamports: 20_000_000n, data: await vaultBytes(x), programAddress: address(VAULT.toBase58()), executable: false, space: BigInt(VAULT_SPACE) });
  const ONE = 10n ** 18n;
  const supply = 3_000_000_000n;
  /** Runs check_drawdown at high-water mark `hw`: whether it paused. */
  const drawdown = async (hw) => {
    await writeVault({ ...(await readVault()), paused: false, highWater: new BN(hw.toString()) });
    const ix = await vaultProgram.methods.checkDrawdown().accountsStrict({ vault: vPda, assets, shareMint: state.shareMint }).remainingAccounts([new PublicKey(exchange.perpAssetMap), new PublicKey(vCross), new PublicKey(vChild)].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))).instruction();
    const e = await send([{ programAddress: address(VAULT.toBase58()), accounts: ix.keys.map((k) => ({ address: address(k.pubkey.toBase58()), role: roleOf(k) })), data: new Uint8Array(ix.data) }]);
    if (e) throw new Error(`check_drawdown failed: ${e}`);
    return (await readVault()).paused;
  };

  const vOrder = (key, side, price, size) =>
    rise.buildPlaceMarketOrderIxResolved({
      exchange,
      market: { marketAddress: btc.orderbook, splineCollection: btc.spline },
      trader: { authority: vAuth, positionAuthority: key.address, traderAccount: vChild },
      orderPacket: rise.buildMarketOrderPacketFromMarketParams({ side, priceLimitUsd: price, baseUnits: size, minBaseUnitsToFill: size }, marketParams),
    });
  err = await send([vOrder(traderKey, rise.Side.Bid, "101000", "0.001")], { feePayer: traderKey });
  check(!err, "the trader's key buys 0.001 BTC on the vault's subaccount", err);
  {
    // Marked to market as Phoenix's SDK decodes its own accounts: collateral + base x mark x tick + virtual quote - funding owed.
    const t = traderOf(vChild);
    const map = rise.decodePerpAssetMap(new Uint8Array(vm.getAccount(address(exchange.perpAssetMap)).data));
    const pos = t.positions.entries[0].value;
    const m = map.metadata.entries.find((e) => e.key === "BTC").value;
    const base = BigInt(pos.baseLotPosition), mark = BigInt(m.oraclePrice.markPrice.price.ticks), tick = BigInt(m.staticMarketParams.tickSize);
    // The fixture's funding is zero, so the funding term isn't exercised here (it needs a mainnet account).
    const funding = -(BigInt(m.fundingAccumulator.cumulativeFundingRate) - BigInt(pos.cumulativeFundingSnapshot)) * base;
    const upnl = base * mark * tick + BigInt(pos.virtualQuoteLotPosition) + funding;
    const value = assetsBalance() + collateralOf(vCross) + collateralOf(vChild) + upnl;
    const hw = ((value * ONE) / supply) * 10_000n / 8_000n;
    const stale = await drawdown(hw).then(() => null, (e) => e.message);
    check(/code: 6138 /.test(stale ?? "") /* GovError::StalePrice */, `an open position marked at a price older than max_price_age_slots (the fixture's is from its setup, ${vm.getClock().slot - BigInt(m.oraclePrice.markPrice.price.slot)} slots back) stops the valuation`, stale ?? "it valued");
    const x = await readVault();
    await writeVault({ ...x, config: { ...x.config, maxPriceAgeSlots: new BN(1_000) } });
    check(base !== 0n && !(await drawdown(hw - hw / 1_000_000n)) && (await drawdown(hw + hw / 1_000_000n)), `with 0.001 BTC open the vault is valued at ${value} (collateral, plus ${upnl} marked at ${mark} ticks): the drawdown check agrees to a millionth`);
    const y = await readVault();
    await writeVault({ ...y, paused: false, config: { ...y.config, maxPriceAgeSlots: new BN(150) } });
  }
  err = await send([vOrder(traderKey, rise.Side.Ask, "99000", "0.001")], { feePayer: traderKey });
  check(!err, "and closes it", err);
  const vThief = await rise.getPhoenixTraderTokenAccountAddress(traderKey.address, collateral);
  err = await send([rise.buildWithdrawFundsIxResolved({ exchange, trader: { authority: traderKey.address, traderAccount: vChild, destinationTokenAccount: vThief }, amount: 100_000_000n })], { feePayer: traderKey });
  check(Boolean(err), "the trader's key can't withdraw the vault's money", "it succeeded");

  err = await byProposal(rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: vAuth, traderAccount: vChild }, newPositionAuthority: vAuth }));
  check(!err && traderOf(vChild).positionAuthority === vAuth, "desk remove: the subaccount is delegated back to the vault", err);

  vm.warpToSlot(vm.getClock().slot + 151n);
  const beforeAssets = assetsBalance();
  const vWithdraw = rise.buildWithdrawIxsResolved({ exchange, feePayer: tAuth, trader: { authority: vAuth, traderAccount: vCross, usdcTokenAccount: assets.toBase58(), phoenixTokenAccount: vCollateralAta }, amount: 400_000_000n });
  err = await byProposal([rise.buildTransferCollateralChildToParentIxResolved({ exchange, trader: { authority: vAuth, childTraderAccount: vChild, parentTraderAccount: vCross } }), ...vWithdraw.instructions], { skip: [vWithdraw.named.createUsdcAta] });
  check(!err && assetsBalance() - beforeAssets === 400_000_000n, `the vault withdraws 400 back into its assets account (${beforeAssets} -> ${assetsBalance()})`, err);
  const after = await vaultProgram.coder.accounts.decode("vault", Buffer.from(vm.getAccount(address(vPda.toBase58())).data));
  check(BigInt(after.lastMoveAt.toString()) === BigInt(vm.getClock().unixTimestamp), "the vault recorded the moves (last_move_at)");
  const expected = assetsBalance() + collateralOf(vCross) + collateralOf(vChild); // flat: collateral is the whole value
    const price = (expected * ONE) / supply;
  // Paused when price < high_water x 80%: a high-water mark a millionth either side of price / 80% pins the valuation.
  let limitHw = (price * 10_000n) / 8_000n;
  check(!(await drawdown(limitHw - limitHw / 1_000_000n)), `valued at ${expected} (USDC idle + Phoenix collateral): not paused just inside the 20% drawdown`);
  check(await drawdown(limitHw + limitHw / 1_000_000n), "and paused just past it");
  await writeVault({ ...(await readVault()), paused: false });

  // A window due within freeze_before: the vault refuses to move money until it's processed.
  await writeVault({ ...(await readVault()), nextWindowAt: new BN(Number(vm.getClock().unixTimestamp) + 3600) });
  err = await byProposal(rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: vAuth, traderAccount: vChild }, newPositionAuthority: traderKey.address }));
  check(/code: 6135 /.test(err ?? "") /* GovError::MovesFrozen */, "in the run-up to a window the vault refuses to move (MovesFrozen)", err ?? "it moved");
  // The same proposals for a vault: each instruction the vault signs grows by vault.execute's wrapping.
  const asStored = async (ixs) => Promise.all(ixs.map(async (ix) => { const w = await sf.asVault(net, { treasury: tPda }, vPda, web3Instruction(ix)); return { accounts: w.keys, data: w.data }; }));
  vaultSteps = {
    "fund": vDeposit.instructions,
    "open a subaccount": [rise.buildRegisterTraderIxResolved({ exchange, trader: { payer: tAuth, authority: vAuth, traderAccount: vChild }, maxPositions: 1n, traderPdaIndex: 0, traderSubaccountIndex: 1 }), rise.buildSyncParentToChildIxResolved({ exchange, trader: { authority: vAuth, parentTraderAccount: vCross, childTraderAccount: vChild } }), rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: vAuth, traderAccount: vChild }, newPositionAuthority: traderKey.address })],
    "appoint / remove": [rise.buildDelegateTraderIxResolved({ exchange, trader: { authority: vAuth, traderAccount: vChild }, newPositionAuthority: traderKey.address })],
    "withdraw": [rise.buildTransferCollateralChildToParentIxResolved({ exchange, trader: { authority: vAuth, childTraderAccount: vChild, parentTraderAccount: vCross } }), ...vWithdraw.instructions.filter((ix) => ix !== vWithdraw.named.createUsdcAta)],
  };
  for (const [k, ixs] of Object.entries(vaultSteps)) vaultSteps[k] = await asStored(ixs);
}

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
for (const [step, ixs] of Object.entries(vaultSteps ?? {})) console.log(`    a vault's proposal "${step}": ${ixs.length} instruction(s), ${storedBytes(ixs)} bytes stored${storedBytes(ixs) <= 876 ? "" : " - needs v1 transactions"}`);

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll Phoenix flow checks passed.");
process.exit(failures ? 1 : 0);
