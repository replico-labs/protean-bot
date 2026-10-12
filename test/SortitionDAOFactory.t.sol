// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SortitionDAOFactory} from "../src/factory/SortitionDAOFactory.sol";
import {SortitionGovernance} from "../src/governance/sortition/SortitionGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";

/// @dev Minimal mock - SortitionGovernance's constructor only stores this
///      address and checks it's non-zero, never calls into it, so a full
///      functional implementation isn't needed to test factory wiring.
contract MockRandomnessSource {
    function requestRandomness(bytes32) external payable {}
    function isFulfilled(bytes32) external pure returns (bool) {
        return false;
    }
    function getRandomness(bytes32) external pure returns (uint256) {
        return 0;
    }
}

contract SortitionDAOFactoryTest is Test {
    SortitionDAOFactory internal factory;
    SortitionGovernance internal gov;
    Treasury internal treasury;
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;
    MockRandomnessSource internal randomnessSource;

    address internal creator = makeAddr("creator");
    address internal council1 = makeAddr("council1");
    address internal council2 = makeAddr("council2");
    address internal council3 = makeAddr("council3");
    address internal recipient = makeAddr("recipient");

    address[] internal initialCouncil;

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    function defaultConfig() internal pure returns (SortitionGovernance.SortitionGovernanceConfig memory) {
        return SortitionGovernance.SortitionGovernanceConfig({
            councilSize: 3,
            termLength: 30 days,
            eligibilityThreshold: 0,
            councilQuorum: 2,
            councilApprovalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 100,
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function setUp() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        SortitionGovernance sortitionGovernanceImplementation = new SortitionGovernance();

        factory = new SortitionDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(sortitionGovernanceImplementation)
        );
        randomnessSource = new MockRandomnessSource();

        initialCouncil.push(council1);
        initialCouncil.push(council2);
        initialCouncil.push(council3);

        vm.prank(creator);
        address governanceAddr = factory.createDAO(
            "Test DAO", "TDAO", INITIAL_SUPPLY, MAX_SUPPLY, address(randomnessSource), defaultConfig(), initialCouncil
        );

        gov = SortitionGovernance(governanceAddr);
        token = StakedGovernanceToken(gov.governanceToken());
        underlying = GovernanceToken(address(token.underlying()));
        treasury = Treasury(payable(gov.treasury()));
    }

    function test_CreateDAO_WiresGovernanceAsTreasuryController() public view {
        assertEq(treasury.governance(), address(gov));
    }

    function test_CreateDAO_WiresGovernanceAsUnderlyingTokenOwner() public view {
        assertEq(underlying.owner(), address(gov));
    }

    /// @dev The actual reason this factory differs from the standard
    ///      shape - the supplied randomness source must be the one
    ///      actually stored on the deployed governance contract, not
    ///      silently dropped or swapped for something else.
    function test_CreateDAO_WiresSuppliedRandomnessSource() public view {
        assertEq(address(gov.randomnessSource()), address(randomnessSource));
    }

    function test_CreateDAO_RevertsOnZeroRandomnessSource() public {
        vm.prank(creator);
        vm.expectRevert(SortitionGovernance.ZeroAddress.selector);
        factory.createDAO("Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, address(0), defaultConfig(), initialCouncil);
    }

    function test_CreateDAO_RecordsAllInitialCouncilMembers() public view {
        assertTrue(gov.isCouncilMember(council1));
        assertTrue(gov.isCouncilMember(council2));
        assertTrue(gov.isCouncilMember(council3));
    }

    function test_CreateDAO_GovernanceReadsVotesFromStakingWrapper() public view {
        assertEq(gov.governanceToken(), address(token));
        assertEq(address(token.underlying()), address(underlying));
    }

    function test_CreateDAO_SetsGovernanceConstructorArgs() public view {
        assertEq(gov.daoName(), "Test DAO");
        assertEq(gov.creator(), creator);
        assertEq(gov.governanceToken(), address(token));
        assertEq(gov.treasury(), address(treasury));
    }

    function test_CreateDAO_IncrementsDaoCount() public {
        assertEq(factory.daoCount(), 1);

        vm.prank(creator);
        factory.createDAO(
            "Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, address(randomnessSource), defaultConfig(), initialCouncil
        );

        assertEq(factory.daoCount(), 2);
    }

    function test_CreateDAO_TracksCreatorDAOs() public {
        vm.prank(creator);
        address secondGov = factory.createDAO(
            "Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, address(randomnessSource), defaultConfig(), initialCouncil
        );

        address[] memory creatorDAOs = factory.getCreatorDAOs(creator);
        assertEq(creatorDAOs.length, 2);
        assertEq(creatorDAOs[0], address(gov));
        assertEq(creatorDAOs[1], secondGov);
    }

    function test_CreateDAO_RevertsOnInvalidConfig() public {
        SortitionGovernance.SortitionGovernanceConfig memory badConfig = defaultConfig();
        badConfig.councilApprovalThresholdBps = 0;

        vm.prank(creator);
        vm.expectRevert(SortitionGovernance.InvalidConfiguration.selector);
        factory.createDAO(
            "Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, address(randomnessSource), badConfig, initialCouncil
        );
    }

    function test_CreateDAO_RevertsWhenCouncilLengthMismatchesConfig() public {
        address[] memory tooFew = new address[](1);
        tooFew[0] = council1;

        vm.prank(creator);
        vm.expectRevert(SortitionGovernance.InvalidConfiguration.selector);
        factory.createDAO(
            "Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, address(randomnessSource), defaultConfig(), tooFew
        );
    }

    function test_TreasuryCannotBeControlledByFactoryAfterHandoff() public {
        vm.prank(address(factory));
        vm.expectRevert(ITreasury.Unauthorized.selector);
        treasury.transferETH(payable(recipient), 0);
    }
}
