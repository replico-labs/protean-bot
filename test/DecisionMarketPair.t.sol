// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DecisionMarketPair} from "../src/governance/futarchy/DecisionMarketPair.sol";

contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract DecisionMarketPairTest is Test {
    DecisionMarketPair internal pair;
    MockERC20 internal token0;
    MockERC20 internal token1;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        MockERC20 a = new MockERC20();
        MockERC20 b = new MockERC20();
        // Order deterministically so tests are stable regardless of
        // address randomness from makeAddr/deployment order.
        (token0, token1) = address(a) < address(b) ? (a, b) : (b, a);

        pair = new DecisionMarketPair();
        pair.initialize(address(token0), address(token1));
    }

    function _addLiquidity(address account, uint256 amount0, uint256 amount1) internal {
        token0.mint(account, amount0);
        token1.mint(account, amount1);
        vm.startPrank(account);
        token0.transfer(address(pair), amount0);
        token1.transfer(address(pair), amount1);
        pair.mint(account);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_Initialize_RevertsOnDoubleInit() public {
        vm.expectRevert(DecisionMarketPair.AlreadyInitialized.selector);
        pair.initialize(address(token0), address(token1));
    }

    /*//////////////////////////////////////////////////////////////
                                MINT
    //////////////////////////////////////////////////////////////*/

    function test_Mint_InitialLiquidityLocksMinimum() public {
        _addLiquidity(alice, 100 ether, 100 ether);

        // sqrt(100e18 * 100e18) - 1000 = 100e18 - 1000
        assertEq(pair.balanceOf(alice), 100 ether - 1000);
        assertEq(pair.balanceOf(address(0xdead)), 1000);
        assertEq(pair.totalSupply(), 100 ether);
    }

    function test_Mint_SubsequentMintIsProportional() public {
        _addLiquidity(alice, 100 ether, 100 ether);
        _addLiquidity(bob, 50 ether, 50 ether); // half the pool's existing ratio

        // Bob should get half of alice's post-mint LP balance, since he
        // added exactly half the pool's reserves at the time.
        uint256 totalAfterAlice = 100 ether;
        uint256 expectedBobLiquidity = (50 ether * totalAfterAlice) / 100 ether;
        assertEq(pair.balanceOf(bob), expectedBobLiquidity);
    }

   function test_Mint_RevertsOnZeroDeposit() public {
        // A truly empty deposit underflows in the sqrt(0*0) - MINIMUM_LIQUIDITY
        // step before ever reaching the custom error check - this matches the
       // real, original Uniswap V2 pattern's actual behavior in this exact
      // edge case, not something introduced by stripping this version down.
       vm.expectRevert(); // arithmetic underflow panic, not a custom error
       pair.mint(alice);
    }

    function test_Mint_RevertsOnInsufficientLiquidityMinted() public {
        // A deposit small enough that sqrt(amount0*amount1) equals exactly
        // MINIMUM_LIQUIDITY (1000) - liquidity comes out to exactly zero
        // without underflowing, correctly reaching the intended custom error.
        token0.mint(alice, 1000);
        token1.mint(alice, 1000);
        vm.startPrank(alice);
        token0.transfer(address(pair), 1000);
        token1.transfer(address(pair), 1000);
        vm.expectRevert(DecisionMarketPair.InsufficientLiquidityMinted.selector);
        pair.mint(alice);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                SWAP
    //////////////////////////////////////////////////////////////*/

    function test_Swap_ProducesCorrectOutputAmount() public {
        _addLiquidity(alice, 1_000 ether, 1_000 ether);

        uint256 amountIn = 100 ether;
        token0.mint(bob, amountIn);
        vm.prank(bob);
        token0.transfer(address(pair), amountIn);

        uint256 expectedOut = pair.getAmountOut(amountIn, true);

        vm.prank(bob);
        pair.swap(0, expectedOut, bob);

        assertEq(token1.balanceOf(bob), expectedOut);
    }

    function test_Swap_RevertsOnInsufficientOutputAmount() public {
        _addLiquidity(alice, 1_000 ether, 1_000 ether);
        vm.expectRevert(DecisionMarketPair.InsufficientOutputAmount.selector);
        pair.swap(0, 0, bob);
    }

    function test_Swap_RevertsWhenRequestingMoreThanReserves() public {
        _addLiquidity(alice, 1_000 ether, 1_000 ether);
        vm.expectRevert(DecisionMarketPair.InsufficientLiquidity.selector);
        pair.swap(0, 1_000 ether, bob); // requesting the entire reserve
    }

    /// @dev The actual K-invariant enforcement, tested by attempting to
    ///      take out MORE than the fee-adjusted constant-product formula
    ///      allows for a given input - this must revert regardless of
    ///      what the caller claims, proving the invariant check is real
    ///      and not just trusting the caller's input.
    function test_Swap_RevertsOnKInvariantViolation() public {
        _addLiquidity(alice, 1_000 ether, 1_000 ether);

        uint256 amountIn = 100 ether;
        token0.mint(bob, amountIn);
        vm.prank(bob);
        token0.transfer(address(pair), amountIn);

        uint256 correctOut = pair.getAmountOut(amountIn, true);

        vm.prank(bob);
        vm.expectRevert(DecisionMarketPair.KInvariant.selector);
        pair.swap(0, correctOut + 1 ether, bob); // demanding more than the formula allows
    }

    /*//////////////////////////////////////////////////////////////
                                BURN
    //////////////////////////////////////////////////////////////*/

    function test_Burn_ReturnsProportionalReserves() public {
        _addLiquidity(alice, 1_000 ether, 1_000 ether);

        uint256 aliceLp = pair.balanceOf(alice);
        vm.prank(alice);
        pair.transfer(address(pair), aliceLp);

        vm.prank(alice);
        (uint256 amount0, uint256 amount1) = pair.burn(alice);

        // Alice gets back essentially everything she put in, minus the
        // small permanently-locked MINIMUM_LIQUIDITY share.
        assertApproxEqAbs(amount0, 1_000 ether, 1000);
        assertApproxEqAbs(amount1, 1_000 ether, 1000);
    }

    /*//////////////////////////////////////////////////////////////
        TWAP ACCUMULATOR - HAND-VERIFIED, NOT JUST TRUSTED BY INSPECTION
    //////////////////////////////////////////////////////////////*/

    function test_TWAP_AccumulatesExactlyPriceTimesElapsedTime() public {
        // Equal reserves -> price ratio is exactly 1 (2^112 in UQ112x112
        // fixed-point encoding), making the expected accumulator value
        // simple to compute by hand and check exactly.
        _addLiquidity(alice, 100 ether, 100 ether);

        uint256 startTimestamp = vm.getBlockTimestamp();
        uint256 elapsed = 100;
        vm.warp(startTimestamp + elapsed);

        // sync() triggers _update() without changing reserves - a clean
        // way to force an accumulator update for this check.
        pair.sync();

        uint256 Q112 = 2 ** 112;
        uint256 expectedPrice0Cumulative = Q112 * elapsed; // ratio is 1:1, times elapsed seconds

        assertEq(pair.price0CumulativeLast(), expectedPrice0Cumulative);
        assertEq(pair.price1CumulativeLast(), expectedPrice0Cumulative); // symmetric, since reserves are equal
    }

    function test_TWAP_DoesNotAccumulateTwiceInSameBlock() public {
        _addLiquidity(alice, 100 ether, 100 ether);
        vm.warp(vm.getBlockTimestamp() + 50);

        pair.sync(); // first update this block
        uint256 afterFirst = pair.price0CumulativeLast();

        pair.sync(); // second update, same timestamp - no time has elapsed
        uint256 afterSecond = pair.price0CumulativeLast();

        assertEq(afterFirst, afterSecond);
    }

    function test_TWAP_UsesOldReservesNotNewOnesForTheJustElapsedWindow() public {
        _addLiquidity(alice, 100 ether, 100 ether); // 1:1 ratio initially

        vm.warp(vm.getBlockTimestamp() + 100);

        // A swap changes the reserves - but the 100 seconds that just
        // elapsed were under the OLD 1:1 ratio, not the new post-swap one.
        uint256 amountIn = 100 ether;
        token0.mint(bob, amountIn);
        vm.prank(bob);
        token0.transfer(address(pair), amountIn);
        uint256 out = pair.getAmountOut(amountIn, true);
        vm.prank(bob);
        pair.swap(0, out, bob);

        uint256 Q112 = 2 ** 112;
        // Must reflect the OLD 1:1 ratio over the 100 elapsed seconds,
        // not the new, post-swap ratio.
        assertEq(pair.price0CumulativeLast(), Q112 * 100);
    }
}
