// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Governance} from "../src/governance/Governance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {DAOFactory} from "../src/factory/DAOFactory.sol";
import "../src/governance/Types.sol";
import "../src/governance/GovernanceErrors.sol";
import "../src/governance/GovernanceEvents.sol";

/// @title GovernanceTestBase
/// @notice Shared deployment + helper logic reused across the governance test suite.
/// @dev Not a test file itself (no test_ functions) - inherited by the actual test
///      contracts to avoid duplicating setup and voting-power/time-travel helpers.
abstract contract GovernanceTestBase is Test {
    DAOFactory internal factory;

    Governance internal gov;
    Treasury internal treasury;

    // `token` is the staking wrapper - this is what Governance actually
    // reads voting power from (gov.governanceToken() returns its address).
    // `underlying` is the raw, transferable GovernanceToken that must be
    // staked into `token` to receive voting power.
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    // Default governance config used across most tests:
    // 10% quorum, 60% approval, 1 block voting delay, 100 block voting
    // period, 1 day timelock, 7 day execution window, 1 token proposal
    // threshold.
    function defaultConfig() internal pure returns (GovernanceConfig memory) {
        return GovernanceConfig({
            quorumBps: 1_000,
            approvalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 100,
            timelockDelay: 1 days,
            executionPeriod: 7 days,
            proposalThreshold: 1 ether
        });
    }

    function deployDAO(GovernanceConfig memory config) internal {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        Governance governanceImplementation = new Governance();

        factory = new DAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(governanceImplementation)
        );

        vm.prank(creator);
        address governanceAddr = factory.createDAO(
            "Test DAO",
            "TDAO",
            INITIAL_SUPPLY,
            MAX_SUPPLY,
            config
        );

        gov = Governance(governanceAddr);
        token = StakedGovernanceToken(gov.governanceToken());
        underlying = GovernanceToken(address(token.underlying()));
        treasury = Treasury(payable(gov.treasury()));
    }

    function setUp() public virtual {
        deployDAO(defaultConfig());
    }

    /// @dev Moves `amount` of the raw (underlying) token from the creator
    ///      (who received the full initial supply) to `to`, then has `to`
    ///      stake it into the staking wrapper - the only way to receive
    ///      voting power under this model. Staking auto-delegates to self
    ///      on first stake, so no separate delegate() call is needed here.
    function _fundAndDelegate(address to, uint256 amount) internal {
        vm.prank(creator);
        bool ok = underlying.transfer(to, amount);
        assertTrue(ok, "transfer failed");

        vm.startPrank(to);
        underlying.approve(address(token), amount);
        token.stake(amount);
        vm.stopPrank();

        // Advance one block so this checkpoint is safely in the past by the
        // time anything checks getPastVotes(to, block.number - 1) (e.g. the
        // proposal threshold check) or a proposal snapshot.
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _singleAction(
        address target,
        uint256 value,
        bytes memory data
    ) internal pure returns (ProposalAction[] memory actions) {
        actions = new ProposalAction[](1);
        actions[0] = ProposalAction({target: target, value: value, data: data});
    }

    /// @dev Advances past the voting delay and period so a proposal's
    ///      voting window has fully closed.
    function _endVoting(uint256 proposalId) internal {
        Proposal memory p = gov.getProposal(proposalId);
        vm.roll(p.endBlock + 1);
    }

    /// @dev Advances past the timelock so a queued proposal is executable.
    function _passTimelock(uint256 proposalId) internal {
        uint256 executableAt = gov.executableAfter(proposalId);
        vm.warp(executableAt + 1);
    }
}
