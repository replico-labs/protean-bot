// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConvictionGovernance} from "../src/governance/conviction/ConvictionGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @dev Minimal mock of a StakedGovernanceToken - only balanceOf is needed
///      by this governance model (see the contract's design note on why
///      there's no fixed snapshot block here).
contract MockBalanceToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public lockedBalance;

    error InsufficientUnlockedBalance();
    error InsufficientLockedBalance();

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

    function lock(address account, uint256 amount) external {
        uint256 newLocked = lockedBalance[account] + amount;
        if (newLocked > balanceOf[account]) revert InsufficientUnlockedBalance();
        lockedBalance[account] = newLocked;
    }

    function unlock(address account, uint256 amount) external {
        uint256 current = lockedBalance[account];
        if (amount > current) revert InsufficientLockedBalance();
        lockedBalance[account] = current - amount;
    }

    /// @dev Mirrors the real token's transfer-blocking behavior for tests
    ///      that want to prove locked tokens genuinely can't move.
    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 available = balanceOf[msg.sender] - lockedBalance[msg.sender];
        if (amount > available) revert InsufficientUnlockedBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract ConvictionGovernanceTest is Test {
    ConvictionGovernance internal gov;
    MockBalanceToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant GROWTH_RATE = 10 ether; // conviction units per block

    function defaultConfig() internal pure returns (ConvictionGovernance.ConvictionGovernanceConfig memory) {
        return ConvictionGovernance.ConvictionGovernanceConfig({
            convictionGrowthRate: GROWTH_RATE,
            minThresholdConviction: 1_000 ether,
            thresholdMultiplier: 1, // 1 extra conviction-wei required per wei requested
            proposalThreshold: 0,
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function setUp() public {
        token = new MockBalanceToken();
        gov = ConvictionGovernance(Clones.clone(address(new ConvictionGovernance())));
        gov.initialize("Test DAO", creator, address(token), treasury, defaultConfig());
    }

    function _actionWithValue(uint256 value) internal view returns (ConvictionGovernance.ProposalAction[] memory actions) {
        actions = new ConvictionGovernance.ProposalAction[](1);
        actions[0] = ConvictionGovernance.ProposalAction({target: recipient, value: value, data: ""});
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_RevertsOnZeroGrowthRate() public {
        ConvictionGovernance.ConvictionGovernanceConfig memory badConfig = defaultConfig();
        badConfig.convictionGrowthRate = 0;

        ConvictionGovernance freshGov = ConvictionGovernance(Clones.clone(address(new ConvictionGovernance())));
        vm.expectRevert(ConvictionGovernance.InvalidConfiguration.selector);
        freshGov.initialize("Test", creator, address(token), treasury, badConfig);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CREATION
    //////////////////////////////////////////////////////////////*/

    function test_Propose_ComputesRequestedAmountFromActionValues() public {
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(5 ether), "ipfs://p1");

        ConvictionGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(p.requestedAmount, 5 ether);
    }

    /*//////////////////////////////////////////////////////////////
            THE ACTUAL POINT: LINEAR RAMP MATH CORRECTNESS
    //////////////////////////////////////////////////////////////*/

    function test_Conviction_RampsUpLinearlyTowardSupport() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");

        vm.prank(alice);
        gov.support(id); // totalSupport = 100 ether, conviction starts at 0

        vm.roll(vm.getBlockNumber() + 1);
        // 1 block elapsed * 10 ether/block growth rate = conviction should be 10 ether
        assertEq(gov.previewConviction(id), 10 ether);

        vm.roll(vm.getBlockNumber() + 4);
        // 5 blocks total elapsed since support * 10 ether/block = 50 ether
        assertEq(gov.previewConviction(id), 50 ether);
    }

    function test_Conviction_CapsAtTargetNeverOvershoots() public {
        token.setBalance(alice, 25 ether); // small support relative to growth rate
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");

        vm.prank(alice);
        gov.support(id); // target = 25 ether

        // Growth rate is 10 ether/block; after 10 blocks it would "want" to
        // reach 100 ether, but must clamp at the 25 ether target.
        vm.roll(vm.getBlockNumber() + 10);
        assertEq(gov.previewConviction(id), 25 ether);
    }

    function test_Conviction_RampsDownWhenSupportWithdrawn() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");

        vm.prank(alice);
        gov.support(id);
        vm.roll(vm.getBlockNumber() + 5); // conviction settles to 50 ether when touched next

        vm.prank(alice);
        gov.withdrawSupport(); // settles conviction to 50 ether, then target drops to 0

        assertEq(gov.previewConviction(id), 50 ether); // just settled, no blocks passed yet

        vm.roll(vm.getBlockNumber() + 2);
        // target is now 0; ramps down by 2 blocks * 10 ether/block = 20 ether
        assertEq(gov.previewConviction(id), 30 ether);
    }

    function test_Conviction_SwitchingSupportSettlesBothProposals() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id1 = gov.propose(_actionWithValue(0), "ipfs://p1");
        vm.prank(alice);
        uint256 id2 = gov.propose(_actionWithValue(0), "ipfs://p2");

        vm.prank(alice);
        gov.support(id1);
        vm.roll(vm.getBlockNumber() + 3); // id1 would settle to 30 ether if touched

        vm.prank(alice);
        gov.support(id2); // settles id1 to 30 ether and withdraws; id2 starts fresh

        ConvictionGovernance.Proposal memory p1 = gov.getProposal(id1);
        assertEq(p1.conviction, 30 ether);
        assertEq(gov.totalSupport(id1), 0);
        assertEq(gov.totalSupport(id2), 100 ether);
        assertEq(gov.currentSupportProposal(alice), id2);
    }

    /*//////////////////////////////////////////////////////////////
                    SUPPORT / WITHDRAWAL MECHANICS
    //////////////////////////////////////////////////////////////*/

    /*//////////////////////////////////////////////////////////////
        THE ACTUAL FIX: COMMITTED SUPPORT IS LOCKED, NOT JUST SNAPSHOTTED
    //////////////////////////////////////////////////////////////*/

    function test_Support_LocksCommittedWeight() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");

        vm.prank(alice);
        gov.support(id);

        assertEq(token.lockedBalance(alice), 100 ether);
    }

    function test_Support_LockedTokensCannotBeTransferredAway() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");

        vm.prank(alice);
        gov.support(id);

        // This is the exact gap the fix closes - alice can no longer sell
        // the tokens backing her support out from under the proposal.
        vm.prank(alice);
        vm.expectRevert(MockBalanceToken.InsufficientUnlockedBalance.selector);
        token.transfer(bob, 100 ether);
    }

    function test_WithdrawSupport_UnlocksTokens() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");
        vm.prank(alice);
        gov.support(id);

        vm.prank(alice);
        gov.withdrawSupport();

        assertEq(token.lockedBalance(alice), 0);

        // Now genuinely transferable again.
        vm.prank(alice);
        bool ok = token.transfer(bob, 100 ether);
        assertTrue(ok);
    }

    function test_SwitchingSupport_UnlocksOldAndLocksNew() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id1 = gov.propose(_actionWithValue(0), "ipfs://p1");
        vm.prank(alice);
        uint256 id2 = gov.propose(_actionWithValue(0), "ipfs://p2");

        vm.prank(alice);
        gov.support(id1);
        assertEq(token.lockedBalance(alice), 100 ether);

        vm.prank(alice);
        gov.support(id2); // switches from id1 to id2

        // Still exactly 100 ether locked (unlocked from id1, relocked for
        // id2) - not double-locked, not left dangling on the old proposal.
        assertEq(token.lockedBalance(alice), 100 ether);
    }

    function test_Support_RevertsOnAlreadySupportingSameProposal() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");

        vm.prank(alice);
        gov.support(id);

        vm.prank(alice);
        vm.expectRevert(ConvictionGovernance.AlreadySupportingThisProposal.selector);
        gov.support(id);
    }

    function test_WithdrawSupport_RevertsWhenNotSupporting() public {
        vm.prank(alice);
        vm.expectRevert(ConvictionGovernance.NotCurrentlySupporting.selector);
        gov.withdrawSupport();
    }

    /*//////////////////////////////////////////////////////////////
                    THRESHOLD SCALING WITH REQUESTED AMOUNT
    //////////////////////////////////////////////////////////////*/

    function test_RequiredConviction_ScalesWithRequestedAmount() public {
        vm.prank(alice);
        uint256 smallAsk = gov.propose(_actionWithValue(1 ether), "ipfs://p1");
        vm.prank(alice);
        uint256 bigAsk = gov.propose(_actionWithValue(1_000 ether), "ipfs://p2");

        assertEq(gov.requiredConviction(smallAsk), 1_000 ether + 1 ether);
        assertEq(gov.requiredConviction(bigAsk), 1_000 ether + 1_000 ether);
        assertTrue(gov.requiredConviction(bigAsk) > gov.requiredConviction(smallAsk));
    }

    /*//////////////////////////////////////////////////////////////
                            QUEUE & EXECUTE
    //////////////////////////////////////////////////////////////*/

    function test_QueueProposal_RevertsBelowThreshold() public {
        token.setBalance(alice, 1 ether); // far below requiredConviction
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");
        vm.prank(alice);
        gov.support(id);

        vm.expectRevert(ConvictionGovernance.ConvictionThresholdNotMet.selector);
        gov.queueProposal(id);
    }

    function test_QueueProposal_SucceedsOnceThresholdCrossed() public {
        token.setBalance(alice, 100 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1"); // required = 1000 ether

        vm.prank(alice);
        gov.support(id);
        // conviction caps at 100 ether (the support level) - never reaches
        // 1000 ether this way. Need enough supporters.
        token.setBalance(bob, 900 ether);
        vm.prank(bob);
        gov.support(id); // total support now 1000 ether

        vm.roll(vm.getBlockNumber() + 200); // plenty of blocks to ramp fully to 1000 ether
        gov.queueProposal(id);

        assertEq(uint8(gov.state(id)), uint8(ConvictionGovernance.ProposalState.Queued));
    }

    function test_ExecuteProposal_RevertsBeforeTimelock() public {
        token.setBalance(alice, 1_000 ether);
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(0), "ipfs://p1");
        vm.prank(alice);
        gov.support(id);
        vm.roll(vm.getBlockNumber() + 200);
        gov.queueProposal(id);

        vm.expectRevert(ConvictionGovernance.ProposalNotExecutable.selector);
        gov.executeProposal(id);
    }

    function test_ExecuteProposal_Succeeds() public {
        token.setBalance(alice, 1_001 ether); // must reach requiredConviction = 1000 + 1 ether
        vm.prank(alice);
        uint256 id = gov.propose(_actionWithValue(1 ether), "ipfs://p1");
        vm.prank(alice);
        gov.support(id);
        vm.roll(vm.getBlockNumber() + 300); // ramp past required (1000 + 1 ether)
        gov.queueProposal(id);

        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);
        gov.executeProposal{value: 1 ether}(id);

        assertEq(uint8(gov.state(id)), uint8(ConvictionGovernance.ProposalState.Executed));
        assertEq(recipient.balance, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function test_UpdateGovernanceConfig_RevertsForExternalCaller() public {
        vm.expectRevert(ConvictionGovernance.Unauthorized.selector);
        gov.updateGovernanceConfig(defaultConfig());
    }
}
