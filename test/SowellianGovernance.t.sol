// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SowellianGovernance} from "../src/governance/sowellian/SowellianGovernance.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythPriceFeedAdapter} from "../src/oracles/PythPriceFeedAdapter.sol";

/// @dev Minimal mock of a StakedGovernanceToken - voting power reads plus
///      real transfer/transferFrom semantics, since this contract moves
///      real value through bonds and market positions.
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

contract MockOracle {
    int256 internal _value;
    uint256 internal _updatedAt;

    function setValue(int256 value) external {
        _value = value;
        _updatedAt = block.timestamp;
    }

    function setValueAt(int256 value, uint256 updatedAt) external {
        _value = value;
        _updatedAt = updatedAt;
    }

    function latestValue(bytes32) external view returns (int256 value, uint256 updatedAt) {
        return (_value, _updatedAt);
    }
}

contract SowellianGovernanceTest is Test {
    SowellianGovernance internal gov;
    MockVotesToken internal token;
    MockOracle internal oracle;

    address internal creator = makeAddr("creator");
    address internal treasury = makeAddr("treasury");
    address internal proposer = makeAddr("proposer");
    address internal resolver = makeAddr("resolver");
    address internal challenger = makeAddr("challenger");
    address internal alice = makeAddr("alice"); // YES position
    address internal bob = makeAddr("bob"); // NO position
    address internal voter = makeAddr("voter"); // approval + adjudication voter
    address internal recipient = makeAddr("recipient");

    function defaultConfig() internal pure returns (SowellianGovernance.SowellianConfig memory) {
        return SowellianGovernance.SowellianConfig({
            proposalBondAmount: 100 ether,
            approvalVotingDelay: 1,
            approvalVotingPeriod: 50,
            approvalQuorumBps: 1_000,
            approvalThresholdBps: 6_000,
            positionsWindow: 7 days,
            executionTimelockDelay: 0,
            resolutionBondAmount: 200 ether,
            challengePeriod: 3 days,
            challengeBondAmount: 200 ether,
            adjudicationVotingPeriod: 50,
            adjudicationQuorumBps: 1_000,
            adjudicationThresholdBps: 6_000,
            maxOracleStaleness: 1 days
        });
    }

    function setUp() public {
        token = new MockVotesToken();
        oracle = new MockOracle();
        gov = SowellianGovernance(Clones.clone(address(new SowellianGovernance())));
        gov.initialize("Test DAO", creator, address(token), treasury, defaultConfig());

        token.setBalance(proposer, 1_000 ether);
        token.setBalance(resolver, 1_000 ether);
        token.setBalance(challenger, 1_000 ether);
        token.setBalance(alice, 1_000 ether);
        token.setBalance(bob, 1_000 ether);
        token.setBalance(voter, 1_000 ether);

        vm.prank(proposer);
        token.transferFrom(proposer, proposer, 0); // no-op, just documents proposer has balance
    }

    function _singleAction() internal view returns (SowellianGovernance.ProposalAction[] memory actions) {
        actions = new SowellianGovernance.ProposalAction[](1);
        actions[0] = SowellianGovernance.ProposalAction({target: recipient, value: 0, data: ""});
    }

    /*//////////////////////////////////////////////////////////////
                    ORACLE-TRACK FULL LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    function _proposeOracleTrack() internal returns (uint256 id) {
        vm.prank(proposer);
        id = gov.propose(
            _singleAction(),
            "ipfs://p1",
            SowellianGovernance.ResolutionMethod.Oracle,
            address(oracle),
            bytes32(0), // oracleSelector - MockOracle ignores this entirely
            100, // targetValue
            true, // targetIsMinimum
            30 days // measurementPeriod
        );
    }

    function _approveProposal(uint256 id) internal {
        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        token.setPastVotes(voter, p.approvalSnapshotBlock, 500 ether);
        token.setPastTotalSupply(p.approvalSnapshotBlock, 1_000 ether);

        vm.roll(vm.getBlockNumber() + defaultConfig().approvalVotingDelay);
        vm.prank(voter);
        gov.castApprovalVote(id, SowellianGovernance.VoteType.For);

        vm.roll(vm.getBlockNumber() + defaultConfig().approvalVotingPeriod + 1);
        gov.finalizeApproval(id);
    }

    function test_OracleTrack_FullLifecycle_Success() public {
        uint256 id = _proposeOracleTrack();
        _approveProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.PositionsOpen));

        vm.prank(alice);
        gov.takePosition(id, SowellianGovernance.Side.Yes, 300 ether);
        vm.prank(bob);
        gov.takePosition(id, SowellianGovernance.Side.No, 200 ether);

        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        oracle.setValue(150); // >= targetValue(100), targetIsMinimum=true -> Success
        gov.resolveViaOracle(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.Finalized));
        assertEq(uint8(p.finalOutcome), uint8(SowellianGovernance.Outcome.Success));

        // Proposal bond returned to proposer.
        assertEq(token.balanceOf(proposer), 1_000 ether); // never actually left except during propose, now returned

        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        gov.claimPosition(id);
        // Alice was the sole YES holder (300/300 pool), wins entire 500 pool.
        assertEq(token.balanceOf(alice), aliceBefore + 500 ether);

        vm.prank(bob);
        vm.expectRevert(SowellianGovernance.NothingToClaim.selector);
        gov.claimPosition(id); // bob was on the losing side
    }

    /// The real adapter path: a Pyth feed (expo -8) resolves a proposal
    /// whose target is in 18 decimals, with a price update posted to Pyth
    /// right before resolution (Pyth is pull-based).
    function test_OracleTrack_ResolvesAgainstPythPriceFeed() public {
        MockPyth pyth = new MockPyth(60, 1 wei);
        PythPriceFeedAdapter adapter = new PythPriceFeedAdapter(address(pyth));
        bytes32 ethUsd = keccak256("ETH/USD");

        vm.prank(proposer);
        uint256 id = gov.propose(
            _singleAction(),
            "ipfs://pyth",
            SowellianGovernance.ResolutionMethod.Oracle,
            address(adapter),
            ethUsd, // oracleSelector = the Pyth price feed ID
            3_000e18, // success if ETH/USD >= $3,000
            true,
            30 days
        );
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);
        vm.warp(gov.getProposal(id).measurementDeadline + 1);

        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.createPriceFeedUpdateData(ethUsd, 312_345_000_000, 10, -8, 312_345_000_000, 10, uint64(block.timestamp), uint64(block.timestamp - 1));
        pyth.updatePriceFeeds{value: pyth.getUpdateFee(updates)}(updates);

        gov.resolveViaOracle(id); // $3,123.45 >= $3,000
        assertEq(uint8(gov.getProposal(id).finalOutcome), uint8(SowellianGovernance.Outcome.Success));
    }

    function test_OracleTrack_FailureOutcome_NoPayoutToYes() public {
        uint256 id = _proposeOracleTrack();
        _approveProposal(id);

        vm.prank(alice);
        gov.takePosition(id, SowellianGovernance.Side.Yes, 300 ether);
        vm.prank(bob);
        gov.takePosition(id, SowellianGovernance.Side.No, 200 ether);

        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        oracle.setValue(50); // < targetValue(100) -> Failure
        gov.resolveViaOracle(id);

        vm.prank(alice);
        vm.expectRevert(SowellianGovernance.NothingToClaim.selector);
        gov.claimPosition(id);

        uint256 bobBefore = token.balanceOf(bob);
        vm.prank(bob);
        gov.claimPosition(id);
        assertEq(token.balanceOf(bob), bobBefore + 500 ether);
    }

    function test_ResolveViaOracle_RevertsBeforeMeasurementDeadline() public {
        uint256 id = _proposeOracleTrack();
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        vm.expectRevert(SowellianGovernance.MeasurementPeriodNotEnded.selector);
        gov.resolveViaOracle(id);
    }

    function test_ResolveViaOracle_RevertsOnStaleData() public {
        uint256 id = _proposeOracleTrack();
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        // Value was last updated well outside the configured 1-day
        // staleness window - the feed is frozen or broken, and the
        // contract must refuse to trust it rather than silently proceed.
        oracle.setValueAt(150, vm.getBlockTimestamp() - 2 days);

        vm.expectRevert(SowellianGovernance.StaleOracleData.selector);
        gov.resolveViaOracle(id);
    }

    function test_ResolveViaOracle_SucceedsWithFreshData() public {
        uint256 id = _proposeOracleTrack();
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        // Updated just inside the 1-day window.
        oracle.setValueAt(150, vm.getBlockTimestamp() - 1 hours);
        gov.resolveViaOracle(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.Finalized));
    }

    /*//////////////////////////////////////////////////////////////
                    APPROVAL REJECTION - BOND FORFEITED
    //////////////////////////////////////////////////////////////*/

    function test_ApprovalRejected_ForfeitsProposalBondToTreasury() public {
        uint256 id = _proposeOracleTrack();

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        token.setPastVotes(voter, p.approvalSnapshotBlock, 500 ether);
        token.setPastTotalSupply(p.approvalSnapshotBlock, 1_000 ether);

        vm.roll(vm.getBlockNumber() + defaultConfig().approvalVotingDelay);
        vm.prank(voter);
        gov.castApprovalVote(id, SowellianGovernance.VoteType.Against);

        vm.roll(vm.getBlockNumber() + defaultConfig().approvalVotingPeriod + 1);
        gov.finalizeApproval(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.Rejected));
        assertEq(token.balanceOf(treasury), 100 ether); // the proposal bond
    }

    /*//////////////////////////////////////////////////////////////
                HUMAN-TRACK: UNCHALLENGED RESOLUTION
    //////////////////////////////////////////////////////////////*/

    function _proposeHumanTrack() internal returns (uint256 id) {
        vm.prank(proposer);
        id = gov.propose(
            _singleAction(),
            "ipfs://p1",
            SowellianGovernance.ResolutionMethod.Human,
            address(0),
            bytes32(0), // oracleSelector - irrelevant for human track
            0,
            true,
            30 days
        );
    }

    function test_HumanTrack_UnchallengedLifecycle() public {
        uint256 id = _proposeHumanTrack();
        _approveProposal(id);

        vm.prank(alice);
        gov.takePosition(id, SowellianGovernance.Side.Yes, 100 ether);

        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        vm.prank(resolver);
        gov.proposeResolution(id, SowellianGovernance.Outcome.Success);

        p = gov.getProposal(id);
        vm.warp(p.challengeDeadline + 1);

        uint256 resolverBefore = token.balanceOf(resolver);
        gov.finalizeUnchallenged(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.Finalized));
        assertEq(uint8(p.finalOutcome), uint8(SowellianGovernance.Outcome.Success));
        // Resolver's bond returned.
        assertEq(token.balanceOf(resolver), resolverBefore + 200 ether);
    }

    /*//////////////////////////////////////////////////////////////
            HUMAN-TRACK: CHALLENGED, ADJUDICATION UPHOLDS RESOLVER
    //////////////////////////////////////////////////////////////*/

    function test_HumanTrack_ChallengedAdjudicationUpholdsResolver() public {
        uint256 id = _proposeHumanTrack();
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        vm.prank(resolver);
        gov.proposeResolution(id, SowellianGovernance.Outcome.Success);

        vm.prank(challenger);
        gov.challengeResolution(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.Adjudicating));

        token.setPastVotes(voter, p.positionsOpenSnapshotBlock, 500 ether);
        token.setPastTotalSupply(p.positionsOpenSnapshotBlock, 1_000 ether);

        vm.prank(voter);
        gov.castAdjudicationVote(id, SowellianGovernance.Outcome.Success);

        vm.roll(vm.getBlockNumber() + defaultConfig().adjudicationVotingPeriod + 1);

        uint256 resolverBefore = token.balanceOf(resolver);
        uint256 treasuryBefore = token.balanceOf(treasury);
        gov.finalizeAdjudication(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.finalOutcome), uint8(SowellianGovernance.Outcome.Success));
        // Resolver correct: bond returned; challenger wrong: bond forfeited to treasury.
        assertEq(token.balanceOf(resolver), resolverBefore + 200 ether);
        assertEq(token.balanceOf(treasury), treasuryBefore + 200 ether);
    }

    /*//////////////////////////////////////////////////////////////
            HUMAN-TRACK: CHALLENGED, ADJUDICATION SIDES WITH CHALLENGER
    //////////////////////////////////////////////////////////////*/

    function test_HumanTrack_ChallengedAdjudicationSidesWithChallenger() public {
        uint256 id = _proposeHumanTrack();
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);

        vm.prank(resolver);
        gov.proposeResolution(id, SowellianGovernance.Outcome.Success); // resolver claims success

        vm.prank(challenger);
        gov.challengeResolution(id);

        p = gov.getProposal(id);
        token.setPastVotes(voter, p.positionsOpenSnapshotBlock, 500 ether);
        token.setPastTotalSupply(p.positionsOpenSnapshotBlock, 1_000 ether);

        vm.prank(voter);
        gov.castAdjudicationVote(id, SowellianGovernance.Outcome.Failure); // adjudicators disagree with resolver

        vm.roll(vm.getBlockNumber() + defaultConfig().adjudicationVotingPeriod + 1);

        uint256 challengerBefore = token.balanceOf(challenger);
        uint256 treasuryBefore = token.balanceOf(treasury);
        gov.finalizeAdjudication(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.finalOutcome), uint8(SowellianGovernance.Outcome.Failure));
        // Challenger correct: bond returned; resolver wrong: bond forfeited to treasury.
        assertEq(token.balanceOf(challenger), challengerBefore + 200 ether);
        assertEq(token.balanceOf(treasury), treasuryBefore + 200 ether);
    }

    /*//////////////////////////////////////////////////////////////
                            REENTRANCY GUARD
    //////////////////////////////////////////////////////////////*/

    function test_ResolveViaOracle_ReentrancyGuardBlocksNestedCall() public {
        // A malicious oracle that tries to call back into resolveViaOracle
        // during its own latestValue() read.
        ReentrantOracle badOracle = new ReentrantOracle(gov);

        vm.prank(proposer);
        uint256 id = gov.propose(
            _singleAction(),
            "ipfs://p1",
            SowellianGovernance.ResolutionMethod.Oracle,
            address(badOracle),
            bytes32(0), // oracleSelector - ReentrantOracle ignores it
            100,
            true,
            30 days
        );
        _approveProposal(id);
        vm.warp(vm.getBlockTimestamp() + defaultConfig().positionsWindow + 1);
        gov.executeProposal(id);

        SowellianGovernance.Proposal memory p = gov.getProposal(id);
        vm.warp(p.measurementDeadline + 1);
        badOracle.setTargetProposal(id);

        // The reentrant inner call must revert; the outer call still
        // succeeds normally once the guard releases.
        gov.resolveViaOracle(id);

        p = gov.getProposal(id);
        assertEq(uint8(p.phase), uint8(SowellianGovernance.Phase.Finalized));
    }
}

/// @dev Deliberately malicious oracle for the reentrancy test above - its
///      latestValue() call tries to re-enter resolveViaOracle.
contract ReentrantOracle {
    SowellianGovernance internal immutable gov;
    uint256 internal targetProposal;

    constructor(SowellianGovernance gov_) {
        gov = gov_;
    }

    function setTargetProposal(uint256 id) external {
        targetProposal = id;
    }

    function latestValue(bytes32) external returns (int256, uint256) {
        // This call must revert (Reentrant) without unwinding the outer
        // call - a plain external call from a non-test contract, so a
        // revert here just returns false-ish/propagates depending on call
        // style; using a raw low-level call keeps the outer flow alive to
        // prove the guard fired rather than just letting the whole tx revert.
        (bool ok, ) = address(gov).call(
            abi.encodeWithSelector(SowellianGovernance.resolveViaOracle.selector, targetProposal)
        );
        require(!ok, "reentrancy guard did not fire");
        return (150, block.timestamp);
    }
}
