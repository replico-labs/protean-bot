// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GovernanceToken} from "../src/token/GovernanceToken.sol";
import {WelcomeDistributor} from "../src/distribution/WelcomeDistributor.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

contract WelcomeDistributorTest is Test {
    GovernanceToken internal token;
    WelcomeDistributor internal distributor;

    address internal recipient = makeAddr("recipient"); // initial supply holder
    address internal owner = makeAddr("owner");
    address internal governance = makeAddr("governance");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant AMOUNT_PER_CLAIM = 100 ether;
    uint256 internal constant DISTRIBUTION_CAP = 1_000 ether;
    uint256 internal constant INITIAL_SUPPLY = 10_000 ether;

    function setUp() public {
        token = GovernanceToken(Clones.clone(address(new GovernanceToken())));
        token.initialize(
            "Test Token", "TT", INITIAL_SUPPLY, INITIAL_SUPPLY, recipient, owner
        );
        distributor = new WelcomeDistributor(
            address(token), governance, operator, AMOUNT_PER_CLAIM, DISTRIBUTION_CAP
        );

        // Fund the distributor with a plain transfer - no governance
        // proposal or minting allowance required.
        vm.prank(recipient);
        assertTrue(token.transfer(address(distributor), DISTRIBUTION_CAP), "transfer failed");
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsFields() public view {
        assertEq(distributor.token(), address(token));
        assertEq(distributor.governance(), governance);
        assertEq(distributor.operator(), operator);
        assertEq(distributor.amountPerClaim(), AMOUNT_PER_CLAIM);
        assertEq(distributor.distributionCap(), DISTRIBUTION_CAP);
    }

    function test_Constructor_RevertsOnZeroToken() public {
        vm.expectRevert(WelcomeDistributor.ZeroAddress.selector);
        new WelcomeDistributor(address(0), governance, operator, AMOUNT_PER_CLAIM, DISTRIBUTION_CAP);
    }

    function test_Constructor_RevertsOnZeroGovernance() public {
        vm.expectRevert(WelcomeDistributor.ZeroAddress.selector);
        new WelcomeDistributor(address(token), address(0), operator, AMOUNT_PER_CLAIM, DISTRIBUTION_CAP);
    }

    function test_Constructor_RevertsOnZeroOperator() public {
        vm.expectRevert(WelcomeDistributor.ZeroAddress.selector);
        new WelcomeDistributor(address(token), governance, address(0), AMOUNT_PER_CLAIM, DISTRIBUTION_CAP);
    }

    function test_Constructor_RevertsOnZeroAmountPerClaim() public {
        vm.expectRevert(WelcomeDistributor.ZeroAmount.selector);
        new WelcomeDistributor(address(token), governance, operator, 0, DISTRIBUTION_CAP);
    }

    /*//////////////////////////////////////////////////////////////
                            DISTRIBUTION
    //////////////////////////////////////////////////////////////*/

    function test_Distribute_OnlyOperator() public {
        vm.prank(alice);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.distribute(alice);
    }

    function test_Distribute_SendsAmountPerClaim() public {
        vm.prank(operator);
        distributor.distribute(alice);

        assertEq(token.balanceOf(alice), AMOUNT_PER_CLAIM);
        assertEq(distributor.totalDistributed(), AMOUNT_PER_CLAIM);
        assertTrue(distributor.hasClaimed(alice));
    }

    function test_Distribute_RevertsOnZeroAddress() public {
        vm.prank(operator);
        vm.expectRevert(WelcomeDistributor.ZeroAddress.selector);
        distributor.distribute(address(0));
    }

    function test_Distribute_RevertsOnDoubleClaim() public {
        vm.prank(operator);
        distributor.distribute(alice);

        vm.prank(operator);
        vm.expectRevert(WelcomeDistributor.AlreadyClaimed.selector);
        distributor.distribute(alice);
    }

    function test_Distribute_RevertsWhenCapExceeded() public {
        uint256 claims = DISTRIBUTION_CAP / AMOUNT_PER_CLAIM; // exactly fills the cap

        for (uint256 i = 0; i < claims; i++) {
            address claimant = address(uint160(i + 1000));
            vm.prank(operator);
            distributor.distribute(claimant);
        }

        assertEq(distributor.totalDistributed(), DISTRIBUTION_CAP);

        vm.prank(operator);
        vm.expectRevert(WelcomeDistributor.DistributionCapExceeded.selector);
        distributor.distribute(bob);
    }

    function test_Distribute_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit WelcomeDistributor.Distributed(alice, AMOUNT_PER_CLAIM);

        vm.prank(operator);
        distributor.distribute(alice);
    }

    /*//////////////////////////////////////////////////////////////
                        GOVERNANCE-ONLY ADMIN
    //////////////////////////////////////////////////////////////*/

    function test_SetOperator_OnlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.setOperator(bob);
    }

    function test_SetOperator_UpdatesOperator() public {
        vm.prank(governance);
        distributor.setOperator(bob);

        assertEq(distributor.operator(), bob);

        // Old operator loses access.
        vm.prank(operator);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.distribute(alice);

        // New operator can distribute.
        vm.prank(bob);
        distributor.distribute(alice);
        assertEq(token.balanceOf(alice), AMOUNT_PER_CLAIM);
    }

    function test_SetAmountPerClaim_OnlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.setAmountPerClaim(50 ether);
    }

    function test_SetAmountPerClaim_UpdatesFutureClaimsOnly() public {
        vm.prank(operator);
        distributor.distribute(alice);
        assertEq(token.balanceOf(alice), AMOUNT_PER_CLAIM);

        vm.prank(governance);
        distributor.setAmountPerClaim(50 ether);

        vm.prank(operator);
        distributor.distribute(bob);
        assertEq(token.balanceOf(bob), 50 ether);

        // Alice's earlier claim is untouched by the rate change.
        assertEq(token.balanceOf(alice), AMOUNT_PER_CLAIM);
    }

    function test_SetDistributionCap_OnlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.setDistributionCap(0);
    }

    function test_SetDistributionCap_BelowDistributedHaltsFurtherClaims() public {
        vm.prank(operator);
        distributor.distribute(alice); // 100 ether distributed

        vm.prank(governance);
        distributor.setDistributionCap(50 ether); // below what's already given out

        vm.prank(operator);
        vm.expectRevert(WelcomeDistributor.DistributionCapExceeded.selector);
        distributor.distribute(bob);

        // Alice's already-completed claim is unaffected.
        assertEq(token.balanceOf(alice), AMOUNT_PER_CLAIM);
    }

    function test_SetGovernance_OnlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.setGovernance(bob);
    }

    function test_SetGovernance_UpdatesGovernance() public {
        vm.prank(governance);
        distributor.setGovernance(bob);

        assertEq(distributor.governance(), bob);

        vm.prank(governance);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.setOperator(alice);

        vm.prank(bob);
        distributor.setOperator(alice);
        assertEq(distributor.operator(), alice);
    }

    function test_Withdraw_OnlyGovernance() public {
        vm.prank(alice);
        vm.expectRevert(WelcomeDistributor.Unauthorized.selector);
        distributor.withdraw(alice, 1 ether);
    }

    function test_Withdraw_SendsTokensOut() public {
        vm.prank(governance);
        distributor.withdraw(bob, 200 ether);

        assertEq(token.balanceOf(bob), 200 ether);
        assertEq(distributor.balance(), DISTRIBUTION_CAP - 200 ether);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

    function test_Balance_ReflectsFunding() public view {
        assertEq(distributor.balance(), DISTRIBUTION_CAP);
    }

    function test_RemainingCapacity_DecreasesWithClaims() public {
        assertEq(distributor.remainingCapacity(), DISTRIBUTION_CAP);

        vm.prank(operator);
        distributor.distribute(alice);

        assertEq(distributor.remainingCapacity(), DISTRIBUTION_CAP - AMOUNT_PER_CLAIM);
    }

    function test_RemainingCapacity_ZeroWhenCapLoweredBelowDistributed() public {
        vm.prank(operator);
        distributor.distribute(alice);

        vm.prank(governance);
        distributor.setDistributionCap(50 ether);

        assertEq(distributor.remainingCapacity(), 0);
    }
}
