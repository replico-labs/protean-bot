// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {WMON} from "../src/governance/futarchy/WMON.sol";

contract WMONTest is Test {
    WMON internal wmon;
    address internal alice = makeAddr("alice");

    function setUp() public {
        wmon = new WMON();
        vm.deal(alice, 10 ether);
    }

    function test_Deposit_MintsEqualBalance() public {
        vm.prank(alice);
        wmon.deposit{value: 5 ether}();

        assertEq(wmon.balanceOf(alice), 5 ether);
        assertEq(wmon.totalSupply(), 5 ether);
        assertEq(address(wmon).balance, 5 ether);
    }

    function test_Receive_ActsAsDeposit() public {
        vm.prank(alice);
        (bool ok, ) = address(wmon).call{value: 3 ether}("");
        assertTrue(ok);

        assertEq(wmon.balanceOf(alice), 3 ether);
    }

    function test_Withdraw_BurnsAndReturnsNative() public {
        vm.startPrank(alice);
        wmon.deposit{value: 5 ether}();
        uint256 nativeBefore = alice.balance;

        wmon.withdraw(2 ether);
        vm.stopPrank();

        assertEq(wmon.balanceOf(alice), 3 ether);
        assertEq(alice.balance, nativeBefore + 2 ether);
    }

    function test_Withdraw_RevertsOnInsufficientBalance() public {
        vm.prank(alice);
        vm.expectRevert(WMON.InsufficientBalance.selector);
        wmon.withdraw(1 ether);
    }

    function test_TransferAndTransferFrom_StandardERC20Behavior() public {
        address bob = makeAddr("bob");
        vm.prank(alice);
        wmon.deposit{value: 5 ether}();

        vm.prank(alice);
        wmon.transfer(bob, 2 ether);
        assertEq(wmon.balanceOf(bob), 2 ether);
        assertEq(wmon.balanceOf(alice), 3 ether);

        vm.prank(bob);
        wmon.approve(alice, 1 ether);
        vm.prank(alice);
        wmon.transferFrom(bob, alice, 1 ether);
        assertEq(wmon.balanceOf(bob), 1 ether);
        assertEq(wmon.balanceOf(alice), 4 ether);
    }
}
