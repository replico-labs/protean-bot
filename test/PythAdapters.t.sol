// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {PythEntropyRandomnessAdapter} from "../src/randomness/PythEntropyRandomnessAdapter.sol";
import {PythPriceFeedAdapter} from "../src/oracles/PythPriceFeedAdapter.sol";

/// @dev Entropy stand-in that charges a fee (Pyth's MockEntropy charges
///      none) and lets a test reveal a number, calling the consumer back
///      the way Entropy's keeper does.
contract FeeEntropy {
    address public provider = address(0xBEEF);
    uint128 public fee = 0.01 ether;
    uint64 public nextSequence = 1;
    mapping(uint64 => address) public requester;
    uint32 public lastGasLimit;

    function setFee(uint128 fee_) external {
        fee = fee_;
    }

    function getDefaultProvider() external view returns (address) {
        return provider;
    }

    function getFeeV2() external view returns (uint128) {
        return fee;
    }

    function getFeeV2(uint32) external view returns (uint128) {
        return fee + 1;
    }

    function requestV2() external payable returns (uint64 seq) {
        require(msg.value >= fee, "fee");
        seq = nextSequence++;
        requester[seq] = msg.sender;
    }

    function requestV2(uint32 gasLimit) external payable returns (uint64 seq) {
        require(msg.value >= fee + 1, "fee");
        lastGasLimit = gasLimit;
        seq = nextSequence++;
        requester[seq] = msg.sender;
    }

    function reveal(uint64 seq, bytes32 randomNumber) external {
        IEntropyConsumer(requester[seq])._entropyCallback(seq, provider, randomNumber);
    }

    function revealAs(address consumer, uint64 seq, address provider_, bytes32 randomNumber) external {
        IEntropyConsumer(consumer)._entropyCallback(seq, provider_, randomNumber);
    }
}

contract PythEntropyRandomnessAdapterTest is Test {
    FeeEntropy internal entropy;
    PythEntropyRandomnessAdapter internal adapter;
    address internal dao = makeAddr("dao");
    address internal other = makeAddr("other");

    function setUp() public {
        entropy = new FeeEntropy();
        adapter = new PythEntropyRandomnessAdapter(address(entropy), 0);
        vm.deal(dao, 10 ether);
        vm.deal(other, 10 ether);
    }

    function test_Constructor_RejectsZeroAndNonEntropy() public {
        vm.expectRevert(PythEntropyRandomnessAdapter.ZeroAddress.selector);
        new PythEntropyRandomnessAdapter(address(0), 0);
        vm.expectRevert();
        new PythEntropyRandomnessAdapter(makeAddr("eoa"), 0);
    }

    function test_Request_PaysFee_ThenCallbackFulfills() public {
        vm.prank(dao);
        adapter.requestRandomness{value: 0.01 ether}("r1");
        assertEq(address(entropy).balance, 0.01 ether);
        assertFalse(adapter.isFulfilled("r1"));
        vm.expectRevert(PythEntropyRandomnessAdapter.NotYetFulfilled.selector);
        adapter.getRandomness("r1");

        entropy.reveal(adapter.sequenceOf("r1"), bytes32(uint256(42)));
        assertTrue(adapter.isFulfilled("r1"));
        // Mixed with the request ID so no two consumers share a number.
        assertEq(adapter.getRandomness("r1"), uint256(keccak256(abi.encode(bytes32(uint256(42)), bytes32("r1")))));
    }

    function test_Request_RevertsWithoutEnoughFunds() public {
        vm.prank(dao);
        vm.expectRevert(abi.encodeWithSelector(PythEntropyRandomnessAdapter.InsufficientFunds.selector, 0.01 ether, 0.005 ether));
        adapter.requestRandomness{value: 0.005 ether}("r1");
    }

    function test_Excess_BecomesCredit_UsedForNextRequest() public {
        vm.prank(dao);
        adapter.requestRandomness{value: 0.025 ether}("r1");
        assertEq(adapter.credit(dao), 0.015 ether);
        vm.prank(dao);
        adapter.requestRandomness("r2"); // nothing sent: paid from credit
        assertEq(adapter.credit(dao), 0.005 ether);
    }

    function test_Fund_IsOnlySpendableByThatConsumer() public {
        vm.prank(other);
        adapter.fund{value: 0.05 ether}(dao);
        assertEq(adapter.credit(dao), 0.05 ether);

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(PythEntropyRandomnessAdapter.InsufficientFunds.selector, 0.01 ether, 0));
        adapter.requestRandomness("stolen");

        vm.prank(dao);
        adapter.requestRandomness("r1");
        assertEq(adapter.credit(dao), 0.04 ether);
    }

    function test_WithdrawCredit() public {
        vm.prank(dao);
        adapter.fund{value: 1 ether}(dao);
        uint256 before = dao.balance;
        vm.prank(dao);
        adapter.withdrawCredit(0.4 ether);
        assertEq(dao.balance, before + 0.4 ether);
        assertEq(adapter.credit(dao), 0.6 ether);
        vm.prank(dao);
        vm.expectRevert(abi.encodeWithSelector(PythEntropyRandomnessAdapter.InsufficientFunds.selector, 1 ether, 0.6 ether));
        adapter.withdrawCredit(1 ether);
    }

    function test_DuplicateRequestId_Reverts() public {
        vm.prank(dao);
        adapter.requestRandomness{value: 0.01 ether}("r1");
        vm.prank(dao);
        vm.expectRevert(PythEntropyRandomnessAdapter.AlreadyRequested.selector);
        adapter.requestRandomness{value: 0.01 ether}("r1");
    }

    function test_Callback_OnlyFromEntropy() public {
        vm.prank(dao);
        adapter.requestRandomness{value: 0.01 ether}("r1");
        uint64 seq = adapter.sequenceOf("r1");
        address provider = entropy.provider();
        vm.expectRevert("Only Entropy can call this function");
        adapter._entropyCallback(seq, provider, bytes32(uint256(1)));
    }

    function test_Callback_UnknownOrRepeated_IsIgnoredNotReverted() public {
        vm.prank(dao);
        adapter.requestRandomness{value: 0.01 ether}("r1");
        uint64 seq = adapter.sequenceOf("r1");
        // Same sequence from a different provider: a different request entirely.
        entropy.revealAs(address(adapter), seq, address(0xCAFE), bytes32(uint256(7)));
        assertFalse(adapter.isFulfilled("r1"));

        entropy.reveal(seq, bytes32(uint256(1)));
        uint256 first = adapter.getRandomness("r1");
        entropy.reveal(seq, bytes32(uint256(2))); // a repeat can't change it
        assertEq(adapter.getRandomness("r1"), first);
    }

    function test_CustomCallbackGasLimit_UsesThatFee() public {
        PythEntropyRandomnessAdapter custom = new PythEntropyRandomnessAdapter(address(entropy), 150_000);
        assertEq(custom.requestFee(), 0.01 ether + 1);
        vm.prank(dao);
        custom.requestRandomness{value: 0.01 ether + 1}("r1");
        assertEq(entropy.lastGasLimit(), 150_000);
    }
}

contract PythPriceFeedAdapterTest is Test {
    MockPyth internal pyth;
    PythPriceFeedAdapter internal adapter;
    bytes32 internal constant ETH_USD = keccak256("ETH/USD");

    function setUp() public {
        pyth = new MockPyth(60, 1 wei);
        adapter = new PythPriceFeedAdapter(address(pyth));
    }

    function _post(bytes32 id, int64 price, int32 expo, uint64 publishTime) internal {
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.createPriceFeedUpdateData(id, price, 10, expo, price, 10, publishTime, publishTime - 1);
        pyth.updatePriceFeeds{value: pyth.getUpdateFee(updates)}(updates);
    }

    function test_Constructor_RejectsZeroAndNonPyth() public {
        vm.expectRevert(PythPriceFeedAdapter.ZeroAddress.selector);
        new PythPriceFeedAdapter(address(0));
        vm.expectRevert(PythPriceFeedAdapter.NotPyth.selector);
        new PythPriceFeedAdapter(makeAddr("eoa"));
    }

    function test_LatestValue_Is18DecimalsWithPublishTime() public {
        vm.warp(1_000_000);
        _post(ETH_USD, 250_050_000_000, -8, 999_990); // $2,500.50 at expo -8
        (int256 value, uint256 updatedAt) = adapter.latestValue(ETH_USD);
        assertEq(value, 2_500.5e18);
        assertEq(updatedAt, 999_990);
    }

    function test_LatestValue_NegativeAndPositiveExponents() public {
        assertEq(adapter.toDecimals18(-1_234, -2), -12.34e18);
        assertEq(adapter.toDecimals18(5, 3), 5_000e18);
        assertEq(adapter.toDecimals18(123_456_789, -20), 1_234_567); // finer than 18 decimals rounds toward zero
        vm.expectRevert(abi.encodeWithSelector(PythPriceFeedAdapter.UnsupportedExponent.selector, int32(-80)));
        adapter.toDecimals18(1, -80);
    }

    function test_LatestValue_UnknownFeedReverts() public {
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        adapter.latestValue(keccak256("nope"));
    }
}
