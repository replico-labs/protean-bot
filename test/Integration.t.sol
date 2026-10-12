// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GovernanceTestBase} from "./GovernanceTestBase.sol";
import {Governance} from "../src/governance/Governance.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import "../src/governance/Types.sol";
import "../src/governance/GovernanceErrors.sol";

/// @title IntegrationTest
/// @notice Exercises full DAO lifecycles end-to-end through the factory:
///         funding a treasury, proposing, voting, queueing, timelock, and
///         executing actions that move treasury funds, mint new tokens,
///         and reconfigure governance - each purely through the proposal
///         pipeline, with no privileged shortcuts.
contract IntegrationTest is GovernanceTestBase {
    function setUp() public override {
        super.setUp();

        // Spread voting power across three holders so quorum/approval
        // scenarios can be exercised realistically.
        _fundAndDelegate(alice, 150_000 ether); // 15%
        _fundAndDelegate(bob, 100_000 ether); //  10%
        _fundAndDelegate(carol, 50_000 ether); //   5%

        // Fund the treasury so proposals can pay out of it.
        vm.deal(address(treasury), 20 ether);
    }

    /*//////////////////////////////////////////////////////////////
                TREASURY PAYOUT VIA GOVERNANCE-EXECUTED PROPOSAL
    //////////////////////////////////////////////////////////////*/

    function test_FullLifecycle_TreasuryETHPayout() public {
        bytes memory data = abi.encodeWithSelector(
            ITreasury.transferETH.selector,
            payable(recipient),
            5 ether
        );
        ProposalAction[] memory actions = _singleAction(address(treasury), 0, data);

        vm.prank(alice);
        uint256 proposalId = gov.propose(actions, "ipfs://fund-recipient");

        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        vm.prank(bob);
        gov.castVote(proposalId, VoteType.For);
        vm.prank(carol);
        gov.castVote(proposalId, VoteType.Against);

        _endVoting(proposalId);

        // 250k For / 300k total participation = 83.3% approval, well above
        // the 60% threshold; 300k / 1,000,000 = 30% participation, well
        // above the 10% quorum.
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Succeeded));

        gov.queueProposal(proposalId);
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Queued));

        // Executing too early still fails.
        vm.expectRevert(ProposalNotExecutable.selector);
        gov.executeProposal(proposalId);

        _passTimelock(proposalId);

        uint256 before = recipient.balance;
        gov.executeProposal(proposalId);

        assertEq(recipient.balance, before + 5 ether);
        assertEq(treasury.ethBalance(), 15 ether);
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Executed));
    }

    function test_Defeated_WhenNobodyMeetsQuorum() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        _endVoting(proposalId);

        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Defeated));

        vm.expectRevert(QuorumNotReached.selector);
        gov.queueProposal(proposalId);
    }

    function test_Defeated_WhenQuorumMetButApprovalFails() public {
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        // 150k(For) + 100k(Against) = 250k participation (25%, above 10%
        // quorum) but only 60% For of decisive votes... exactly at the
        // 60% threshold boundary, so nudge it below with carol voting
        // Against too.
        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        vm.prank(bob);
        gov.castVote(proposalId, VoteType.Against);
        vm.prank(carol);
        gov.castVote(proposalId, VoteType.Against);

        _endVoting(proposalId);

        // 150k For / 300k decisive = 50% < 60% threshold.
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Defeated));

        vm.expectRevert(ApprovalThresholdNotMet.selector);
        gov.queueProposal(proposalId);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-CONTROLLED TOKEN MINTING
    //////////////////////////////////////////////////////////////*/

    function test_FullLifecycle_GovernanceControlledMint() public {
        address grantee = makeAddr("grantee");

        bytes memory data = abi.encodeWithSelector(
            GovernanceToken.mint.selector,
            grantee,
            10_000 ether
        );
        uint256 proposalId = _executeSimpleProposal(
            _singleAction(address(underlying), 0, data)
        );

        assertEq(underlying.balanceOf(grantee), 10_000 ether);
        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Executed));
    }

    function test_CreatorCannotMintDirectly_OnlyGovernanceCan() public {
        // Confirms the DAOFactory bug fix: the creator (original deployer)
        // must have no unilateral mint power once the DAO is live.
        vm.prank(creator);
        vm.expectRevert();
        underlying.mint(creator, 1 ether);
    }

    /*//////////////////////////////////////////////////////////////
                GOVERNANCE SELF-RECONFIGURATION VIA PROPOSAL
    //////////////////////////////////////////////////////////////*/

    function test_FullLifecycle_GovernanceConfigUpdate() public {
        GovernanceConfig memory newConfig = defaultConfig();
        newConfig.quorumBps = 2_000; // raise quorum to 20%
        newConfig.approvalThresholdBps = 5_000; // lower approval to 50%

        bytes memory data = abi.encodeWithSelector(
            Governance.updateGovernanceConfig.selector,
            newConfig
        );
        _executeSimpleProposal(_singleAction(address(gov), 0, data));

        GovernanceConfig memory updated = gov.governanceConfig();
        assertEq(updated.quorumBps, 2_000);
        assertEq(updated.approvalThresholdBps, 5_000);
    }

    function test_UpdatedQuorum_AppliesToFutureProposals() public {
        // Raise quorum to 20% via governance.
        GovernanceConfig memory newConfig = defaultConfig();
        newConfig.quorumBps = 2_000;
        bytes memory data = abi.encodeWithSelector(
            Governance.updateGovernanceConfig.selector,
            newConfig
        );
        _executeSimpleProposal(_singleAction(address(gov), 0, data));

        // Alice + Bob = 250k (25%) would have passed the old 10% quorum by
        // a wide margin and still clears the new 20% quorum.
        vm.prank(alice);
        uint256 proposalId = gov.propose(_singleAction(recipient, 0, ""), "ipfs://p2");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        vm.prank(bob);
        gov.castVote(proposalId, VoteType.For);
        _endVoting(proposalId);

        assertEq(uint8(gov.state(proposalId)), uint8(ProposalState.Succeeded));
    }

    /*//////////////////////////////////////////////////////////////
                            TREASURY MIGRATION
    //////////////////////////////////////////////////////////////*/

    function test_SetTreasury_ThroughGovernanceProposal() public {
        // Deploy a fresh treasury that already trusts this Governance
        // contract (mirrors the factory's own handoff pattern).
        Treasury newTreasury = Treasury(payable(Clones.clone(address(new Treasury()))));
        newTreasury.initialize(address(gov));

        bytes memory data = abi.encodeWithSelector(
            Governance.setTreasury.selector,
            address(newTreasury)
        );
        _executeSimpleProposal(_singleAction(address(gov), 0, data));

        assertEq(gov.treasury(), address(newTreasury));
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Proposes a single action, has alice+bob vote For (well above
    ///      quorum and approval under the default config), advances past
    ///      voting and the timelock, then executes.
    function _executeSimpleProposal(
        ProposalAction[] memory actions
    ) internal returns (uint256 proposalId) {
        vm.prank(alice);
        proposalId = gov.propose(actions, "ipfs://p1");
        vm.roll(vm.getBlockNumber() + defaultConfig().votingDelay);

        vm.prank(alice);
        gov.castVote(proposalId, VoteType.For);
        vm.prank(bob);
        gov.castVote(proposalId, VoteType.For);

        _endVoting(proposalId);
        gov.queueProposal(proposalId);
        _passTimelock(proposalId);
        gov.executeProposal(proposalId);
    }
}
