// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LiquidGovernance} from "../src/governance/liquid/LiquidGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @dev Minimal mock of a StakedGovernanceToken.
contract MockVotesToken {
    mapping(address => mapping(uint256 => uint256)) internal _pastVotes;
    mapping(uint256 => uint256) internal _pastTotalSupply;

    function setPastVotes(address account, uint256 blockNumber, uint256 amount) external {
        _pastVotes[account][blockNumber] = amount;
    }

    function setPastTotalSupply(uint256 blockNumber, uint256 amount) external {
        _pastTotalSupply[blockNumber] = amount;
    }

    function getPastVotes(address account, uint256 timepoint) external view returns (uint256) {
        return _pastVotes[account][timepoint];
    }

    function getPastTotalSupply(uint256 timepoint) external view returns (uint256) {
        return _pastTotalSupply[timepoint];
    }
}

contract LiquidGovernanceTest is Test {
    LiquidGovernance internal gov;
    MockVotesToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal recipient = makeAddr("recipient");

    function defaultConfig() internal pure returns (LiquidGovernance.LiquidGovernanceConfig memory) {
        return LiquidGovernance.LiquidGovernanceConfig({
            quorumBps: 1_000,
            approvalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 100,
            timelockDelay: 1 days,
            executionPeriod: 7 days,
            proposalThreshold: 0
        });
    }

    function setUp() public {
        token = new MockVotesToken();
        gov = LiquidGovernance(Clones.clone(address(new LiquidGovernance())));
        gov.initialize("Test DAO", creator, address(token), treasury, defaultConfig());
    }

    function _singleAction() internal view returns (LiquidGovernance.ProposalAction[] memory actions) {
        actions = new LiquidGovernance.ProposalAction[](1);
        actions[0] = LiquidGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    function _createProposal() internal returns (uint256 id) {
        vm.prank(alice);
        id = gov.propose(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);
    }

    /*//////////////////////////////////////////////////////////////
                            DELEGATION SETUP
    //////////////////////////////////////////////////////////////*/

    function test_Delegate_RevertsOnSelfDelegate() public {
        vm.prank(alice);
        vm.expectRevert(LiquidGovernance.CannotDelegateToSelf.selector);
        gov.delegate(alice);
    }

    function test_Delegate_SetsDelegation() public {
        vm.prank(alice);
        gov.delegate(bob);
        assertEq(gov.delegatedTo(alice), bob);
    }

    function test_Undelegate_ClearsDelegation() public {
        vm.prank(alice);
        gov.delegate(bob);
        vm.prank(alice);
        gov.undelegate();
        assertEq(gov.delegatedTo(alice), address(0));
    }

    function test_Undelegate_RevertsWhenNotDelegated() public {
        vm.prank(alice);
        vm.expectRevert(LiquidGovernance.NotDelegated.selector);
        gov.undelegate();
    }

    function test_DelegateChainTip_WalksChain() public {
        vm.prank(alice);
        gov.delegate(bob);
        vm.prank(bob);
        gov.delegate(carol);

        (address tip, uint256 hops) = gov.delegateChainTip(alice);
        assertEq(tip, carol);
        assertEq(hops, 2);
    }

    /*//////////////////////////////////////////////////////////////
        REVERSE INDEX - WHAT A BOT NEEDS TO FIND WHO TO RESOLVE
    //////////////////////////////////////////////////////////////*/

    function test_GetDirectDelegators_ReflectsWhoDelegatesToAnAddress() public {
        vm.prank(alice);
        gov.delegate(bob);
        vm.prank(carol);
        gov.delegate(bob);

        address[] memory delegators = gov.getDirectDelegators(bob);
        assertEq(delegators.length, 2);
    }

    function test_GetDirectDelegators_RemovesOnUndelegate() public {
        vm.prank(alice);
        gov.delegate(bob);
        vm.prank(carol);
        gov.delegate(bob);
        vm.prank(dave);
        gov.delegate(bob);

        // Remove the middle entry - exercises the swap-and-pop path, not
        // just the trivial last-element-removal case.
        vm.prank(carol);
        gov.undelegate();

        address[] memory delegators = gov.getDirectDelegators(bob);
        assertEq(delegators.length, 2);
        // alice and dave both still present, carol gone, neither
        // remaining entry corrupted by the swap.
        bool foundAlice;
        bool foundDave;
        bool foundCarol;
        for (uint256 i = 0; i < delegators.length; i++) {
            if (delegators[i] == alice) foundAlice = true;
            if (delegators[i] == dave) foundDave = true;
            if (delegators[i] == carol) foundCarol = true;
        }
        assertTrue(foundAlice);
        assertTrue(foundDave);
        assertFalse(foundCarol);
    }

    function test_GetDirectDelegators_UpdatesWhenRedelegatingElsewhere() public {
        vm.prank(alice);
        gov.delegate(bob);
        assertEq(gov.getDirectDelegators(bob).length, 1);

        // alice changes her mind, redirects to carol instead.
        vm.prank(alice);
        gov.delegate(carol);

        assertEq(gov.getDirectDelegators(bob).length, 0);
        assertEq(gov.getDirectDelegators(carol).length, 1);
        assertEq(gov.getDirectDelegators(carol)[0], alice);
    }

    function test_GetDirectDelegators_EmptyForAddressWithNoDelegators() public view {
        assertEq(gov.getDirectDelegators(bob).length, 0);
    }

    /*//////////////////////////////////////////////////////////////
            DIRECT VOTING ALWAYS AVAILABLE (the core liquid property)
    //////////////////////////////////////////////////////////////*/

    function test_CastVote_WorksEvenWithDelegateSet() public {
        vm.prank(alice);
        gov.delegate(bob); // alice has a delegate...

        uint256 id = _createProposal();
        token.setPastVotes(alice, gov.getProposal(id).snapshotBlock, 500 ether);

        vm.prank(alice);
        uint256 weight = gov.castVote(id, LiquidGovernance.VoteType.For); // ...but still votes directly

        assertEq(weight, 500 ether);
        assertEq(gov.getProposal(id).forVotes, 500 ether);
    }

    /*//////////////////////////////////////////////////////////////
        THE ACTUAL POINT: BOUNDED TRANSITIVE CHAIN RESOLUTION
    //////////////////////////////////////////////////////////////*/

    function test_ResolveDelegatedVote_OneHop() public {
        vm.prank(alice);
        gov.delegate(bob); // alice -> bob

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(bob, snap, 200 ether);
        token.setPastVotes(alice, snap, 50 ether);

        vm.prank(bob);
        gov.castVote(id, LiquidGovernance.VoteType.For);

        gov.resolveDelegatedVote(id, alice);

        LiquidGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(p.forVotes, 250 ether); // bob's 200 + alice's 50

        LiquidGovernance.VoteReceipt memory receipt = gov.getVoteReceipt(id, alice);
        assertTrue(receipt.hasVoted);
        assertTrue(receipt.viaDelegation);
        assertEq(receipt.resolvedVia, bob);
    }

    function test_ResolveDelegatedVote_MultiHopChain() public {
        // dave -> carol -> bob (votes)
        vm.prank(dave);
        gov.delegate(carol);
        vm.prank(carol);
        gov.delegate(bob);

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(bob, snap, 100 ether);
        token.setPastVotes(dave, snap, 30 ether);

        vm.prank(bob);
        gov.castVote(id, LiquidGovernance.VoteType.For);

        // One call resolves dave all the way through carol to bob, without
        // carol needing her own separate resolution first.
        gov.resolveDelegatedVote(id, dave);

        LiquidGovernance.VoteReceipt memory receipt = gov.getVoteReceipt(id, dave);
        assertTrue(receipt.hasVoted);
        assertEq(receipt.resolvedVia, bob);
        assertEq(gov.getProposal(id).forVotes, 130 ether);
    }

    function test_ResolveDelegatedVote_RevertsWhenDelegateHasNotVotedYet() public {
        vm.prank(alice);
        gov.delegate(bob);

        uint256 id = _createProposal();
        // bob never votes.

        vm.expectRevert(LiquidGovernance.DelegateHasNotVoted.selector);
        gov.resolveDelegatedVote(id, alice);
    }

    function test_ResolveDelegatedVote_RevertsWhenNotDelegated() public {
        uint256 id = _createProposal();
        vm.expectRevert(LiquidGovernance.NotDelegated.selector);
        gov.resolveDelegatedVote(id, alice);
    }

    function test_ResolveDelegatedVote_RevertsOnDoubleResolve() public {
        vm.prank(alice);
        gov.delegate(bob);

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(bob, snap, 100 ether);
        token.setPastVotes(alice, snap, 10 ether);

        vm.prank(bob);
        gov.castVote(id, LiquidGovernance.VoteType.For);
        gov.resolveDelegatedVote(id, alice);

        vm.expectRevert(LiquidGovernance.AlreadyVoted.selector);
        gov.resolveDelegatedVote(id, alice);
    }

    function test_ResolveDelegatedVote_PermissionlessCaller() public {
        // Resolution can be called by anyone, not just alice or bob.
        vm.prank(alice);
        gov.delegate(bob);

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(bob, snap, 100 ether);
        token.setPastVotes(alice, snap, 10 ether);

        vm.prank(bob);
        gov.castVote(id, LiquidGovernance.VoteType.For);

        // carol, an unrelated third party, triggers the resolution.
        vm.prank(carol);
        gov.resolveDelegatedVote(id, alice);

        assertTrue(gov.getVoteReceipt(id, alice).hasVoted);
    }

    /*//////////////////////////////////////////////////////////////
                    CHAIN DEPTH CAP ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    function test_ResolveDelegatedVote_RevertsWhenVoterIsBeyondMaxDepth() public {
        // Build a chain longer than MAX_CHAIN_DEPTH (5): a->b->c->d->e->f->g,
        // where g is the one who actually votes - 6 hops from a to g,
        // beyond the cap.
        address b = makeAddr("b");
        address c = makeAddr("c");
        address d = makeAddr("d");
        address e = makeAddr("e");
        address f = makeAddr("f");
        address g = makeAddr("g");

        vm.prank(alice);
        gov.delegate(b);
        vm.prank(b);
        gov.delegate(c);
        vm.prank(c);
        gov.delegate(d);
        vm.prank(d);
        gov.delegate(e);
        vm.prank(e);
        gov.delegate(f);
        vm.prank(f);
        gov.delegate(g);

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(g, snap, 100 ether);
        token.setPastVotes(alice, snap, 10 ether);

        vm.prank(g);
        gov.castVote(id, LiquidGovernance.VoteType.For);

        // alice -> b -> c -> d -> e -> f is exactly 5 hops (MAX_CHAIN_DEPTH),
        // landing on f, who hasn't voted - g is one hop further than the
        // cap allows, so resolution correctly fails to find a voter.
        vm.expectRevert(LiquidGovernance.DelegateHasNotVoted.selector);
        gov.resolveDelegatedVote(id, alice);
    }

    function test_ResolveDelegatedVote_SucceedsAtExactlyMaxDepth() public {
        // alice -> b -> c -> d -> e -> f, where f votes - exactly 5 hops.
        address b = makeAddr("b");
        address c = makeAddr("c");
        address d = makeAddr("d");
        address e = makeAddr("e");
        address f = makeAddr("f");

        vm.prank(alice);
        gov.delegate(b);
        vm.prank(b);
        gov.delegate(c);
        vm.prank(c);
        gov.delegate(d);
        vm.prank(d);
        gov.delegate(e);
        vm.prank(e);
        gov.delegate(f);

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(f, snap, 100 ether);
        token.setPastVotes(alice, snap, 10 ether);

        vm.prank(f);
        gov.castVote(id, LiquidGovernance.VoteType.For);

        gov.resolveDelegatedVote(id, alice);

        assertTrue(gov.getVoteReceipt(id, alice).hasVoted);
        assertEq(gov.getVoteReceipt(id, alice).resolvedVia, f);
    }

    /*//////////////////////////////////////////////////////////////
                        CYCLE SAFETY
    //////////////////////////////////////////////////////////////*/

    function test_ResolveDelegatedVote_CycleDoesNotHangRevertsInstead() public {
        // alice -> bob -> alice (a cycle). Neither ever votes.
        vm.prank(alice);
        gov.delegate(bob);
        vm.prank(bob);
        gov.delegate(alice);

        uint256 id = _createProposal();

        // Must not infinite-loop - the hard depth cap bounds it, and since
        // nobody in the cycle ever votes, resolution correctly fails.
        vm.expectRevert(LiquidGovernance.DelegateHasNotVoted.selector);
        gov.resolveDelegatedVote(id, alice);
    }

    /*//////////////////////////////////////////////////////////////
                            QUEUE & EXECUTE
    //////////////////////////////////////////////////////////////*/

    function test_QueueProposal_CombinesDirectAndDelegatedWeight() public {
        vm.prank(bob);
        gov.delegate(carol); // bob -> carol

        uint256 id = _createProposal();
        uint256 snap = gov.getProposal(id).snapshotBlock;
        token.setPastVotes(carol, snap, 700 ether);
        token.setPastVotes(bob, snap, 300 ether);
        token.setPastTotalSupply(snap, 1_000 ether);

        vm.prank(carol);
        gov.castVote(id, LiquidGovernance.VoteType.For);
        gov.resolveDelegatedVote(id, bob);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + 1);
        gov.queueProposal(id);

        assertEq(uint8(gov.state(id)), uint8(LiquidGovernance.ProposalState.Queued));
    }
}
