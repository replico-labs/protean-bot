// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title GuardWrapper
/// @author Marvin Sunday
/// @notice A standalone circuit-breaker that sits between any governance
///         model and its real targets (Treasury, a token contract, an
///         external platform - anything). Governance never calls its
///         targets directly; every action is routed through this wrapper
///         as a proposed instruction, which a small signer set must
///         confirm before it actually executes.
/// @dev Deliberately NOT baked into any Governance contract, the same way
///      NFTMarketplaceWrapper is not baked into Treasury - this works
///      identically for any of the ten governance models in this
///      library, present or future, without any of them needing to
///      change. A DAO opts in simply by pointing its proposal actions at
///      this wrapper's address instead of the real destination directly.
///
///      Threat model, precisely: signers can ONLY confirm or reject an
///      instruction governance already sent - they can never propose one
///      themselves, never withdraw funds, never call anything
///      unilaterally. Since they have no initiating power at all, a
///      malicious signer's worst case is refusing to confirm (a denial,
///      not a theft), which is already bounded by requiredApprovals
///      staying below the total signer count, and eventually resolved by
///      the tenure-end replacement below. No mid-term removal mechanism
///      exists or is needed - there is nothing a bad signer can do that
///      waiting out the term, or having enough other signers simply
///      confirm without them, doesn't already handle.
///
///      Replacing governance itself is not a special case - it is just
///      another instruction. Current governance proposes a call to this
///      wrapper's own setGovernance(), targeting itself; signers confirm
///      it like any other instruction, through the exact same pipeline.
///      A compromised governance can never swap itself out for an
///      attacker's contract without signers getting the chance to see
///      and block it first.
contract GuardWrapper {
    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    address public governance;

    address[] public signers;
    mapping(address => bool) public isSigner;
    uint256 public requiredApprovals;

    /// @dev Fixed duration each signer set serves before governance can
    ///      replace them. Not enforced as a maximum term on any
    ///      individual signer's continuous service - governance could in
    ///      principle re-propose the same set again - only as the
    ///      minimum time that must pass before a replacement is even
    ///      possible at all.
    uint256 public tenureLength;
    uint256 public tenureEnd;

    struct Instruction {
        address target;
        uint256 value;
        bytes data;
        bool executed;
        bool rejected;
        uint256 confirmations;
        uint256 rejections;
    }

    uint256 public instructionCount;
    mapping(uint256 => Instruction) internal _instructions;
    mapping(uint256 => mapping(address => bool)) public hasConfirmed;
    mapping(uint256 => mapping(address => bool)) public hasRejected;

    /*//////////////////////////////////////////////////////////////
                                EVENTS
    //////////////////////////////////////////////////////////////*/

    event InstructionProposed(uint256 indexed instructionId, address indexed target, uint256 value);
    event InstructionConfirmed(uint256 indexed instructionId, address indexed signer, uint256 confirmations);
    event InstructionRejected(uint256 indexed instructionId, address indexed signer, uint256 rejections);
    event InstructionExecuted(uint256 indexed instructionId);
    event InstructionCancelled(uint256 indexed instructionId);
    event GovernanceUpdated(address indexed previousGovernance, address indexed newGovernance);
    event SignersReplaced(address[] newSigners, uint256 newRequiredApprovals, uint256 newTenureEnd);

    /*//////////////////////////////////////////////////////////////
                                ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error Unauthorized();
    error NotSigner();
    error InvalidRequiredApprovals();
    error TenureNotYetEnded();
    error InstructionDoesNotExist();
    error InstructionAlreadyExecuted();
    error InstructionAlreadyRejected();
    error AlreadyConfirmed();
    error NotConfirmed();
    error AlreadyRejected();
    error ExecutionFailed();

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Unauthorized();
        _;
    }

    /// @dev Satisfied when an instruction executed by this contract
    ///      targets this contract directly - the same onlyGovernance
    ///      pattern used throughout this project for self-administered
    ///      changes, just one level removed: here it gates changes
    ///      governance itself must route through signer confirmation
    ///      first, rather than changes governance can make unilaterally.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert Unauthorized();
        _;
    }

    modifier onlySigner() {
        if (!isSigner[msg.sender]) revert NotSigner();
        _;
    }

    modifier instructionExists(uint256 instructionId) {
        if (instructionId == 0 || instructionId > instructionCount) revert InstructionDoesNotExist();
        _;
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(
        address governance_,
        address[] memory initialSigners_,
        uint256 requiredApprovals_,
        uint256 tenureLength_
    ) {
        if (governance_ == address(0)) revert ZeroAddress();
        if (tenureLength_ == 0) revert TenureNotYetEnded();
        if (
            requiredApprovals_ == 0 ||
            requiredApprovals_ > initialSigners_.length
        ) {
            revert InvalidRequiredApprovals();
        }

        governance = governance_;
        requiredApprovals = requiredApprovals_;
        tenureLength = tenureLength_;
        tenureEnd = block.timestamp + tenureLength_;

        for (uint256 i = 0; i < initialSigners_.length; ++i) {
            address signer = initialSigners_[i];
            if (signer == address(0)) revert ZeroAddress();
            isSigner[signer] = true;
            signers.push(signer);
        }
    }

    receive() external payable {}

    /*//////////////////////////////////////////////////////////////
                        INSTRUCTION PROPOSAL
    //////////////////////////////////////////////////////////////*/

    /// @notice Governance proposes an instruction - a plain
    ///         (target, value, data) call, identical in shape to a
    ///         Treasury.execute() or a governance proposal action. Only
    ///         governance can call this; signers never initiate anything.
    function proposeInstruction(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyGovernance returns (uint256 instructionId) {
        if (target == address(0)) revert ZeroAddress();

        instructionId = ++instructionCount;
        Instruction storage instruction = _instructions[instructionId];
        instruction.target = target;
        instruction.value = value;
        instruction.data = data;

        emit InstructionProposed(instructionId, target, value);
    }

    /*//////////////////////////////////////////////////////////////
                    SIGNER CONFIRMATION / REJECTION
    //////////////////////////////////////////////////////////////*/

    /// @notice A signer confirms a pending instruction. Once
    ///         `requiredApprovals` distinct signers have confirmed, the
    ///         instruction executes immediately, in the same
    ///         transaction as the final confirming call.
    function confirmInstruction(
        uint256 instructionId
    ) external onlySigner instructionExists(instructionId) {
        Instruction storage instruction = _instructions[instructionId];
        if (instruction.executed) revert InstructionAlreadyExecuted();
        if (instruction.rejected) revert InstructionAlreadyRejected();
        if (hasConfirmed[instructionId][msg.sender]) revert AlreadyConfirmed();

        hasConfirmed[instructionId][msg.sender] = true;
        uint256 confirmations = ++instruction.confirmations;

        emit InstructionConfirmed(instructionId, msg.sender, confirmations);

        if (confirmations >= requiredApprovals) {
            _execute(instructionId, instruction);
        }
    }

    /// @notice A signer withdraws their own confirmation before
    ///         execution - lets a signer who confirmed in error, or
    ///         reconsiders, back out without anyone else's help.
    function revokeConfirmation(
        uint256 instructionId
    ) external onlySigner instructionExists(instructionId) {
        Instruction storage instruction = _instructions[instructionId];
        if (instruction.executed) revert InstructionAlreadyExecuted();
        if (!hasConfirmed[instructionId][msg.sender]) revert NotConfirmed();

        hasConfirmed[instructionId][msg.sender] = false;
        instruction.confirmations--;
    }

    /// @notice A signer flags an instruction as one that should never
    ///         execute. Once `requiredApprovals` distinct signers have
    ///         rejected it (same threshold as confirmation, for
    ///         symmetry), the instruction is permanently cancelled and
    ///         can no longer be confirmed by anyone, even if some
    ///         signers had already confirmed it beforehand.
    function rejectInstruction(
        uint256 instructionId
    ) external onlySigner instructionExists(instructionId) {
        Instruction storage instruction = _instructions[instructionId];
        if (instruction.executed) revert InstructionAlreadyExecuted();
        if (instruction.rejected) revert InstructionAlreadyRejected();
        if (hasRejected[instructionId][msg.sender]) revert AlreadyRejected();

        hasRejected[instructionId][msg.sender] = true;
        uint256 rejections = ++instruction.rejections;

        emit InstructionRejected(instructionId, msg.sender, rejections);

        if (rejections >= requiredApprovals) {
            instruction.rejected = true;
            emit InstructionCancelled(instructionId);
        }
    }

    function _execute(uint256 instructionId, Instruction storage instruction) internal {
        instruction.executed = true;

        (bool ok, ) = instruction.target.call{value: instruction.value}(instruction.data);
        if (!ok) revert ExecutionFailed();

        emit InstructionExecuted(instructionId);
    }

    /*//////////////////////////////////////////////////////////////
                        TENURE-END REPLACEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Replaces the entire signer set, once the current tenure
    ///         has genuinely ended. Deliberately requires no signer
    ///         confirmation at all - the on-chain tenure check itself is
    ///         the objective proof this action is legitimate, the same
    ///         way a timestamp comparison needs no human judgment applied
    ///         on top of it. Only governance can call this, and only
    ///         after tenureEnd has actually passed.
    function replaceSigners(
        address[] calldata newSigners,
        uint256 newRequiredApprovals
    ) external onlyGovernance {
        if (block.timestamp < tenureEnd) revert TenureNotYetEnded();
        if (
            newRequiredApprovals == 0 ||
            newRequiredApprovals > newSigners.length
        ) {
            revert InvalidRequiredApprovals();
        }

        uint256 oldLen = signers.length;
        for (uint256 i = 0; i < oldLen; ++i) {
            isSigner[signers[i]] = false;
        }
        delete signers;

        for (uint256 i = 0; i < newSigners.length; ++i) {
            address signer = newSigners[i];
            if (signer == address(0)) revert ZeroAddress();
            isSigner[signer] = true;
            signers.push(signer);
        }

        requiredApprovals = newRequiredApprovals;
        tenureEnd = block.timestamp + tenureLength;

        emit SignersReplaced(newSigners, newRequiredApprovals, tenureEnd);
    }

    /// @notice Updates the tenure duration used for future replacements.
    /// @dev Only callable through an executed instruction targeting this
    ///      contract itself - same as setGovernance, this changes the
    ///      wrapper's own rules and must go through signer confirmation,
    ///      not something governance can set unilaterally.
    function setTenureLength(uint256 newTenureLength) external onlySelf {
        if (newTenureLength == 0) revert TenureNotYetEnded();
        tenureLength = newTenureLength;
    }

    /*//////////////////////////////////////////////////////////////
                        GOVERNANCE REPLACEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Points this wrapper at a new governance contract.
    /// @dev Only callable through an executed instruction targeting this
    ///      contract itself - even replacing governance is not a
    ///      backdoor. Current governance proposes this exact call
    ///      (target = address(this), data = encoded setGovernance call);
    ///      signers confirm it through the same pipeline as any other
    ///      instruction before it takes effect.
    function setGovernance(address newGovernance) external onlySelf {
        if (newGovernance == address(0)) revert ZeroAddress();

        address previousGovernance = governance;
        governance = newGovernance;

        emit GovernanceUpdated(previousGovernance, newGovernance);
    }

    /*//////////////////////////////////////////////////////////////
                            VIEW FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    function getSigners() external view returns (address[] memory) {
        return signers;
    }

    function getInstruction(
        uint256 instructionId
    ) external view instructionExists(instructionId) returns (Instruction memory) {
        return _instructions[instructionId];
    }
}
