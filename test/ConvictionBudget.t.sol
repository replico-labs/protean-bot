// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ConvictionGovernance} from "../src/governance/conviction/ConvictionGovernance.sol";
import {Treasury} from "../src/treasury/Treasury.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract BudgetToken is ERC20 {
    uint8 internal immutable _decimals;

    constructor(string memory symbol_, uint8 decimals_) ERC20(symbol_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Staked-token stand-in: balances, locking, and the underlying() the
///      governance reads to list the DAO's own token.
contract BudgetStakedToken {
    address public underlying;
    mapping(address => uint256) public balanceOf;

    constructor(address underlying_) {
        underlying = underlying_;
    }

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

    function lock(address, uint256) external {}
    function unlock(address, uint256) external {}
}

/// @dev Permit2's allowance/approve, enough to prove revocation.
contract BudgetPermit2 {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Allowance))) internal _allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        _allowance[msg.sender][token][spender] = Allowance(amount, expiration, 0);
    }

    function allowance(address owner, address token, address spender) external view returns (uint160, uint48, uint48) {
        Allowance memory a = _allowance[owner][token][spender];
        return (a.amount, a.expiration, a.nonce);
    }
}

/// @dev A swap venue: pulls `amountIn` of a token, pays native back.
contract BudgetSwapper {
    receive() external payable {}

    function swap(address token, uint256 amountIn, uint256 nativeOut) external {
        ERC20(token).transferFrom(msg.sender, address(this), amountIn);
        (bool ok, ) = msg.sender.call{value: nativeOut}("");
        require(ok);
    }
}

contract ConvictionBudgetTest is Test {
    ConvictionGovernance internal gov;
    Treasury internal treasury;
    BudgetStakedToken internal staked;
    BudgetToken internal daoToken;
    BudgetToken internal usdc;
    BudgetToken internal stray;

    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant MIN = 100 ether;
    uint256 internal constant USDC_WEIGHT = 1_000 ether;

    function setUp() public {
        daoToken = new BudgetToken("DAO", 18);
        usdc = new BudgetToken("USDC", 6);
        stray = new BudgetToken("STRAY", 18);
        staked = new BudgetStakedToken(address(daoToken));

        gov = ConvictionGovernance(Clones.clone(address(new ConvictionGovernance())));
        treasury = Treasury(payable(Clones.clone(address(new Treasury()))));
        treasury.initialize(address(gov));
        gov.initialize(
            "Budget DAO",
            creator,
            address(staked),
            address(treasury),
            ConvictionGovernance.ConvictionGovernanceConfig({
                convictionGrowthRate: 1_000 ether,
                minThresholdConviction: MIN,
                thresholdMultiplier: 0,
                proposalThreshold: 0,
                timelockDelay: 1 days,
                executionPeriod: 7 days
            })
        );

        vm.prank(address(gov));
        gov.addAsset(address(usdc), USDC_WEIGHT);

        usdc.mint(address(treasury), 100e6);
        daoToken.mint(address(treasury), 1_000 ether);
        stray.mint(address(treasury), 5 ether);
        vm.deal(address(treasury), 50 ether);

        staked.setBalance(alice, 1e30);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _one(address target, bytes memory data) internal pure returns (ConvictionGovernance.ProposalAction[] memory a) {
        a = new ConvictionGovernance.ProposalAction[](1);
        a[0] = ConvictionGovernance.ProposalAction(target, 0, data);
    }

    function _viaTreasury(address target, uint256 value, bytes memory data) internal view returns (ConvictionGovernance.ProposalAction memory) {
        return ConvictionGovernance.ProposalAction(address(treasury), 0, abi.encodeCall(Treasury.execute, (target, value, data)));
    }

    function _budget(address asset, uint256 amount) internal pure returns (ConvictionGovernance.AssetAmount[] memory b) {
        b = new ConvictionGovernance.AssetAmount[](1);
        b[0] = ConvictionGovernance.AssetAmount(asset, amount);
    }

    function _none() internal pure returns (ConvictionGovernance.AssetAmount[] memory b) {
        b = new ConvictionGovernance.AssetAmount[](0);
    }

    function _transferUsdc(uint256 amount) internal view returns (ConvictionGovernance.ProposalAction[] memory) {
        return _one(address(treasury), abi.encodeCall(Treasury.transferERC20, (address(usdc), recipient, amount)));
    }

    /// @dev Supports, lets conviction cross the bar, queues, waits out the timelock.
    function _pass(uint256 id) internal {
        vm.prank(alice);
        gov.support(id);
        vm.roll(block.number + gov.requiredConviction(id) / 1_000 ether + 1);
        gov.queueProposal(id);
        vm.warp(block.timestamp + 1 days + 1);
    }

    /*//////////////////////////////////////////////////////////////
                            ASSET LIST
    //////////////////////////////////////////////////////////////*/

    function test_Initialize_ListsNativeAndDaoToken() public view {
        (address[] memory assets, uint256[] memory weights) = gov.listedAssets();
        assertEq(assets.length, 3);
        assertEq(assets[0], address(0));
        assertEq(assets[1], address(daoToken));
        assertEq(assets[2], address(usdc));
        assertEq(weights[0], gov.DEFAULT_ASSET_WEIGHT());
        assertEq(weights[1], gov.DEFAULT_ASSET_WEIGHT());
        assertEq(weights[2], USDC_WEIGHT);
        assertEq(gov.BUDGET_VERSION(), 2);
    }

    function test_AssetFunctions_AreGovernanceOnly() public {
        vm.expectRevert(ConvictionGovernance.Unauthorized.selector);
        gov.addAsset(address(stray), 1);
        vm.expectRevert(ConvictionGovernance.Unauthorized.selector);
        gov.setAssetWeight(address(usdc), 1);
        vm.expectRevert(ConvictionGovernance.Unauthorized.selector);
        gov.removeAsset(address(usdc));
    }

    function test_AddAsset_RejectsDuplicate() public {
        vm.prank(address(gov));
        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.AssetAlreadyListed.selector, address(usdc)));
        gov.addAsset(address(usdc), 1);
    }

    function test_WeightRaise_AppliesAtOnce() public {
        vm.prank(address(gov));
        gov.setAssetWeight(address(usdc), 2_000 ether);
        assertEq(gov.assetWeight(address(usdc)), 2_000 ether);
    }

    function test_WeightCut_WaitsOutTheDelay() public {
        vm.prank(address(gov));
        gov.setAssetWeight(address(usdc), 10 ether);
        assertEq(gov.assetWeight(address(usdc)), USDC_WEIGHT, "cut not applied yet");

        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.AssetChangeNotDue.selector, block.timestamp + 7 days));
        gov.applyAssetChange(address(usdc));

        vm.warp(block.timestamp + 7 days);
        gov.applyAssetChange(address(usdc));
        assertEq(gov.assetWeight(address(usdc)), 10 ether);
    }

    function test_RaiseCancelsAPendingCut() public {
        vm.startPrank(address(gov));
        gov.setAssetWeight(address(usdc), 10 ether);
        gov.setAssetWeight(address(usdc), 1_500 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(ConvictionGovernance.NoPendingAssetChange.selector);
        gov.applyAssetChange(address(usdc));
        assertEq(gov.assetWeight(address(usdc)), 1_500 ether);
    }

    function test_RemoveAsset_WaitsThenUnlists() public {
        vm.prank(address(gov));
        gov.removeAsset(address(usdc));
        assertTrue(gov.isListedAsset(address(usdc)));
        vm.warp(block.timestamp + 7 days);
        gov.applyAssetChange(address(usdc));
        assertFalse(gov.isListedAsset(address(usdc)));
        (address[] memory assets, ) = gov.listedAssets();
        assertEq(assets.length, 2);
    }

    /*//////////////////////////////////////////////////////////////
                        REQUIRED CONVICTION
    //////////////////////////////////////////////////////////////*/

    function test_Budget_CostIsWeightTimesShare() public {
        // 10 of 100 USDC (10%) at weight 1000 -> +100.
        uint256 id = gov.proposeWithBudget(_transferUsdc(10e6), "pay", _budget(address(usdc), 10e6));
        assertEq(gov.requiredConviction(id), MIN + 100 ether);
        assertFalse(gov.weakensRules(id));
    }

    function test_Budget_SumsAcrossAssets() public {
        ConvictionGovernance.AssetAmount[] memory b = new ConvictionGovernance.AssetAmount[](2);
        b[0] = ConvictionGovernance.AssetAmount(address(usdc), 10e6); // 10% x 1000 = 100
        b[1] = ConvictionGovernance.AssetAmount(address(0), 0.5 ether); // 1% x 900 = 9
        uint256 id = gov.proposeWithBudget(_transferUsdc(10e6), "pay", b);
        assertEq(gov.requiredConviction(id), MIN + 109 ether);
        assertEq(gov.proposalBudget(id).length, 2);
    }

    function test_Budget_MoreThanHeldCountsAsAll() public {
        uint256 id = gov.proposeWithBudget(_transferUsdc(10e6), "pay", _budget(address(usdc), 500e6));
        assertEq(gov.requiredConviction(id), MIN + USDC_WEIGHT);
    }

    function test_Budget_FixedAtCreation() public {
        uint256 id = gov.proposeWithBudget(_transferUsdc(10e6), "pay", _budget(address(usdc), 10e6));
        vm.prank(address(gov));
        gov.setAssetWeight(address(usdc), 5_000 ether);
        assertEq(gov.requiredConviction(id), MIN + 100 ether);
    }

    function test_Budget_RejectsUnlistedDuplicateAndZero() public {
        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.AssetNotListed.selector, address(stray)));
        gov.proposeWithBudget(_transferUsdc(1), "x", _budget(address(stray), 1));

        ConvictionGovernance.AssetAmount[] memory b = new ConvictionGovernance.AssetAmount[](2);
        b[0] = ConvictionGovernance.AssetAmount(address(usdc), 1);
        b[1] = ConvictionGovernance.AssetAmount(address(usdc), 1);
        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.DuplicateBudgetAsset.selector, address(usdc)));
        gov.proposeWithBudget(_transferUsdc(1), "x", b);

        vm.expectRevert(ConvictionGovernance.ZeroBudgetAmount.selector);
        gov.proposeWithBudget(_transferUsdc(1), "x", _budget(address(usdc), 0));
    }

    /*//////////////////////////////////////////////////////////////
                        RULE-WEAKENING PROPOSALS
    //////////////////////////////////////////////////////////////*/

    function _totalWeight() internal view returns (uint256 total) {
        (, uint256[] memory weights) = gov.listedAssets();
        for (uint256 i = 0; i < weights.length; i++) total += weights[i];
    }

    function test_Weakening_WeightCutNeedsEverything() public {
        uint256 id = gov.propose(_one(address(gov), abi.encodeCall(gov.setAssetWeight, (address(usdc), 1))), "cut");
        assertTrue(gov.weakensRules(id));
        assertEq(gov.requiredConviction(id), MIN + _totalWeight());
    }

    function test_Weakening_RaiseAndAddAreCheap() public {
        uint256 raise = gov.propose(_one(address(gov), abi.encodeCall(gov.setAssetWeight, (address(usdc), 2_000 ether))), "raise");
        uint256 add = gov.propose(_one(address(gov), abi.encodeCall(gov.addAsset, (address(stray), 1 ether))), "add");
        assertFalse(gov.weakensRules(raise));
        assertFalse(gov.weakensRules(add));
        assertEq(gov.requiredConviction(raise), MIN);
    }

    function test_Weakening_RemoveConfigTreasuryAndOwnership() public {
        assertTrue(gov.weakensRules(gov.propose(_one(address(gov), abi.encodeCall(gov.removeAsset, (address(usdc)))), "rm")));
        assertTrue(gov.weakensRules(gov.propose(_one(address(gov), abi.encodeCall(gov.setTreasury, (recipient))), "tr")));
        assertTrue(gov.weakensRules(gov.propose(_one(address(treasury), abi.encodeCall(Treasury.transferGovernance, (recipient))), "hand")));
        assertTrue(gov.weakensRules(gov.propose(_one(address(daoToken), abi.encodeWithSignature("transferOwnership(address)", recipient)), "own")));
        ConvictionGovernance.ProposalAction[] memory a = new ConvictionGovernance.ProposalAction[](1);
        a[0] = _viaTreasury(address(daoToken), 0, abi.encodeWithSignature("transferOwnership(address)", recipient));
        assertTrue(gov.weakensRules(gov.propose(a, "own via treasury")));
    }

    /*//////////////////////////////////////////////////////////////
                            EXECUTION CHECK
    //////////////////////////////////////////////////////////////*/

    function test_Execute_WithinBudget() public {
        uint256 id = gov.proposeWithBudget(_transferUsdc(10e6), "pay", _budget(address(usdc), 10e6));
        _pass(id);
        gov.executeProposal(id);
        assertEq(usdc.balanceOf(recipient), 10e6);
    }

    function test_Execute_OverBudgetReverts() public {
        uint256 id = gov.proposeWithBudget(_transferUsdc(10e6), "pay", _budget(address(usdc), 5e6));
        _pass(id);
        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.BudgetExceeded.selector, address(usdc), 5e6, 10e6));
        gov.executeProposal(id);
    }

    function test_Execute_UndeclaredListedAssetReverts() public {
        // Budget covers USDC; the action pays native.
        uint256 id = gov.proposeWithBudget(
            _one(address(treasury), abi.encodeCall(Treasury.transferETH, (payable(recipient), 1 ether))),
            "pay native",
            _budget(address(usdc), 1e6)
        );
        _pass(id);
        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.BudgetExceeded.selector, address(0), 0, 1 ether));
        gov.executeProposal(id);
    }

    function test_Execute_NoBudgetSpendingListedAssetReverts() public {
        uint256 id = gov.propose(_transferUsdc(1e6), "sneaky");
        assertEq(gov.requiredConviction(id), MIN);
        _pass(id);
        vm.expectRevert(abi.encodeWithSelector(ConvictionGovernance.BudgetExceeded.selector, address(usdc), 0, 1e6));
        gov.executeProposal(id);
    }

    function test_Execute_UnlistedAssetIsNotChecked() public {
        uint256 id = gov.propose(_one(address(treasury), abi.encodeCall(Treasury.transferERC20, (address(stray), recipient, 5 ether))), "stray");
        _pass(id);
        gov.executeProposal(id);
        assertEq(stray.balanceOf(recipient), 5 ether);
    }

    function test_Execute_SwapCountsOnlyWhatLeft() public {
        BudgetSwapper swapper = new BudgetSwapper();
        vm.deal(address(swapper), 10 ether);
        ConvictionGovernance.ProposalAction[] memory a = new ConvictionGovernance.ProposalAction[](2);
        a[0] = _viaTreasury(address(usdc), 0, abi.encodeCall(ERC20.approve, (address(swapper), 10e6)));
        a[1] = _viaTreasury(address(swapper), 0, abi.encodeCall(BudgetSwapper.swap, (address(usdc), 10e6, 2 ether)));
        uint256 id = gov.proposeWithBudget(a, "swap", _budget(address(usdc), 10e6));
        _pass(id);
        gov.executeProposal(id);
        assertEq(usdc.balanceOf(address(treasury)), 90e6);
        assertEq(address(treasury).balance, 52 ether, "native came in, never counted as spent");
    }

    function test_Execute_LeftoverErc20ApprovalIsRevoked() public {
        address spender = makeAddr("spender");
        ConvictionGovernance.ProposalAction[] memory a = new ConvictionGovernance.ProposalAction[](1);
        a[0] = _viaTreasury(address(usdc), 0, abi.encodeCall(ERC20.approve, (spender, 50e6)));
        uint256 id = gov.propose(a, "approve");
        _pass(id);
        vm.expectEmit(true, true, true, false, address(gov));
        emit ConvictionGovernance.ApprovalRevoked(id, address(usdc), spender);
        gov.executeProposal(id);
        assertEq(usdc.allowance(address(treasury), spender), 0);
    }

    function test_Execute_LeftoverPermit2ApprovalIsRevoked() public {
        BudgetPermit2 permit2 = new BudgetPermit2();
        address router = makeAddr("router");
        ConvictionGovernance.ProposalAction[] memory a = new ConvictionGovernance.ProposalAction[](2);
        a[0] = _viaTreasury(address(usdc), 0, abi.encodeCall(ERC20.approve, (address(permit2), 10e6)));
        a[1] = _viaTreasury(address(permit2), 0, abi.encodeCall(BudgetPermit2.approve, (address(usdc), router, uint160(10e6), uint48(block.timestamp + 1 days))));
        uint256 id = gov.propose(a, "permit2");
        _pass(id);
        gov.executeProposal(id);
        (uint160 amount, , ) = permit2.allowance(address(treasury), address(usdc), router);
        assertEq(amount, 0);
        assertEq(usdc.allowance(address(treasury), address(permit2)), 0);
    }
}
