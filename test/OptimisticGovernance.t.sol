// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OptimisticGovernance} from "../src/governance/optimistic/OptimisticGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @dev Minimal mock of a StakedGovernanceToken - covers voting-power reads
///      and standard ERC20 transfer methods (for bond handling).
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

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract OptimisticGovernanceTest is Test {
    OptimisticGovernance internal gov;
    MockVotesToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // proposer
    address internal challenger = makeAddr("challenger");
    address internal bob = makeAddr("bob"); // voter in fallback votes
    address internal recipient = makeAddr("recipient");

    uint256 internal constant CHALLENGE_BOND = 500 ether;

    function defaultConfig() internal pure returns (OptimisticGovernance.OptimisticGovernanceConfig memory) {
        return OptimisticGovernance.OptimisticGovernanceConfig({
            challengePeriod: 50,
            challengeBond: CHALLENGE_BOND,
            quorumBps: 1_000,
            approvalThresholdBps: 6_000,
            votingPeriod: 100,
            timelockDelay: 1 days,
            executionPeriod: 7 days,
            proposalThreshold: 0
        });
    }

    function setUp() public {
        token = new MockVotesToken();
        gov = OptimisticGovernance(Clones.clone(address(new OptimisticGovernance())));
        gov.initialize("Test DAO", creator, address(token), treasury, defaultConfig());
    }

    function _singleAction() internal view returns (OptimisticGovernance.ProposalAction[] memory actions) {
        actions = new OptimisticGovernance.ProposalAction[](1);
        actions[0] = OptimisticGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    /*//////////////////////////////////////////////////////////////
                    UNCHALLENGED FAST PATH (the whole point)
    //////////////////////////////////////////////////////////////*/

    function test_UnchallengedProposal_AutoSucceedsAfterWindow() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");
        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.ChallengeWindow));

        vm.roll(vm.getBlockNumber() + defaultConfig().challengePeriod + 1);
        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.Succeeded));

        gov.finalizeUnchallenged(id);
        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.Queued));
    }

    function test_FinalizeUnchallenged_RevertsIfChallenged() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        token.setBalance(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        gov.challenge(id);

        vm.roll(vm.getBlockNumber() + defaultConfig().challengePeriod + 1);
        vm.expectRevert(OptimisticGovernance.AlreadyChallenged.selector);
        gov.finalizeUnchallenged(id);
    }

    function test_FinalizeUnchallenged_RevertsBeforeWindowCloses() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        vm.expectRevert(OptimisticGovernance.ChallengeWindowStillOpen.selector);
        gov.finalizeUnchallenged(id);
    }

    function test_UnchallengedProposal_FullyExecutes() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().challengePeriod + 1);
        gov.finalizeUnchallenged(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        gov.executeProposal(id);
        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.Executed));
    }

    /*//////////////////////////////////////////////////////////////
                            CHALLENGING
    //////////////////////////////////////////////////////////////*/

    function test_Challenge_RevertsAfterWindowCloses() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().challengePeriod + 1);

        token.setBalance(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        vm.expectRevert(OptimisticGovernance.ChallengeWindowClosed.selector);
        gov.challenge(id);
    }

    function test_Challenge_RevertsOnDoubleChallenge() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        token.setBalance(challenger, CHALLENGE_BOND * 2);
        vm.prank(challenger);
        gov.challenge(id);

        vm.prank(challenger);
        vm.expectRevert(OptimisticGovernance.AlreadyChallenged.selector);
        gov.challenge(id);
    }

    function test_Challenge_PullsBondIntoContract() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        token.setBalance(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        gov.challenge(id);

        assertEq(token.balanceOf(challenger), 0);
        assertEq(token.balanceOf(address(gov)), CHALLENGE_BOND);
        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.Active));
    }

    /*//////////////////////////////////////////////////////////////
        CHALLENGE OUTCOME 1: VOTE UPHOLDS THE PROPOSAL -> BOND FORFEITED
    //////////////////////////////////////////////////////////////*/

    function test_ChallengeFails_BondForfeitedAndProposalQueues() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        token.setBalance(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        gov.challenge(id);

        OptimisticGovernance.Proposal memory p = gov.getProposal(id);
        token.setPastVotes(bob, p.snapshotBlock, 10_000 ether);
        token.setPastTotalSupply(p.snapshotBlock, 100_000 ether); // 10% quorum met

        vm.prank(bob);
        gov.castVote(id, OptimisticGovernance.VoteType.For);

        vm.roll(p.votingEndBlock + 1);
        gov.finalizeChallenge(id);

        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.Queued));
        assertEq(token.balanceOf(treasury), CHALLENGE_BOND);
        assertEq(token.balanceOf(challenger), 0);
    }

    /*//////////////////////////////////////////////////////////////
        CHALLENGE OUTCOME 2: VOTE STRIKES DOWN THE PROPOSAL -> BOND RETURNED
    //////////////////////////////////////////////////////////////*/

    function test_ChallengeSucceeds_BondReturnedAndProposalDefeated() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        token.setBalance(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        gov.challenge(id);

        OptimisticGovernance.Proposal memory p = gov.getProposal(id);
        token.setPastVotes(bob, p.snapshotBlock, 10_000 ether);
        token.setPastTotalSupply(p.snapshotBlock, 100_000 ether);

        vm.prank(bob);
        gov.castVote(id, OptimisticGovernance.VoteType.Against);

        vm.roll(p.votingEndBlock + 1);
        gov.finalizeChallenge(id);

        assertEq(uint8(gov.state(id)), uint8(OptimisticGovernance.ProposalState.Defeated));
        assertEq(token.balanceOf(challenger), CHALLENGE_BOND);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_FinalizeChallenge_RevertsOnDoubleResolve() public {
        vm.prank(alice);
        uint256 id = gov.propose(_singleAction(), "ipfs://p1");

        token.setBalance(challenger, CHALLENGE_BOND);
        vm.prank(challenger);
        gov.challenge(id);

        OptimisticGovernance.Proposal memory p = gov.getProposal(id);
        token.setPastVotes(bob, p.snapshotBlock, 10_000 ether);
        token.setPastTotalSupply(p.snapshotBlock, 100_000 ether);
        vm.prank(bob);
        gov.castVote(id, OptimisticGovernance.VoteType.Against);

        vm.roll(p.votingEndBlock + 1);
        gov.finalizeChallenge(id);

        // Defeated proposals never get queuedAt set, so the ordinary
        // ProposalAlreadyQueued guard doesn't apply - bondResolved is the
        // guard that actually prevents a second bond payout here.
        vm.expectRevert(OptimisticGovernance.BondAlreadyResolved.selector);
        gov.finalizeChallenge(id);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function test_UpdateGovernanceConfig_RevertsForExternalCaller() public {
        vm.expectRevert(OptimisticGovernance.Unauthorized.selector);
        gov.updateGovernanceConfig(defaultConfig());
    }
}
