import { encodeFunctionData, getAddress, parseEther } from "viem";

/**
 * Every entry here is already fully verified - real ABI fragments,
 * computed directly against actual contract source, matching
 * docs/proposal-instructions-reference.md exactly. External platform
 * actions (Uniswap, Aave, etc.) are deliberately NOT here yet - each
 * needs its own individual verification (real deployed addresses, real
 * interface, checked for non-obvious architecture like Uniswap V4's
 * callback requirement) before it's safe to add. An unverified entry
 * with a "verified" badge is worse than no entry at all.
 *
 * targetKind tells the encoder which address to resolve for a given
 * DAO: "governance" and "treasury" are looked up per-DAO (they differ
 * for every DAO); "fixedAddress" means the caller supplies the address
 * directly (used for wrappers and tokens, which aren't always known to
 * the calling context ahead of time).
 */
export const ACTION_LIBRARY = [
  /*//////////////////////////////////////////////////////////////
                    SHARED - MOST TOKEN-BASED MODELS
  //////////////////////////////////////////////////////////////*/
  {
    id: "set-governance-token",
    label: "Point governance at a new voting token",
    appliesTo: ["tokenWeighted", "quadratic", "liquid", "optimistic", "conviction", "delegate", "sortition", "sowellian", "decisionMarkets"],
    targetKind: "governance",
    functionName: "setGovernanceToken",
    abi: [{ type: "function", name: "setGovernanceToken", stateMutability: "nonpayable", inputs: [{ name: "newToken", type: "address" }], outputs: [] }],
    params: [{ name: "newToken", type: "address" }],
  },
  {
    id: "set-treasury",
    label: "Point governance at a new treasury",
    appliesTo: ["tokenWeighted", "quadratic", "liquid", "optimistic", "conviction", "delegate", "sortition", "sowellian", "decisionMarkets", "board"],
    targetKind: "governance",
    functionName: "setTreasury",
    abi: [{ type: "function", name: "setTreasury", stateMutability: "nonpayable", inputs: [{ name: "newTreasury", type: "address" }], outputs: [] }],
    params: [{ name: "newTreasury", type: "address" }],
  },

  /*//////////////////////////////////////////////////////////////
                    PER-MODEL CONFIG UPDATE
  //////////////////////////////////////////////////////////////*/
  {
    id: "update-config-tokenweighted",
    label: "Update governance config (tokenWeighted)",
    appliesTo: ["tokenWeighted"],
    targetKind: "governance",
    functionName: "updateGovernanceConfig",
    abi: [{
      type: "function", name: "updateGovernanceConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "quorumBps", type: "uint16" }, { name: "approvalThresholdBps", type: "uint16" },
        { name: "votingDelay", type: "uint32" }, { name: "votingPeriod", type: "uint32" },
        { name: "timelockDelay", type: "uint32" }, { name: "executionPeriod", type: "uint32" },
        { name: "proposalThreshold", type: "uint256" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["quorumBps", "approvalThresholdBps", "votingDelay", "votingPeriod", "timelockDelay", "executionPeriod", "proposalThreshold"] }],
  },
  {
    id: "update-config-liquid",
    label: "Update governance config (Liquid)",
    appliesTo: ["liquid"],
    targetKind: "governance",
    functionName: "updateGovernanceConfig",
    abi: [{
      type: "function", name: "updateGovernanceConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "quorumBps", type: "uint16" }, { name: "approvalThresholdBps", type: "uint16" },
        { name: "votingDelay", type: "uint32" }, { name: "votingPeriod", type: "uint32" },
        { name: "timelockDelay", type: "uint32" }, { name: "executionPeriod", type: "uint32" },
        { name: "proposalThreshold", type: "uint256" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["quorumBps", "approvalThresholdBps", "votingDelay", "votingPeriod", "timelockDelay", "executionPeriod", "proposalThreshold"] }],
  },
  {
    id: "update-config-quadratic",
    label: "Update governance config (Quadratic)",
    appliesTo: ["quadratic"],
    targetKind: "governance",
    functionName: "updateGovernanceConfig",
    abi: [{
      type: "function", name: "updateGovernanceConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "quorumBps", type: "uint16" }, { name: "approvalThresholdBps", type: "uint16" },
        { name: "votingDelay", type: "uint32" }, { name: "votingPeriod", type: "uint32" },
        { name: "timelockDelay", type: "uint32" }, { name: "executionPeriod", type: "uint32" },
        { name: "proposalThreshold", type: "uint256" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["quorumBps", "approvalThresholdBps", "votingDelay", "votingPeriod", "timelockDelay", "executionPeriod", "proposalThreshold"] }],
  },
  {
    id: "update-config-conviction",
    label: "Update governance config (Conviction)",
    appliesTo: ["conviction"],
    targetKind: "governance",
    functionName: "updateGovernanceConfig",
    abi: [{
      type: "function", name: "updateGovernanceConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "convictionGrowthRate", type: "uint256" }, { name: "minThresholdConviction", type: "uint256" },
        { name: "thresholdMultiplier", type: "uint256" }, { name: "proposalThreshold", type: "uint256" },
        { name: "timelockDelay", type: "uint32" }, { name: "executionPeriod", type: "uint32" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["convictionGrowthRate", "minThresholdConviction", "thresholdMultiplier", "proposalThreshold", "timelockDelay", "executionPeriod"] }],
  },
  {
    id: "update-config-optimistic",
    label: "Update governance config (Optimistic)",
    appliesTo: ["optimistic"],
    targetKind: "governance",
    functionName: "updateGovernanceConfig",
    abi: [{
      type: "function", name: "updateGovernanceConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "challengePeriod", type: "uint32" }, { name: "challengeBond", type: "uint256" },
        { name: "quorumBps", type: "uint16" }, { name: "approvalThresholdBps", type: "uint16" },
        { name: "votingPeriod", type: "uint32" }, { name: "timelockDelay", type: "uint32" },
        { name: "executionPeriod", type: "uint32" }, { name: "proposalThreshold", type: "uint256" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["challengePeriod", "challengeBond", "quorumBps", "approvalThresholdBps", "votingPeriod", "timelockDelay", "executionPeriod", "proposalThreshold"] }],
  },
  {
    id: "update-config-delegate",
    label: "Update governance config (Delegate)",
    appliesTo: ["delegate"],
    targetKind: "governance",
    functionName: "updateConfig",
    abi: [{
      type: "function", name: "updateConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "councilSize", type: "uint16" }, { name: "termLength", type: "uint32" },
        { name: "candidacyThreshold", type: "uint256" }, { name: "candidacyPeriod", type: "uint32" },
        { name: "electionVotingPeriod", type: "uint32" }, { name: "councilQuorum", type: "uint16" },
        { name: "councilApprovalThresholdBps", type: "uint16" }, { name: "votingDelay", type: "uint32" },
        { name: "votingPeriod", type: "uint32" }, { name: "timelockDelay", type: "uint32" },
        { name: "executionPeriod", type: "uint32" }, { name: "recallQuorumBps", type: "uint16" },
        { name: "recallApprovalThresholdBps", type: "uint16" }, { name: "recallVotingPeriod", type: "uint32" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["councilSize", "termLength", "candidacyThreshold", "candidacyPeriod", "electionVotingPeriod", "councilQuorum", "councilApprovalThresholdBps", "votingDelay", "votingPeriod", "timelockDelay", "executionPeriod", "recallQuorumBps", "recallApprovalThresholdBps", "recallVotingPeriod"] }],
  },
  {
    id: "update-config-sortition",
    label: "Update governance config (Sortition)",
    appliesTo: ["sortition"],
    targetKind: "governance",
    functionName: "updateConfig",
    abi: [{
      type: "function", name: "updateConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "councilSize", type: "uint16" }, { name: "termLength", type: "uint32" },
        { name: "eligibilityThreshold", type: "uint256" }, { name: "councilQuorum", type: "uint16" },
        { name: "councilApprovalThresholdBps", type: "uint16" }, { name: "votingDelay", type: "uint32" },
        { name: "votingPeriod", type: "uint32" }, { name: "timelockDelay", type: "uint32" },
        { name: "executionPeriod", type: "uint32" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["councilSize", "termLength", "eligibilityThreshold", "councilQuorum", "councilApprovalThresholdBps", "votingDelay", "votingPeriod", "timelockDelay", "executionPeriod"] }],
  },
  {
    id: "update-config-sowellian",
    label: "Update governance config (Sowellian)",
    appliesTo: ["sowellian"],
    targetKind: "governance",
    functionName: "updateConfig",
    abi: [{
      type: "function", name: "updateConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "proposalBondAmount", type: "uint256" }, { name: "approvalVotingDelay", type: "uint32" },
        { name: "approvalVotingPeriod", type: "uint32" }, { name: "approvalQuorumBps", type: "uint16" },
        { name: "approvalThresholdBps", type: "uint16" }, { name: "positionsWindow", type: "uint32" },
        { name: "executionTimelockDelay", type: "uint32" }, { name: "resolutionBondAmount", type: "uint256" },
        { name: "challengePeriod", type: "uint32" }, { name: "challengeBondAmount", type: "uint256" },
        { name: "adjudicationVotingPeriod", type: "uint32" }, { name: "adjudicationQuorumBps", type: "uint16" },
        { name: "adjudicationThresholdBps", type: "uint16" }, { name: "maxOracleStaleness", type: "uint32" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["proposalBondAmount", "approvalVotingDelay", "approvalVotingPeriod", "approvalQuorumBps", "approvalThresholdBps", "positionsWindow", "executionTimelockDelay", "resolutionBondAmount", "challengePeriod", "challengeBondAmount", "adjudicationVotingPeriod", "adjudicationQuorumBps", "adjudicationThresholdBps", "maxOracleStaleness"] }],
  },
  {
    id: "update-config-decisionmarkets",
    label: "Update governance config (DecisionMarkets)",
    appliesTo: ["decisionMarkets"],
    targetKind: "governance",
    functionName: "updateConfig",
    abi: [{
      type: "function", name: "updateConfig", stateMutability: "nonpayable", outputs: [],
      inputs: [{ name: "newConfig", type: "tuple", components: [
        { name: "tradingPeriod", type: "uint32" }, { name: "thresholdBps", type: "uint16" },
        { name: "timelockDelay", type: "uint32" }, { name: "executionPeriod", type: "uint32" },
      ]}],
    }],
    params: [{ name: "newConfig", type: "tuple", fields: ["tradingPeriod", "thresholdBps", "timelockDelay", "executionPeriod"] }],
  },

  /*//////////////////////////////////////////////////////////////
                        BOARD-SPECIFIC
  //////////////////////////////////////////////////////////////*/
  {
    id: "board-add-signer",
    label: "Add a Board signer",
    appliesTo: ["board"],
    targetKind: "governance",
    functionName: "addSigner",
    abi: [{ type: "function", name: "addSigner", stateMutability: "nonpayable", inputs: [{ name: "newSigner", type: "address" }], outputs: [] }],
    params: [{ name: "newSigner", type: "address" }],
  },
  {
    id: "board-remove-signer",
    label: "Remove a Board signer",
    appliesTo: ["board"],
    targetKind: "governance",
    functionName: "removeSigner",
    abi: [{ type: "function", name: "removeSigner", stateMutability: "nonpayable", inputs: [{ name: "signer", type: "address" }], outputs: [] }],
    params: [{ name: "signer", type: "address" }],
  },
  {
    id: "board-set-required-approvals",
    label: "Set Board's required approval count",
    appliesTo: ["board"],
    targetKind: "governance",
    functionName: "setRequiredApprovals",
    abi: [{ type: "function", name: "setRequiredApprovals", stateMutability: "nonpayable", inputs: [{ name: "newRequiredApprovals", type: "uint16" }], outputs: [] }],
    params: [{ name: "newRequiredApprovals", type: "uint16" }],
  },

  /*//////////////////////////////////////////////////////////////
                        SORTITION-SPECIFIC
  //////////////////////////////////////////////////////////////*/
  {
    id: "sortition-set-randomness-source",
    label: "Set Sortition's randomness source",
    appliesTo: ["sortition"],
    targetKind: "governance",
    functionName: "setRandomnessSource",
    abi: [{ type: "function", name: "setRandomnessSource", stateMutability: "nonpayable", inputs: [{ name: "newSource", type: "address" }], outputs: [] }],
    params: [{ name: "newSource", type: "address" }],
  },

  /*//////////////////////////////////////////////////////////////
                            TREASURY
  //////////////////////////////////////////////////////////////*/
  {
    id: "treasury-transfer-eth",
    label: "Send native MON from Treasury",
    appliesTo: "treasury",
    targetKind: "treasury",
    functionName: "transferETH",
    abi: [{ type: "function", name: "transferETH", stateMutability: "nonpayable", inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
    params: [{ name: "recipient", type: "address" }, { name: "amountWhole", type: "uint256", scaled: true }],
  },
  {
    id: "treasury-transfer-erc20",
    label: "Send an ERC20 token from Treasury",
    appliesTo: "treasury",
    targetKind: "treasury",
    functionName: "transferERC20",
    abi: [{ type: "function", name: "transferERC20", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
    params: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amountWhole", type: "uint256", scaled: true }],
  },
  {
    id: "treasury-execute",
    label: "Generic Treasury call (any target, any calldata)",
    appliesTo: "treasury",
    targetKind: "treasury",
    functionName: "execute",
    abi: [{ type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] }],
    params: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
  },
  {
    id: "treasury-transfer-governance",
    label: "Hand Treasury control to a new governance address",
    appliesTo: "treasury",
    targetKind: "treasury",
    functionName: "transferGovernance",
    abi: [{ type: "function", name: "transferGovernance", stateMutability: "nonpayable", inputs: [{ name: "newGovernance", type: "address" }], outputs: [] }],
    params: [{ name: "newGovernance", type: "address" }],
  },

  /*//////////////////////////////////////////////////////////////
                            TOKENS
  //////////////////////////////////////////////////////////////*/
  {
    id: "token-mint",
    label: "Mint new governance tokens",
    appliesTo: "token",
    targetKind: "fixedAddress",
    functionName: "mint",
    abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
    params: [{ name: "tokenAddress", type: "address", isTarget: true }, { name: "to", type: "address" }, { name: "amountWhole", type: "uint256", scaled: true }],
  },
  {
    id: "token-transfer-ownership",
    label: "Transfer token ownership (mint rights)",
    appliesTo: "token",
    targetKind: "fixedAddress",
    functionName: "transferOwnership",
    abi: [{ type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] }],
    params: [{ name: "tokenAddress", type: "address", isTarget: true }, { name: "newOwner", type: "address" }],
  },
  {
    id: "staked-token-set-authorized-locker",
    label: "Set the staking wrapper's authorized locker",
    appliesTo: "token",
    targetKind: "fixedAddress",
    functionName: "setAuthorizedLocker",
    abi: [{ type: "function", name: "setAuthorizedLocker", stateMutability: "nonpayable", inputs: [{ name: "locker", type: "address" }], outputs: [] }],
    params: [{ name: "stakingTokenAddress", type: "address", isTarget: true }, { name: "locker", type: "address" }],
  },

  /*//////////////////////////////////////////////////////////////
                    NFT MARKETPLACE WRAPPER
  //////////////////////////////////////////////////////////////*/
  {
    id: "nftwrapper-approve-order-hash",
    label: "Approve an NFT marketplace order hash",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "approveOrderHash",
    abi: [{ type: "function", name: "approveOrderHash", stateMutability: "nonpayable", inputs: [{ name: "orderHash", type: "bytes32" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "orderHash", type: "bytes32" }],
  },
  {
    id: "nftwrapper-revoke-order-hash",
    label: "Revoke an NFT marketplace order hash",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "revokeOrderHash",
    abi: [{ type: "function", name: "revokeOrderHash", stateMutability: "nonpayable", inputs: [{ name: "orderHash", type: "bytes32" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "orderHash", type: "bytes32" }],
  },
  {
    id: "nftwrapper-execute",
    label: "Generic NFT wrapper call",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "execute",
    abi: [{ type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ type: "bytes" }] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
  },
  {
    id: "nftwrapper-set-treasury",
    label: "Point NFT wrapper at a new treasury",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "setTreasury",
    abi: [{ type: "function", name: "setTreasury", stateMutability: "nonpayable", inputs: [{ name: "newTreasury", type: "address" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "newTreasury", type: "address" }],
  },
  {
    id: "nftwrapper-sweep-erc721",
    label: "Sweep a stuck ERC721 from the NFT wrapper",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "sweepERC721",
    abi: [{ type: "function", name: "sweepERC721", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "token", type: "address" }, { name: "tokenId", type: "uint256" }],
  },
  {
    id: "nftwrapper-sweep-erc1155",
    label: "Sweep stuck ERC1155 from the NFT wrapper",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "sweepERC1155",
    abi: [{ type: "function", name: "sweepERC1155", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "token", type: "address" }, { name: "tokenId", type: "uint256" }, { name: "amount", type: "uint256" }],
  },
  {
    id: "nftwrapper-sweep-native",
    label: "Sweep stuck native MON from the NFT wrapper",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "sweepNative",
    abi: [{ type: "function", name: "sweepNative", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "amountWhole", type: "uint256", scaled: true }],
  },
  {
    id: "nftwrapper-sweep-erc20",
    label: "Sweep a stuck ERC20 from the NFT wrapper",
    appliesTo: "nftWrapper",
    targetKind: "fixedAddress",
    functionName: "sweepERC20",
    abi: [{ type: "function", name: "sweepERC20", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "token", type: "address" }, { name: "amountWhole", type: "uint256", scaled: true }],
  },

  /*//////////////////////////////////////////////////////////////
                        GUARD WRAPPER
  //////////////////////////////////////////////////////////////*/
  {
    id: "guardwrapper-propose-instruction",
    label: "Propose an instruction to the guard wrapper's signers",
    appliesTo: "guardWrapper",
    targetKind: "fixedAddress",
    functionName: "proposeInstruction",
    abi: [{ type: "function", name: "proposeInstruction", stateMutability: "nonpayable", inputs: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ name: "instructionId", type: "uint256" }] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }],
  },
  {
    id: "guardwrapper-replace-signers",
    label: "Replace the guard wrapper's signer set (only after tenure ends)",
    appliesTo: "guardWrapper",
    targetKind: "fixedAddress",
    functionName: "replaceSigners",
    abi: [{ type: "function", name: "replaceSigners", stateMutability: "nonpayable", inputs: [{ name: "newSigners", type: "address[]" }, { name: "newRequiredApprovals", type: "uint256" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "newSigners", type: "address[]" }, { name: "newRequiredApprovals", type: "uint256" }],
  },
  {
    id: "guardwrapper-set-tenure-length",
    label: "Set the guard wrapper's tenure length (must route through its own instruction pipeline)",
    appliesTo: "guardWrapper",
    targetKind: "fixedAddress",
    functionName: "setTenureLength",
    abi: [{ type: "function", name: "setTenureLength", stateMutability: "nonpayable", inputs: [{ name: "newTenureLength", type: "uint256" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "newTenureLength", type: "uint256" }],
  },
  {
    id: "guardwrapper-set-governance",
    label: "Replace the guard wrapper's governance address (must route through its own instruction pipeline)",
    appliesTo: "guardWrapper",
    targetKind: "fixedAddress",
    functionName: "setGovernance",
    abi: [{ type: "function", name: "setGovernance", stateMutability: "nonpayable", inputs: [{ name: "newGovernance", type: "address" }], outputs: [] }],
    params: [{ name: "wrapperAddress", type: "address", isTarget: true }, { name: "newGovernance", type: "address" }],
  },
];

export function getAction(actionId) {
  return ACTION_LIBRARY.find((a) => a.id === actionId) ?? null;
}

export function listActionsForModel(model) {
  return ACTION_LIBRARY.filter((a) => a.appliesTo === "any" || a.appliesTo === model || (Array.isArray(a.appliesTo) && a.appliesTo.includes(model)));
}

/**
 * Encodes an action's calldata from a flat array of string args (as
 * they'd arrive from a Telegram command). For a struct-taking action,
 * args must be supplied in exactly the field order listed in that
 * action's params[0].fields - Solidity ABI encoding has no named
 * fields at the wire level, only positional ones.
 */
export function encodeAction(actionId, args) {
  const action = getAction(actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);

  if (action.params.length === 1 && action.params[0].type === "tuple") {
    const fields = action.params[0].fields;
    if (args.length !== fields.length) {
      throw new Error(`${action.id} needs exactly ${fields.length} values: ${fields.join(", ")}`);
    }
    const tupleArg = args.map((v) => BigInt(v));
    const data = encodeFunctionData({ abi: action.abi, functionName: action.functionName, args: [tupleArg] });
    return { data, target: null };
  }

  let targetFromArgs = null;
  const values = [];
  let argIndex = 0;
  for (const param of action.params) {
    const raw = args[argIndex++];
    if (param.isTarget) {
      targetFromArgs = getAddress(raw.toLowerCase());
      continue;
    }
    if (param.type === "address") values.push(getAddress(raw.toLowerCase()));
    else if (param.type === "address[]") values.push(raw.split(",").map((s) => getAddress(s.trim().toLowerCase())));
    else if (param.scaled) values.push(parseEther(String(raw)));
    else if (param.type.startsWith("uint")) values.push(BigInt(raw));
    else values.push(raw);
  }

  const data = encodeFunctionData({ abi: action.abi, functionName: action.functionName, args: values });
  return { data, target: targetFromArgs };
}