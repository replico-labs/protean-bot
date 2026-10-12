// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DelegateGovernance} from "../src/governance/delegate/DelegateGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @dev Minimal mock of a StakedGovernanceToken - just enough surface for
///      DelegateGovernance's IVotesToken interface. Lets these tests run
///      without pulling in the full ERC20Votes stack.
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

contract DelegateGovernanceTest is Test {
    DelegateGovernance internal gov;
    MockVotesToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // council member
    address internal bob = makeAddr("bob"); // council member
    address internal carol = makeAddr("carol"); // council member
    address internal dave = makeAddr("dave"); // token holder, not on council
    address internal eve = makeAddr("eve"); // candidate challenger
    address internal recipient = makeAddr("recipient");

    function defaultConfig() internal pure returns (DelegateGovernance.DelegateGovernanceConfig memory) {
        return DelegateGovernance.DelegateGovernanceConfig({
            councilSize: 3,
            termLength: 30 days,
            candidacyThreshold: 100 ether,
            candidacyPeriod: 10,
            electionVotingPeriod: 50,
            councilQuorum: 2,
            councilApprovalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 50,
            timelockDelay: 1 days,
            executionPeriod: 7 days,
            recallQuorumBps: 1_000,
            recallApprovalThresholdBps: 6_000,
            recallVotingPeriod: 50
        });
    }

    function initialCouncil() internal view returns (address[] memory members) {
        members = new address[](3);
        members[0] = alice;
        members[1] = bob;
        members[2] = carol;
    }

    function setUp() public {
        token = new MockVotesToken();
        gov = DelegateGovernance(Clones.clone(address(new DelegateGovernance())));
        gov.initialize(
            "Test DAO", creator, address(token), treasury, defaultConfig(), initialCouncil()
        );
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsInitialCouncil() public view {
        address[] memory council = gov.getCouncil();
        assertEq(council.length, 3);
        assertTrue(gov.isCouncilMember(alice));
        assertTrue(gov.isCouncilMember(bob));
        assertTrue(gov.isCouncilMember(carol));
        assertFalse(gov.isCouncilMember(dave));
    }

    function test_Constructor_SetsTermEnd() public view {
        assertEq(gov.currentTermEnd(), vm.getBlockTimestamp() + 30 days);
    }

    function test_Constructor_RevertsOnCouncilSizeMismatch() public {
        address[] memory tooFew = new address[](2);
        tooFew[0] = alice;
        tooFew[1] = bob;

        DelegateGovernance freshGov1 = DelegateGovernance(Clones.clone(address(new DelegateGovernance())));
        vm.expectRevert(DelegateGovernance.InvalidConfiguration.selector);
        freshGov1.initialize("Test DAO", creator, address(token), treasury, defaultConfig(), tooFew);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        DelegateGovernance freshGov2 = DelegateGovernance(Clones.clone(address(new DelegateGovernance())));
        vm.expectRevert(DelegateGovernance.ZeroAddress.selector);
        freshGov2.initialize("Test DAO", creator, address(token), address(0), defaultConfig(), initialCouncil());
    }

    function test_Constructor_RevertsOnInvalidQuorumAboveCouncilSize() public {
        DelegateGovernance.DelegateGovernanceConfig memory badConfig = defaultConfig();
        badConfig.councilQuorum = 5; // exceeds councilSize of 3

        DelegateGovernance freshGov3 = DelegateGovernance(Clones.clone(address(new DelegateGovernance())));
        vm.expectRevert(DelegateGovernance.InvalidConfiguration.selector);
        freshGov3.initialize("Test DAO", creator, address(token), treasury, badConfig, initialCouncil());
    }

    /*//////////////////////////////////////////////////////////////
                        COUNCIL PROPOSAL LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function _singleAction() internal view returns (DelegateGovernance.ProposalAction[] memory actions) {
        actions = new DelegateGovernance.ProposalAction[](1);
        actions[0] = DelegateGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    function test_ProposeCouncilAction_OnlyCouncilMember() public {
        vm.prank(dave);
        vm.expectRevert(DelegateGovernance.NotCouncilMember.selector);
        gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
    }

    function test_ProposeCouncilAction_CreatesProposal() public {
        vm.prank(alice);
        uint256 id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");

        DelegateGovernance.CouncilProposal memory p = gov.getProposal(id);
        assertEq(p.proposer, alice);
        assertEq(p.metadataURI, "ipfs://p1");
    }

    function test_CastCouncilVote_OnlyCouncilMember() public {
        vm.prank(alice);
        uint256 id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(dave);
        vm.expectRevert(DelegateGovernance.NotCouncilMember.selector);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);
    }

    function test_CastCouncilVote_RevertsOnDoubleVote() public {
        vm.prank(alice);
        uint256 id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);

        vm.prank(alice);
        vm.expectRevert(DelegateGovernance.AlreadyVoted.selector);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);
    }

    function _proposeVoteAndQueue() internal returns (uint256 id) {
        vm.prank(alice);
        id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);
        vm.prank(bob);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + 1);
        gov.queueCouncilProposal(id);
    }

    function test_QueueCouncilProposal_RevertsWhenQuorumNotReached() public {
        vm.prank(alice);
        uint256 id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        // Only one of three council members votes - below councilQuorum of 2.
        vm.prank(alice);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + 1);
        vm.expectRevert(DelegateGovernance.CouncilQuorumNotReached.selector);
        gov.queueCouncilProposal(id);
    }

    function test_QueueCouncilProposal_RevertsWhenApprovalNotMet() public {
        vm.prank(alice);
        uint256 id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.For);
        vm.prank(bob);
        gov.castCouncilVote(id, DelegateGovernance.VoteType.Against);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + 1);
        vm.expectRevert(DelegateGovernance.CouncilApprovalNotMet.selector);
        gov.queueCouncilProposal(id);
    }

    function test_QueueCouncilProposal_SucceedsWithTwoOfThreeFor() public {
        uint256 id = _proposeVoteAndQueue();
        assertEq(uint8(gov.state(id)), uint8(DelegateGovernance.ProposalState.Queued));
    }

    function test_ExecuteCouncilProposal_RevertsBeforeTimelock() public {
        uint256 id = _proposeVoteAndQueue();
        vm.expectRevert(DelegateGovernance.ProposalNotExecutable.selector);
        gov.executeCouncilProposal(id);
    }

    function test_ExecuteCouncilProposal_Succeeds() public {
        uint256 id = _proposeVoteAndQueue();
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        gov.executeCouncilProposal(id);
        assertEq(uint8(gov.state(id)), uint8(DelegateGovernance.ProposalState.Executed));
    }

    /*//////////////////////////////////////////////////////////////
                            ELECTION LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function test_StartElection_RevertsBeforeTermEnd() public {
        vm.expectRevert(DelegateGovernance.TooEarlyForElection.selector);
        gov.startElection();
    }

    function test_FullElection_ReplacesCouncil() public {
        vm.warp(gov.currentTermEnd());

        uint256 electionId = gov.startElection();

        token.setBalance(eve, 200 ether);
        token.setBalance(dave, 200 ether);

        vm.prank(eve);
        gov.declareCandidacy(electionId);
        vm.prank(dave);
        gov.declareCandidacy(electionId);

        DelegateGovernance.Election memory election = gov.getElection(electionId);
        vm.roll(election.candidacyDeadline + 1);

        token.setPastVotes(alice, election.snapshotBlock, 500 ether);
        token.setPastVotes(bob, election.snapshotBlock, 100 ether);

        address[] memory picksEve = new address[](1);
        picksEve[0] = eve;
        vm.prank(alice);
        gov.voteInElection(electionId, picksEve);

        address[] memory picksDave = new address[](1);
        picksDave[0] = dave;
        vm.prank(bob);
        gov.voteInElection(electionId, picksDave);

        vm.roll(election.votingEndBlock + 1);
        gov.finalizeElection(electionId);

        // Eve and dave were the only two candidates - both win seats (3rd
        // seat vacant, since there were only 2 candidates for 3 seats).
        assertTrue(gov.isCouncilMember(eve));
        assertTrue(gov.isCouncilMember(dave));
        // Old council members who weren't candidates are no longer members.
        assertFalse(gov.isCouncilMember(carol));

        address[] memory newCouncil = gov.getCouncil();
        assertEq(newCouncil.length, 2);
    }

    function test_DeclareCandidacy_RevertsBelowThreshold() public {
        vm.warp(gov.currentTermEnd());
        uint256 electionId = gov.startElection();

        token.setBalance(dave, 1 ether); // below candidacyThreshold of 100 ether

        vm.prank(dave);
        vm.expectRevert(DelegateGovernance.CandidacyThresholdNotMet.selector);
        gov.declareCandidacy(electionId);
    }

    function test_VoteInElection_RevertsOnDuplicateCandidate() public {
        vm.warp(gov.currentTermEnd());
        uint256 electionId = gov.startElection();

        token.setBalance(eve, 200 ether);
        vm.prank(eve);
        gov.declareCandidacy(electionId);

        DelegateGovernance.Election memory election = gov.getElection(electionId);
        vm.roll(election.candidacyDeadline + 1);

        address[] memory dupes = new address[](2);
        dupes[0] = eve;
        dupes[1] = eve;

        vm.prank(dave);
        vm.expectRevert(DelegateGovernance.DuplicateCandidate.selector);
        gov.voteInElection(electionId, dupes);
    }

    /*//////////////////////////////////////////////////////////////
                                RECALL
    //////////////////////////////////////////////////////////////*/

    function test_InitiateRecall_OnlyAgainstCurrentCouncilMember() public {
        token.setBalance(dave, 200 ether);
        vm.prank(dave);
        vm.expectRevert(DelegateGovernance.NotCurrentlyOnCouncil.selector);
        gov.initiateRecall(dave);
    }

    function test_InitiateRecall_RevertsBelowThreshold() public {
        token.setBalance(dave, 1 ether);
        vm.prank(dave);
        vm.expectRevert(DelegateGovernance.CandidacyThresholdNotMet.selector);
        gov.initiateRecall(alice);
    }

    function test_FullRecall_RemovesDelegateWhenPassed() public {
        token.setBalance(dave, 200 ether);
        vm.prank(dave);
        uint256 recallId = gov.initiateRecall(alice);

        DelegateGovernance.RecallVote memory r = gov.getRecall(recallId);
        token.setPastVotes(dave, r.snapshotBlock, 200 ether);
        token.setPastTotalSupply(r.snapshotBlock, 1_000 ether); // 20% participation clears 10% quorum

        vm.prank(dave);
        gov.voteRecall(recallId, DelegateGovernance.VoteType.For);

        vm.roll(r.endBlock + 1);
        gov.finalizeRecall(recallId);

        assertFalse(gov.isCouncilMember(alice));
        address[] memory council = gov.getCouncil();
        assertEq(council.length, 2);
    }

    function test_FullRecall_DelegateStaysWhenQuorumNotMet() public {
        token.setBalance(dave, 100 ether);
        vm.prank(dave);
        uint256 recallId = gov.initiateRecall(alice);

        DelegateGovernance.RecallVote memory r = gov.getRecall(recallId);
        token.setPastVotes(dave, r.snapshotBlock, 10 ether);
        token.setPastTotalSupply(r.snapshotBlock, 1_000 ether); // 1% participation, below 10% quorum

        vm.prank(dave);
        gov.voteRecall(recallId, DelegateGovernance.VoteType.For);

        vm.roll(r.endBlock + 1);
        gov.finalizeRecall(recallId);

        assertTrue(gov.isCouncilMember(alice));
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function test_UpdateConfig_RevertsForExternalCaller() public {
        vm.expectRevert(DelegateGovernance.Unauthorized.selector);
        gov.updateConfig(defaultConfig());
    }

    function test_SetTreasury_RevertsForExternalCaller() public {
        vm.expectRevert(DelegateGovernance.Unauthorized.selector);
        gov.setTreasury(address(0xBEEF));
    }
}
