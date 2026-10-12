// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../governance/Types.sol";

/// @title IDAOFactory
/// @notice Interface for the DAO deployment factory.
interface IDAOFactory {
    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event DAOCreated(
        uint256 indexed daoId,
        address indexed creator,
        address governance,
        address treasury,
        address token
    );

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns the total number of DAOs deployed by this factory.
    function daoCount() external view returns (uint256);

    /// @notice Returns the recorded info for a deployed DAO.
    /// @dev Matches the tuple shape Solidity auto-generates for a public
    ///      mapping of a struct with no nested mapping/array members.
    function daos(
        uint256 daoId
    )
        external
        view
        returns (
            string memory name,
            address daoCreator,
            address governanceToken,
            address underlyingToken,
            address governance,
            address treasury,
            uint256 createdAt
        );

    /// @notice Returns the list of DAO governance addresses created by a given creator.
    function getCreatorDAOs(
        address creator
    ) external view returns (address[] memory);

    /*//////////////////////////////////////////////////////////////
                            DEPLOYMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Deploys a new DAO (governance token, treasury and governance
    ///         contract) and wires them together.
    /// @return governance The address of the newly deployed Governance contract.
    function createDAO(
        string calldata name,
        string calldata symbol,
        uint256 initialSupply,
        uint256 maxSupply,
        GovernanceConfig calldata config
    ) external returns (address governance);
}
