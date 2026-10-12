// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SortitionGovernance} from "../src/governance/sortition/SortitionGovernance.sol";
import {IRandomnessSource} from "../src/randomness/IRandomnessSource.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PythEntropyRandomnessAdapter} from "../src/randomness/PythEntropyRandomnessAdapter.sol";
import {FeeEntropy} from "./PythAdapters.t.sol";

/// @dev Minimal mock randomness source - lets these tests control exactly
///      what "random" value gets returned, so the draw logic itself can be
///      verified deterministically.
contract MockRandomnessSource is IRandomnessSource {
    mapping(bytes32 => bool) public fulfilled;
    mapping(bytes32 => uint256) public value;

    function requestRandomness(bytes32 requestId) external payable {
        // Left unfulfilled until the test explicitly calls setFulfilled -
        // mirrors the real async request/fulfill split.
    }

    function setFulfilled(bytes32 requestId, uint256 randomValue) external {
        fulfilled[requestId] = true;
        value[requestId] = randomValue;
    }

    function isFulfilled(bytes32 requestId) external view returns (bool) {
        return fulfilled[requestId];
    }

    function getRandomness(bytes32 requestId) external view returns (uint256) {
        require(fulfilled[requestId], "not fulfilled");
        return value[requestId];
    }
}

contract MockBalanceToken {
    mapping(address => uint256) public balanceOf;

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}

contract SortitionGovernanceTest is Test {
    SortitionGovernance internal gov;
    MockRandomnessSource internal randomness;
    MockBalanceToken internal token;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // initial council
    address internal bob = makeAddr("bob"); // initial council
    address internal carol = makeAddr("carol"); // initial council
    address internal dave = makeAddr("dave"); // eligible pool
    address internal eve = makeAddr("eve"); // eligible pool
    address internal frank = makeAddr("frank"); // eligible pool
    address internal recipient = makeAddr("recipient");

    function defaultConfig() internal pure returns (SortitionGovernance.SortitionGovernanceConfig memory) {
        return SortitionGovernance.SortitionGovernanceConfig({
            councilSize: 3,
            termLength: 30 days,
            eligibilityThreshold: 100 ether,
            councilQuorum: 2,
            councilApprovalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 50,
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function initialCouncil() internal view returns (address[] memory members) {
        members = new address[](3);
        members[0] = alice;
        members[1] = bob;
        members[2] = carol;
    }

    function setUp() public {
        token = new MockBalanceToken();
        randomness = new MockRandomnessSource();
        gov = SortitionGovernance(Clones.clone(address(new SortitionGovernance())));
        gov.initialize(
            "Test DAO", creator, address(token), treasury, address(randomness), defaultConfig(), initialCouncil()
        );
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsInitialCouncil() public view {
        assertEq(gov.getCouncil().length, 3);
        assertTrue(gov.isCouncilMember(alice));
    }

    function test_Constructor_RevertsOnZeroRandomnessSource() public {
        SortitionGovernance freshGov = SortitionGovernance(Clones.clone(address(new SortitionGovernance())));
        vm.expectRevert(SortitionGovernance.ZeroAddress.selector);
        freshGov.initialize(
            "Test", creator, address(token), treasury, address(0), defaultConfig(), initialCouncil()
        );
    }

    /*//////////////////////////////////////////////////////////////
                    ELIGIBILITY POOL REGISTRATION
    //////////////////////////////////////////////////////////////*/

    function test_RegisterEligible_RevertsBelowThreshold() public {
        token.setBalance(dave, 1 ether);
        vm.prank(dave);
        vm.expectRevert(SortitionGovernance.EligibilityThresholdNotMet.selector);
        gov.registerEligible();
    }

    function test_RegisterEligible_AddsToPool() public {
        token.setBalance(dave, 100 ether);
        vm.prank(dave);
        gov.registerEligible();

        assertTrue(gov.isEligible(dave));
        assertEq(gov.getEligiblePool().length, 1);
    }

    function test_RegisterEligible_RevertsOnDoubleRegister() public {
        token.setBalance(dave, 100 ether);
        vm.prank(dave);
        gov.registerEligible();

        vm.prank(dave);
        vm.expectRevert(SortitionGovernance.AlreadyEligible.selector);
        gov.registerEligible();
    }

    function test_WithdrawEligibility_RemovesFromPool() public {
        token.setBalance(dave, 100 ether);
        token.setBalance(eve, 100 ether);
        vm.prank(dave);
        gov.registerEligible();
        vm.prank(eve);
        gov.registerEligible();

        vm.prank(dave);
        gov.withdrawEligibility();

        assertFalse(gov.isEligible(dave));
        assertEq(gov.getEligiblePool().length, 1);
        assertEq(gov.getEligiblePool()[0], eve);
    }

    function test_WithdrawEligibility_RevertsWhenNotEligible() public {
        vm.prank(dave);
        vm.expectRevert(SortitionGovernance.NotEligible.selector);
        gov.withdrawEligibility();
    }

    /*//////////////////////////////////////////////////////////////
                            SORTITION ROUNDS
    //////////////////////////////////////////////////////////////*/

    function test_StartSortition_RevertsBeforeTermEnd() public {
        vm.expectRevert(SortitionGovernance.TooEarlyForSortition.selector);
        gov.startSortition();
    }

    function test_StartSortition_RevertsOnEmptyPool() public {
        vm.warp(gov.currentTermEnd());
        vm.expectRevert(SortitionGovernance.EmptyEligiblePool.selector);
        gov.startSortition();
    }

    function _registerPool() internal {
        address[3] memory pool = [dave, eve, frank];
        for (uint256 i = 0; i < pool.length; i++) {
            token.setBalance(pool[i], 100 ether);
            vm.prank(pool[i]);
            gov.registerEligible();
        }
    }

    function test_FinalizeSortition_RevertsBeforeFulfilled() public {
        _registerPool();
        vm.warp(gov.currentTermEnd());
        gov.startSortition();

        vm.expectRevert(SortitionGovernance.RandomnessNotYetFulfilled.selector);
        gov.finalizeSortition();
    }

    function test_FullSortitionRound_DrawsCouncilFromPool() public {
        _registerPool(); // exactly 3 eligible, councilSize is 3 - all get drawn
        vm.warp(gov.currentTermEnd());
        uint256 round = gov.startSortition();

        bytes32 requestId = gov.requestIdOfRound(round);
        randomness.setFulfilled(requestId, 12345);

        gov.finalizeSortition();

        address[] memory newCouncil = gov.getCouncil();
        assertEq(newCouncil.length, 3);
        assertTrue(gov.isCouncilMember(dave));
        assertTrue(gov.isCouncilMember(eve));
        assertTrue(gov.isCouncilMember(frank));
        // Old council fully replaced.
        assertFalse(gov.isCouncilMember(alice));
        assertFalse(gov.isCouncilMember(bob));
        assertFalse(gov.isCouncilMember(carol));
    }

    function test_FullSortitionRound_DrawsFewerThanPoolWhenPoolLargerThanSeats() public {
        _registerPool();
        address grace = makeAddr("grace");
        token.setBalance(grace, 100 ether);
        vm.prank(grace);
        gov.registerEligible(); // 4 eligible, only 3 seats

        vm.warp(gov.currentTermEnd());
        uint256 round = gov.startSortition();
        bytes32 requestId = gov.requestIdOfRound(round);
        randomness.setFulfilled(requestId, 999);

        gov.finalizeSortition();

        // Exactly 3 seats filled, no more, no fewer.
        assertEq(gov.getCouncil().length, 3);
    }

    function test_FullSortitionRound_DistinctMembersNoDuplicates() public {
        _registerPool();
        address grace = makeAddr("grace");
        address henry = makeAddr("henry");
        token.setBalance(grace, 100 ether);
        token.setBalance(henry, 100 ether);
        vm.prank(grace);
        gov.registerEligible();
        vm.prank(henry);
        gov.registerEligible(); // 5 eligible, 3 seats

        vm.warp(gov.currentTermEnd());
        uint256 round = gov.startSortition();
        bytes32 requestId = gov.requestIdOfRound(round);
        randomness.setFulfilled(requestId, 777);

        gov.finalizeSortition();

        address[] memory newCouncil = gov.getCouncil();
        assertEq(newCouncil.length, 3);
        // No duplicate seats - every member appears in the pool exactly once.
        assertTrue(newCouncil[0] != newCouncil[1]);
        assertTrue(newCouncil[1] != newCouncil[2]);
        assertTrue(newCouncil[0] != newCouncil[2]);
    }

    function test_FinalizeSortition_RevertsOnDoubleFinalize() public {
        _registerPool();
        vm.warp(gov.currentTermEnd());
        uint256 round = gov.startSortition();
        bytes32 requestId = gov.requestIdOfRound(round);
        randomness.setFulfilled(requestId, 42);
        gov.finalizeSortition();

        vm.expectRevert(SortitionGovernance.NoActiveSortitionRound.selector);
        gov.finalizeSortition();
    }

    function test_StartSortition_RevertsWhileRoundAlreadyActive() public {
        _registerPool();
        vm.warp(gov.currentTermEnd());
        gov.startSortition();

        vm.expectRevert(SortitionGovernance.SortitionAlreadyActive.selector);
        gov.startSortition();
    }

    /*//////////////////////////////////////////////////////////////
                PYTH ENTROPY AS THE RANDOMNESS SOURCE
    //////////////////////////////////////////////////////////////*/

    event SortitionRoundAbandoned(uint256 indexed round);

    function _useEntropy() internal returns (FeeEntropy entropy, PythEntropyRandomnessAdapter adapter) {
        entropy = new FeeEntropy();
        adapter = new PythEntropyRandomnessAdapter(address(entropy), 0);
        vm.prank(address(gov)); // onlyGovernance: as if through a passed proposal
        gov.setRandomnessSource(address(adapter));
    }

    function test_StartSortition_ForwardsFeeToPythEntropy() public {
        (FeeEntropy entropy, PythEntropyRandomnessAdapter adapter) = _useEntropy();
        _registerPool();
        vm.warp(gov.currentTermEnd());
        uint256 fee = adapter.requestFee();
        uint256 round = gov.startSortition{value: fee}();
        assertEq(address(entropy).balance, fee);

        bytes32 requestId = gov.requestIdOfRound(round);
        entropy.reveal(adapter.sequenceOf(requestId), bytes32(uint256(12345)));
        gov.finalizeSortition();
        assertEq(gov.getCouncil().length, 3);
    }

    function test_StartSortition_WithoutFee_Reverts() public {
        (, PythEntropyRandomnessAdapter adapter) = _useEntropy();
        _registerPool();
        vm.warp(gov.currentTermEnd());
        vm.expectRevert(abi.encodeWithSelector(PythEntropyRandomnessAdapter.InsufficientFunds.selector, adapter.requestFee(), 0));
        gov.startSortition();
    }

    /// A DAO cloned before startSortition was payable can still draw:
    /// its governance contract's credit is funded in advance.
    function test_StartSortition_PaidFromPrefundedCredit() public {
        (FeeEntropy entropy, PythEntropyRandomnessAdapter adapter) = _useEntropy();
        adapter.fund{value: 1 ether}(address(gov));
        _registerPool();
        vm.warp(gov.currentTermEnd());
        uint256 round = gov.startSortition();
        assertEq(adapter.credit(address(gov)), 1 ether - adapter.requestFee());
        entropy.reveal(adapter.sequenceOf(gov.requestIdOfRound(round)), bytes32(uint256(9)));
        gov.finalizeSortition();
        assertEq(gov.getCouncil().length, 3);
    }

    /// The Switchboard case: a round waiting on a provider that will never
    /// answer. Switching the source abandons it, so the DAO isn't stuck.
    function test_SetRandomnessSource_AbandonsStuckRound() public {
        _registerPool();
        vm.warp(gov.currentTermEnd());
        uint256 stuck = gov.startSortition(); // the mock never fulfills it

        FeeEntropy entropy = new FeeEntropy();
        PythEntropyRandomnessAdapter adapter = new PythEntropyRandomnessAdapter(address(entropy), 0);
        vm.expectEmit(true, false, false, false, address(gov));
        emit SortitionRoundAbandoned(stuck);
        vm.prank(address(gov));
        gov.setRandomnessSource(address(adapter));

        vm.expectRevert(SortitionGovernance.NoActiveSortitionRound.selector);
        gov.finalizeSortition();

        vm.warp(block.timestamp + 1); // a fresh request ID
        uint256 round = gov.startSortition{value: adapter.requestFee()}();
        assertEq(round, stuck + 1);
        entropy.reveal(adapter.sequenceOf(gov.requestIdOfRound(round)), bytes32(uint256(77)));
        gov.finalizeSortition();
        assertEq(gov.getCouncil().length, 3);
    }

    /*//////////////////////////////////////////////////////////////
                COUNCIL PROPOSAL LIFECYCLE (same shape as
                DelegateGovernance's council mechanics)
    //////////////////////////////////////////////////////////////*/

    function _singleAction() internal view returns (SortitionGovernance.ProposalAction[] memory actions) {
        actions = new SortitionGovernance.ProposalAction[](1);
        actions[0] = SortitionGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    function test_ProposeCouncilAction_NonCouncilMemberCanProposeIfEligible() public {
        // dave isn't on the council, but proposing no longer requires a
        // seat - only meeting the eligibility threshold.
        token.setBalance(dave, 100 ether);
        vm.prank(dave);
        uint256 id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");

        SortitionGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(p.proposer, dave);
    }

    function test_ProposeCouncilAction_RevertsBelowEligibilityThreshold() public {
        token.setBalance(dave, 1 ether); // below eligibilityThreshold of 100 ether
        vm.prank(dave);
        vm.expectRevert(SortitionGovernance.EligibilityThresholdNotMet.selector);
        gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
    }

    function _proposeVoteQueue() internal returns (uint256 id) {
        token.setBalance(alice, 100 ether); // meet eligibilityThreshold to propose
        vm.prank(alice);
        id = gov.proposeCouncilAction(_singleAction(), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castCouncilVote(id, SortitionGovernance.VoteType.For);
        vm.prank(bob);
        gov.castCouncilVote(id, SortitionGovernance.VoteType.For);

        vm.roll(vm.getBlockNumber() + defaultConfig().votingPeriod + 1);
        gov.queueProposal(id);
    }

    function test_QueueProposal_SucceedsWithTwoOfThreeFor() public {
        uint256 id = _proposeVoteQueue();
        assertEq(uint8(gov.state(id)), uint8(SortitionGovernance.ProposalState.Queued));
    }

    function test_ExecuteProposal_Succeeds() public {
        uint256 id = _proposeVoteQueue();
        vm.warp(vm.getBlockTimestamp() + defaultConfig().timelockDelay + 1);

        gov.executeProposal(id);
        assertEq(uint8(gov.state(id)), uint8(SortitionGovernance.ProposalState.Executed));
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function test_SetRandomnessSource_RevertsForExternalCaller() public {
        vm.expectRevert(SortitionGovernance.Unauthorized.selector);
        gov.setRandomnessSource(address(0xBEEF));
    }

    function test_UpdateConfig_RevertsForExternalCaller() public {
        vm.expectRevert(SortitionGovernance.Unauthorized.selector);
        gov.updateConfig(defaultConfig());
    }
}
