// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract StakedGovernanceTokenTest is Test {
    GovernanceToken internal underlying;
    StakedGovernanceToken internal staked;

    address internal recipient = makeAddr("recipient");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant INITIAL_SUPPLY = 1_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000 ether;

    function setUp() public {
        underlying = GovernanceToken(Clones.clone(address(new GovernanceToken())));
        underlying.initialize("Test Token", "TT", INITIAL_SUPPLY, MAX_SUPPLY, recipient, owner);

        staked = StakedGovernanceToken(Clones.clone(address(new StakedGovernanceToken())));
        staked.initialize(address(underlying), "Staked Test Token", "sTT", address(this));

        vm.prank(recipient);
        underlying.transfer(alice, 500 ether);
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsUnderlying() public view {
        assertEq(address(staked.underlying()), address(underlying));
    }

    function test_Constructor_RevertsOnZeroUnderlying() public {
        StakedGovernanceToken freshStaked = StakedGovernanceToken(Clones.clone(address(new StakedGovernanceToken())));
        vm.expectRevert(StakedGovernanceToken.ZeroUnderlying.selector);
        freshStaked.initialize(address(0), "Staked Test Token", "sTT", address(this));
    }

    /*//////////////////////////////////////////////////////////////
                                STAKING
    //////////////////////////////////////////////////////////////*/

    function test_Stake_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(StakedGovernanceToken.ZeroAmount.selector);
        staked.stake(0);
    }

    function test_Stake_RevertsWithoutApproval() public {
        vm.prank(alice);
        vm.expectRevert();
        staked.stake(100 ether);
    }

    function test_Stake_PullsUnderlyingAndMintsStaked() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);
        vm.stopPrank();

        assertEq(underlying.balanceOf(alice), 300 ether);
        assertEq(underlying.balanceOf(address(staked)), 200 ether);
        assertEq(staked.balanceOf(alice), 200 ether);
    }

    function test_Stake_AutoDelegatesToSelfOnFirstStake() public {
        assertEq(staked.delegates(alice), address(0));

        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);
        vm.stopPrank();

        assertEq(staked.delegates(alice), alice);
        assertEq(staked.getVotes(alice), 200 ether);
    }

    function test_Stake_PreservesExistingDelegationOnSubsequentStakes() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 500 ether);
        staked.stake(100 ether);

        // Alice delegates elsewhere after her first stake.
        staked.delegate(bob);
        assertEq(staked.delegates(alice), bob);

        // A second stake must not silently override that choice back to
        // self-delegation.
        staked.stake(100 ether);
        vm.stopPrank();

        assertEq(staked.delegates(alice), bob);
        assertEq(staked.getVotes(bob), 200 ether);
        assertEq(staked.getVotes(alice), 0);
    }

    function test_Stake_EmitsStakedEvent() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);

        vm.expectEmit(true, false, false, true);
        emit StakedGovernanceToken.Staked(alice, 200 ether);
        staked.stake(200 ether);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                                UNSTAKING
    //////////////////////////////////////////////////////////////*/

    function test_Unstake_RevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(StakedGovernanceToken.ZeroAmount.selector);
        staked.unstake(0);
    }

    function test_Unstake_RevertsWithoutSufficientStakedBalance() public {
        vm.prank(alice);
        vm.expectRevert();
        staked.unstake(1 ether);
    }

    function test_Unstake_BurnsStakedAndReturnsUnderlying() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);

        staked.unstake(150 ether);
        vm.stopPrank();

        assertEq(staked.balanceOf(alice), 50 ether);
        assertEq(underlying.balanceOf(alice), 450 ether);
        assertEq(underlying.balanceOf(address(staked)), 50 ether);
    }

    function test_Unstake_ReducesVotingPower() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);
        staked.unstake(200 ether);
        vm.stopPrank();

        assertEq(staked.getVotes(alice), 0);
    }

    function test_Unstake_EmitsUnstakedEvent() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);

        vm.expectEmit(true, false, false, true);
        emit StakedGovernanceToken.Unstaked(alice, 200 ether);
        staked.unstake(200 ether);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
            HISTORICAL VOTE INTEGRITY (the whole point of this design)
    //////////////////////////////////////////////////////////////*/

    function test_GetPastVotes_UnaffectedByLaterUnstaking() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);
        vm.stopPrank();

        uint256 snapshotBlock = vm.getBlockNumber();
        vm.roll(vm.getBlockNumber() + 1);

        // Alice fully unstakes after the snapshot.
        vm.prank(alice);
        staked.unstake(200 ether);
        vm.roll(vm.getBlockNumber() + 1);

        // Her voting power right now is zero...
        assertEq(staked.getVotes(alice), 0);
        // ...but the historical snapshot is untouched - a proposal that
        // already recorded her vote or counted her toward quorum at that
        // block keeps that record intact.
        assertEq(staked.getPastVotes(alice, snapshotBlock), 200 ether);
    }

    function test_GetPastTotalSupply_ReflectsStakedSupplyOverTime() public {
        vm.startPrank(alice);
        underlying.approve(address(staked), 200 ether);
        staked.stake(200 ether);
        vm.stopPrank();

        uint256 blockAfterFirstStake = vm.getBlockNumber();
        vm.roll(vm.getBlockNumber() + 1);

        vm.prank(recipient);
        underlying.transfer(bob, 100 ether);
        vm.startPrank(bob);
        underlying.approve(address(staked), 100 ether);
        staked.stake(100 ether);
        vm.stopPrank();

        vm.roll(vm.getBlockNumber() + 1);

        assertEq(staked.getPastTotalSupply(blockAfterFirstStake), 200 ether);
        assertEq(staked.getPastTotalSupply(vm.getBlockNumber() - 1), 300 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    OWNER / AUTHORIZED LOCKER ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsDeployerAsOwner() public view {
        // setUp() deploys `staked` as the test contract itself.
        assertEq(staked.owner(), address(this));
    }

    function test_TransferOwnership_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(StakedGovernanceToken.Unauthorized.selector);
        staked.transferOwnership(alice);
    }

    function test_TransferOwnership_RevertsOnZeroAddress() public {
        vm.expectRevert(StakedGovernanceToken.ZeroAddress.selector);
        staked.transferOwnership(address(0));
    }

    function test_TransferOwnership_UpdatesOwner() public {
        staked.transferOwnership(alice);
        assertEq(staked.owner(), alice);

        // Old owner loses admin access.
        vm.expectRevert(StakedGovernanceToken.Unauthorized.selector);
        staked.setAuthorizedLocker(bob);
    }

    function test_SetAuthorizedLocker_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(StakedGovernanceToken.Unauthorized.selector);
        staked.setAuthorizedLocker(bob);
    }

    function test_SetAuthorizedLocker_UpdatesLocker() public {
        staked.setAuthorizedLocker(bob);
        assertEq(staked.authorizedLocker(), bob);
    }

    /*//////////////////////////////////////////////////////////////
        LOCK / UNLOCK - REAL CONTRACT, NOT A MOCK, THIS TIME
    //////////////////////////////////////////////////////////////*/

    function _stakeFor(address account, uint256 amount) internal {
        vm.prank(recipient);
        underlying.transfer(account, amount);
        vm.startPrank(account);
        underlying.approve(address(staked), amount);
        staked.stake(amount);
        vm.stopPrank();
    }

    function test_Lock_OnlyAuthorizedLocker() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(bob);

        vm.expectRevert(StakedGovernanceToken.Unauthorized.selector);
        staked.lock(alice, 50 ether); // called by test contract, not bob
    }

    function test_Lock_RevertsWhenExceedingBalance() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));

        vm.expectRevert(StakedGovernanceToken.InsufficientUnlockedBalance.selector);
        staked.lock(alice, 150 ether);
    }

    function test_Lock_SetsLockedBalance() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));

        staked.lock(alice, 60 ether);
        assertEq(staked.lockedBalance(alice), 60 ether);
    }

    function test_Unlock_RevertsWhenExceedingLockedAmount() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));
        staked.lock(alice, 60 ether);

        vm.expectRevert(StakedGovernanceToken.InsufficientLockedBalance.selector);
        staked.unlock(alice, 100 ether);
    }

    function test_Unlock_ReducesLockedBalance() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));
        staked.lock(alice, 60 ether);

        staked.unlock(alice, 40 ether);
        assertEq(staked.lockedBalance(alice), 20 ether);
    }

    /*//////////////////////////////////////////////////////////////
        THE ACTUAL FIX: LOCKED BALANCE BLOCKS TRANSFER AND UNSTAKE
        (this is what ConvictionGovernance's fix actually depends on -
        proven here against the real contract, not a mock)
    //////////////////////////////////////////////////////////////*/

    function test_LockedBalance_BlocksTransfer() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));
        staked.lock(alice, 100 ether); // fully locked

        vm.prank(alice);
        vm.expectRevert(StakedGovernanceToken.InsufficientUnlockedBalance.selector);
        staked.transfer(bob, 100 ether);
    }

    function test_LockedBalance_BlocksUnstake() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));
        staked.lock(alice, 100 ether);

        vm.prank(alice);
        vm.expectRevert(StakedGovernanceToken.InsufficientUnlockedBalance.selector);
        staked.unstake(100 ether);
    }

    function test_LockedBalance_AllowsTransferOfUnlockedPortion() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));
        staked.lock(alice, 60 ether); // 40 ether stays free

        vm.prank(alice);
        bool ok = staked.transfer(bob, 40 ether);
        assertTrue(ok);
    }

    function test_LockedBalance_TransferableAgainAfterUnlock() public {
        _stakeFor(alice, 100 ether);
        staked.setAuthorizedLocker(address(this));
        staked.lock(alice, 100 ether);
        staked.unlock(alice, 100 ether);

        vm.prank(alice);
        bool ok = staked.transfer(bob, 100 ether);
        assertTrue(ok);
    }

    function test_Minting_NeverRestrictedByLock() public {
        // Staking (which mints) must never be blocked by lock accounting -
        // the _update guard only checks `from != address(0)`.
        staked.setAuthorizedLocker(address(this));
        _stakeFor(alice, 50 ether);
        staked.lock(alice, 50 ether);

        // A second, fresh stake (another mint) must still succeed even
        // though alice's existing balance is fully locked.
        vm.prank(recipient);
        underlying.transfer(alice, 30 ether);
        vm.startPrank(alice);
        underlying.approve(address(staked), 30 ether);
        staked.stake(30 ether);
        vm.stopPrank();

        assertEq(staked.balanceOf(alice), 80 ether);
    }
}
