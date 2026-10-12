// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BoardGovernance} from "../src/governance/board/BoardGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract BoardGovernanceTest is Test {
    BoardGovernance internal gov;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // signer
    address internal bob = makeAddr("bob"); // signer
    address internal carol = makeAddr("carol"); // signer
    address internal dave = makeAddr("dave"); // not a signer
    address internal recipient = makeAddr("recipient");

    function defaultConfig() internal pure returns (BoardGovernance.BoardGovernanceConfig memory) {
        return BoardGovernance.BoardGovernanceConfig({
            requiredApprovals: 2, // 2-of-3
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function initialSigners() internal view returns (address[] memory signers) {
        signers = new address[](3);
        signers[0] = alice;
        signers[1] = bob;
        signers[2] = carol;
    }

    function setUp() public {
        gov = BoardGovernance(Clones.clone(address(new BoardGovernance())));
        gov.initialize(
            "Test Board DAO", creator, treasury, defaultConfig(), initialSigners()
        );
    }

    function _singleAction() internal view returns (BoardGovernance.ProposalAction[] memory actions) {
        actions = new BoardGovernance.ProposalAction[](1);
        actions[0] = BoardGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsSigners() public view {
        address[] memory signers = gov.getSigners();
        assertEq(signers.length, 3);
        assertTrue(gov.isSigner(alice));
        assertTrue(gov.isSigner(bob));
        assertTrue(gov.isSigner(carol));
        assertFalse(gov.isSigner(dave));
    }

    function test_Constructor_RevertsOnZeroSigners() public {
        address[] memory none = new address[](0);
        BoardGovernance freshGov1 = BoardGovernance(Clones.clone(address(new BoardGovernance())));
        vm.expectRevert(BoardGovernance.InvalidConfiguration.selector);
        freshGov1.initialize("Test", creator, treasury, defaultConfig(), none);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        BoardGovernance freshGov2 = BoardGovernance(Clones.clone(address(new BoardGovernance())));
        vm.expectRevert(BoardGovernance.ZeroAddress.selector);
        freshGov2.initialize("Test", creator, address(0), defaultConfig(), initialSigners());
    }

    function test_Constructor_RevertsOnDuplicateSigner() public {
        address[] memory dupes = new address[](2);
        dupes[0] = alice;
        dupes[1] = alice;

        BoardGovernance freshGov3 = BoardGovernance(Clones.clone(address(new BoardGovernance())));
        vm.expectRevert(BoardGovernance.AlreadySigner.selector);
        freshGov3.initialize("Test", creator, treasury, defaultConfig(), dupes);
    }

    function test_Constructor_RevertsOnThresholdExceedingSignerCount() public {
        BoardGovernance.BoardGovernanceConfig memory badConfig = defaultConfig();
        badConfig.requiredApprovals = 5;

        BoardGovernance freshGov4 = BoardGovernance(Clones.clone(address(new BoardGovernance())));
        vm.expectRevert(BoardGovernance.InvalidConfiguration.selector);
        freshGov4.initialize("Test", creator, treasury, badConfig, initialSigners());
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL & CONFIRMATION
    //////////////////////////////////////////////////////////////*/

    function test_ProposeTransaction_OnlySigner() public {
        vm.prank(dave);
        vm.expectRevert(BoardGovernance.NotSigner.selector);
        gov.proposeTransaction(_singleAction(), "ipfs://p1");
    }

    function test_ProposeTransaction_AutoConfirmsProposer() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");

        BoardGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(p.confirmations, 1);
        assertTrue(gov.hasConfirmed(id, alice));
    }

    function test_ProposeTransaction_RevertsOnEmptyActions() public {
        BoardGovernance.ProposalAction[] memory none = new BoardGovernance.ProposalAction[](0);
        vm.prank(alice);
        vm.expectRevert(BoardGovernance.EmptyProposalActions.selector);
        gov.proposeTransaction(none, "ipfs://p1");
    }

    function test_ConfirmTransaction_OnlySigner() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");

        vm.prank(dave);
        vm.expectRevert(BoardGovernance.NotSigner.selector);
        gov.confirmTransaction(id);
    }

    function test_ConfirmTransaction_RevertsOnDoubleConfirm() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");

        vm.prank(alice);
        vm.expectRevert(BoardGovernance.AlreadyConfirmed.selector);
        gov.confirmTransaction(id);
    }

    function test_ConfirmTransaction_AutoQueuesAtThreshold() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");
        assertEq(uint8(gov.state(id)), uint8(BoardGovernance.ProposalState.Active));

        vm.prank(bob);
        gov.confirmTransaction(id); // 2nd confirmation - meets 2-of-3 threshold

        assertEq(uint8(gov.state(id)), uint8(BoardGovernance.ProposalState.Queued));
    }

    /*//////////////////////////////////////////////////////////////
                            REVOCATION
    //////////////////////////////////////////////////////////////*/

    function test_RevokeConfirmation_RevertsIfNotConfirmed() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");

        vm.prank(bob);
        vm.expectRevert(BoardGovernance.NotConfirmed.selector);
        gov.revokeConfirmation(id);
    }

    function test_RevokeConfirmation_UnqueuesIfBelowThreshold() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");
        vm.prank(bob);
        gov.confirmTransaction(id); // queued now, 2/2

        vm.prank(bob);
        gov.revokeConfirmation(id); // drops to 1/2 - below threshold

        assertEq(uint8(gov.state(id)), uint8(BoardGovernance.ProposalState.Active));
        BoardGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(p.queuedAt, 0);
    }

    /*//////////////////////////////////////////////////////////////
                        EXECUTION & TIMELOCK
    //////////////////////////////////////////////////////////////*/

    function _proposeAndQueue() internal returns (uint256 id) {
        vm.prank(alice);
        id = gov.proposeTransaction(_singleAction(), "ipfs://p1");
        vm.prank(bob);
        gov.confirmTransaction(id);
    }

    function test_ExecuteTransaction_RevertsBeforeTimelock() public {
        uint256 id = _proposeAndQueue();
        vm.expectRevert(BoardGovernance.ProposalNotExecutable.selector);
        gov.executeTransaction(id);
    }

    function test_ExecuteTransaction_RevertsAfterExpiry() public {
        uint256 id = _proposeAndQueue();
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + defaultConfig().executionPeriod + 1);

        vm.expectRevert(BoardGovernance.ProposalExpired.selector);
        gov.executeTransaction(id);
    }

    function test_ExecuteTransaction_Succeeds() public {
        uint256 id = _proposeAndQueue();
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        gov.executeTransaction(id);
        assertEq(uint8(gov.state(id)), uint8(BoardGovernance.ProposalState.Executed));
    }

    function test_ExecuteTransaction_ForwardsExactETHValue() public {
        BoardGovernance.ProposalAction[] memory actions = new BoardGovernance.ProposalAction[](1);
        actions[0] = BoardGovernance.ProposalAction({target: recipient, value: 1 ether, data: ""});

        vm.prank(alice);
        uint256 id = gov.proposeTransaction(actions, "ipfs://p1");
        vm.prank(bob);
        gov.confirmTransaction(id);

        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        uint256 before = recipient.balance;
        gov.executeTransaction{value: 1 ether}(id);
        assertEq(recipient.balance, before + 1 ether);
    }

    function test_ExecuteTransaction_RevertsOnValueMismatch() public {
        BoardGovernance.ProposalAction[] memory actions = new BoardGovernance.ProposalAction[](1);
        actions[0] = BoardGovernance.ProposalAction({target: recipient, value: 1 ether, data: ""});

        vm.prank(alice);
        uint256 id = gov.proposeTransaction(actions, "ipfs://p1");
        vm.prank(bob);
        gov.confirmTransaction(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        vm.expectRevert(BoardGovernance.InvalidValue.selector);
        gov.executeTransaction(id); // sends 0 ETH, action needs 1 ether
    }

    /*//////////////////////////////////////////////////////////////
                        CANCELLATION
    //////////////////////////////////////////////////////////////*/

    function test_CancelProposal_ByProposer() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");

        vm.prank(alice);
        gov.cancelProposal(id);
        assertEq(uint8(gov.state(id)), uint8(BoardGovernance.ProposalState.Cancelled));
    }

    function test_CancelProposal_RevertsForUnrelatedSigner() public {
        vm.prank(alice);
        uint256 id = gov.proposeTransaction(_singleAction(), "ipfs://p1");

        vm.prank(bob);
        vm.expectRevert(BoardGovernance.Unauthorized.selector);
        gov.cancelProposal(id);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function test_AddSigner_RevertsForExternalCaller() public {
        vm.expectRevert(BoardGovernance.Unauthorized.selector);
        gov.addSigner(dave);
    }

    function test_RemoveSigner_RevertsBelowThreshold() public {
        // 2-of-3 with only 3 signers: removing one would leave 2 signers,
        // requiredApprovals(2) <= 2 is fine, so this should actually
        // succeed. Test the real failing case: threshold == signer count.
        vm.prank(address(gov));
        gov.setRequiredApprovals(3);

        vm.prank(address(gov));
        vm.expectRevert(BoardGovernance.SignerCountBelowThreshold.selector);
        gov.removeSigner(carol);
    }

    function test_RemoveSigner_SucceedsWhenAboveThreshold() public {
        vm.prank(address(gov));
        gov.removeSigner(carol);

        assertFalse(gov.isSigner(carol));
        assertEq(gov.getSigners().length, 2);
    }

    function test_SetRequiredApprovals_RevertsAboveSignerCount() public {
        vm.prank(address(gov));
        vm.expectRevert(BoardGovernance.InvalidConfiguration.selector);
        gov.setRequiredApprovals(10);
    }

    function test_SetTreasury_RevertsForExternalCaller() public {
        vm.expectRevert(BoardGovernance.Unauthorized.selector);
        gov.setTreasury(address(0xBEEF));
    }
}
