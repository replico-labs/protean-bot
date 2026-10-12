// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20VotesUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title GovernanceToken
/// @notice Clone-compatible version of the original GovernanceToken -
///         converted from constructor-based initialization to
///         initialize(), so factories can deploy cheap EIP-1167 clones
///         of one canonical implementation instead of embedding this
///         contract's full creation bytecode in every factory (the
///         root cause of every factory in this system exceeding
///         Ethereum's 24,576-byte contract size limit).
///
///         IMPORTANT, easy to get wrong: `maxSupply` was `immutable` in
///         the original constructor-based version. Immutables are baked
///         directly into the IMPLEMENTATION contract's own bytecode at
///         deploy time - a clone never runs the implementation's
///         constructor, so every clone reading an immutable would
///         silently get whatever value the implementation itself has
///         (here, zero, since the implementation is never meaningfully
///         constructed with real values), not its own per-clone value.
///         Moved to regular storage, set inside initialize(), instead.
contract GovernanceToken is Initializable, ERC20VotesUpgradeable, ERC20PermitUpgradeable, OwnableUpgradeable {
    uint256 public maxSupply;

    /// @dev Locks initializers on the implementation contract itself -
    ///      standard OpenZeppelin upgradeable-contracts practice, so
    ///      nobody can call initialize() directly on the implementation
    ///      (only on clones, which get their own independent storage).
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_,
        uint256 maxSupply_,
        address initialSupplyRecipient_,
        address initialOwner_
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC20Votes_init();
        __Ownable_init(initialOwner_);

        require(initialSupplyRecipient_ != address(0), "Zero recipient");
        require(initialOwner_ != address(0), "Zero owner");
        require(initialSupply_ <= maxSupply_, "Invalid supply");
        maxSupply = maxSupply_;
        _mint(initialSupplyRecipient_, initialSupply_);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        require(totalSupply() + amount <= maxSupply, "Max supply exceeded");
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20VotesUpgradeable)
    {
        super._update(from, to, value);
    }

    function nonces(address owner)
        public
        view
        override(ERC20PermitUpgradeable, NoncesUpgradeable)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
