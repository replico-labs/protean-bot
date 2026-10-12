// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ConditionalToken
/// @author Marvin Sunday
/// @notice A minimal, cloneable ERC20 representing one outcome (pass or
///         fail) of a proposal's conditional decision market. Minted and
///         burned only by the ConditionalVault that owns it - splitting,
///         merging, and redemption are the only ways supply ever changes.
/// @dev Hand-rolled rather than built on OpenZeppelin's Upgradeable
///      package, deliberately - a plain ERC20 is simple enough to verify
///      correct by inspection, and this avoids pulling in a second,
///      separate OZ package (openzeppelin-contracts-upgradeable) just for
///      one small token. Deployed via EIP-1167 minimal proxy clones (see
///      OpenZeppelin's Clones.sol, already available in the standard,
///      non-upgradeable package), with `initialize()` substituting for a
///      constructor since every clone shares one implementation's code
///      and can't run per-clone constructor logic.
contract ConditionalToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public vault;
    bool private _initialized;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error AlreadyInitialized();
    error OnlyVault();
    error InsufficientBalance();
    error InsufficientAllowance();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    /// @notice Called exactly once, immediately after cloning.
    function initialize(string calldata name_, string calldata symbol_, address vault_) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        name = name_;
        symbol = symbol_;
        vault = vault_;
    }

    function mint(address to, uint256 amount) external onlyVault {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
