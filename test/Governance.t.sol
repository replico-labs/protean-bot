// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GovernanceTestBase} from "./GovernanceTestBase.sol";
import {Governance} from "../src/governance/Governance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import "../src/governance/Types.sol";
import "../src/governance/GovernanceErrors.sol";
import "../src/governance/GovernanceEvents.sol";

contract GovernanceTest is GovernanceTestBase {
    function setUp() public override {
        super.setUp();
        // Give alice enough voting power to propose and to single-handedly
        // meet quorum + approval for most tests.
        _fundAndDelegate(alice, 200_000 ether);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CREATION
    //////////////////////////////////////////////////////////////*/

    function test_Propose_CreatesProposalWithExpectedFields() public {
        ProposalAction[] memory actions = _singleAction(recipient, 0, "");

        vm.prank(alice);
        uint256 proposalId = gov.propose(actions, "ipfs://proposal-1");

        Proposal memory p = gov.getProposal(proposalId);
        assertEq(p.id, proposalId);
        assertEq(p.proposer, alice);
        assertEq(p.metadataURI, "ipfs://proposal-1");
        assertEq(p.startBlock, vm.getBlockNumber() + defaultConfig().votingDelay);
        assertEq(p.endBlock, p.startBlock + defaultConfig().votingPeriod);
        assertFalse(p.executed);
        assertFalse(p.cancelled);
    }

    function test_Propose_IncrementsProposalCount() public {
        assertEq(gov.proposalCount(), 0);

        vm.prank(alice);
        gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        assertEq(gov.proposalCount(), 1);
    }

    function test_Propose_RevertsOnEmptyActions() public {
        ProposalAction[] memory actions = new ProposalAction[](0);

        vm.prank(alice);
        vm.expectRevert(EmptyProposalActions.selector);
        gov.propose(actions, "ipfs://p1");
    }

    function test_Propose_RevertsOnEmptyMetadataURI() public {
        vm.prank(alice);
        vm.expectRevert(EmptyMetadataURI.selector);
        gov.propose(_singleAction(recipient, 0, ""), "");
    }

    function test_Propose_RevertsOnZeroAddressTarget() public {
        ProposalAction[] memory actions = _singleAction(address(0), 0, "");

        vm.prank(alice);
        vm.expectRevert(InvalidProposalAction.selector);
        gov.propose(actions, "ipfs://p1");
    }

    function test_Propose_RevertsBelowProposalThreshold() public {
        // Bob has no tokens/delegation at all.
        vm.prank(bob);
        vm.expectRevert(ProposalThresholdNotMet.selector);
        gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
    }

    function test_Propose_AllowedWhenThresholdIsZero() public {
        GovernanceConfig memory config = defaultConfig();
        config.proposalThreshold = 0;
        deployDAO(config);

        // Bob still has zero tokens, but threshold is disabled.
        vm.prank(bob);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        assertEq(proposalId, 1);
    }

    /*//////////////////////////////////////////////////////////////
                            VOTE CASTING
    //////////////////////////////////////////////////////////////*/

    function test_CastVote_RecordsWeightAndReceipt() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        uint256 weight = gov.castVote(proposalId, VoteType.For);

        assertEq(weight, 200_000 ether);

        VoteReceipt memory receipt = gov.getVoteReceipt(proposalId, alice);
        assertTrue(receipt.hasVoted);
        assertEq(uint8(receipt.support), uint8(VoteType.For));
        assertEq(receipt.weight, 200_000 ether);

        Proposal memory p = gov.getProposal(proposalId);
        assertEq(p.forVotes, 200_000 ether);
    }

    function test_CastVote_RevertsBeforeVotingStarts() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.prank(alice);
        vm.expectRevert(ProposalNotActive.selector);
        gov.castVote(proposalId, VoteType.For);
    }

    function test_CastVote_RevertsAfterVotingEnds() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        _endVoting(proposalId);

        vm.prank(alice);
        vm.expectRevert(ProposalNotActive.selector);
        gov.castVote(proposalId, VoteType.For);
    }

    function test_CastVote_RevertsOnDoubleVote() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);

        vm.prank(alice);
        vm.expectRevert(AlreadyVoted.selector);
        gov.castVote(proposalId, VoteType.For);
    }

    function test_CastVote_RevertsOnNonexistentProposal() public {
        vm.prank(alice);
        vm.expectRevert(); // proposalExists() modifier's require()
        gov.castVote(999, VoteType.For);
    }

    function test_CastVote_ZeroWeightForUnstakedHolder() public {
        _fundAndDelegate(bob, 1); // trivial balance but staked
        // carol holds raw (unstaked) tokens - zero voting weight, no
        // matter how large her balance, until she stakes them.
        vm.prank(creator);
        bool ok = underlying.transfer(carol, 100 ether);
        assertTrue(ok);

        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(carol);
        uint256 weight = gov.castVote(proposalId, VoteType.For);
        assertEq(weight, 0);
    }

    function test_CastVoteWithReason_EmitsReasonInEvent() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.expectEmit(true, true, false, true);
        emit VoteCast(alice, proposalId, VoteType.For, 200_000 ether, "I like this");

        vm.prank(alice);
        gov.castVoteWithReason(proposalId, VoteType.For, "I like this");
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL CANCELLATION
    //////////////////////////////////////////////////////////////*/

    function test_CancelProposal_ByProposer() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.prank(alice);
        gov.cancelProposal(proposalId);

        Proposal memory p = gov.getProposal(proposalId);
        assertTrue(p.cancelled);
    }

    function test_CancelProposal_RevertsForUnrelatedCaller() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.prank(bob);
        vm.expectRevert(Unauthorized.selector);
        gov.cancelProposal(proposalId);
    }

    function test_CancelProposal_RevertsIfAlreadyCancelled() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.prank(alice);
        gov.cancelProposal(proposalId);

        vm.prank(alice);
        vm.expectRevert(ProposalAlreadyCancelled.selector);
        gov.cancelProposal(proposalId);
    }

    function test_CancelProposal_RevertsAfterExecution() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        _endVoting(proposalId);

        gov.queueProposal(proposalId);
        _passTimelock(proposalId);
        gov.executeProposal(proposalId);

        vm.prank(alice);
        vm.expectRevert(ProposalAlreadyExecuted.selector);
        gov.cancelProposal(proposalId);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL QUEUEING
    //////////////////////////////////////////////////////////////*/

    function test_QueueProposal_RevertsBeforeVotingEnds() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.expectRevert(VotingNotStarted.selector);
        gov.queueProposal(proposalId);
    }

    function test_QueueProposal_RevertsWhenQuorumNotReached() public {
        // Nobody votes.
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        _endVoting(proposalId);

        vm.expectRevert(QuorumNotReached.selector);
        gov.queueProposal(proposalId);
    }

    function test_QueueProposal_RevertsWhenApprovalNotMet() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        // Alice's 200k votes meet quorum (10% of 1M) but she votes Against,
        // so approval (60% For) is never met.
        vm.prank(alice);
        gov.castVote(proposalId, VoteType.Against);
        _endVoting(proposalId);

        vm.expectRevert(ApprovalThresholdNotMet.selector);
        gov.queueProposal(proposalId);
    }

    function test_QueueProposal_SucceedsAndSetsQueuedAt() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        _endVoting(proposalId);

        gov.queueProposal(proposalId);

        Proposal memory p = gov.getProposal(proposalId);
        assertEq(p.queuedAt, vm.getBlockTimestamp());
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Queued));
    }

    function test_QueueProposal_RevertsIfAlreadyQueued() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);
        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        _endVoting(proposalId);
        gov.queueProposal(proposalId);

        vm.expectRevert(ProposalAlreadyQueued.selector);
        gov.queueProposal(proposalId);
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL EXECUTION
    //////////////////////////////////////////////////////////////*/

    function _proposeVoteAndQueue(
        ProposalAction[] memory actions
    ) internal returns (uint256 proposalId) {
        vm.prank(alice);
        proposalId = gov.propose(actions, "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);
        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        _endVoting(proposalId);
        gov.queueProposal(proposalId);
    }

    function test_ExecuteProposal_RevertsBeforeQueueing() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        vm.expectRevert(ProposalNotExecutable.selector);
        gov.executeProposal(proposalId);
    }

    function test_ExecuteProposal_RevertsBeforeTimelockElapses() public {
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(recipient, 0, ""));

        vm.expectRevert(ProposalNotExecutable.selector);
        gov.executeProposal(proposalId);
    }

    function test_ExecuteProposal_RevertsAfterExpiry() public {
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(recipient, 0, ""));

        vm.warp(
            vm.getBlockTimestamp()
                + defaultConfig().timelockDelay
                + defaultConfig().executionPeriod
                + 1
        );

        vm.expectRevert(ProposalExpired.selector);
        gov.executeProposal(proposalId);
    }

    function test_ExecuteProposal_RevertsOnValueMismatch() public {
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(recipient, 1 ether, ""));
        _passTimelock(proposalId);

        vm.expectRevert(InvalidValue.selector);
        gov.executeProposal(proposalId);
    }

    function test_ExecuteProposal_ForwardsExactETHValue() public {
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(recipient, 1 ether, ""));
        _passTimelock(proposalId);

        uint256 before = recipient.balance;
        gov.executeProposal{value: 1 ether}(proposalId);
        assertEq(recipient.balance, before + 1 ether);

        Proposal memory p = gov.getProposal(proposalId);
        assertTrue(p.executed);
    }

    function test_ExecuteProposal_RevertsIfAlreadyExecuted() public {
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(recipient, 0, ""));
        _passTimelock(proposalId);
        gov.executeProposal(proposalId);

        vm.expectRevert(ProposalAlreadyExecuted.selector);
        gov.executeProposal(proposalId);
    }

    function test_ExecuteProposal_RevertsOnFailedAction() public {
        // Target a contract with no receive/fallback and nonzero value with
        // empty calldata against an EOA works fine, so instead call a
        // function that will definitely revert: a self-targeted governance
        // update with an invalid config.
        GovernanceConfig memory badConfig = defaultConfig();
        badConfig.quorumBps = 0;

        bytes memory data = abi.encodeWithSelector(
            Governance.updateGovernanceConfig.selector,
            badConfig
        );
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(address(gov), 0, data));
        _passTimelock(proposalId);

        vm.expectRevert(ExecutionFailed.selector);
        gov.executeProposal(proposalId);
    }

    function test_ExecuteProposal_MultiAction() public {
        address recipient2 = makeAddr("recipient2");

        ProposalAction[] memory actions = new ProposalAction[](2);
        actions[0] = ProposalAction({target: recipient, value: 1 ether, data: ""});
        actions[1] = ProposalAction({target: recipient2, value: 2 ether, data: ""});

        uint256 proposalId = _proposeVoteAndQueue(actions);
        _passTimelock(proposalId);

        gov.executeProposal{value: 3 ether}(proposalId);

        assertEq(recipient.balance, 1 ether);
        assertEq(recipient2.balance, 2 ether);
    }

    /*//////////////////////////////////////////////////////////////
                SELF-TARGETED GOVERNANCE ADMIN ACTIONS
    //////////////////////////////////////////////////////////////*/

    function test_UpdateGovernanceConfig_RevertsForExternalCaller() public {
        vm.expectRevert(Unauthorized.selector);
        gov.updateGovernanceConfig(defaultConfig());
    }

    function test_UpdateGovernanceConfig_SucceedsViaProposalSelfCall() public {
        GovernanceConfig memory newConfig = defaultConfig();
        newConfig.votingPeriod = 200;

        bytes memory data = abi.encodeWithSelector(
            Governance.updateGovernanceConfig.selector,
            newConfig
        );
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(address(gov), 0, data));
        _passTimelock(proposalId);

        gov.executeProposal(proposalId);

        assertEq(gov.governanceConfig().votingPeriod, 200);
    }

    function test_SetGovernanceToken_RevertsForExternalCaller() public {
        vm.expectRevert(Unauthorized.selector);
        gov.setGovernanceToken(address(0xBEEF));
    }

    function test_SetTreasury_RevertsForExternalCaller() public {
        vm.expectRevert(Unauthorized.selector);
        gov.setTreasury(address(0xBEEF));
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function test_State_PendingBeforeVotingDelay() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Pending));
    }

    function test_State_ActiveDuringVoting() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Active));
    }

    function test_State_DefeatedWhenQuorumNotReached() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        _endVoting(proposalId);
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Defeated));
    }

    function test_State_ExecutedAfterExecution() public {
        uint256 proposalId = _proposeVoteAndQueue(_singleAction(recipient, 0, ""));
        _passTimelock(proposalId);
        gov.executeProposal(proposalId);
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Executed));
    }

    function test_QuorumVotes_MatchesConfigBps() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");

        // Quorum is based on the staked token's total supply (voting power),
        // not the underlying token's full supply. Only alice's 200,000 ether
        // is staked at this point, so quorum is 10% of that.
        assertEq(gov.quorumVotes(proposalId), 20_000 ether);
    }

    function test_ExecutableAfter_ZeroWhenNotQueued() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        assertEq(gov.executableAfter(proposalId), 0);
    }

    function test_ExecutableAfter_MatchesQueuedAtPlusTimelock() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);
        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        _endVoting(proposalId);
        gov.queueProposal(proposalId);

        Proposal memory p = gov.getProposal(proposalId);
        assertEq(gov.executableAfter(proposalId), p.queuedAt + defaultConfig().timelockDelay);
    }

    /*//////////////////////////////////////////////////////////////
                        CONSTRUCTOR VALIDATION
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_RevertsOnZeroCreator() public {
        Governance freshGov = Governance(Clones.clone(address(new Governance())));
        vm.expectRevert(ZeroAddress.selector);
        freshGov.initialize("DAO", address(0), address(token), address(treasury), defaultConfig());
    }

    function test_Constructor_RevertsOnZeroToken() public {
        Governance freshGov = Governance(Clones.clone(address(new Governance())));
        vm.expectRevert(ZeroAddress.selector);
        freshGov.initialize("DAO", creator, address(0), address(treasury), defaultConfig());
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        Governance freshGov = Governance(Clones.clone(address(new Governance())));
        vm.expectRevert(ZeroAddress.selector);
        freshGov.initialize("DAO", creator, address(token), address(0), defaultConfig());
    }

    function test_Constructor_RevertsOnInvalidConfig() public {
        GovernanceConfig memory badConfig = defaultConfig();
        badConfig.votingPeriod = 0;

        Governance freshGov = Governance(Clones.clone(address(new Governance())));
        vm.expectRevert(InvalidVotingPeriod.selector);
        freshGov.initialize("DAO", creator, address(token), address(treasury), badConfig);
    }
}
