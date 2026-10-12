// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title BoardGovernance
/// @author Marvin Sunday
/// @notice A board/multisig governance model: a fixed set of designated
///         signers directly propose, confirm, and execute DAO actions.
///         Requires M-of-N signer confirmations - no voting token of any
///         kind is involved.
/// @dev Drops into the same trusted-`governance` slot on Treasury as every
///      other governance implementation in this system - Treasury only
///      ever checks "is the caller my registered governance address?", so
///      this is a genuine swap-in alternative. Unlike every other model
///      built so far, this one has zero token dependency: governance power
///      here is identity-based (are you a designated signer?), not
///      capital-based. A DAO can start with this model (a small trusted
///      founding team) and later switch to a token-weighted or delegate
///      model without its Treasury ever moving.
contract BoardGovernance is Initializable {
    /*//////////////////////////////////////////////////////////////
                                TYPES
    //////////////////////////////////////////////////////////////*/

    enum ProposalState {
        Active, // open for confirmations, not yet queued
        Queued,
        Executed,
        Cancelled,
        Expired
    }

    struct ProposalAction {
        address target;
        uint256 value;
        bytes data;
    }

    struct Proposal {
        uint256 id;
        ProposalAction[] actions;
        address proposer;
        string metadataURI;
        uint256 createdAt;
        uint16 confirmations;
        uint256 queuedAt;
        bool executed;
        bool cancelled;
    }

    struct BoardGovernanceConfig {
        uint16 requiredApprovals; // M
        uint32 timelockDelay; // seconds
        uint32 executionPeriod; // seconds
    }

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error InvalidConfiguration();
    error NotSigner();
    error AlreadySigner();
    error SignerCountBelowThreshold();
    error EmptyProposalActions();
    error EmptyMetadataURI();
    error InvalidProposalAction();
    error ProposalNotFound();
    error AlreadyConfirmed();
    error NotConfirmed();
    error ProposalAlreadyExecuted();
    error ProposalAlreadyCancelled();
    error ProposalAlreadyQueued();
    error ThresholdNotMet();
    error ProposalNotExecutable();
    error ProposalExpired();
    error ExecutionFailed();
    error InvalidValue();
    error Unauthorized();

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event ProposalCreated(uint256 indexed proposalId, address indexed proposer, string metadataURI);
    event Confirmed(uint256 indexed proposalId, address indexed signer, uint16 totalConfirmations);
    event ConfirmationRevoked(uint256 indexed proposalId, address indexed signer, uint16 totalConfirmations);
    event ProposalQueued(uint256 indexed proposalId, uint256 executeAfter);
    event ProposalUnqueued(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId, address indexed caller);
    event ProposalExecuted(uint256 indexed proposalId, address indexed executor);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);
    event RequiredApprovalsUpdated(uint16 previousValue, uint16 newValue);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    /*//////////////////////////////////////////////////////////////
                                STATE
    //////////////////////////////////////////////////////////////*/

    string public daoName;
    address public creator;
    address public treasury;
    BoardGovernanceConfig internal _config;

    address[] public signers;
    mapping(address => bool) public isSigner;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasConfirmed;

    /*//////////////////////////////////////////////////////////////
                            MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    modifier onlyGovernance() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    modifier proposalExists(uint256 proposalId) {
        if (proposalId == 0 || proposalId > proposalCount) revert ProposalNotFound();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                            CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    /*//////////////////////////////////////////////////////////////
                            INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory daoName_,
        address creator_,
        address treasury_,
        BoardGovernanceConfig memory config_,
        address[] memory initialSigners_
    ) external initializer {
        if (creator_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (initialSigners_.length == 0) revert InvalidConfiguration();
        _validateConfig(config_, initialSigners_.length);

        daoName = daoName_;
        creator = creator_;
        treasury = treasury_;
        _config = config_;

        for (uint256 i = 0; i < initialSigners_.length; i++) {
            address signer = initialSigners_[i];
            if (signer == address(0)) revert ZeroAddress();
            if (isSigner[signer]) revert AlreadySigner();
            isSigner[signer] = true;
            signers.push(signer);
        }
    }

    /*//////////////////////////////////////////////////////////////
                        PROPOSAL LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Proposes a transaction. The proposer's confirmation counts
    ///         immediately, matching the standard multisig UX (you don't
    ///         propose something you don't already support).
    function proposeTransaction(
        ProposalAction[] calldata actions,
        string calldata metadataURI
    ) external onlySigner returns (uint256 proposalId) {
        if (actions.length == 0) revert EmptyProposalActions();
        for (uint256 i = 0; i < actions.length; i++) {
            if (actions[i].target == address(0)) revert InvalidProposalAction();
        }
        if (bytes(metadataURI).length == 0) revert EmptyMetadataURI();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.id = proposalId;
        p.proposer = msg.sender;
        p.metadataURI = metadataURI;
        p.createdAt = block.timestamp;

        for (uint256 i = 0; i < actions.length; i++) {
            p.actions.push(actions[i]);
        }

        emit ProposalCreated(proposalId, msg.sender, metadataURI);

        _confirm(proposalId, msg.sender);
    }

    /// @notice Adds the caller's confirmation. Auto-queues the proposal
    ///         once confirmations reach the required threshold.
    function confirmTransaction(uint256 proposalId) external onlySigner proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (hasConfirmed[proposalId][msg.sender]) revert AlreadyConfirmed();

        _confirm(proposalId, msg.sender);
    }

    function _confirm(uint256 proposalId, address signer) internal {
        Proposal storage p = _proposals[proposalId];
        hasConfirmed[proposalId][signer] = true;
        p.confirmations += 1;

        emit Confirmed(proposalId, signer, p.confirmations);

        if (p.queuedAt == 0 && p.confirmations >= _config.requiredApprovals) {
            p.queuedAt = block.timestamp;
            emit ProposalQueued(proposalId, block.timestamp + _config.timelockDelay);
        }
    }

    /// @notice Revokes the caller's confirmation. If this drops the
    ///         proposal below the required threshold after it was already
    ///         queued, it's un-queued - a proposal that's lost its majority
    ///         cannot coast to execution on a timelock that started when it
    ///         still had one.
    function revokeConfirmation(uint256 proposalId) external onlySigner proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (!hasConfirmed[proposalId][msg.sender]) revert NotConfirmed();

        hasConfirmed[proposalId][msg.sender] = false;
        p.confirmations -= 1;

        emit ConfirmationRevoked(proposalId, msg.sender, p.confirmations);

        if (p.queuedAt != 0 && p.confirmations < _config.requiredApprovals) {
            p.queuedAt = 0;
            emit ProposalUnqueued(proposalId);
        }
    }

    function cancelProposal(uint256 proposalId) external proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (msg.sender != p.proposer && msg.sender != address(this)) revert Unauthorized();

        p.cancelled = true;
        emit ProposalCancelled(proposalId, msg.sender);
    }

    /// @notice Executes a queued proposal once its timelock has elapsed
    ///         and before its execution window expires. Callable by anyone
    ///         once those conditions hold - not restricted to signers.
    function executeTransaction(uint256 proposalId) external payable proposalExists(proposalId) {
        Proposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted();
        if (p.cancelled) revert ProposalAlreadyCancelled();
        if (p.queuedAt == 0) revert ProposalNotExecutable();
        if (p.confirmations < _config.requiredApprovals) revert ThresholdNotMet();
        if (block.timestamp < p.queuedAt + _config.timelockDelay) revert ProposalNotExecutable();
        if (block.timestamp > p.queuedAt + _config.timelockDelay + _config.executionPeriod) {
            revert ProposalExpired();
        }

        uint256 totalValue;
        uint256 len = p.actions.length;
        for (uint256 i = 0; i < len; i++) totalValue += p.actions[i].value;
        if (msg.value != totalValue) revert InvalidValue();

        p.executed = true;

        for (uint256 i = 0; i < len; i++) {
            ProposalAction storage action = p.actions[i];
            (bool ok, ) = action.target.call{value: action.value}(action.data);
            if (!ok) revert ExecutionFailed();
        }

        emit ProposalExecuted(proposalId, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                    GOVERNANCE-ONLY ADMIN (self-call)
    //////////////////////////////////////////////////////////////*/

    function addSigner(address newSigner) external onlyGovernance {
        if (newSigner == address(0)) revert ZeroAddress();
        if (isSigner[newSigner]) revert AlreadySigner();

        isSigner[newSigner] = true;
        signers.push(newSigner);

        emit SignerAdded(newSigner);
    }

    /// @notice Removes a signer. Reverts if this would drop the signer
    ///         count below the current approval threshold - the board
    ///         cannot vote itself into an unreachable quorum.
    function removeSigner(address signer) external onlyGovernance {
        if (!isSigner[signer]) revert NotSigner();
        if (signers.length - 1 < _config.requiredApprovals) revert SignerCountBelowThreshold();

        isSigner[signer] = false;
        uint256 len = signers.length;
        for (uint256 i = 0; i < len; i++) {
            if (signers[i] == signer) {
                signers[i] = signers[len - 1];
                signers.pop();
                break;
            }
        }

        emit SignerRemoved(signer);
    }

    function setRequiredApprovals(uint16 newRequiredApprovals) external onlyGovernance {
        if (newRequiredApprovals == 0 || newRequiredApprovals > signers.length) revert InvalidConfiguration();
        emit RequiredApprovalsUpdated(_config.requiredApprovals, newRequiredApprovals);
        _config.requiredApprovals = newRequiredApprovals;
    }

    function setTreasury(address newTreasury) external onlyGovernance {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function config() external view returns (BoardGovernanceConfig memory) {
        return _config;
    }

    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    function getProposal(uint256 proposalId) external view proposalExists(proposalId) returns (Proposal memory) {
        return _proposals[proposalId];
    }

    function state(uint256 proposalId) public view proposalExists(proposalId) returns (ProposalState) {
        Proposal storage p = _proposals[proposalId];

        if (p.cancelled) return ProposalState.Cancelled;
        if (p.executed) return ProposalState.Executed;

        if (p.queuedAt != 0 && p.confirmations >= _config.requiredApprovals) {
            if (block.timestamp > p.queuedAt + _config.timelockDelay + _config.executionPeriod) {
                return ProposalState.Expired;
            }
            return ProposalState.Queued;
        }

        return ProposalState.Active;
    }

    function executableAfter(uint256 proposalId) external view proposalExists(proposalId) returns (uint256) {
        Proposal storage p = _proposals[proposalId];
        if (p.queuedAt == 0) return 0;
        return p.queuedAt + _config.timelockDelay;
    }

    /*//////////////////////////////////////////////////////////////
                        INTERNAL VALIDATION
    //////////////////////////////////////////////////////////////*/

    function _validateConfig(BoardGovernanceConfig memory c, uint256 signerCount) internal pure {
        if (c.requiredApprovals == 0 || c.requiredApprovals > signerCount) revert InvalidConfiguration();
    }
}
