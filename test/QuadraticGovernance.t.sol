// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuadraticGovernance} from "../src/governance/quadratic/QuadraticGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @dev Minimal mock of a StakedGovernanceToken - just enough surface for
///      QuadraticGovernance's IVotesToken interface.
contract MockVotesToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(uint256 => uint256)) internal _pastVotes;
    mapping(uint256 => uint256) internal _pastTotalSupply;

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

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

contract QuadraticGovernanceTest is Test {
    QuadraticGovernance internal gov;
    MockVotesToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // small holder
    address internal whale = makeAddr("whale"); // 100x alice's balance
    address internal recipient = makeAddr("recipient");

    function defaultConfig() internal pure returns (QuadraticGovernance.QuadraticGovernanceConfig memory) {
        return QuadraticGovernance.QuadraticGovernanceConfig({
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
        gov = QuadraticGovernance(Clones.clone(address(new QuadraticGovernance())));
        gov.initialize("Test DAO", creator, address(token), treasury, defaultConfig());
    }

    function _singleAction() internal view returns (QuadraticGovernance.ProposalAction[] memory actions) {
        actions = new QuadraticGovernance.ProposalAction[](1);
        actions[0] = QuadraticGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    /*//////////////////////////////////////////////////////////////
                        SQRT MATH CORRECTNESS
    //////////////////////////////////////////////////////////////*/

    function test_PreviewWeight_KnownPerfectSquares() public {
        token.setBalance(alice, 0);
        assertEq(gov.previewWeight(alice), 0);

        token.setBalance(alice, 1);
        assertEq(gov.previewWeight(alice), 1);

        token.setBalance(alice, 4);
        assertEq(gov.previewWeight(alice), 2);

        token.setBalance(alice, 100);
        assertEq(gov.previewWeight(alice), 10);

        token.setBalance(alice, 1_000_000);
        assertEq(gov.previewWeight(alice), 1_000);
    }

    function test_PreviewWeight_RoundsDownOnNonPerfectSquares() public {
        token.setBalance(alice, 2); // sqrt(2) ≈ 1.41, should floor to 1
        assertEq(gov.previewWeight(alice), 1);

        token.setBalance(alice, 99); // sqrt(99) ≈ 9.95, should floor to 9
        assertEq(gov.previewWeight(alice), 9);
    }

    /*//////////////////////////////////////////////////////////////
            THE ACTUAL POINT: DIMINISHING RETURNS FOR WHALES
    //////////////////////////////////////////////////////////////*/

    function test_DiminishingReturns_100xBalanceIsOnly10xWeight() public {
        token.setBalance(alice, 100 ether);
        token.setBalance(whale, 10_000 ether); // exactly 100x alice's balance

        uint256 aliceWeight = gov.previewWeight(alice);
        uint256 whaleWeight = gov.previewWeight(whale);

        // Whale has 100x the tokens but only 10x the voting weight - this
        // is the entire reason this contract exists.
        assertEq(whaleWeight, aliceWeight * 10);
    }

    function test_DiminishingReturns_AffectsActualVoteTally() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        _setSnapshotVotes(id, alice, 100 ether);
        _setSnapshotVotes(id, whale, 10_000 ether);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        uint256 aliceWeight = gov.castVote(id, QuadraticGovernance.VoteType.For);
        vm.prank(whale);
        uint256 whaleWeight = gov.castVote(id, QuadraticGovernance.VoteType.Against);

        // Raw balances would have made the whale dominate 100:1. Under
        // sqrt-weighting, the whale's advantage shrinks to 10:1.
        assertEq(whaleWeight, aliceWeight * 10);

        QuadraticGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(p.forVotes, aliceWeight);
        assertEq(p.againstVotes, whaleWeight);
    }

    /// @dev Helper: sets a holder's getPastVotes at the snapshot block a
    ///      given proposal actually uses (proposal.snapshotBlock).
    function _setSnapshotVotes(uint256 proposalId, address account, uint256 amount) internal {
        QuadraticGovernance.Proposal memory p = gov.getProposal(proposalId);
        token.setPastVotes(account, p.snapshotBlock, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            PROPOSAL LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function test_Propose_RevertsOnEmptyActions() public {
        QuadraticGovernance.ProposalAction[] memory none = new QuadraticGovernance.ProposalAction[](0);
        vm.expectRevert(QuadraticGovernance.EmptyProposalActions.selector);
        gov.propose(none, "ipfs://p1");
    }

    function test_CastVote_RevertsOnDoubleVote() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");
        _setSnapshotVotes(id, alice, 100 ether);
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(id, QuadraticGovernance.VoteType.For);

        vm.prank(alice);
        vm.expectRevert(QuadraticGovernance.AlreadyVoted.selector);
        gov.castVote(id, QuadraticGovernance.VoteType.For);
    }

    function _proposeVoteQueue() internal returns (uint256 id) {
        vm.prank(alice);
        id = gov.propose(_singleAction(), "ipfs://p1");
        _setSnapshotVotes(id, alice, 10_000 ether);

        QuadraticGovernance.Proposal memory p = gov.getProposal(id);
        // 10,000 ether vs. 1,000,000 ether is a 100x ratio in raw balance;
        // sqrt shrinks that to a 10x ratio in weight, giving exactly 10%
        // participation against quorum (the ether-unit scaling factor
        // cancels out between numerator and denominator).
        token.setPastTotalSupply(p.snapshotBlock, 1_000_000 ether);
        
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);
        vm.prank(alice);
        gov.castVote(id, QuadraticGovernance.VoteType.For);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + 1);
        gov.queueProposal(id);
        
    }

    function test_QueueProposal_RevertsWhenQuorumNotReached() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + defaultConfig().votingDelay + 1);

        vm.expectRevert(QuadraticGovernance.QuorumNotReached.selector);
        gov.queueProposal(id);
    }

    function test_QueueProposal_SucceedsAtExactQuorum() public {
        uint256 id = _proposeVoteQueue();
        assertEq(uint8(gov.state(id)), uint8(QuadraticGovernance.ProposalState.Queued));
    }

    function test_ExecuteProposal_RevertsBeforeTimelock() public {
        uint256 id = _proposeVoteQueue();
        vm.expectRevert(QuadraticGovernance.ProposalNotExecutable.selector);
        gov.executeProposal(id);
    }

    function test_ExecuteProposal_Succeeds() public {
        uint256 id = _proposeVoteQueue();
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        gov.executeProposal(id);
        assertEq(uint8(gov.state(id)), uint8(QuadraticGovernance.ProposalState.Executed));
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function test_UpdateGovernanceConfig_RevertsForExternalCaller() public {
        vm.expectRevert(QuadraticGovernance.Unauthorized.selector);
        gov.updateGovernanceConfig(defaultConfig());
    }

    function test_SetTreasury_RevertsForExternalCaller() public {
        vm.expectRevert(QuadraticGovernance.Unauthorized.selector);
        gov.setTreasury(address(0xBEEF));
    }
}
