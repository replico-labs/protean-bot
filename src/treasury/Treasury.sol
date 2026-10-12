// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./../interfaces/ITreasury.sol";

/// @dev Clone-compatible version - converted from constructor-based
///      initialization to initialize(), same reasoning as
///      GovernanceToken.sol/StakedGovernanceToken.sol: every factory in
///      this system was embedding this contract's full creation bytecode
///      via `new Treasury(...)`, a major contributor to every factory
///      exceeding Ethereum's 24,576-byte contract size limit. No
///      immutable-to-storage concern here - `governance` was always
///      regular storage, not immutable, so this conversion is otherwise
///      a direct, faithful port of the original constructor's logic.
contract Treasury is Initializable, ITreasury {
    address public override governance;

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    /// @dev Locks initializers on the implementation contract itself -
    ///      standard OpenZeppelin upgradeable-contracts practice, so
    ///      nobody can call initialize() directly on the implementation
    ///      (only on clones, which get their own independent storage).
    constructor() {
        _disableInitializers();
    }

    function initialize(address governance_) external initializer {
        if (governance_ == address(0)) revert ZeroAddress();
        governance = governance_;
    }

    receive() external payable {
        emit ETHReceived(msg.sender, msg.value);
    }

    function ethBalance() external view override returns (uint256) {
        return address(this).balance;
    }

    function tokenBalance(address token) external view override returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function transferETH(address payable recipient,uint256 amount)
        external
        override
        onlyGovernance
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (address(this).balance < amount) revert InsufficientBalance();

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit ETHTransferred(recipient, amount);
    }

    function transferERC20(address token,address recipient,uint256 amount)
        external
        override
        onlyGovernance
    {
        if (recipient == address(0) || token == address(0)) revert ZeroAddress();
        bool ok = IERC20(token).transfer(recipient, amount);
        if (!ok) revert TransferFailed();

        emit ERC20Transferred(token, recipient, amount);
    }

    function execute(address target,uint256 value,bytes calldata data)
        external
        override
        onlyGovernance
        returns (bytes memory)
    {
        if (target == address(0)) revert ZeroAddress();
        (bool ok, bytes memory result)=target.call{value:value}(data);
        if(!ok) revert TransferFailed();
        return result;
    }

    function transferGovernance(address newGovernance)
        external
        override
        onlyGovernance
    {
        if(newGovernance==address(0)) revert ZeroAddress();
        address old=governance;
        governance=newGovernance;
        emit OwnershipTransferred(old,newGovernance);
    }
}
