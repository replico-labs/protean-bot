// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConvictionDAOFactory} from "../src/factory/ConvictionDAOFactory.sol";
import {ConvictionGovernance} from "../src/governance/conviction/ConvictionGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {StakedGovernanceToken} from "../src/token/StakedGovernanceToken.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";

contract ConvictionDAOFactoryTest is Test {
    ConvictionDAOFactory internal factory;
    ConvictionGovernance internal gov;
    Treasury internal treasury;
    StakedGovernanceToken internal token;
    GovernanceToken internal underlying;

    address internal creator = makeAddr("creator");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant INITIAL_SUPPLY = 1_000_000 ether;
    uint256 internal constant MAX_SUPPLY = 10_000_000 ether;

    function defaultConfig() internal pure returns (ConvictionGovernance.ConvictionGovernanceConfig memory) {
        return ConvictionGovernance.ConvictionGovernanceConfig({
            convictionGrowthRate: 1e15,
            minThresholdConviction: 100 ether,
            thresholdMultiplier: 10,
            proposalThreshold: 1 ether,
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function setUp() public {
        GovernanceToken governanceTokenImplementation = new GovernanceToken();
        StakedGovernanceToken stakedGovernanceTokenImplementation = new StakedGovernanceToken();
        Treasury treasuryImplementation = new Treasury();
        ConvictionGovernance convictionGovernanceImplementation = new ConvictionGovernance();

        factory = new ConvictionDAOFactory(
            address(governanceTokenImplementation),
            address(stakedGovernanceTokenImplementation),
            address(treasuryImplementation),
            address(convictionGovernanceImplementation)
        );

        vm.prank(creator);
        address governanceAddr =
            factory.createDAO("Test DAO", "TDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());

        gov = ConvictionGovernance(governanceAddr);
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

    /// @dev The actual reason this factory exists as a distinct
    ///      contract - ConvictionGovernance needs to be authorized to
    ///      lock committed support, and that only ever gets set here,
    ///      in the same transaction, since the factory remains the
    ///      staking wrapper's owner afterward and nothing else calls
    ///      setAuthorizedLocker for it.
    function test_CreateDAO_AuthorizesGovernanceAsLocker() public view {
        assertEq(token.authorizedLocker(), address(gov));
    }

    function test_CreateDAO_FactoryRemainsStakingWrapperOwner() public view {
        // Documented, deliberate behavior - ownership of the staking
        // wrapper is never transferred away from the factory, which is
        // exactly what makes the setAuthorizedLocker call above possible
        // in the first place.
        assertEq(token.owner(), address(factory));
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
        ConvictionGovernance.ConvictionGovernanceConfig memory badConfig = defaultConfig();
        badConfig.convictionGrowthRate = 0;

        vm.prank(creator);
        vm.expectRevert(ConvictionGovernance.InvalidConfiguration.selector);
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
