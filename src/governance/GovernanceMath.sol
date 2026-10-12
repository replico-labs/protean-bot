// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./Types.sol";
import "./GovernanceErrors.sol";

/// @title GovernanceMath
/// @author Marvin Sunday
/// @notice Mathematical helper library for governance calculations.
/// @dev Contains only deterministic calculations. No storage is accessed.
library GovernanceMath {

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice 100% expressed in basis points.
    uint16 internal constant MAX_BPS = 10_000;

    /*//////////////////////////////////////////////////////////////
                            CONFIG VALIDATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Validates governance configuration.
    function validateConfig(
        GovernanceConfig memory config
    ) internal pure {

        if (config.quorumBps == 0)
            revert InvalidQuorum();

        if (config.quorumBps > MAX_BPS)
            revert InvalidQuorum();

        if (config.approvalThresholdBps == 0)
            revert InvalidApprovalThreshold();

        if (config.approvalThresholdBps > MAX_BPS)
            revert InvalidApprovalThreshold();

        if (config.votingDelay == 0)
            revert InvalidVotingDelay();

        if (config.votingPeriod == 0)
            revert InvalidVotingPeriod();

        if (
            config.approvalThresholdBps >
            MAX_BPS
        )
            revert InvalidApprovalThreshold();
    }

    /*//////////////////////////////////////////////////////////////
                        BASIS POINT UTILITIES
    //////////////////////////////////////////////////////////////*/

    /// @notice Converts a percentage in basis points to an amount.
    function percentageOf(
        uint256 amount,
        uint16 bps
    )
        internal
        pure
        returns (uint256)
    {
        return (amount * bps) / MAX_BPS;
    }

    /// @notice Calculates a basis point percentage.
    function calculateBps(
        uint256 numerator,
        uint256 denominator
    )
        internal
        pure
        returns (uint256)
    {
        if (denominator == 0) {
            return 0;
        }

        return
            (numerator * MAX_BPS) /
            denominator;
    }

    /*//////////////////////////////////////////////////////////////
                            QUORUM
    //////////////////////////////////////////////////////////////*/

    /// @notice Calculates the number of votes
    /// required to reach quorum.
    function quorumVotes(
        uint256 totalSupply,
        uint16 quorumBps
    )
        internal
        pure
        returns (uint256)
    {
        return
            percentageOf(
                totalSupply,
                quorumBps
            );
    }

    /// @notice Returns true if quorum has been met.
    function hasQuorum(
        uint256 participationVotes,
        uint256 totalSupply,
        uint16 quorumBps
    )
        internal
        pure
        returns (bool)
    {
        return
            participationVotes >=
            quorumVotes(
                totalSupply,
                quorumBps
            );
    }

    /*//////////////////////////////////////////////////////////////
                        PARTICIPATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns total participating votes.
    function participation(
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes
    )
        internal
        pure
        returns (uint256)
    {
        return
            forVotes +
            againstVotes +
            abstainVotes;
    }

    /// @notice Returns participation from a proposal.
    function participation(
        Proposal memory proposal
    )
        internal
        pure
        returns (uint256)
    {
        return
            participation(
                proposal.forVotes,
                proposal.againstVotes,
                proposal.abstainVotes
            );
    }

    /*//////////////////////////////////////////////////////////////
                        APPROVAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns approval percentage in basis points.
    ///
    /// Formula:
    ///
    /// FOR
    /// -------------------
    /// FOR + AGAINST
    ///
    /// Abstain votes count
    /// toward quorum but not approval.
    function approvalPercentage(
        uint256 forVotes,
        uint256 againstVotes
    )
        internal
        pure
        returns (uint256)
    {
        uint256 countedVotes =
            forVotes +
            againstVotes;

        if (countedVotes == 0) {
            return 0;
        }

        return
            calculateBps(
                forVotes,
                countedVotes
            );
    }

    /// @notice Returns approval percentage for a proposal.
    function approvalPercentage(
        Proposal memory proposal
    )
        internal
        pure
        returns (uint256)
    {
        return
            approvalPercentage(
                proposal.forVotes,
                proposal.againstVotes
            );
    }

    /// @notice Returns true if approval threshold is met.
    function hasApproval(
        uint256 forVotes,
        uint256 againstVotes,
        uint16 thresholdBps
    )
        internal
        pure
        returns (bool)
    {
        return
            approvalPercentage(
                forVotes,
                againstVotes
            )
            >=
            thresholdBps;
    }

    /// @notice Returns true if proposal meets approval threshold.
    function hasApproval(
        Proposal memory proposal,
        GovernanceConfig memory config
    )
        internal
        pure
        returns (bool)
    {
        return
            hasApproval(
                proposal.forVotes,
                proposal.againstVotes,
                config.approvalThresholdBps
            );
    }

        /*//////////////////////////////////////////////////////////////
                        PROPOSAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Returns true if quorum and approval threshold are met.
    function proposalPassed(
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 totalSupply,
        GovernanceConfig memory config
    )
        internal
        pure
        returns (bool)
    {
        uint256 totalParticipation = participation(
            forVotes,
            againstVotes,
            abstainVotes
        );

        return
            hasQuorum(
                totalParticipation,
                totalSupply,
                config.quorumBps
            ) &&
            hasApproval(
                forVotes,
                againstVotes,
                config.approvalThresholdBps
            );
    }

    /// @notice Returns the number of additional votes
    /// required to reach quorum.
    function quorumVotesRemaining(
        uint256 participationVotes,
        uint256 totalSupply,
        uint16 quorumBps
    )
        internal
        pure
        returns (uint256)
    {
        uint256 required = quorumVotes(
            totalSupply,
            quorumBps
        );

        if (participationVotes >= required) {
            return 0;
        }

        return required - participationVotes;
    }

    /// @notice Returns additional FOR votes needed
    /// to satisfy the approval threshold.
    function approvalVotesRemaining(
        uint256 forVotes,
        uint256 againstVotes,
        uint16 thresholdBps
    )
        internal
        pure
        returns (uint256)
    {
        if (
            hasApproval(
                forVotes,
                againstVotes,
                thresholdBps
            )
        ) {
            return 0;
        }

        uint256 totalVotes =
            forVotes + againstVotes;

        if (totalVotes == 0) {
            return 1;
        }

        uint256 requiredFor =
            (totalVotes * thresholdBps + MAX_BPS - 1)
            / MAX_BPS;

        if (requiredFor <= forVotes) {
            return 0;
        }

        return requiredFor - forVotes;
    }

    /// @notice Returns true if there are no counted votes.
    function isEmptyVote(
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes
    )
        internal
        pure
        returns (bool)
    {
        return
            participation(
                forVotes,
                againstVotes,
                abstainVotes
            ) == 0;
    }

    /// @notice Returns total decisive votes.
    /// Abstain votes are excluded.
    function decisiveVotes(
        uint256 forVotes,
        uint256 againstVotes
    )
        internal
        pure
        returns (uint256)
    {
        return forVotes + againstVotes;
    }

    /// @notice Returns true if FOR votes are greater than AGAINST votes.
    function hasMajority(
        uint256 forVotes,
        uint256 againstVotes
    )
        internal
        pure
        returns (bool)
    {
        return forVotes > againstVotes;
    }
}