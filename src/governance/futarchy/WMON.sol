// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WMON
/// @author Marvin Sunday
/// @notice Wrapped native MON - deposit native currency, get back an
///         equivalent ERC20 balance; burn that balance, get native
///         currency back. The same canonical pattern as WETH9, which has
///         secured value across the EVM ecosystem essentially unchanged
///         since 2015.
/// @dev This exists purely so DecisionMarketPair - built entirely around
///      IERC20.balanceOf/transfer - can hold and trade the DAO's chosen
///      quote asset without needing any native-currency-specific code
///      inside the pair contract itself. The wrapping happens here, at
///      the edge; the audited AMM core stays untouched.
contract WMON {
    string public constant name = "Wrapped MON";
    string public constant symbol = "WMON";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    error InsufficientBalance();
    error InsufficientAllowance();
    error NativeTransferFailed();

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;

        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();

        emit Withdrawal(msg.sender, amount);
        emit Transfer(msg.sender, address(0), amount);
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
