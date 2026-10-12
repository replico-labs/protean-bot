// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @title NFTMarketplaceWrapper
/// @author Marvin Sunday
/// @notice A governance-controlled EIP-1271 signer, letting a DAO's
///         Treasury participate in marketplaces (OpenSea/Seaport) that
///         require the offerer to be able to validate signatures -
///         something Treasury deliberately does NOT implement itself,
///         to keep Treasury's own trust model minimal and marketplace-
///         agnostic. One deployed per DAO, same pattern as
///         ChainlinkPriceFeedAdapter - not shared across DAOs, since
///         (unlike a price adapter) this one holds real assets.
/// @dev NFT CUSTODY: this wrapper, not Treasury, is where a DAO's NFTs
///      live. Treasury has no ERC721/ERC1155 receiver hooks, so every
///      safeTransferFrom into it reverts (and every ERC1155 transfer is a
///      safe one). Rather than widen Treasury, NFTs are sent here and
///      stay here - listed, sold or handed out from here - and only
///      money (native currency, ERC20) is swept back to Treasury.
///      transferERC721/transferERC1155 refuse Treasury as a recipient.
/// @dev SCOPE NOTE: `isValidSignature` implements the standard
///      "approved-hash" EIP-1271 pattern used by Gnosis Safe and other
///      smart-contract wallets - it does not verify a cryptographic
///      signature at all, since this contract has no private key.
///      Governance pre-approves a specific order hash via
///      `approveOrderHash`, and `isValidSignature` simply checks
///      whether the hash being asked about was pre-approved. The
///      actual Seaport order-hash computation (turning "list this NFT
///      for this price" into the specific bytes32 Seaport expects) is
///      NOT done on-chain here - it happens off-chain, using Seaport's
///      own real order-hashing logic, and the resulting hash is what
///      gets passed to `approveOrderHash`. This keeps this contract
///      simple and marketplace-agnostic: it never needs to know any
///      specific marketplace's order struct layout.
contract NFTMarketplaceWrapper {
    address public governance;
    address public treasury;

    /// @dev EIP-1271 magic value returned for a valid signature.
    bytes4 internal constant MAGICVALUE = 0x1626ba7e;

    mapping(bytes32 => bool) public approvedOrderHashes;

    event OrderHashApproved(bytes32 indexed orderHash);
    event OrderHashRevoked(bytes32 indexed orderHash);
    event ERC721Transferred(address indexed token, uint256 indexed tokenId, address indexed to);
    event ERC1155Transferred(address indexed token, uint256 indexed tokenId, uint256 amount, address indexed to);
    event NativeSwept(uint256 amount, address indexed to);
    event ERC20Swept(address indexed token, uint256 amount, address indexed to);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    error ZeroAddress();
    error Unauthorized();
    error TransferFailed();
    error TreasuryCannotHoldNFTs();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    constructor(address governance_, address treasury_) {
        if (governance_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        governance = governance_;
        treasury = treasury_;
    }

    receive() external payable {}

    /// @notice Approves a specific order hash - governance's way of
    ///         saying "yes, list under these exact terms." The hash
    ///         itself is computed off-chain from the actual listing
    ///         terms (NFT, price, expiration, etc.) - this contract
    ///         never needs to understand those terms directly, only
    ///         the resulting hash.
    function approveOrderHash(bytes32 orderHash) external onlyGovernance {
        approvedOrderHashes[orderHash] = true;
        emit OrderHashApproved(orderHash);
    }

    /// @notice Revokes a previously approved hash - e.g. to cancel a
    ///         listing before it's filled.
    function revokeOrderHash(bytes32 orderHash) external onlyGovernance {
        approvedOrderHashes[orderHash] = false;
        emit OrderHashRevoked(orderHash);
    }

    /// @notice EIP-1271 - lets external contracts (Seaport) verify that
    ///         a given order hash was genuinely authorized by this
    ///         contract. `signature` is intentionally unused - this
    ///         contract has no private key to check a real signature
    ///         against; approval is tracked by hash instead.
    function isValidSignature(bytes32 hash, bytes memory) external view returns (bytes4) {
        return approvedOrderHashes[hash] ? MAGICVALUE : bytes4(0);
    }

    /// @notice Generic escape hatch, mirroring Treasury's own execute()
    ///         - lets governance make this wrapper interact with
    ///         whatever a specific marketplace actually requires
    ///         (token approvals, fulfillment calls, etc.) without this
    ///         contract needing to know that marketplace's interface
    ///         ahead of time.
    function execute(address target, uint256 value, bytes calldata data) external onlyGovernance returns (bytes memory) {
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) revert TransferFailed();
        return result;
    }

    /// @notice Lets governance update which Treasury this wrapper sweeps
    ///         assets back to - mirrors Governance's own setTreasury(),
    ///         so this wrapper stays correct if the DAO's treasury ever
    ///         changes.
    function setTreasury(address newTreasury) external onlyGovernance {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Sends an ERC721 this wrapper holds to `to` - e.g. a
    ///         member reward or an off-marketplace sale. Never to
    ///         Treasury: NFTs stay in this wrapper (see contract notes).
    ///         safeTransferFrom, so a contract recipient that can't hold
    ///         NFTs makes this revert instead of locking the token.
    function transferERC721(address token, address to, uint256 tokenId) external onlyGovernance {
        if (to == address(0)) revert ZeroAddress();
        if (to == treasury) revert TreasuryCannotHoldNFTs();
        IERC721(token).safeTransferFrom(address(this), to, tokenId);
        emit ERC721Transferred(token, tokenId, to);
    }

    /// @notice Sends ERC1155 tokens this wrapper holds to `to`. Never to Treasury.
    function transferERC1155(address token, address to, uint256 tokenId, uint256 amount) external onlyGovernance {
        if (to == address(0)) revert ZeroAddress();
        if (to == treasury) revert TreasuryCannotHoldNFTs();
        IERC1155(token).safeTransferFrom(address(this), to, tokenId, amount, "");
        emit ERC1155Transferred(token, tokenId, amount, to);
    }

    /// @notice Sweeps native currency proceeds (e.g. from a filled sale) back to Treasury.
    function sweepNative(uint256 amount) external onlyGovernance {
        (bool ok, ) = payable(treasury).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit NativeSwept(amount, treasury);
    }

    /// @notice Sweeps ERC20 proceeds back to Treasury.
    function sweepERC20(address token, uint256 amount) external onlyGovernance {
        bool ok = IERC20(token).transfer(treasury, amount);
        if (!ok) revert TransferFailed();
        emit ERC20Swept(token, amount, treasury);
    }

    /// @dev Required so this contract can legally hold ERC721 tokens via safeTransferFrom.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @dev Required so this contract can legally hold ERC1155 tokens via safeTransferFrom.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC1155BatchReceived.selector;
    }
}
