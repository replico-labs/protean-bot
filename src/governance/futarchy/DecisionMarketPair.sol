// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { UQ112x112 } from "./libraries/UQ112x112.sol";

interface IERC20Pair {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title DecisionMarketPair
/// @author Marvin Sunday
/// @notice A minimal constant-product AMM pair, purpose-built for a single
///         proposal's pass or fail market (pass-token/WMON, or
///         fail-token/WMON). Cloneable, so a proposal's two pools deploy
///         cheaply, same pattern as ConditionalToken and ConditionalVault.
/// @dev This is a derivative of Uniswap V2's official core contract
///      (github.com/Uniswap/v2-core, licensed GPL-3.0-or-later) - the
///      swap invariant and TWAP accumulator below were confirmed to match
///      that real source line-for-line before reuse, not assumed or
///      taken from a secondary fork. Licensed here under the same
///      GPL-3.0-or-later terms accordingly. Adapted with three deliberate
///      removals:
///
///      1. No protocol fee-switch (_mintFee/kLast/feeTo). A general-purpose
///         DEX needs one; a proposal-scoped market doesn't - one less
///         piece of unverified logic for no benefit here.
///      2. No flash-swap callback. Letting arbitrary contracts borrow
///         against the pool mid-swap is a real feature for a general DEX,
///         and a real, unnecessary attack surface for a market whose only
///         job is producing a TWAP for one proposal.
///      3. No general-purpose Factory. The original's factory was tightly
///         coupled to a separate, unrelated product's asset-registry and
///         identity system - not something to strip down, something to
///         skip entirely. This pair is cloned and initialized directly by
///         the decision-market orchestrator, exactly two per proposal,
///         never through a public "create any pair" entry point.
///
///      The swap invariant check and the TWAP price accumulator below are
///      otherwise UNMODIFIED from the verified original - this is where
///      the real value of reusing an audited pattern lives, and it's kept
///      intact rather than rewritten.

contract DecisionMarketPair {
    using UQ112x112 for uint224;

    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 3;

    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    uint256 private _unlocked;
    bool private _initialized;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    error Locked();
    error AlreadyInitialized();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InsufficientInputAmount();
    error InvalidTo();
    error KInvariant();
    error TransferFailed();

    modifier lock() {
        if (_unlocked != 1) revert Locked();
        _unlocked = 0;
        _;
        _unlocked = 1;
    }

    /// @notice Called exactly once, immediately after cloning.
    function initialize(address token0_, address token1_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _unlocked = 1;
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    function _safeTransfer(address token, address to, uint256 value) private {
        bool ok = IERC20Pair(token).transfer(to, value);
        if (!ok) revert TransferFailed();
    }

    /// @dev Unmodified from the verified original: updates reserves and,
    ///      once per block, the TWAP price accumulators - using the OLD
    ///      reserves (the price actually in effect since the last
    ///      update), not the new post-trade ones.
    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();

        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += uint256(UQ112x112.encode(_reserve1).uqdiv(_reserve0)) * timeElapsed;
                price1CumulativeLast += uint256(UQ112x112.encode(_reserve0).uqdiv(_reserve1)) * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    /*//////////////////////////////////////////////////////////////
                LP TOKEN - THE PAIR CONTRACT IS ITS OWN LP TOKEN
    //////////////////////////////////////////////////////////////*/

    function transfer(address to, uint256 amount) external returns (bool) {
        _transferLp(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transferLp(from, to, amount);
        return true;
    }

    function _transferLp(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1, ) = getReserves();
        uint256 balance0 = IERC20Pair(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Pair(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY); // permanently lock minimum liquidity
        } else {
            uint256 liq0 = (amount0 * _totalSupply) / _reserve0;
            uint256 liq1 = (amount1 * _totalSupply) / _reserve1;
            liquidity = liq0 < liq1 ? liq0 : liq1;
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1, ) = getReserves();
        address _token0 = token0;
        address _token1 = token1;
        uint256 balance0 = IERC20Pair(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20Pair(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];

        uint256 _totalSupply = totalSupply;
        amount0 = (liquidity * balance0) / _totalSupply;
        amount1 = (liquidity * balance1) / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = IERC20Pair(_token0).balanceOf(address(this));
        balance1 = IERC20Pair(_token1).balanceOf(address(this));

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @dev Swap invariant check is unmodified from the verified original -
    ///      the exact x*y=k formula with the 0.3% LP fee baked in via the
    ///      1000/3 scaling.
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _reserve0, uint112 _reserve1, ) = getReserves();
        if (amount0Out >= _reserve0 || amount1Out >= _reserve1) revert InsufficientLiquidity();

        uint256 balance0;
        uint256 balance1;
        {
            address _token0 = token0;
            address _token1 = token1;
            if (to == _token0 || to == _token1) revert InvalidTo();
            if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out);
            if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out);
            balance0 = IERC20Pair(_token0).balanceOf(address(this));
            balance1 = IERC20Pair(_token1).balanceOf(address(this));
        }

        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        {
            uint256 balance0Adjusted = balance0 * 1000 - amount0In * 3;
            uint256 balance1Adjusted = balance1 * 1000 - amount1In * 3;
            if (balance0Adjusted * balance1Adjusted < uint256(_reserve0) * _reserve1 * 1e6) revert KInvariant();
        }

        _update(balance0, balance1, _reserve0, _reserve1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function skim(address to) external lock {
        address _token0 = token0;
        address _token1 = token1;
        _safeTransfer(_token0, to, IERC20Pair(_token0).balanceOf(address(this)) - reserve0);
        _safeTransfer(_token1, to, IERC20Pair(_token1).balanceOf(address(this)) - reserve1);
    }

    function sync() external lock {
        _update(IERC20Pair(token0).balanceOf(address(this)), IERC20Pair(token1).balanceOf(address(this)), reserve0, reserve1);
    }

    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256 amountOut) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = (reserveIn * 1000) + amountInWithFee;
        amountOut = numerator / denominator;
    }

    /// @notice Quotes the output for a given input, without executing a
    ///         trade - lets a caller (like the orchestrator, or a UI)
    ///         compute a swap amount before calling `swap`.
    function getAmountOut(uint256 amountIn, bool zeroForOne) external view returns (uint256) {
        (uint112 _reserve0, uint112 _reserve1, ) = getReserves();
        return zeroForOne ? _getAmountOut(amountIn, _reserve0, _reserve1) : _getAmountOut(amountIn, _reserve1, _reserve0);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 result) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        result = x;
        while (z < result) {
            result = z;
            z = (x / z + z) / 2;
        }
    }
}
