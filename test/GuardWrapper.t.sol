// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GuardWrapper} from "../src/wrapper/GuardWrapper.sol";

/// @dev A minimal real target contract - not a mock of behavior, an
///      actual contract with genuine state, so tests confirm the
///      wrapper's forwarded calls truly land, rather than just not
///      reverting.
contract TestTarget {
    uint256 public value;
    bool public wasCalled;
    uint256 public receivedEth;

    function increment() external {
        wasCalled = true;
        value += 1;
    }

    function setValue(uint256 v) external {
        value = v;
    }

    receive() external payable {
        receivedEth += msg.value;
    }

    function alwaysReverts() external pure {
        revert("nope");
    }
}

contract GuardWrapperTest is Test {
    GuardWrapper internal wrapper;
    TestTarget internal target;

    address internal governance = makeAddr("governance");
    address internal signer1 = makeAddr("signer1");
    address internal signer2 = makeAddr("signer2");
    address internal signer3 = makeAddr("signer3");
    address internal stranger = makeAddr("stranger");

    address[] internal initialSigners;
    uint256 internal constant REQUIRED_APPROVALS = 2;
    uint256 internal constant TENURE_LENGTH = 30 days;

    function setUp() public {
        initialSigners = [signer1, signer2, signer3];
        wrapper = new GuardWrapper(governance, initialSigners, REQUIRED_APPROVALS, TENURE_LENGTH);
        target = new TestTarget();
        vm.deal(address(wrapper), 10 ether);
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsFieldsCorrectly() public view {
        assertEq(wrapper.governance(), governance);
        assertEq(wrapper.requiredApprovals(), REQUIRED_APPROVALS);
        assertEq(wrapper.tenureLength(), TENURE_LENGTH);
        assertEq(wrapper.tenureEnd(), vm.getBlockTimestamp() + TENURE_LENGTH);
        assertTrue(wrapper.isSigner(signer1));
        assertTrue(wrapper.isSigner(signer2));
        assertTrue(wrapper.isSigner(signer3));
        assertFalse(wrapper.isSigner(stranger));

        address[] memory signers = wrapper.getSigners();
        assertEq(signers.length, 3);
    }

    function test_Constructor_RevertsOnZeroGovernance() public {
        vm.expectRevert(GuardWrapper.ZeroAddress.selector);
        new GuardWrapper(address(0), initialSigners, REQUIRED_APPROVALS, TENURE_LENGTH);
    }

    function test_Constructor_RevertsOnZeroTenureLength() public {
        vm.expectRevert(GuardWrapper.TenureNotYetEnded.selector);
        new GuardWrapper(governance, initialSigners, REQUIRED_APPROVALS, 0);
    }

    function test_Constructor_RevertsOnZeroRequiredApprovals() public {
        vm.expectRevert(GuardWrapper.InvalidRequiredApprovals.selector);
        new GuardWrapper(governance, initialSigners, 0, TENURE_LENGTH);
    }

    function test_Constructor_RevertsWhenRequiredApprovalsExceedsSignerCount() public {
        vm.expectRevert(GuardWrapper.InvalidRequiredApprovals.selector);
        new GuardWrapper(governance, initialSigners, 4, TENURE_LENGTH);
    }

    function test_Constructor_RevertsOnZeroAddressSigner() public {
        address[] memory badSigners = new address[](2);
        badSigners[0] = signer1;
        badSigners[1] = address(0);
        vm.expectRevert(GuardWrapper.ZeroAddress.selector);
        new GuardWrapper(governance, badSigners, 1, TENURE_LENGTH);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSE INSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_ProposeInstruction_OnlyGovernanceCanCall() public {
        vm.prank(stranger);
        vm.expectRevert(GuardWrapper.Unauthorized.selector);
        wrapper.proposeInstruction(address(target), 0, abi.encodeWithSignature("increment()"));
    }

    function test_ProposeInstruction_RevertsOnZeroTarget() public {
        vm.prank(governance);
        vm.expectRevert(GuardWrapper.ZeroAddress.selector);
        wrapper.proposeInstruction(address(0), 0, "");
    }

    function test_ProposeInstruction_StoresCorrectly() public {
        vm.prank(governance);
        uint256 id = wrapper.proposeInstruction(address(target), 5, abi.encodeWithSignature("increment()"));

        assertEq(id, 1);
        assertEq(wrapper.instructionCount(), 1);

        GuardWrapper.Instruction memory instruction = wrapper.getInstruction(id);
        assertEq(instruction.target, address(target));
        assertEq(instruction.value, 5);
        assertFalse(instruction.executed);
        assertFalse(instruction.rejected);
        assertEq(instruction.confirmations, 0);
    }

    /*//////////////////////////////////////////////////////////////
                        CONFIRM INSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function _proposeIncrement() internal returns (uint256 id) {
        vm.prank(governance);
        id = wrapper.proposeInstruction(address(target), 0, abi.encodeWithSignature("increment()"));
    }

    function test_ConfirmInstruction_OnlySignerCanCall() public {
        uint256 id = _proposeIncrement();
        vm.prank(stranger);
        vm.expectRevert(GuardWrapper.NotSigner.selector);
        wrapper.confirmInstruction(id);
    }

    function test_ConfirmInstruction_RevertsOnNonexistentInstruction() public {
        vm.prank(signer1);
        vm.expectRevert(GuardWrapper.InstructionDoesNotExist.selector);
        wrapper.confirmInstruction(999);
    }

    function test_ConfirmInstruction_RevertsOnDoubleConfirm() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.confirmInstruction(id);

        vm.prank(signer1);
        vm.expectRevert(GuardWrapper.AlreadyConfirmed.selector);
        wrapper.confirmInstruction(id);
    }

    function test_ConfirmInstruction_BelowThresholdDoesNotExecute() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.confirmInstruction(id);

        assertFalse(wrapper.getInstruction(id).executed);
        assertFalse(target.wasCalled());
    }

    /// @dev The core property this whole contract exists for: reaching
    ///      the confirmation threshold must genuinely execute the real
    ///      target call, not just flip a flag - confirmed here against
    ///      an actual contract with real, checkable state, not a mock.
    function test_ConfirmInstruction_ReachingThresholdExecutes() public {
        uint256 id = _proposeIncrement();

        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        assertFalse(target.wasCalled());

        vm.prank(signer2);
        wrapper.confirmInstruction(id);

        assertTrue(target.wasCalled());
        assertEq(target.value(), 1);
        assertTrue(wrapper.getInstruction(id).executed);
    }

    function test_ConfirmInstruction_ExecutesWithValue() public {
        vm.prank(governance);
        uint256 id = wrapper.proposeInstruction(address(target), 3 ether, "");

        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        vm.prank(signer2);
        wrapper.confirmInstruction(id);

        assertEq(target.receivedEth(), 3 ether);
        assertEq(address(wrapper).balance, 7 ether);
    }

    function test_ConfirmInstruction_RevertsOnAlreadyExecuted() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        vm.prank(signer2);
        wrapper.confirmInstruction(id);

        vm.prank(signer3);
        vm.expectRevert(GuardWrapper.InstructionAlreadyExecuted.selector);
        wrapper.confirmInstruction(id);
    }

    function test_ConfirmInstruction_RevertsWhenExecutionFails() public {
        vm.prank(governance);
        uint256 id = wrapper.proposeInstruction(address(target), 0, abi.encodeWithSignature("alwaysReverts()"));

        vm.prank(signer1);
        wrapper.confirmInstruction(id);

        vm.prank(signer2);
        vm.expectRevert(GuardWrapper.ExecutionFailed.selector);
        wrapper.confirmInstruction(id);
    }

    function test_ConfirmInstruction_RevertsOnRejectedInstruction() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.rejectInstruction(id);
        vm.prank(signer2);
        wrapper.rejectInstruction(id);

        vm.prank(signer3);
        vm.expectRevert(GuardWrapper.InstructionAlreadyRejected.selector);
        wrapper.confirmInstruction(id);
    }

    /*//////////////////////////////////////////////////////////////
                        REVOKE CONFIRMATION
    //////////////////////////////////////////////////////////////*/

    function test_RevokeConfirmation_Works() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        assertEq(wrapper.getInstruction(id).confirmations, 1);

        vm.prank(signer1);
        wrapper.revokeConfirmation(id);
        assertEq(wrapper.getInstruction(id).confirmations, 0);
        assertFalse(wrapper.hasConfirmed(id, signer1));
    }

    /// @dev Regression test for a real bug found and fixed while writing
    ///      this suite: revoking without ever having confirmed used to
    ///      revert with AlreadyConfirmed(), which is backwards - the
    ///      condition being checked is the opposite (the signer has NOT
    ///      confirmed), so the correct, fixed error is NotConfirmed().
    function test_RevokeConfirmation_RevertsIfNotConfirmed() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        vm.expectRevert(GuardWrapper.NotConfirmed.selector);
        wrapper.revokeConfirmation(id);
    }

    function test_RevokeConfirmation_RevertsIfAlreadyExecuted() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        vm.prank(signer2);
        wrapper.confirmInstruction(id);

        vm.prank(signer1);
        vm.expectRevert(GuardWrapper.InstructionAlreadyExecuted.selector);
        wrapper.revokeConfirmation(id);
    }

    /*//////////////////////////////////////////////////////////////
                        REJECT INSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_RejectInstruction_OnlySignerCanCall() public {
        uint256 id = _proposeIncrement();
        vm.prank(stranger);
        vm.expectRevert(GuardWrapper.NotSigner.selector);
        wrapper.rejectInstruction(id);
    }

    function test_RejectInstruction_RevertsOnDoubleReject() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.rejectInstruction(id);

        vm.prank(signer1);
        vm.expectRevert(GuardWrapper.AlreadyRejected.selector);
        wrapper.rejectInstruction(id);
    }

    function test_RejectInstruction_BelowThresholdDoesNotCancel() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.rejectInstruction(id);

        assertFalse(wrapper.getInstruction(id).rejected);
    }

    function test_RejectInstruction_ReachingThresholdCancelsPermanently() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.rejectInstruction(id);
        vm.prank(signer2);
        wrapper.rejectInstruction(id);

        assertTrue(wrapper.getInstruction(id).rejected);
    }

    /// @dev Important edge case: an instruction with SOME confirmations
    ///      already in place must still become permanently
    ///      un-confirmable once rejections reach the threshold - a
    ///      partially-confirmed instruction is not a safer one.
    function test_RejectInstruction_PreventsConfirmationAfterRejection() public {
        uint256 id = _proposeIncrement();
        vm.prank(signer1);
        wrapper.confirmInstruction(id);

        vm.prank(signer2);
        wrapper.rejectInstruction(id);
        vm.prank(signer3);
        wrapper.rejectInstruction(id);

        assertTrue(wrapper.getInstruction(id).rejected);
        assertFalse(target.wasCalled());
    }

    /*//////////////////////////////////////////////////////////////
                    TENURE-GATED SIGNER REPLACEMENT
    //////////////////////////////////////////////////////////////*/

    function test_ReplaceSigners_RevertsBeforeTenureEnds() public {
        address[] memory newSigners = new address[](2);
        newSigners[0] = makeAddr("new1");
        newSigners[1] = makeAddr("new2");

        vm.prank(governance);
        vm.expectRevert(GuardWrapper.TenureNotYetEnded.selector);
        wrapper.replaceSigners(newSigners, 1);
    }

    /// @dev The core guarantee the whole design depends on: no matter
    ///      who calls this or why, the tenure check is completely
    ///      unconditional - confirmed here by having GOVERNANCE ITSELF
    ///      (not a stranger) attempt this before tenure ends, and it
    ///      still reverts identically. Even a fully legitimate,
    ///      honestly-acting governance cannot bypass this.
    function test_ReplaceSigners_GovernanceItselfCannotBypassTenure() public {
        address[] memory newSigners = new address[](1);
        newSigners[0] = makeAddr("new1");

        vm.warp(vm.getBlockTimestamp() + TENURE_LENGTH - 1); // one second before tenure ends
        vm.prank(governance);
        vm.expectRevert(GuardWrapper.TenureNotYetEnded.selector);
        wrapper.replaceSigners(newSigners, 1);
    }

    function test_ReplaceSigners_WorksAfterTenureEndsWithNoSignerConfirmationNeeded() public {
        address newSigner1 = makeAddr("newSigner1");
        address newSigner2 = makeAddr("newSigner2");
        address[] memory newSigners = new address[](2);
        newSigners[0] = newSigner1;
        newSigners[1] = newSigner2;

        vm.warp(vm.getBlockTimestamp() + TENURE_LENGTH);

        // No signer confirmation involved at all - governance alone,
        // once tenure has genuinely passed.
        vm.prank(governance);
        wrapper.replaceSigners(newSigners, 2);

        assertTrue(wrapper.isSigner(newSigner1));
        assertTrue(wrapper.isSigner(newSigner2));
        assertFalse(wrapper.isSigner(signer1));
        assertFalse(wrapper.isSigner(signer2));
        assertFalse(wrapper.isSigner(signer3));
        assertEq(wrapper.requiredApprovals(), 2);
        assertEq(wrapper.tenureEnd(), vm.getBlockTimestamp() + TENURE_LENGTH);
    }

    function test_ReplaceSigners_OnlyGovernanceCanCall() public {
        vm.warp(vm.getBlockTimestamp() + TENURE_LENGTH);
        address[] memory newSigners = new address[](1);
        newSigners[0] = makeAddr("new1");

        vm.prank(stranger);
        vm.expectRevert(GuardWrapper.Unauthorized.selector);
        wrapper.replaceSigners(newSigners, 1);
    }

    /*//////////////////////////////////////////////////////////////
                    SELF-ADMINISTERED CHANGES
    //////////////////////////////////////////////////////////////*/

    function test_SetGovernance_RevertsOnDirectCall() public {
        vm.prank(governance);
        vm.expectRevert(GuardWrapper.Unauthorized.selector);
        wrapper.setGovernance(makeAddr("newGovernance"));
    }

    /// @dev The full, real flow: even replacing governance itself is
    ///      not a special case or a backdoor - it goes through the
    ///      exact same propose -> confirm -> execute pipeline as any
    ///      other instruction, proven here end to end rather than
    ///      assumed.
    function test_SetGovernance_WorksWhenRoutedThroughInstructionPipeline() public {
        address newGovernance = makeAddr("newGovernance");

        vm.prank(governance);
        uint256 id = wrapper.proposeInstruction(
            address(wrapper),
            0,
            abi.encodeWithSignature("setGovernance(address)", newGovernance)
        );

        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        vm.prank(signer2);
        wrapper.confirmInstruction(id);

        assertEq(wrapper.governance(), newGovernance);
    }

    function test_SetTenureLength_RevertsOnDirectCall() public {
        vm.prank(governance);
        vm.expectRevert(GuardWrapper.Unauthorized.selector);
        wrapper.setTenureLength(60 days);
    }

    function test_SetTenureLength_WorksWhenRoutedThroughInstructionPipeline() public {
        vm.prank(governance);
        uint256 id = wrapper.proposeInstruction(
            address(wrapper),
            0,
            abi.encodeWithSignature("setTenureLength(uint256)", 60 days)
        );

        vm.prank(signer1);
        wrapper.confirmInstruction(id);
        vm.prank(signer2);
        wrapper.confirmInstruction(id);

        assertEq(wrapper.tenureLength(), 60 days);
    }
}
