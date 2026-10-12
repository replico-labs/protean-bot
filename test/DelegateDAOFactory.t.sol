// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DelegateDAOFactory} from "../src/factory/DelegateDAOFactory.sol";
import {DelegateGovernance} from "../src/governance/delegate/DelegateGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";

contract DelegateDAOFactoryTest is Test {
    DelegateDAOFactory internal factory;
    DelegateGovernance internal gov;
    Treasury internal treasury;
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;

    address internal creator = makeAddr("creator");
    address internal council1 = makeAddr("council1");
    address internal council2 = makeAddr("council2");
    address internal council3 = makeAddr("council3");
    address internal recipient = makeAddr("recipient");

    address[] internal initialCouncil;

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    function defaultConfig() internal pure returns (DelegateGovernance.DelegateGovernanceConfig memory) {
        return DelegateGovernance.DelegateGovernanceConfig({
            councilSize: 3,
            termLength: 30 days,
            candidacyThreshold: 0,
            candidacyPeriod: 100,
            electionVotingPeriod: 100,
            councilQuorum: 2,
            councilApprovalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 100,
            timelockDelay: 1 days,
            executionPeriod: 7 days,
            recallQuorumBps: 1_000,
            recallApprovalThresholdBps: 6_000,
            recallVotingPeriod: 100
        });
    }

    function setUp() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        DelegateGovernance delegateGovernanceImplementation = new DelegateGovernance();

        factory = new DelegateDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(delegateGovernanceImplementation)
        );

        initialCouncil.push(council1);
        initialCouncil.push(council2);
        initialCouncil.push(council3);

        vm.prank(creator);
        address governanceAddr =
            factory.createDAO("Test DAO", "TDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig(), initialCouncil);

        gov = DelegateGovernance(governanceAddr);
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

    function test_CreateDAO_RecordsAllInitialCouncilMembers() public view {
        assertTrue(gov.isCouncilMember(council1));
        assertTrue(gov.isCouncilMember(council2));
        assertTrue(gov.isCouncilMember(council3));
        assertEq(gov.getCouncil().length, 3);
    }

    function test_CreateDAO_GovernanceReadsVotesFromStakingWrapper() public view {
        assertEq(gov.governanceToken(), address(token));
        assertEq(address(token.underlying()), address(underlying));
    }

    function test_CreateDAO_MintsInitialSupplyToCreatorAsRawTokens() public view {
        assertEq(underlying.balanceOf(creator), INITIAL_SUPPLY);
        assertEq(underlying.balanceOf(address(factory)), 0);
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
        factory.createDAO("Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig(), initialCouncil);

        assertEq(factory.daoCount(), 2);
    }

    function test_CreateDAO_TracksCreatorDAOs() public {
        vm.prank(creator);
        address secondGov =
            factory.createDAO("Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig(), initialCouncil);

        address[] memory creatorDAOs = factory.getCreatorDAOs(creator);
        assertEq(creatorDAOs.length, 2);
        assertEq(creatorDAOs[0], address(gov));
        assertEq(creatorDAOs[1], secondGov);
    }

    function test_CreateDAO_RevertsOnInvalidConfig() public {
        DelegateGovernance.DelegateGovernanceConfig memory badConfig = defaultConfig();
        badConfig.councilApprovalThresholdBps = 0;

        vm.prank(creator);
        vm.expectRevert(DelegateGovernance.InvalidConfiguration.selector);
        factory.createDAO("Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, badConfig, initialCouncil);
    }

    function test_CreateDAO_RevertsWhenCouncilLengthMismatchesConfig() public {
        address[] memory tooFew = new address[](1);
        tooFew[0] = council1;

        vm.prank(creator);
        vm.expectRevert(DelegateGovernance.InvalidConfiguration.selector);
        factory.createDAO("Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig(), tooFew);
    }

    function test_TreasuryCannotBeControlledByFactoryAfterHandoff() public {
        vm.prank(address(factory));
        vm.expectRevert(ITreasury.Unauthorized.selector);
        treasury.transferETH(payable(recipient), 0);
    }

    function test_UnderlyingTokenCannotBeMintedByFactoryAfterHandoff() public {
        vm.prank(address(factory));
        vm.expectRevert();
        underlying.mint(recipient, 1 ether);
    }
}
