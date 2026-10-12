// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/conviction/ConvictionGovernance.sol";
import "../treasury/Treasury.sol";
import "../token/GovernanceToken.sol";
import "../token/StakedGovernanceToken.sol";
import "../governance/Types.sol";
import "./DAOFactoryLib.sol";
import { Clones } from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title ConvictionDAOFactory
/// @notice Deploys and wires together a governance token, staking
///         wrapper, treasury, and ConvictionGovernance contract for a new
///         DAO. ConvictionGovernance is the one model whose continuous
///         support has no single voting moment to snapshot against, so
///         it locks committed tokens directly instead - this factory
///         additionally authorizes the new governance contract as the
///         staking wrapper's locker immediately after deployment,
///         matching the manual setAuthorizedLocker step documented on
///         StakedGovernanceToken. The factory remains
///         StakedGovernanceToken's owner after this call (ownership is
///         never transferred here, matching the original DAOFactory's
///         own behavior), so it is the only address able to make this
///         call at all - this must happen now, in the same transaction,
///         or not through this factory again.
/// @dev Clone-based - see QuadraticDAOFactory's own notes for why.
contract ConvictionDAOFactory {
    using Clones for address;

    address public immutable governanceTokenImplementation;
    address public immutable stakedGovernanceTokenImplementation;
    address public immutable treasuryImplementation;
    address public immutable convictionGovernanceImplementation;

    uint256 public daoCount;
    mapping(uint256 => DAOInfo) public daos;
    mapping(address => address[]) public creatorDAOs;

    event DAOCreated(uint256 indexed daoId, address indexed creator, address governance, address treasury, address token);

    constructor(
        address governanceTokenImplementation_,
        address stakedGovernanceTokenImplementation_,
        address treasuryImplementation_,
        address convictionGovernanceImplementation_
    ) {
        require(governanceTokenImplementation_ != address(0), "Zero implementation");
        require(stakedGovernanceTokenImplementation_ != address(0), "Zero implementation");
        require(treasuryImplementation_ != address(0), "Zero implementation");
        require(convictionGovernanceImplementation_ != address(0), "Zero implementation");

        governanceTokenImplementation = governanceTokenImplementation_;
        stakedGovernanceTokenImplementation = stakedGovernanceTokenImplementation_;
        treasuryImplementation = treasuryImplementation_;
        convictionGovernanceImplementation = convictionGovernanceImplementation_;
    }

    function createDAO(
        string calldata name,
        string calldata symbol,
        uint256 initialSupply,
        uint256 maxSupply,
        ConvictionGovernance.ConvictionGovernanceConfig calldata config
    ) external returns (address governance) {
        (GovernanceToken token, StakedGovernanceToken stakedToken, Treasury treasury) = DAOFactoryLib.deployCore(
            name,
            symbol,
            initialSupply,
            maxSupply,
            msg.sender,
            governanceTokenImplementation,
            stakedGovernanceTokenImplementation,
            treasuryImplementation
        );

        ConvictionGovernance gov = ConvictionGovernance(convictionGovernanceImplementation.clone());
        gov.initialize(name, msg.sender, address(stakedToken), address(treasury), config);
        governance = address(gov);

        treasury.transferGovernance(governance);
        token.transferOwnership(governance);
        stakedToken.setAuthorizedLocker(governance);

        _recordDAO(name, address(stakedToken), address(token), governance, address(treasury));
    }

    function _recordDAO(
        string calldata name,
        address stakedToken,
        address token,
        address governance,
        address treasury
    ) private {
        daoCount++;
        daos[daoCount] = DAOInfo(name, msg.sender, stakedToken, token, governance, treasury, block.timestamp);
        creatorDAOs[msg.sender].push(governance);
        emit DAOCreated(daoCount, msg.sender, governance, treasury, stakedToken);
    }

    function getCreatorDAOs(address creator) external view returns (address[] memory) {
        return creatorDAOs[creator];
    }
}
