// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LiquidDAOFactory} from "../src/factory/LiquidDAOFactory.sol";
import {LiquidGovernance} from "../src/governance/liquid/LiquidGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";

contract LiquidDAOFactoryTest is Test {
    LiquidDAOFactory internal factory;
    LiquidGovernance internal gov;
    Treasury internal treasury;
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;

    address internal creator = makeAddr("creator");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    function defaultConfig() internal pure returns (LiquidGovernance.LiquidGovernanceConfig memory) {
        return LiquidGovernance.LiquidGovernanceConfig({
            quorumBps: 1_000,
            approvalThresholdBps: 6_000,
            votingDelay: 1,
            votingPeriod: 100,
            timelockDelay: 1 days,
            executionPeriod: 7 days,
            proposalThreshold: 1 ether
        });
    }

    function setUp() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        LiquidGovernance liquidGovernanceImplementation = new LiquidGovernance();

        factory = new LiquidDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(liquidGovernanceImplementation)
        );

        vm.prank(creator);
        address governanceAddr =
            factory.createDAO("Test DAO", "TDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());

        gov = LiquidGovernance(governanceAddr);
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

    function test_CreateDAO_GovernanceReadsVotesFromStakingWrapper() public view {
        assertEq(gov.governanceToken(), address(token));
        assertEq(address(token.underlying()), address(underlying));
    }

    function test_CreateDAO_MintsInitialSupplyToCreatorAsRawTokens() public view {
        assertEq(underlying.balanceOf(creator), INITIAL_SUPPLY);
        assertEq(underlying.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(creator), 0);
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

    function test_CreateDAO_RecordsDAOInfo() public view {
        (
            string memory name,
            address daoCreator,
            address governanceToken,
            address underlyingToken,
            address governance,
            address treasuryAddr,
            uint256 createdAt
        ) = factory.daos(1);

        assertEq(name, "Test DAO");
        assertEq(daoCreator, creator);
        assertEq(governanceToken, address(token));
        assertEq(underlyingToken, address(underlying));
        assertEq(governance, address(gov));
        assertEq(treasuryAddr, address(treasury));
        assertEq(createdAt, vm.getBlockTimestamp());
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
        LiquidGovernance.LiquidGovernanceConfig memory badConfig = defaultConfig();
        badConfig.quorumBps = 0;

        vm.prank(creator);
        vm.expectRevert(LiquidGovernance.InvalidConfiguration.selector);
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
