// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { FhevmTest } from "forge-fhevm/FhevmTest.sol";
import { FHE } from "@fhevm/solidity/lib/FHE.sol";
import "encrypted-types/EncryptedTypes.sol";

import { OpportunityMarket } from "../src/governance/opportunity-market/OpportunityMarket.sol";
import { OpportunityMarketFactory } from "../src/governance/opportunity-market/OpportunityMarketFactory.sol";

/// @dev Minimal mock ERC20 standing in for the real underlying token.
contract MockERC20 {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev HONESTY NOTE: this is written against forge-fhevm's real, documented
///      API (encryptUint32/64, decrypt, publicDecrypt - confirmed directly
///      from the official zama-ai/forge-fhevm README, not guessed). Unlike
///      every other test file in this project, this one could not be
///      compiled or run in this environment - there is no `forge` binary
///      available here, and reconstructing forge-fhevm's full vendored
///      host-contract stack locally to compile-check against was
///      impractical given what it would actually take. This is the one
///      test file in the whole project that genuinely needs a real
///      `forge test` run to know whether it's correct, not just to
///      re-confirm something already checked another way.
contract OpportunityMarketTest is FhevmTest {
    OpportunityMarket internal marketImpl;
    OpportunityMarketFactory internal factory;
    OpportunityMarket internal market;
    MockERC20 internal token;

    address internal deployer;
    uint256 internal deployerPk;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp(); // deploys the real fhEVM host contracts
        (deployer, deployerPk) = makeAddrAndKey("deployer");

        token = new MockERC20();
        marketImpl = new OpportunityMarket();
        factory = new OpportunityMarketFactory(address(marketImpl));

        vm.prank(deployer);
        address created = factory.createMarket(address(token));
        market = OpportunityMarket(created);

        token.mint(alice, 1_000);
        token.mint(bob, 1_000);
        token.mint(deployer, 1_000);
    }

    /*//////////////////////////////////////////////////////////////
                                FACTORY
    //////////////////////////////////////////////////////////////*/

    function test_Factory_CreateMarketSetsCorrectDeployer() public view {
        assertEq(market.deployer(), deployer);
        assertEq(market.underlyingToken(), address(token));
        assertTrue(factory.isMarket(address(market)));
        assertEq(factory.marketCount(), 1);
    }

    function test_Factory_MultipleMarketsAreIndependent() public {
        vm.prank(alice);
        address second = factory.createMarket(address(token));

        assertTrue(second != address(market));
        assertEq(OpportunityMarket(second).deployer(), alice);
        assertEq(factory.marketCount(), 2);
    }

    /*//////////////////////////////////////////////////////////////
                        DEPOSIT AND BACKING
    //////////////////////////////////////////////////////////////*/

    function _deposit(address account, uint256 amount) internal {
        vm.startPrank(account);
        token.approve(address(market), amount);
        market.deposit(amount);
        vm.stopPrank();
    }

    function test_Deposit_CreditsConfidentialBalance() public {
        _deposit(alice, 500);

        vm.prank(alice);
        euint64 balance = market.balanceOf(alice); // see note below on this helper
        assertEq(decrypt(balance), 500);
    }

    function test_Back_DeductsFromBalanceAndRecordsBet() public {
        _deposit(alice, 500);
        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");

        (externalEuint32 targetHandle, bytes memory targetProof) = encryptUint32(1, alice, address(market));
        (externalEuint64 amountHandle, bytes memory amountProof) = encryptUint64(200, alice, address(market));

        vm.prank(alice);
        market.back(targetHandle, targetProof, amountHandle, amountProof);

        vm.prank(alice);
        euint64 remaining = market.balanceOf(alice);
        assertEq(decrypt(remaining), 300);
        assertEq(market.betCount(alice), 1);
    }

    function test_Back_InsufficientBalanceSilentlyBetsZero() public {
        _deposit(alice, 100);
        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");

        // Request backing more than alice actually has.
        (externalEuint32 targetHandle, bytes memory targetProof) = encryptUint32(1, alice, address(market));
        (externalEuint64 amountHandle, bytes memory amountProof) = encryptUint64(500, alice, address(market));

        vm.prank(alice);
        market.back(targetHandle, targetProof, amountHandle, amountProof);

        // Balance is untouched - the oversized bet was silently treated
        // as zero, not reverted, and not partially applied.
        vm.prank(alice);
        euint64 remaining = market.balanceOf(alice);
        assertEq(decrypt(remaining), 100);
    }

    /*//////////////////////////////////////////////////////////////
                            STAKE RECLAMATION
    //////////////////////////////////////////////////////////////*/

    function test_ReclaimStake_RevertsBeforeResolution() public {
        _deposit(alice, 500);
        vm.prank(alice);
        vm.expectRevert(OpportunityMarket.NotResolved.selector);
        market.reclaimStake();
    }

    function test_ReclaimStake_ReturnsFullOriginalAmount() public {
        _deposit(alice, 500);
        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");

        (externalEuint32 targetHandle, bytes memory targetProof) = encryptUint32(1, alice, address(market));
        (externalEuint64 amountHandle, bytes memory amountProof) = encryptUint64(200, alice, address(market));
        vm.prank(alice);
        market.back(targetHandle, targetProof, amountHandle, amountProof);

        vm.prank(deployer);
        market.resolve(1);

        vm.prank(alice);
        market.reclaimStake();

        vm.prank(alice);
        euint64 total = market.balanceOf(alice);
        assertEq(decrypt(total), 500); // 300 remaining + 200 backed, back together
    }

    /*//////////////////////////////////////////////////////////////
            FULL LIFECYCLE: RESOLVE -> AGGREGATE REVEAL -> PAYOUT
    //////////////////////////////////////////////////////////////*/

    function test_FullLifecycle_WinnerReceivesProportionalReward() public {
        // Two opportunities; alice and bob both back opportunity 1 with
        // equal amounts, so they should split the reward pool evenly.
        _deposit(alice, 1_000);
        _deposit(bob, 1_000);

        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");
        vm.prank(alice);
        market.listOpportunity("ipfs://opp2");

        (externalEuint32 t1, bytes memory tp1) = encryptUint32(1, alice, address(market));
        (externalEuint64 a1, bytes memory ap1) = encryptUint64(400, alice, address(market));
        vm.prank(alice);
        market.back(t1, tp1, a1, ap1);

        (externalEuint32 t2, bytes memory tp2) = encryptUint32(1, bob, address(market));
        (externalEuint64 a2, bytes memory ap2) = encryptUint64(400, bob, address(market));
        vm.prank(bob);
        market.back(t2, tp2, a2, ap2);

        vm.startPrank(deployer);
        token.approve(address(market), 200);
        market.fundRewardPool(200);
        market.resolve(1); // opportunity 1 wins
        vm.stopPrank();

        // Reveal the aggregate total backing the winner (800 total: 400 + 400).
        bytes32 totalHandle = market.finalizeWinningTotal();
        bytes32[] memory totalHandles = new bytes32[](1);
        totalHandles[0] = totalHandle;
        (uint256[] memory totalCleartexts, bytes memory totalProof) = publicDecrypt(totalHandles);
        bytes memory totalCleartext = abi.encodePacked(totalCleartexts);
        market.completeWinningTotalReveal(totalCleartext, totalProof);
        assertEq(market.winningTotalBacking(), 800);

        // Each of alice and bob computes and withdraws their reward -
        // (400 * 200) / 800 = 100 each.
        vm.prank(alice);
        market.computeReward();
        vm.prank(alice);
        bytes32 aliceHandle = market.requestRewardWithdrawal();
        bytes32[] memory aliceHandles = new bytes32[](1);
        aliceHandles[0] = aliceHandle;
        (uint256[] memory aliceCleartexts, bytes memory aliceProof) = publicDecrypt(aliceHandles);
        bytes memory aliceCleartext = abi.encodePacked(aliceCleartexts);

        uint256 aliceBefore = token.balanceOf(alice);
        market.completeWithdrawal(aliceHandle, aliceCleartext, aliceProof);
        assertEq(token.balanceOf(alice), aliceBefore + 100);
    }

    function test_ResolveOpportunityDoesNotExist_Reverts() public {
        vm.prank(deployer);
        vm.expectRevert(OpportunityMarket.OpportunityDoesNotExist.selector);
        market.resolve(1); // nothing listed yet
    }

    /*//////////////////////////////////////////////////////////////
                            CANCEL MARKET
    //////////////////////////////////////////////////////////////*/

    function test_CancelMarket_RevertsForNonDeployer() public {
        vm.prank(alice);
        vm.expectRevert(OpportunityMarket.OnlyDeployer.selector);
        market.cancelMarket();
    }

    function test_CancelMarket_RefundsRewardPoolToDeployer() public {
        vm.startPrank(deployer);
        token.approve(address(market), 200);
        market.fundRewardPool(200);

        uint256 before = token.balanceOf(deployer);
        market.cancelMarket();
        vm.stopPrank();

        assertEq(token.balanceOf(deployer), before + 200);
        assertTrue(market.cancelled());
        assertEq(market.rewardPool(), 0);
    }

    function test_CancelMarket_RevertsIfAlreadyResolved() public {
        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");

        vm.prank(deployer);
        market.resolve(1);

        vm.prank(deployer);
        vm.expectRevert(OpportunityMarket.CannotCancelAfterResolution.selector);
        market.cancelMarket();
    }

    function test_CancelMarket_RevertsOnDoubleCancel() public {
        vm.prank(deployer);
        market.cancelMarket();

        vm.prank(deployer);
        vm.expectRevert(OpportunityMarket.AlreadyCancelled.selector);
        market.cancelMarket();
    }

    function test_ReclaimStake_WorksAfterCancellationNotJustResolution() public {
        _deposit(alice, 500);

        vm.prank(deployer);
        market.cancelMarket();

        // Should NOT revert with NotResolved - cancellation alone is
        // enough to unlock stake reclamation.
        vm.prank(alice);
        market.reclaimStake();

        vm.prank(alice);
        euint64 total = market.balanceOf(alice);
        assertEq(decrypt(total), 500);
    }

    /*//////////////////////////////////////////////////////////////
        DEPLOYER-ONLY VISIBILITY - THE ACTUAL PRIVACY BOUNDARY ITSELF
    //////////////////////////////////////////////////////////////*/

    /// @dev Uses the real, confirmed FhevmTest signatures (verified against
    ///      the actual installed source, not the docs) - signUserDecrypt
    ///      takes a private key and returns packed signature bytes
    ///      directly, and userDecrypt returns a plain uint256.

    /// @dev userDecrypt is internal (inherited from FhevmTest), so calling
    ///      it directly is a same-frame jump, not a real EVM call -
    ///      vm.expectRevert() can only reliably intercept a revert that
    ///      crosses an actual call boundary. This external wrapper exists
    ///      purely to give expectRevert something real to catch.
    function _userDecryptExternal(
        bytes32 handle,
        address userAddress,
        address contractAddress,
        bytes memory userSignature
    ) external returns (uint256) {
        return userDecrypt(handle, userAddress, contractAddress, userSignature);
    }

    function test_GetBet_OnlyDeployerAndBackerCanDecrypt() public {
        // A local backer with a known private key, scoped to this test -
        // the shared `alice` state variable is created via makeAddr(),
        // which never exposes a private key, so she can't sign a
        // userDecrypt request. Using a separate local account here
        // avoids changing alice's address for every other test in this
        // file that depends on it.
        (address backer, uint256 backerPk) = makeAddrAndKey("backer");
        token.mint(backer, 1_000);
        _deposit(backer, 500);

        vm.prank(backer);
        market.listOpportunity("ipfs://opp1");

        (externalEuint32 targetHandle, bytes memory targetProof) = encryptUint32(1, backer, address(market));
        (externalEuint64 amountHandle, bytes memory amountProof) = encryptUint64(200, backer, address(market));
        vm.prank(backer);
        market.back(targetHandle, targetProof, amountHandle, amountProof);

        (euint32 target, euint64 amount) = market.getBet(backer, 0);

        // The fix under test: FHE.allow(target, msg.sender) in back() -
        // the backer must be able to decrypt BOTH which opportunity
        // they bet on AND how much, not just the amount. Missing the
        // target grant specifically is the exact bug this test would
        // have caught, had it checked target at all before this fix.
        bytes memory backerSig = signUserDecrypt(backerPk, address(market));
        uint256 backerTargetView = this._userDecryptExternal(euint32.unwrap(target), backer, address(market), backerSig);
        uint256 backerAmountView = this._userDecryptExternal(euint64.unwrap(amount), backer, address(market), backerSig);
        assertEq(backerTargetView, 1);
        assertEq(backerAmountView, 200);

        // The deployer was also granted decrypt rights in back() - both
        // target and amount should succeed for them too.
        bytes memory deployerSig = signUserDecrypt(deployerPk, address(market));
        uint256 deployerTargetView = this._userDecryptExternal(euint32.unwrap(target), deployer, address(market), deployerSig);
        uint256 deployerAmountView = this._userDecryptExternal(euint64.unwrap(amount), deployer, address(market), deployerSig);
        assertEq(deployerTargetView, 1);
        assertEq(deployerAmountView, 200);

        // A random, uninvolved address was never granted decrypt rights
        // on this specific bet - this should revert for BOTH handles,
        // proving the permission boundary is real and not just
        // decorative for one of the two encrypted values.
        (address stranger, uint256 strangerPk) = makeAddrAndKey("stranger");
        bytes memory strangerSig = signUserDecrypt(strangerPk, address(market));
        vm.expectRevert();
        this._userDecryptExternal(euint32.unwrap(target), stranger, address(market), strangerSig);
        vm.expectRevert();
        this._userDecryptExternal(euint64.unwrap(amount), stranger, address(market), strangerSig);
    }

    function test_GetAllBets_ReturnsEveryBetAcrossEveryWallet() public {
        _deposit(alice, 500);
        _deposit(bob, 500);
        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");

        (externalEuint32 t1, bytes memory tp1) = encryptUint32(1, alice, address(market));
        (externalEuint64 a1, bytes memory ap1) = encryptUint64(200, alice, address(market));
        vm.prank(alice);
        market.back(t1, tp1, a1, ap1);

        (externalEuint32 t2, bytes memory tp2) = encryptUint32(1, bob, address(market));
        (externalEuint64 a2, bytes memory ap2) = encryptUint64(300, bob, address(market));
        vm.prank(bob);
        market.back(t2, tp2, a2, ap2);

        (address[] memory bettor, euint32[] memory targets, euint64[] memory amounts) = market.getAllBets();

        assertEq(bettor.length, 2);
        assertEq(bettor[0], alice);
        assertEq(bettor[1], bob);
        assertEq(decrypt(amounts[0]), 200);
        assertEq(decrypt(amounts[1]), 300);
        assertEq(decrypt(targets[0]), 1);
        assertEq(decrypt(targets[1]), 1);
    }

    /*//////////////////////////////////////////////////////////////
            OBLIVIOUS PER-OPPORTUNITY RUNNING TOTAL (redesign)
    //////////////////////////////////////////////////////////////*/

    function test_ListOpportunity_RevertsAtMaxOpportunities() public {
        vm.startPrank(alice);
        for (uint256 i = 0; i < 12; i++) {
            market.listOpportunity("ipfs://opp");
        }
        assertEq(market.opportunityCount(), 12);

        vm.expectRevert(OpportunityMarket.TooManyOpportunities.selector);
        market.listOpportunity("ipfs://one-too-many");
        vm.stopPrank();
    }

    /// @dev The core property the whole redesign depends on: betting on
    ///      one specific opportunity must update ONLY that opportunity's
    ///      running total, not any other one - confirmed here by
    ///      resolving the actually-bet-on opportunity and checking the
    ///      revealed total exactly matches the bet, with no contribution
    ///      leaking in from anywhere else.
    function test_Back_ObliviouslyUpdatesOnlyTheChosenOpportunity() public {
        _deposit(alice, 1_000);

        vm.startPrank(alice);
        market.listOpportunity("ipfs://opp1");
        market.listOpportunity("ipfs://opp2");
        market.listOpportunity("ipfs://opp3");
        market.listOpportunity("ipfs://opp4");
        market.listOpportunity("ipfs://opp5");
        vm.stopPrank();

        // Bet on opportunity 3 specifically, out of five listed.
        (externalEuint32 targetHandle, bytes memory targetProof) = encryptUint32(3, alice, address(market));
        (externalEuint64 amountHandle, bytes memory amountProof) = encryptUint64(350, alice, address(market));
        vm.prank(alice);
        market.back(targetHandle, targetProof, amountHandle, amountProof);

        vm.prank(deployer);
        market.resolve(3); // the one actually bet on

        bytes32 handle = market.finalizeWinningTotal();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        (uint256[] memory cleartexts, bytes memory proof) = publicDecrypt(handles);
        market.completeWinningTotalReveal(abi.encodePacked(cleartexts), proof);

        // Exactly 350 - not 0 (would mean the update never landed) and
        // not some other value (would mean it leaked into the wrong
        // opportunity's slot).
        assertEq(market.winningTotalBacking(), 350);
    }

    /// @dev The edge case found while building this: an opportunity that
    ///      never receives a single bet must still reveal a genuine,
    ///      valid zero if it's resolved as the winner - not revert or
    ///      misbehave over an uninitialized handle. Confirms the fix in
    ///      listOpportunity() that grants every opportunity's total a
    ///      real ciphertext from the moment it's listed.
    function test_FinalizeWinningTotal_UnBetOpportunityRevealsZero() public {
        _deposit(alice, 1_000);

        vm.startPrank(alice);
        market.listOpportunity("ipfs://opp1");
        market.listOpportunity("ipfs://opp2");
        vm.stopPrank();

        // Alice bets on opportunity 1 - opportunity 2 never receives a bet at all.
        (externalEuint32 targetHandle, bytes memory targetProof) = encryptUint32(1, alice, address(market));
        (externalEuint64 amountHandle, bytes memory amountProof) = encryptUint64(500, alice, address(market));
        vm.prank(alice);
        market.back(targetHandle, targetProof, amountHandle, amountProof);

        vm.prank(deployer);
        market.resolve(2); // the never-bet-on opportunity wins instead

        bytes32 handle = market.finalizeWinningTotal();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        (uint256[] memory cleartexts, bytes memory proof) = publicDecrypt(handles);
        market.completeWinningTotalReveal(abi.encodePacked(cleartexts), proof);

        assertEq(market.winningTotalBacking(), 0);
    }

    /// @dev Two separate bettors, two separate transactions, same
    ///      opportunity - the running total must accumulate correctly
    ///      across genuinely independent back() calls, not just within
    ///      a single one.
    function test_Back_MultipleBetsOnSameOpportunityAccumulate() public {
        _deposit(alice, 1_000);
        _deposit(bob, 1_000);

        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");

        (externalEuint32 t1, bytes memory tp1) = encryptUint32(1, alice, address(market));
        (externalEuint64 a1, bytes memory ap1) = encryptUint64(300, alice, address(market));
        vm.prank(alice);
        market.back(t1, tp1, a1, ap1);

        (externalEuint32 t2, bytes memory tp2) = encryptUint32(1, bob, address(market));
        (externalEuint64 a2, bytes memory ap2) = encryptUint64(450, bob, address(market));
        vm.prank(bob);
        market.back(t2, tp2, a2, ap2);

        vm.prank(deployer);
        market.resolve(1);

        bytes32 handle = market.finalizeWinningTotal();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        (uint256[] memory cleartexts, bytes memory proof) = publicDecrypt(handles);
        market.completeWinningTotalReveal(abi.encodePacked(cleartexts), proof);

        assertEq(market.winningTotalBacking(), 750); // 300 + 450
    }

    /*//////////////////////////////////////////////////////////////
        REWARD MATH AT REAL STABLECOIN SIZES (6 decimals)
    //////////////////////////////////////////////////////////////*/

    /// Backs opportunity 1 for each (account, amount), funds `pool`,
    /// resolves to 1 and reveals the winning total.
    function _resolveWithBets(address[] memory accounts, uint64[] memory amounts, uint256 pool) internal {
        vm.prank(alice);
        market.listOpportunity("ipfs://opp1");
        for (uint256 i = 0; i < accounts.length; i++) {
            token.mint(accounts[i], amounts[i]);
            _deposit(accounts[i], amounts[i]);
            (externalEuint32 t, bytes memory tp) = encryptUint32(1, accounts[i], address(market));
            (externalEuint64 a, bytes memory ap) = encryptUint64(amounts[i], accounts[i], address(market));
            vm.prank(accounts[i]);
            market.back(t, tp, a, ap);
        }
        token.mint(deployer, pool);
        vm.startPrank(deployer);
        token.approve(address(market), pool);
        market.fundRewardPool(pool);
        market.resolve(1);
        vm.stopPrank();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = market.finalizeWinningTotal();
        (uint256[] memory cleartexts, bytes memory proof) = publicDecrypt(handles);
        market.completeWinningTotalReveal(abi.encodePacked(cleartexts), proof);
    }

    function _withdrawReward(address account) internal returns (uint256 paid) {
        vm.prank(account);
        market.computeReward();
        vm.prank(account);
        bytes32 handle = market.requestRewardWithdrawal();
        bytes32[] memory handles = new bytes32[](1);
        handles[0] = handle;
        (uint256[] memory cleartexts, bytes memory proof) = publicDecrypt(handles);
        uint256 before = token.balanceOf(account);
        market.completeWithdrawal(handle, abi.encodePacked(cleartexts), proof);
        return token.balanceOf(account) - before;
    }

    /// 5,000 USDC staked x a 5,000 USDC pool = 2.5e19 raw, past 2^64
    /// (~1.8e19): the old 64-bit multiply wrapped and paid ~6.55 billion
    /// raw units short. The 128-bit multiply pays the whole pool.
    function test_Reward_NoOverflowAtStablecoinScale() public {
        address[] memory who = new address[](1);
        who[0] = alice;
        uint64[] memory amts = new uint64[](1);
        amts[0] = 5_000e6;
        _resolveWithBets(who, amts, 5_000e6);
        assertGt(uint256(5_000e6) * 5_000e6, type(uint64).max); // the old math would have wrapped
        assertEq(_withdrawReward(alice), 5_000e6);
    }

    /// Uneven split with large amounts: 3M and 1M USDC on the winner, a
    /// 4M pool -> 3M and 1M (products ~1.2e25 and 4e24, far past 2^64).
    function test_Reward_ProportionalSplitAtLargeAmounts() public {
        address[] memory who = new address[](2);
        who[0] = alice;
        who[1] = bob;
        uint64[] memory amts = new uint64[](2);
        amts[0] = 3_000_000e6;
        amts[1] = 1_000_000e6;
        _resolveWithBets(who, amts, 4_000_000e6);
        assertEq(market.winningTotalBacking(), 4_000_000e6);
        assertEq(_withdrawReward(alice), 3_000_000e6);
        assertEq(_withdrawReward(bob), 1_000_000e6);
    }

    /// Rounds down, like plaintext integer division: 1/3 of 100 each.
    function test_Reward_RoundsDown() public {
        address carol = makeAddr("carol");
        address[] memory who = new address[](3);
        who[0] = alice;
        who[1] = bob;
        who[2] = carol;
        uint64[] memory amts = new uint64[](3);
        amts[0] = 7e6;
        amts[1] = 7e6;
        amts[2] = 7e6;
        _resolveWithBets(who, amts, 100);
        assertEq(_withdrawReward(alice), 33);
        assertEq(_withdrawReward(carol), 33);
    }

    function test_RewardMathVersion() public view {
        assertEq(market.REWARD_MATH_VERSION(), 2);
    }

    /// Above 2^64 - 1 raw units an amount can't be represented
    /// encrypted - refused instead of silently truncated.
    function test_Deposit_RevertsAboveUint64() public {
        uint256 tooBig = uint256(type(uint64).max) + 1;
        token.mint(alice, tooBig);
        vm.startPrank(alice);
        token.approve(address(market), tooBig);
        vm.expectRevert(OpportunityMarket.AmountTooLarge.selector);
        market.deposit(tooBig);
        vm.stopPrank();
    }

    function test_FundRewardPool_RevertsAboveUint64() public {
        uint256 tooBig = uint256(type(uint64).max) + 1;
        token.mint(deployer, tooBig);
        vm.startPrank(deployer);
        token.approve(address(market), tooBig);
        vm.expectRevert(OpportunityMarket.AmountTooLarge.selector);
        market.fundRewardPool(tooBig);
        vm.stopPrank();
    }
}
