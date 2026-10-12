/**
 * Uniswap v4 price/liquidity math, ported line for line from the official
 * sources (bigint in place of uint256):
 *   v4-core src/libraries/TickMath.sol          getSqrtPriceAtTick
 *   v4-periphery src/libraries/LiquidityAmounts.sol
 *   v4-core src/libraries/SqrtPriceMath.sol     amount deltas (rounded down)
 * Tested against TickMath's own MIN/MAX_SQRT_PRICE constants and against
 * a real PositionManager in the integration test.
 */

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;

const TICK_FACTORS = [
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

export function getSqrtPriceAtTick(tick) {
  const absTick = BigInt(Math.abs(tick));
  if (absTick > BigInt(MAX_TICK)) throw new Error(`Tick ${tick} out of range`);
  let price = absTick & 1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, factor] of TICK_FACTORS) if (absTick & bit) price = (price * factor) >> 128n;
  if (tick > 0) price = MAX_UINT256 / price;
  return (price + ((1n << 32n) - 1n)) >> 32n;
}

/** Widest ticks a pool with this spacing accepts. */
export function fullRangeTicks(tickSpacing) {
  const lower = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const upper = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return [lower, upper];
}

function sortPrices(a, b) {
  return a > b ? [b, a] : [a, b];
}

function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  [sqrtA, sqrtB] = sortPrices(sqrtA, sqrtB);
  const intermediate = (sqrtA * sqrtB) / Q96;
  return (amount0 * intermediate) / (sqrtB - sqrtA);
}

function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  [sqrtA, sqrtB] = sortPrices(sqrtA, sqrtB);
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

export function getLiquidityForAmounts(sqrtPrice, sqrtA, sqrtB, amount0, amount1) {
  [sqrtA, sqrtB] = sortPrices(sqrtA, sqrtB);
  if (sqrtPrice <= sqrtA) return liquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtPrice < sqrtB) {
    const l0 = liquidityForAmount0(sqrtPrice, sqrtB, amount0);
    const l1 = liquidityForAmount1(sqrtA, sqrtPrice, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(sqrtA, sqrtB, amount1);
}

function amount0Delta(sqrtA, sqrtB, liquidity) {
  [sqrtA, sqrtB] = sortPrices(sqrtA, sqrtB);
  return (((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB) / sqrtA;
}

function amount1Delta(sqrtA, sqrtB, liquidity) {
  [sqrtA, sqrtB] = sortPrices(sqrtA, sqrtB);
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/** Token amounts a position of `liquidity` is worth at `sqrtPrice`, rounded down. */
export function getAmountsForLiquidity(sqrtPrice, sqrtA, sqrtB, liquidity) {
  [sqrtA, sqrtB] = sortPrices(sqrtA, sqrtB);
  if (sqrtPrice <= sqrtA) return [amount0Delta(sqrtA, sqrtB, liquidity), 0n];
  if (sqrtPrice < sqrtB) return [amount0Delta(sqrtPrice, sqrtB, liquidity), amount1Delta(sqrtA, sqrtPrice, liquidity)];
  return [0n, amount1Delta(sqrtA, sqrtB, liquidity)];
}

/** Integer square root (Newton), for turning a price into sqrtPriceX96. */
export function sqrtBigInt(n) {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** sqrtPriceX96 for a pool where 1 unit of currency0 costs `num/den` units of currency1 (raw base units). */
export function sqrtPriceX96FromRatio(num, den) {
  return sqrtBigInt((num << 192n) / den);
}
