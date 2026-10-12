// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BoardDAOFactory} from "../src/factory/BoardDAOFactory.sol";
import {BoardGovernance} from "../src/governance/board/BoardGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";

contract BoardDAOFactoryTest is Test {
    BoardDAOFactory internal factory;
    BoardGovernance internal gov;
    Treasury internal treasury;

    address internal creator = makeAddr("creator");
    address internal signer1 = makeAddr("signer1");
    address internal signer2 = makeAddr("signer2");
    address internal signer3 = makeAddr("signer3");
    address internal recipient = makeAddr("recipient");

    address[] internal initialSigners;

    function defaultConfig() internal pure returns (BoardGovernance.BoardGovernanceConfig memory) {
        return BoardGovernance.BoardGovernanceConfig({
            requiredApprovals: 2,
            timelockDelay: 1 days,
            executionPeriod: 7 days
        });
    }

    function setUp() public {
        Treasury treasuryImplementation = new Treasury();
        BoardGovernance boardGovernanceImplementation = new BoardGovernance();

        factory = new BoardDAOFactory(
            address(treasuryImplementation),
            address(boardGovernanceImplementation)
        );

        initialSigners.push(signer1);
        initialSigners.push(signer2);
        initialSigners.push(signer3);

        vm.prank(creator);
        address governanceAddr = factory.createDAO("Test DAO", defaultConfig(), initialSigners);

        gov = BoardGovernance(governanceAddr);
        treasury = Treasury(payable(gov.treasury()));
    }

    function test_CreateDAO_WiresGovernanceAsTreasuryController() public view {
        assertEq(treasury.governance(), address(gov));
    }

    function test_CreateDAO_DeploysNoTokenAtAll() public view {
        // BoardGovernance is tokenless - the factory must not create a
        // GovernanceToken or StakedGovernanceToken, and DAOInfo's token
        // fields must be recorded as address(0), not silently omitted.
        (, , address governanceToken, address underlyingToken, , , ) = factory.daos(1);
        assertEq(governanceToken, address(0));
        assertEq(underlyingToken, address(0));
    }

    function test_CreateDAO_RecordsAllInitialSigners() public view {
        assertTrue(gov.isSigner(signer1));
        assertTrue(gov.isSigner(signer2));
        assertTrue(gov.isSigner(signer3));
        assertEq(gov.getSigners().length, 3);
    }

    function test_CreateDAO_SetsGovernanceConstructorArgs() public view {
        assertEq(gov.daoName(), "Test DAO");
        assertEq(gov.creator(), creator);
        assertEq(gov.treasury(), address(treasury));
    }

    function test_CreateDAO_IncrementsDaoCount() public {
        assertEq(factory.daoCount(), 1);

        vm.prank(creator);
        factory.createDAO("Second DAO", defaultConfig(), initialSigners);

        assertEq(factory.daoCount(), 2);
    }

    function test_CreateDAO_RecordsDAOInfo() public view {
        (
            string memory name,
            address daoCreator,
            ,
            ,
            address governance,
            address treasuryAddr,
            uint256 createdAt
        ) = factory.daos(1);

        assertEq(name, "Test DAO");
        assertEq(daoCreator, creator);
        assertEq(governance, address(gov));
        assertEq(treasuryAddr, address(treasury));
        assertEq(createdAt, vm.getBlockTimestamp());
    }

    function test_CreateDAO_TracksCreatorDAOs() public {
        vm.prank(creator);
        address secondGov = factory.createDAO("Second DAO", defaultConfig(), initialSigners);

        address[] memory creatorDAOs = factory.getCreatorDAOs(creator);
        assertEq(creatorDAOs.length, 2);
        assertEq(creatorDAOs[0], address(gov));
        assertEq(creatorDAOs[1], secondGov);
    }

    function test_CreateDAO_RevertsOnInvalidConfig() public {
        BoardGovernance.BoardGovernanceConfig memory badConfig = defaultConfig();
        badConfig.requiredApprovals = 0;

        vm.prank(creator);
        vm.expectRevert(BoardGovernance.InvalidConfiguration.selector);
        factory.createDAO("Bad DAO", badConfig, initialSigners);
    }

    function test_CreateDAO_RevertsOnEmptySigners() public {
        address[] memory empty = new address[](0);

        vm.prank(creator);
        vm.expectRevert(BoardGovernance.InvalidConfiguration.selector);
        factory.createDAO("Bad DAO", defaultConfig(), empty);
    }

    function test_TreasuryCannotBeControlledByFactoryAfterHandoff() public {
        vm.prank(address(factory));
        vm.expectRevert(ITreasury.Unauthorized.selector);
        treasury.transferETH(payable(recipient), 0);
    }
}
