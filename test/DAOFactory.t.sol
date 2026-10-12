// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {GovernanceTestBase} from "./GovernanceTestBase.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IDAOFactory} from "../src/factory/IDAOFactory.sol";
import "../src/governance/Types.sol";
import "../src/governance/GovernanceErrors.sol";

contract DAOFactoryTest is GovernanceTestBase {
    function test_CreateDAO_WiresGovernanceAsTreasuryController() public view {
        // Treasury must recognize the deployed Governance contract as its
        // controller - not the factory, not the creator.
        assertEq(treasury.governance(), address(gov));
    }

    function test_CreateDAO_WiresGovernanceAsUnderlyingTokenOwner() public view {
        // Minting rights on the raw token must end up with Governance, not
        // the factory or the creator - otherwise the token isn't governed.
        assertEq(underlying.owner(), address(gov));
    }

    function test_CreateDAO_GovernanceReadsVotesFromStakingWrapper() public view {
        // Governance must be pointed at the staking wrapper, not the raw
        // token directly - voting power only exists once staked.
        assertEq(gov.governanceToken(), address(token));
        assertEq(address(token.underlying()), address(underlying));
    }

    function test_CreateDAO_MintsInitialSupplyToCreatorAsRawTokens() public view {
        // The initial supply must land with the creator as raw, unstaked
        // tokens - not the factory, and not pre-staked into the wrapper.
        assertEq(underlying.balanceOf(creator), INITIAL_SUPPLY);
        assertEq(underlying.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(creator), 0);
        assertEq(token.getVotes(creator), 0);
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
        address secondGov = factory.createDAO(
            "Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig()
        );

        address[] memory creatorDAOs = factory.getCreatorDAOs(creator);
        assertEq(creatorDAOs.length, 2);
        assertEq(creatorDAOs[0], address(gov));
        assertEq(creatorDAOs[1], secondGov);
    }

    function test_CreateDAO_EmitsDAOCreated() public {
        vm.expectEmit(true, true, false, false);
        emit IDAOFactory.DAOCreated(2, creator, address(0), address(0), address(0));

        vm.prank(creator);
        factory.createDAO("Second DAO", "SDAO", INITIAL_SUPPLY, MAX_SUPPLY, defaultConfig());
    }

    function test_CreateDAO_RevertsOnInvalidConfig() public {
        GovernanceConfig memory badConfig = defaultConfig();
        badConfig.quorumBps = 0;

        vm.prank(creator);
        vm.expectRevert(InvalidQuorum.selector);
        factory.createDAO("Bad DAO", "BAD", INITIAL_SUPPLY, MAX_SUPPLY, badConfig);
    }

    function test_TreasuryCannotBeControlledByFactoryAfterHandoff() public {
        // Once handed off, the factory itself must no longer be able to
        // act as the treasury's governance.
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
