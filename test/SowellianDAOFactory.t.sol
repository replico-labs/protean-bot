// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SowellianDAOFactory} from "../src/factory/SowellianDAOFactory.sol";
import {SowellianGovernance} from "../src/governance/sowellian/SowellianGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";

contract SowellianDAOFactoryTest is Test {
    SowellianDAOFactory internal factory;
    SowellianGovernance internal gov;
    Treasury internal treasury;
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;

    address internal creator = makeAddr("creator");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    function defaultConfig() internal pure returns (SowellianGovernance.SowellianConfig memory) {
        return SowellianGovernance.SowellianConfig({
            proposalBondAmount: 100 ether,
            approvalVotingDelay: 1,
            approvalVotingPeriod: 100,
            approvalQuorumBps: 1_000,
            approvalThresholdBps: 6_000,
            positionsWindow: 7 days,
            executionTimelockDelay: 1 days,
            resolutionBondAmount: 100 ether,
            challengePeriod: 3 days,
            challengeBondAmount: 100 ether,
            adjudicationVotingPeriod: 100,
            adjudicationQuorumBps: 1_000,
            adjudicationThresholdBps: 6_000,
            maxOracleStaleness: 1 hours
        });
    }

    function setUp() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        SowellianGovernance sowellianGovernanceImplementation = new SowellianGovernance();

        factory = new SowellianDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(sowellianGovernanceImplementation)
        );

        vm.prank(creator);
        address governanceAddr =
            factory.createDAO("Test DAO", "TDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());

        gov = SowellianGovernance(governanceAddr);
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
        SowellianGovernance.SowellianConfig memory badConfig = defaultConfig();
        badConfig.approvalQuorumBps = 0;

        vm.prank(creator);
        vm.expectRevert(SowellianGovernance.InvalidConfiguration.selector);
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
