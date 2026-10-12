// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConditionalVault} from "../src/governance/futarchy/ConditionalVault.sol";
import {ConditionalToken} from "../src/governance/futarchy/ConditionalToken.sol";

/// @dev Minimal mock ERC20 standing in for the real underlying token
///      (governance token or WMON).
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

contract ConditionalVaultTest is Test {
    ConditionalVault internal vaultImpl;
    ConditionalVault internal vault;
    ConditionalToken internal tokenImpl;
    MockERC20 internal underlying;

    address internal oracle = makeAddr("oracle"); // the decision-market orchestrator, in real use
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        underlying = new MockERC20();
        tokenImpl = new ConditionalToken();
        vault = new ConditionalVault();

        vault.initialize(
            address(underlying),
            oracle,
            address(tokenImpl),
            "Pass Token",
            "pTKN",
            "Fail Token",
            "fTKN"
        );

        underlying.mint(alice, 1_000 ether);
        underlying.mint(bob, 1_000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    function test_Initialize_RevertsOnDoubleInit() public {
        vm.expectRevert(ConditionalVault.AlreadyInitialized.selector);
        vault.initialize(address(underlying), oracle, address(tokenImpl), "P", "P", "F", "F");
    }

    function test_Initialize_DeploysDistinctConditionalTokens() public view {
        assertTrue(address(vault.passToken()) != address(0));
        assertTrue(address(vault.failToken()) != address(0));
        assertTrue(address(vault.passToken()) != address(vault.failToken()));
    }

    /*//////////////////////////////////////////////////////////////
                            SPLIT TOKENS
    //////////////////////////////////////////////////////////////*/

    function test_SplitTokens_MintsEqualPassAndFail() public {
        vm.startPrank(alice);
        underlying.approve(address(vault), 100 ether);
        vault.splitTokens(100 ether);
        vm.stopPrank();

        assertEq(vault.passToken().balanceOf(alice), 100 ether);
        assertEq(vault.failToken().balanceOf(alice), 100 ether);
        assertEq(underlying.balanceOf(address(vault)), 100 ether);
        assertEq(underlying.balanceOf(alice), 900 ether);
    }

    function test_SplitTokens_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(ConditionalVault.ZeroAmount.selector);
        vault.splitTokens(0);
    }

    /*//////////////////////////////////////////////////////////////
                            MERGE TOKENS
    //////////////////////////////////////////////////////////////*/

    function _split(address account, uint256 amount) internal {
        vm.startPrank(account);
        underlying.approve(address(vault), amount);
        vault.splitTokens(amount);
        vm.stopPrank();
    }

    function test_MergeTokens_BurnsEqualAndReturnsUnderlying() public {
        _split(alice, 100 ether);

        vm.prank(alice);
        vault.mergeTokens(60 ether);

        assertEq(vault.passToken().balanceOf(alice), 40 ether);
        assertEq(vault.failToken().balanceOf(alice), 40 ether);
        assertEq(underlying.balanceOf(alice), 900 ether + 60 ether);
    }

    function test_MergeTokens_RevertsAfterResolution() public {
        _split(alice, 100 ether);

        vm.prank(oracle);
        vault.resolve(1, 0);

        vm.prank(alice);
        vm.expectRevert(ConditionalVault.AlreadyResolved.selector);
        vault.mergeTokens(50 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                RESOLVE
    //////////////////////////////////////////////////////////////*/

    function test_Resolve_OnlyOracle() public {
        vm.prank(alice);
        vm.expectRevert(ConditionalVault.Unauthorized.selector);
        vault.resolve(1, 0);
    }

    function test_Resolve_RevertsOnDoubleResolve() public {
        vm.prank(oracle);
        vault.resolve(1, 0);

        vm.prank(oracle);
        vm.expectRevert(ConditionalVault.AlreadyResolved.selector);
        vault.resolve(1, 0);
    }

    function test_Resolve_RevertsOnZeroNumerators() public {
        vm.prank(oracle);
        vm.expectRevert(ConditionalVault.InvalidPayoutNumerators.selector);
        vault.resolve(0, 0);
    }

    /*//////////////////////////////////////////////////////////////
        REDEEM - THE ACTUAL POINT: WINNING SIDE PAYS, LOSING SIDE DOESN'T
    //////////////////////////////////////////////////////////////*/

    function test_Redeem_RevertsBeforeResolution() public {
        _split(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(ConditionalVault.NotResolved.selector);
        vault.redeemTokens();
    }

    function test_Redeem_PassWinnerGetsFullPayout() public {
        _split(alice, 100 ether); // alice holds 100 pass + 100 fail

        vm.prank(oracle);
        vault.resolve(1, 0); // pass wins cleanly

        uint256 before = underlying.balanceOf(alice);
        vm.prank(alice);
        vault.redeemTokens();

        // Both sides burned, but only pass balance contributed to payout.
        assertEq(vault.passToken().balanceOf(alice), 0);
        assertEq(vault.failToken().balanceOf(alice), 0);
        assertEq(underlying.balanceOf(alice), before + 100 ether);
    }

    function test_Redeem_FailLoserGetsNothing() public {
        // Bob only ever holds fail-side tokens by the time of redemption -
        // simulating having traded away all pass-tokens during the market.
        _split(bob, 100 ether);

        vm.prank(oracle);
        vault.resolve(1, 0); // pass wins - bob's fail tokens are now worthless

        // Manually zero out bob's pass balance to simulate "traded it all
        // away" - transfer to alice so bob is left holding only fail.
        ConditionalToken passTok = vault.passToken();
        vm.prank(bob);
        passTok.transfer(alice, 100 ether);

        uint256 before = underlying.balanceOf(bob);
        vm.prank(bob);
        vault.redeemTokens();

        // Bob's remaining 100 fail-tokens contributed zero to the payout.
        assertEq(underlying.balanceOf(bob), before);
        assertEq(vault.failToken().balanceOf(bob), 0); // still burned, just worth nothing
    }

    function test_Redeem_RevertsWithNothingToRedeem() public {
        vm.prank(oracle);
        vault.resolve(1, 0);

        vm.prank(alice); // alice never split any tokens
        vm.expectRevert(ConditionalVault.NothingToRedeem.selector);
        vault.redeemTokens();
    }

    function test_Redeem_PartialNumeratorsSplitProportionally() public {
        _split(alice, 100 ether);

        // A non-clean resolution: pass gets 70%, fail gets 30%.
        vm.prank(oracle);
        vault.resolve(70, 30);

        uint256 before = underlying.balanceOf(alice);
        vm.prank(alice);
        vault.redeemTokens();

        // (100*70 + 100*30) / 100 = 100 - holding both sides equally
        // under a 70/30 split is equivalent to just getting everything
        // back, since 70+30=100% represented across the pair.
        assertEq(underlying.balanceOf(alice), before + 100 ether);
    }
}
