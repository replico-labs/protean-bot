// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Types.sol";

abstract contract GovernanceStorage {
    string public daoName;
    address public creator;

    GovernanceConfig internal _config;

    address public governanceToken;
    address public treasury;

    uint256 internal _proposalCount;

    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => VoteReceipt)) internal _voteReceipts;

    modifier proposalExists(uint256 proposalId) {
        require(proposalId > 0 && proposalId <= _proposalCount, "Proposal does not exist");
        _;
    }

    function proposalCount() public view returns (uint256) {
        return _proposalCount;
    }

    function governanceConfig() public view returns (GovernanceConfig memory) {
        return _config;
    }

    function getProposal(uint256 proposalId)
        public
        view
        proposalExists(proposalId)
        returns (Proposal memory)
    {
        return _proposals[proposalId];
    }

    function getVoteReceipt(uint256 proposalId, address voter)
        public
        view
        proposalExists(proposalId)
        returns (VoteReceipt memory)
    {
        return _voteReceipts[proposalId][voter];
    }
}
