// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IEntropyV2 } from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import { IEntropyConsumer } from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import { IRandomnessSource } from "./IRandomnessSource.sol";

/// @title PythEntropyRandomnessAdapter
/// @notice Wraps Pyth Entropy (v2) behind the shared IRandomnessSource
///         interface. One adapter per network serves every DAO on it.
/// @dev Entropy is push-based: `requestRandomness` asks Entropy's default
///      provider for a number, and Entropy calls `_entropyCallback` (in
///      IEntropyConsumer, which checks the caller is the Entropy contract)
///      once it's revealed - usually within seconds. No keeper settles
///      anything; a consumer only checks `isFulfilled` and reads the value.
///
///      Every request costs Entropy's fee (`requestFee()`), paid in the
///      chain's native currency. A consumer pays it with msg.value, from
///      credit it holds here, or both: whatever it sends beyond the fee is
///      credited to it for later requests, and anyone can top up a
///      consumer's credit with `fund` (e.g. a DAO's Treasury, through a
///      proposal). Credit is per consumer, so nobody can spend another's.
///      That lets a SortitionGovernance cloned before startSortition was
///      payable still draw, from credit funded in advance.
///
///      The returned value is keccak256(randomNumber, requestId), so two
///      consumers can never be handed the same number. Entropy's
///      `requestV2()` mixes in an in-contract PRNG for the user's share of
///      the randomness, which means a colluding validator and provider
///      could bias it - Pyth's documented trust model for that variant.
contract PythEntropyRandomnessAdapter is IRandomnessSource, IEntropyConsumer {
    IEntropyV2 public immutable entropy;
    /// @notice Gas Entropy allows for the callback; 0 uses the provider's default.
    uint32 public immutable callbackGasLimit;

    /// @notice Native currency each consumer has here toward future fees.
    mapping(address => uint256) public credit;

    mapping(bytes32 => bool) public requested;
    /// @notice Which consumer made each request.
    mapping(bytes32 => address) public requesterOf;
    /// @notice Entropy's sequence number for each request (per provider).
    mapping(bytes32 => uint64) public sequenceOf;
    /// @notice The provider each request went to (sequence numbers are per provider).
    mapping(bytes32 => address) public providerOf;

    mapping(bytes32 => bytes32) internal _requestIdOf; // keccak(provider, sequence) => requestId
    mapping(bytes32 => uint256) internal _randomnessOf;
    mapping(bytes32 => bool) internal _fulfilled;

    event Funded(address indexed consumer, address indexed from, uint256 amount);
    event CreditWithdrawn(address indexed consumer, uint256 amount);
    event RandomnessRequested(bytes32 indexed requestId, address indexed consumer, address provider, uint64 sequence, uint256 fee);
    event RandomnessFulfilled(bytes32 indexed requestId, uint64 sequence);

    error ZeroAddress();
    error NotEntropy();
    error AlreadyRequested();
    error InsufficientFunds(uint256 fee, uint256 available);
    error NotYetFulfilled();
    error TransferFailed();

    /// @param entropy_ Pyth's Entropy contract on this chain (docs.pyth.network/entropy/contract-addresses).
    /// @param callbackGasLimit_ Callback gas; 0 for the provider's default. Storing the number needs ~70k.
    constructor(address entropy_, uint32 callbackGasLimit_) {
        if (entropy_ == address(0)) revert ZeroAddress();
        // A wrong address fails here rather than at the first draw.
        if (IEntropyV2(entropy_).getDefaultProvider() == address(0)) revert NotEntropy();
        entropy = IEntropyV2(entropy_);
        callbackGasLimit = callbackGasLimit_;
    }

    /// @notice Native currency sent directly is credited to the sender.
    receive() external payable {
        credit[msg.sender] += msg.value;
        emit Funded(msg.sender, msg.sender, msg.value);
    }

    /// @notice Adds to `consumer`'s credit, e.g. a DAO's governance contract.
    function fund(address consumer) external payable {
        if (consumer == address(0)) revert ZeroAddress();
        credit[consumer] += msg.value;
        emit Funded(consumer, msg.sender, msg.value);
    }

    /// @notice Returns the caller's unused credit to it.
    function withdrawCredit(uint256 amount) external {
        uint256 held = credit[msg.sender];
        if (amount > held) revert InsufficientFunds(amount, held);
        credit[msg.sender] = held - amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit CreditWithdrawn(msg.sender, amount);
    }

    /// @notice The native fee one request costs right now - send at least
    ///         this (less any credit) with `requestRandomness`.
    function requestFee() public view returns (uint256) {
        return callbackGasLimit == 0 ? entropy.getFeeV2() : entropy.getFeeV2(callbackGasLimit);
    }

    /// @inheritdoc IRandomnessSource
    function requestRandomness(bytes32 requestId) external payable {
        if (requested[requestId]) revert AlreadyRequested();
        requested[requestId] = true;
        requesterOf[requestId] = msg.sender;

        uint256 fee = requestFee();
        uint256 available = credit[msg.sender] + msg.value;
        if (available < fee) revert InsufficientFunds(fee, available);
        credit[msg.sender] = available - fee;

        address provider = entropy.getDefaultProvider();
        uint64 sequence = callbackGasLimit == 0
            ? entropy.requestV2{value: fee}()
            : entropy.requestV2{value: fee}(callbackGasLimit);

        sequenceOf[requestId] = sequence;
        providerOf[requestId] = provider;
        _requestIdOf[keccak256(abi.encode(provider, sequence))] = requestId;

        emit RandomnessRequested(requestId, msg.sender, provider, sequence, fee);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    /// @dev Never reverts: an unknown or repeated callback is ignored, so
    ///      Entropy's keeper never sees a failure from this contract.
    function entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) internal override {
        bytes32 requestId = _requestIdOf[keccak256(abi.encode(provider, sequence))];
        if (!requested[requestId] || _fulfilled[requestId]) return;
        _randomnessOf[requestId] = uint256(keccak256(abi.encode(randomNumber, requestId)));
        _fulfilled[requestId] = true;
        emit RandomnessFulfilled(requestId, sequence);
    }

    /// @inheritdoc IRandomnessSource
    function isFulfilled(bytes32 requestId) external view returns (bool) {
        return _fulfilled[requestId];
    }

    /// @inheritdoc IRandomnessSource
    function getRandomness(bytes32 requestId) external view returns (uint256) {
        if (!_fulfilled[requestId]) revert NotYetFulfilled();
        return _randomnessOf[requestId];
    }
}
