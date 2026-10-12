// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DecisionMarketsDAOFactory} from "../src/factory/DecisionMarketsDAOFactory.sol";
import {DecisionMarketsGovernance} from "../src/governance/futarchy/DecisionMarketsGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {ConditionalToken} from "../src/governance/futarchy/ConditionalToken.sol";
import {ConditionalVault} from "../src/governance/futarchy/ConditionalVault.sol";
import {DecisionMarketPair} from "../src/governance/futarchy/DecisionMarketPair.sol";

contract DecisionMarketsDAOFactoryTest is Test {
    DecisionMarketsDAOFactory internal factory;
    DecisionMarketsGovernance internal gov;
    Treasury internal treasury;
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;

    address internal wmon = makeAddr("wmon");
    address internal creator = makeAddr("creator");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    function defaultConfig() internal pure returns (DecisionMarketsGovernance.DecisionMarketsConfig memory) {
        return DecisionMarketsGovernance.DecisionMarketsConfig({
            tradingPeriod: 3 days,
            thresholdBps: 300,
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function setUp() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        DecisionMarketsGovernance decisionMarketsGovernanceImplementation = new DecisionMarketsGovernance();

        ConditionalToken conditionalTokenImplementation = new ConditionalToken();
        ConditionalVault conditionalVaultImplementation = new ConditionalVault();
        DecisionMarketPair decisionMarketPairImplementation = new DecisionMarketPair();

        factory = new DecisionMarketsDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(decisionMarketsGovernanceImplementation),
            wmon,
            address(conditionalTokenImplementation),
            address(conditionalVaultImplementation),
            address(decisionMarketPairImplementation)
        );

        vm.prank(creator);
        address governanceAddr =
            factory.createDAO("Test DAO", "TDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());

        gov = DecisionMarketsGovernance(payable(governanceAddr));
        token = StakedGovernanceToken(gov.governanceToken());
        underlying = GovernanceToken(address(token.underlying()));
        treasury = Treasury(payable(gov.treasury()));
    }

    function test_Constructor_DeploysThreeDistinctImplementations() public view {
        assertTrue(factory.conditionalTokenImplementation() != address(0));
        assertTrue(factory.conditionalVaultImplementation() != address(0));
        assertTrue(factory.decisionMarketPairImplementation() != address(0));
        assertTrue(factory.conditionalTokenImplementation() != factory.conditionalVaultImplementation());
        assertTrue(factory.conditionalVaultImplementation() != factory.decisionMarketPairImplementation());
    }

    function test_Constructor_StoresSuppliedWmon() public view {
        assertEq(factory.wmon(), wmon);
    }

    function test_Constructor_RevertsOnZeroWmon() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        DecisionMarketsGovernance decisionMarketsGovernanceImplementation = new DecisionMarketsGovernance();
        ConditionalToken conditionalTokenImplementation = new ConditionalToken();
        ConditionalVault conditionalVaultImplementation = new ConditionalVault();
        DecisionMarketPair decisionMarketPairImplementation = new DecisionMarketPair();

        vm.expectRevert(DecisionMarketsDAOFactory.ZeroAddress.selector);
        new DecisionMarketsDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(decisionMarketsGovernanceImplementation),
            address(0), // wmon - the one being tested
            address(conditionalTokenImplementation),
            address(conditionalVaultImplementation),
            address(decisionMarketPairImplementation)
        );
    }

    function test_CreateDAO_WiresGovernanceAsTreasuryController() public view {
        assertEq(treasury.governance(), address(gov));
    }

    function test_CreateDAO_WiresGovernanceAsUnderlyingTokenOwner() public view {
        assertEq(underlying.owner(), address(gov));
    }

    /// @dev The actual reason this factory has its own constructor - every
    ///      DAO it creates must be wired to the SAME shared implementations
    ///      and WMON the factory deployed once, not a fresh set each time.
    function test_CreateDAO_WiresSharedWmonAndImplementations() public view {
        assertEq(gov.wmon(), wmon);
        assertEq(gov.conditionalTokenImplementation(), factory.conditionalTokenImplementation());
        assertEq(gov.conditionalVaultImplementation(), factory.conditionalVaultImplementation());
        assertEq(gov.decisionMarketPairImplementation(), factory.decisionMarketPairImplementation());
    }

    function test_CreateDAO_SecondDAOSharesSameImplementations() public {
        vm.prank(creator);
        address secondGovAddr =
            factory.createDAO("Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());
        DecisionMarketsGovernance secondGov = DecisionMarketsGovernance(payable(secondGovAddr));

        // Same shared templates reused, not redeployed per DAO.
        assertEq(secondGov.conditionalTokenImplementation(), gov.conditionalTokenImplementation());
        assertEq(secondGov.conditionalVaultImplementation(), gov.conditionalVaultImplementation());
        assertEq(secondGov.decisionMarketPairImplementation(), gov.decisionMarketPairImplementation());
        assertEq(secondGov.wmon(), gov.wmon());
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
        factory.createDAO("Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());

        assertEq(factory.daoCount(), 2);
    }

    function test_CreateDAO_TracksCreatorDAOs() public {
        vm.prank(creator);
        address secondGov = factory.createDAO("Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());

        address[] memory creatorDAOs = factory.getCreatorDAOs(creator);
        assertEq(creatorDAOs.length, 2);
        assertEq(creatorDAOs[0], address(gov));
        assertEq(creatorDAOs[1], secondGov);
    }

    function test_CreateDAO_RevertsOnInvalidConfig() public {
        DecisionMarketsGovernance.DecisionMarketsConfig memory badConfig = defaultConfig();
        badConfig.thresholdBps = 0;

        vm.prank(creator);
        vm.expectRevert(DecisionMarketsGovernance.InvalidConfiguration.selector);
        factory.createDAO("Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, badConfig);
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
