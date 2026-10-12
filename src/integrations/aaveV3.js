import { encodeFunctionData, getAddress, maxUint256, formatUnits } from "viem";
import { loadIntegrationAbi } from "./abis/index.js";
import {
  NATIVE, IntegrationError, checksummed, call, approveCall, resolveToken, parseAmount, formatAmount, requireCode,
} from "./common.js";

/**
 * Aave v3 lending - supply (deposit/lend), withdraw, borrow, repay and
 * collateral on/off - called by the Treasury straight on the Pool (no
 * callback or signature is involved, so no wrapper contract is needed).
 * The Treasury is always onBehalfOf / to: positions, aTokens and debt
 * belong to it.
 *
 * Native currency: where the market's WETH reserve is the chain's
 * wrapped native (Base), "ETH"/"native" is wrapped (WETH.deposit) before
 * supplying/repaying and unwrapped (WETH.withdraw) after borrowing or
 * withdrawing an exact amount - the Pool itself only takes ERC20s. Aave's
 * WrappedTokenGateway isn't used: its function signatures changed between
 * versions and the deployed one per chain isn't pinned in any source.
 * Monad's market has no wrapped-MON reserve, so MON can't be supplied.
 *
 * makeAaveModule() is reused for Aave forks with the same Pool interface
 * (HyperLend - see hyperlend.js).
 */

const ABIS = loadIntegrationAbi("aaveV3");
const VARIABLE_RATE = 2n; // stable rate is deprecated in v3; variable is the only borrow mode

export const verifyLinks = [
  ["pool", "ADDRESSES_PROVIDER", "addressesProvider"],
  ["addressesProvider", "getPool", "pool"],
];

export function makeAaveModule({ id, name, prefix, deployments, resolve }) {
  const protocol = { id, name, category: "Lending", deployments };

  /** The deployment; `resolve` (optional) fills in pool/tokens from the chain for markets pinned by a registry. */
  async function deployment(ctx) {
    const d = deployments[ctx.network.id];
    if (!d) throw new IntegrationError(`${name} isn't set up for ${ctx.network.chain.name}.`);
    return resolve ? resolve(ctx, checksummed(d)) : checksummed(d);
  }

  /** The reserve for a token word, plus whether native had to be mapped to the wrapped reserve. */
  function reserveFor(ctx, d, word) {
    const token = resolveToken(word, ctx, d.tokens);
    if (token === NATIVE) {
      if (!d.wrappedNative) throw new IntegrationError(`${name} on ${ctx.network.chain.name} has no ${ctx.network.nativeSymbol} reserve - supply a token it lists instead.`);
      return { asset: getAddress(d.wrappedNative), native: true };
    }
    const listed = Object.values(d.tokens).some((t) => t.toLowerCase() === token.toLowerCase());
    if (!listed) {
      throw new IntegrationError(`${word} isn't a reserve of ${name} on ${ctx.network.chain.name}. Reserves: ${Object.keys(d.tokens).join(", ")}.`);
    }
    return { asset: token, native: false };
  }

  const wrap = (d, amount) => call(d.wrappedNative, encodeFunctionData({ abi: ABIS.wrappedNative, functionName: "deposit" }), { value: amount, note: "wrap native" });
  const unwrap = (d, amount) => call(d.wrappedNative, encodeFunctionData({ abi: ABIS.wrappedNative, functionName: "withdraw", args: [amount] }), { note: "unwrap native" });

  async function accountLine(ctx, d) {
    try {
      const [collateral, debt, available, , , healthFactor] = await ctx.publicClient.readContract({ address: d.pool, abi: ABIS.pool, functionName: "getUserAccountData", args: [ctx.treasury] });
      const usd = (v) => `$${Number(formatUnits(v, 8)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
      const hf = debt === 0n ? "no debt" : Number(formatUnits(healthFactor, 18)).toFixed(2);
      return ` Treasury on ${name} now: ${usd(collateral)} collateral, ${usd(debt)} debt, ${usd(available)} more borrowable, health factor ${hf}.`;
    } catch {
      return "";
    }
  }

  const amountOrAll = async (ctx, token, text, verb) => {
    if (String(text).toLowerCase() === "all" || String(text).toLowerCase() === "max") return { amount: maxUint256, all: true };
    return { amount: await parseAmount(ctx, token, text), all: false };
  };

  const actions = [
    {
      id: `${prefix}-supply`,
      label: `Supply (deposit/lend) a token to ${name}`,
      usage: ["token", "amount"],
      options: [],
      async build(ctx) {
        const d = await deployment(ctx);
        const { asset, native } = reserveFor(ctx, d, ctx.args[0]);
        const amount = await parseAmount(ctx, native ? NATIVE : asset, ctx.args[1]);
        await requireCode(ctx, { Pool: d.pool });
        return {
          calls: [
            ...(native ? [wrap(d, amount)] : []),
            approveCall(asset, d.pool, amount, "approve Pool"),
            call(d.pool, encodeFunctionData({ abi: ABIS.pool, functionName: "supply", args: [asset, amount, ctx.treasury, 0] }), { note: "supply" }),
          ],
          summary: `Supply ${await formatAmount(ctx, native ? NATIVE : asset, amount)} to ${name}; the Treasury receives the interest-bearing aToken.${await accountLine(ctx, d)}`,
        };
      },
    },
    {
      id: `${prefix}-withdraw`,
      label: `Withdraw a supplied token from ${name}`,
      usage: ["token", "amount|all"],
      options: [],
      async build(ctx) {
        const d = await deployment(ctx);
        const { asset, native } = reserveFor(ctx, d, ctx.args[0]);
        const { amount, all } = await amountOrAll(ctx, native ? NATIVE : asset, ctx.args[1]);
        await requireCode(ctx, { Pool: d.pool });
        const calls = [call(d.pool, encodeFunctionData({ abi: ABIS.pool, functionName: "withdraw", args: [asset, amount, ctx.treasury] }), { note: "withdraw" })];
        let tail = "";
        if (native && !all) calls.push(unwrap(d, amount));
        if (native && all) tail = " It arrives as WETH (an unknown final amount can't be unwrapped in the same proposal).";
        return {
          calls,
          summary: `Withdraw ${all ? "everything supplied" : await formatAmount(ctx, native ? NATIVE : asset, amount)} of ${native ? ctx.network.nativeSymbol : await tokenLabel(ctx, asset)} from ${name} to the Treasury.${tail}${await accountLine(ctx, d)}`,
        };
      },
    },
    {
      id: `${prefix}-borrow`,
      label: `Borrow a token from ${name} against the Treasury's collateral`,
      usage: ["token", "amount"],
      options: [],
      help: "Variable rate. Borrowing needs collateral already supplied (and enabled as collateral); if the health factor falls to 1 the position can be liquidated.",
      async build(ctx) {
        const d = await deployment(ctx);
        const { asset, native } = reserveFor(ctx, d, ctx.args[0]);
        const amount = await parseAmount(ctx, native ? NATIVE : asset, ctx.args[1]);
        await requireCode(ctx, { Pool: d.pool });
        return {
          calls: [
            call(d.pool, encodeFunctionData({ abi: ABIS.pool, functionName: "borrow", args: [asset, amount, VARIABLE_RATE, 0, ctx.treasury] }), { note: "borrow" }),
            ...(native ? [unwrap(d, amount)] : []),
          ],
          summary: `Borrow ${await formatAmount(ctx, native ? NATIVE : asset, amount)} from ${name} at the variable rate, into the Treasury.${await accountLine(ctx, d)}`,
        };
      },
    },
    {
      id: `${prefix}-repay`,
      label: `Repay a ${name} loan`,
      usage: ["token", "amount|all"],
      options: [],
      async build(ctx) {
        const d = await deployment(ctx);
        const { asset, native } = reserveFor(ctx, d, ctx.args[0]);
        const { amount, all } = await amountOrAll(ctx, native ? NATIVE : asset, ctx.args[1]);
        if (native && all) throw new IntegrationError(`To repay all of a ${ctx.network.nativeSymbol} loan, give an amount a little above the debt (the rest stays in the Treasury as WETH), or repay with WETH all.`);
        await requireCode(ctx, { Pool: d.pool });
        const calls = [
          ...(native ? [wrap(d, amount)] : []),
          // "all": interest keeps accruing until execution, so the Pool is
          // allowed to take whatever the debt is then - and the allowance is
          // reset to zero straight after.
          approveCall(asset, d.pool, amount, "approve Pool"),
          call(d.pool, encodeFunctionData({ abi: ABIS.pool, functionName: "repay", args: [asset, amount, VARIABLE_RATE, ctx.treasury] }), { note: "repay" }),
          ...(all ? [approveCall(asset, d.pool, 0n, "reset allowance")] : []),
        ];
        return {
          calls,
          summary: `Repay ${all ? "the whole" : await formatAmount(ctx, native ? NATIVE : asset, amount)} ${all ? `${await tokenLabel(ctx, asset)} loan` : ""} on ${name} from the Treasury.${await accountLine(ctx, d)}`.replace(/  +/g, " "),
        };
      },
    },
    {
      id: `${prefix}-collateral`,
      label: `Turn a supplied token's use as ${name} collateral on or off`,
      usage: ["token", "on|off"],
      options: [],
      async build(ctx) {
        const d = await deployment(ctx);
        const { asset } = reserveFor(ctx, d, ctx.args[0]);
        const mode = String(ctx.args[1]).toLowerCase();
        if (mode !== "on" && mode !== "off") throw new IntegrationError('Second argument must be "on" or "off".');
        await requireCode(ctx, { Pool: d.pool });
        return {
          calls: [call(d.pool, encodeFunctionData({ abi: ABIS.pool, functionName: "setUserUseReserveAsCollateral", args: [asset, mode === "on"] }), { note: "collateral" })],
          summary: `Turn ${await tokenLabel(ctx, asset)} collateral ${mode} for the Treasury on ${name}.${await accountLine(ctx, d)}`,
        };
      },
    },
  ];

  return { protocol, actions, verifyLinks };
}

async function tokenLabel(ctx, token) {
  return (await formatAmount(ctx, token, 0n)).replace(/^0 /, "");
}

const aave = makeAaveModule({
  id: "aave-v3",
  name: "Aave v3",
  prefix: "aave",
  deployments: {
    "monad-mainnet": {
      pool: "0x69a5f9ad4f96ebf0a0c792dd42a01cc5c0102fef",
      addressesProvider: "0x34793fb9935f7bb5e5ae920fb963f39063e7a615",
      tokens: {
        USDT0: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
        USDC: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
        USDe: "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34",
        mUSD: "0xaca92e438df0b2401ff60da7e4337b687a2435da",
        AUSD: "0x00000000efe302beaa2b3e6e1b18d08d69a9012a",
        WETH: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
        cbBTC: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
        wstETH: "0x10aeaf63194db8d453d4d85a06e5efe1dd0b5417",
        weETH: "0xa3d68b74bf0528fdd07263c60d6488749044914b",
        syrupUSDC: "0xab6e5a0c3799d020c790d34f7b2c02639e238af7",
        sUSDe: "0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2",
        GHO: "0xfc421ad3c883bf9e7c4f42de845c4e4405799e73",
        PT_AUSD_8OCT2026: "0x9fc74f8ed616b5baf52a170caa97d6d3898602d1",
      },
      sources: ["github.com/bgd-labs/aave-address-book src/AaveV3Monad.sol + src/ts/AaveV3Monad.ts (main)","monad-crypto/protocols mainnet registry (Aave V3 POOL, POOL_ADDRESSES_PROVIDER)"],
    },
    "base": {
      pool: "0xa238dd80c259a72e81d7e4664a9801593f98d1c5",
      addressesProvider: "0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d",
      // Native ETH is supplied/borrowed as this WETH reserve (wrapped/unwrapped around the Pool call).
      wrappedNative: "0x4200000000000000000000000000000000000006",
      tokens: {
        WETH: "0x4200000000000000000000000000000000000006",
        cbETH: "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22",
        USDbC: "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca",
        wstETH: "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452",
        USDC: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        weETH: "0x04c0599ae5a44757c0af6f9ec3b93da8976c150a",
        cbBTC: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
        ezETH: "0x2416092f143378750bb29b79ed961ab195cceea5",
        GHO: "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee",
        wrsETH: "0xedfa23602d0ec14714057867a78d01e94176bea0",
        LBTC: "0xecac9c5f704e954931349da37f60e39f515c11c1",
        EURC: "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
        AAVE: "0x63706e401c06ac8513145b7687a14804d17f814b",
        tBTC: "0x236aa50979d5f3de3bd1eeb40e81137f22ab794b",
        syrupUSDC: "0x660975730059246a68521a3e2fbd4740173100f5",
      },
      sources: ["@bgd-labs/aave-address-book@4.44.22 AaveV3Base"],
    },
    "base-sepolia": {
      pool: "0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27",
      addressesProvider: "0xe4c23309117aa30342bfaae6c95c6478e0a4ad00",
      // Native ETH is supplied/borrowed as this WETH reserve (wrapped/unwrapped around the Pool call).
      wrappedNative: "0x4200000000000000000000000000000000000006",
      tokens: {
        USDC: "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f",
        USDT: "0x0a215d8ba66387dca84b284d18c3b4ec3de6e54a",
        WBTC: "0x54114591963cf60ef3aa63befd6ec263d98145a4",
        WETH: "0x4200000000000000000000000000000000000006",
        cbETH: "0xd171b9694f7a2597ed006d41f7509aad4b485c4b",
        LINK: "0x810d46f9a9027e28f9b01f75e2bdde839da61115",
      },
      sources: ["@bgd-labs/aave-address-book@4.44.22 AaveV3BaseSepolia"],
    },
  },
});

export const protocol = aave.protocol;
export const actions = aave.actions;
