// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {NFTMarketplaceWrapper} from "../src/marketplace/NFTMarketplaceWrapper.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Treasury} from "../src/treasury/Treasury.sol";

/// @dev Minimal real ERC721 for testing - not a mock of behavior, an
///      actual OZ ERC721 instance, so safeTransferFrom's real receiver-
///      callback check genuinely exercises the wrapper's own
///      onERC721Received.
contract TestERC721 is ERC721 {
    constructor() ERC721("Test NFT", "TNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}

contract TestERC1155 is ERC1155 {
    constructor() ERC1155("") {}

    function mint(address to, uint256 id, uint256 amount) external {
        _mint(to, id, amount, "");
    }
}

contract TestERC20 is ERC20 {
    constructor() ERC20("Test Token", "TT") {
        _mint(msg.sender, 1_000_000 ether);
    }
}

contract NFTMarketplaceWrapperTest is Test {
    // Several tests mint ERC1155 tokens to this test contract itself
    // before transferring them onward to the wrapper (to set up a
    // realistic pre-existing balance) - OZ's ERC1155._mint performs a
    // receiver-callback check on every mint, unlike ERC721 (where only
    // _safeMint does), so this contract needs to implement the
    // callback itself for those setup steps to succeed at all. This
    // is scaffolding for the test contract, not related to the
    // wrapper's own onERC1155Received, which is exercised separately
    // by the actual safeTransferFrom calls in each test body.
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
    NFTMarketplaceWrapper internal wrapper;
    TestERC721 internal nft721;
    TestERC1155 internal nft1155;
    TestERC20 internal token20;

    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        wrapper = new NFTMarketplaceWrapper(governance, treasury);
        nft721 = new TestERC721();
        nft1155 = new TestERC1155();
        token20 = new TestERC20();
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    function test_Constructor_SetsFields() public view {
        assertEq(wrapper.governance(), governance);
        assertEq(wrapper.treasury(), treasury);
    }

    function test_Constructor_RevertsOnZeroGovernance() public {
        vm.expectRevert(NFTMarketplaceWrapper.ZeroAddress.selector);
        new NFTMarketplaceWrapper(address(0), treasury);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(NFTMarketplaceWrapper.ZeroAddress.selector);
        new NFTMarketplaceWrapper(governance, address(0));
    }

    /*//////////////////////////////////////////////////////////////
                    EIP-1271 / ORDER HASH APPROVAL
    //////////////////////////////////////////////////////////////*/

    function test_ApproveOrderHash_MakesIsValidSignatureReturnMagicValue() public {
        bytes32 orderHash = keccak256("some seaport order");

        vm.prank(governance);
        wrapper.approveOrderHash(orderHash);

        assertTrue(wrapper.approvedOrderHashes(orderHash));
        assertEq(wrapper.isValidSignature(orderHash, ""), bytes4(0x1626ba7e));
    }

    function test_IsValidSignature_ReturnsZeroForUnapprovedHash() public view {
        bytes32 orderHash = keccak256("never approved");
        assertEq(wrapper.isValidSignature(orderHash, ""), bytes4(0));
    }

    function test_RevokeOrderHash_MakesIsValidSignatureReturnZeroAgain() public {
        bytes32 orderHash = keccak256("some seaport order");

        vm.prank(governance);
        wrapper.approveOrderHash(orderHash);
        assertEq(wrapper.isValidSignature(orderHash, ""), bytes4(0x1626ba7e));

        vm.prank(governance);
        wrapper.revokeOrderHash(orderHash);
        assertEq(wrapper.isValidSignature(orderHash, ""), bytes4(0));
    }

    function test_ApproveOrderHash_RevertsForNonGovernance() public {
        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.approveOrderHash(keccak256("x"));
    }

    function test_RevokeOrderHash_RevertsForNonGovernance() public {
        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.revokeOrderHash(keccak256("x"));
    }

    /*//////////////////////////////////////////////////////////////
                        RECEIVING NFTS (real transfers)
    //////////////////////////////////////////////////////////////*/

    function test_CanReceiveERC721_ViaRealSafeTransferFrom() public {
        nft721.mint(address(this), 1);
        nft721.safeTransferFrom(address(this), address(wrapper), 1);
        assertEq(nft721.ownerOf(1), address(wrapper));
    }

    function test_CanReceiveERC1155_ViaRealSafeTransferFrom() public {
        nft1155.mint(address(this), 1, 10);
        nft1155.safeTransferFrom(address(this), address(wrapper), 1, 10, "");
        assertEq(nft1155.balanceOf(address(wrapper), 1), 10);
    }

    /*//////////////////////////////////////////////////////////////
                    SENDING NFTS (never to Treasury)
    //////////////////////////////////////////////////////////////*/

    address internal member = makeAddr("member");

    function test_TransferERC721_SendsToRecipient() public {
        nft721.mint(address(wrapper), 1);

        vm.prank(governance);
        wrapper.transferERC721(address(nft721), member, 1);

        assertEq(nft721.ownerOf(1), member);
    }

    function test_TransferERC721_RevertsToTreasury() public {
        nft721.mint(address(wrapper), 1);

        vm.prank(governance);
        vm.expectRevert(NFTMarketplaceWrapper.TreasuryCannotHoldNFTs.selector);
        wrapper.transferERC721(address(nft721), treasury, 1);
    }

    function test_TransferERC721_RevertsToZeroAddress() public {
        nft721.mint(address(wrapper), 1);

        vm.prank(governance);
        vm.expectRevert(NFTMarketplaceWrapper.ZeroAddress.selector);
        wrapper.transferERC721(address(nft721), address(0), 1);
    }

    /// @dev safeTransferFrom protects the NFT: a contract that can't hold
    ///      NFTs (here an ERC20) makes the transfer revert, not lock it.
    function test_TransferERC721_RevertsToContractThatCannotHoldNFTs() public {
        nft721.mint(address(wrapper), 1);

        vm.prank(governance);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(token20)));
        wrapper.transferERC721(address(nft721), address(token20), 1);

        assertEq(nft721.ownerOf(1), address(wrapper));
    }

    function test_TransferERC721_RevertsForNonGovernance() public {
        nft721.mint(address(wrapper), 1);

        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.transferERC721(address(nft721), attacker, 1);
    }

    function test_TransferERC1155_SendsToRecipient() public {
        nft1155.mint(address(this), 1, 10);
        nft1155.safeTransferFrom(address(this), address(wrapper), 1, 10, "");

        vm.prank(governance);
        wrapper.transferERC1155(address(nft1155), member, 1, 4);

        assertEq(nft1155.balanceOf(member, 1), 4);
        assertEq(nft1155.balanceOf(address(wrapper), 1), 6);
    }

    function test_TransferERC1155_RevertsToTreasury() public {
        nft1155.mint(address(this), 1, 10);
        nft1155.safeTransferFrom(address(this), address(wrapper), 1, 10, "");

        vm.prank(governance);
        vm.expectRevert(NFTMarketplaceWrapper.TreasuryCannotHoldNFTs.selector);
        wrapper.transferERC1155(address(nft1155), treasury, 1, 10);
    }

    function test_TransferERC1155_RevertsForNonGovernance() public {
        nft1155.mint(address(this), 1, 10);
        nft1155.safeTransferFrom(address(this), address(wrapper), 1, 10, "");

        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.transferERC1155(address(nft1155), attacker, 1, 10);
    }

    /*//////////////////////////////////////////////////////////////
                    SWEEPING MONEY BACK TO TREASURY
    //////////////////////////////////////////////////////////////*/

    function test_SweepNative_SendsToTreasury() public {
        vm.deal(address(wrapper), 1 ether);

        vm.prank(governance);
        wrapper.sweepNative(1 ether);

        assertEq(treasury.balance, 1 ether);
        assertEq(address(wrapper).balance, 0);
    }

    function test_SweepNative_RevertsForNonGovernance() public {
        vm.deal(address(wrapper), 1 ether);

        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.sweepNative(1 ether);
    }

    function test_SweepERC20_SendsToTreasury() public {
        token20.transfer(address(wrapper), 100 ether);

        vm.prank(governance);
        wrapper.sweepERC20(address(token20), 100 ether);

        assertEq(token20.balanceOf(treasury), 100 ether);
    }

    function test_SweepERC20_RevertsForNonGovernance() public {
        token20.transfer(address(wrapper), 100 ether);

        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.sweepERC20(address(token20), 100 ether);
    }

    /*//////////////////////////////////////////////////////////////
                                EXECUTE
    //////////////////////////////////////////////////////////////*/

    function test_Execute_ForwardsCallCorrectly() public {
        // Use execute() to have the wrapper itself mint... no, execute
        // is a generic call - exercise it against a real target: have
        // the wrapper approve nft721's operator via execute(), then
        // confirm the approval genuinely landed.
        nft721.mint(address(wrapper), 5);

        bytes memory data = abi.encodeWithSignature("setApprovalForAll(address,bool)", attacker, true);

        vm.prank(governance);
        wrapper.execute(address(nft721), 0, data);

        assertTrue(nft721.isApprovedForAll(address(wrapper), attacker));
    }

    function test_Execute_RevertsForNonGovernance() public {
        bytes memory data = abi.encodeWithSignature("setApprovalForAll(address,bool)", attacker, true);

        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.execute(address(nft721), 0, data);
    }

    function test_Execute_RevertsOnFailedCall() public {
        // Calling a nonexistent function selector on a real contract fails.
        bytes memory badData = abi.encodeWithSignature("thisFunctionDoesNotExist()");

        vm.prank(governance);
        vm.expectRevert(NFTMarketplaceWrapper.TransferFailed.selector);
        wrapper.execute(address(nft721), 0, badData);
    }

    /*//////////////////////////////////////////////////////////////
                            SET TREASURY
    //////////////////////////////////////////////////////////////*/

    function test_SetTreasury_UpdatesTreasury() public {
        address newTreasury = makeAddr("newTreasury");

        vm.prank(governance);
        wrapper.setTreasury(newTreasury);

        assertEq(wrapper.treasury(), newTreasury);
    }

    function test_SetTreasury_RevertsOnZeroAddress() public {
        vm.prank(governance);
        vm.expectRevert(NFTMarketplaceWrapper.ZeroAddress.selector);
        wrapper.setTreasury(address(0));
    }

    function test_SetTreasury_RevertsForNonGovernance() public {
        vm.prank(attacker);
        vm.expectRevert(NFTMarketplaceWrapper.Unauthorized.selector);
        wrapper.setTreasury(makeAddr("newTreasury"));
    }

    function test_SetTreasury_SweepsGoToUpdatedTreasuryAfterChange() public {
        address newTreasury = makeAddr("newTreasury");

        vm.prank(governance);
        wrapper.setTreasury(newTreasury);

        vm.deal(address(wrapper), 1 ether);
        vm.prank(governance);
        wrapper.sweepNative(1 ether);

        assertEq(newTreasury.balance, 1 ether);
        assertEq(treasury.balance, 0);
    }

    /*//////////////////////////////////////////////////////////////
            REAL TREASURY - the money path works end to end
    //////////////////////////////////////////////////////////////*/

    /// @dev The tests above use a plain address as treasury; these use a
    ///      real Treasury clone, as the factories deploy it.
    function _realTreasuryWrapper() internal returns (NFTMarketplaceWrapper w, Treasury t) {
        t = Treasury(payable(Clones.clone(address(new Treasury()))));
        t.initialize(governance);
        w = new NFTMarketplaceWrapper(governance, address(t));
    }

    function test_RealTreasury_SweepNativeArrives() public {
        (NFTMarketplaceWrapper w, Treasury t) = _realTreasuryWrapper();
        vm.deal(address(w), 1 ether);

        vm.prank(governance);
        w.sweepNative(1 ether);

        assertEq(address(t).balance, 1 ether);
    }

    function test_RealTreasury_SweepERC20Arrives() public {
        (NFTMarketplaceWrapper w, Treasury t) = _realTreasuryWrapper();
        token20.transfer(address(w), 100 ether);

        vm.prank(governance);
        w.sweepERC20(address(token20), 100 ether);

        assertEq(token20.balanceOf(address(t)), 100 ether);
    }

    /// @dev Why NFTs never go to Treasury: it has no receiver hooks.
    function test_RealTreasury_CannotReceiveNFTsViaSafeTransfer() public {
        (, Treasury t) = _realTreasuryWrapper();
        nft721.mint(address(this), 1);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(t)));
        nft721.safeTransferFrom(address(this), address(t), 1);
    }

    function test_RealTreasury_TransferERC721ToItIsRefused() public {
        (NFTMarketplaceWrapper w, Treasury t) = _realTreasuryWrapper();
        nft721.mint(address(w), 1);

        vm.prank(governance);
        vm.expectRevert(NFTMarketplaceWrapper.TreasuryCannotHoldNFTs.selector);
        w.transferERC721(address(nft721), address(t), 1);
    }
}
