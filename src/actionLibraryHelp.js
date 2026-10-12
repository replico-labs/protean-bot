/**
 * Plain-English help for the native action library (actionLibrary.js),
 * shown by /actioninfo. Units are from the Spaces contracts' own config
 * struct comments: voting periods count BLOCKS, timelocks and execution
 * windows count SECONDS, and token amounts inside a config are raw
 * 18-decimal units. Monad blocks are ~0.4s, Base 2s, HyperEVM ~1s.
 *
 * FIELD_HELP is keyed by argument name; a "model.field" key overrides it
 * where two models use the same name with different units.
 */

const RAW = "raw token units, 18 decimals (100 tokens = 100000000000000000000)";

export const FIELD_HELP = {
  // Shared config fields
  quorumBps: "share of total voting supply that must vote, in basis points (10000 = 100%)",
  approvalThresholdBps: "share of For votes (For vs Against) needed to pass, in basis points",
  votingDelay: "BLOCKS between proposing and voting opening",
  votingPeriod: "BLOCKS that voting stays open",
  timelockDelay: "SECONDS between a proposal passing and it becoming executable",
  executionPeriod: "SECONDS a passed proposal stays executable before it expires",
  proposalThreshold: `voting power needed to propose, ${RAW}`,
  // Conviction
  convictionGrowthRate: "conviction gained or lost per block (raw units)",
  minThresholdConviction: "the least conviction any request needs, even a tiny one (raw units)",
  thresholdMultiplier: "extra conviction required per wei requested",
  // Optimistic
  challengePeriod: "BLOCKS a proposal can be challenged before it passes by default",
  "sowellian.challengePeriod": "SECONDS a proposed resolution can be challenged",
  challengeBond: `governance tokens a challenger must post, ${RAW}`,
  "optimistic.quorumBps": "share of total supply that must vote, in basis points - only used if the proposal is challenged",
  "optimistic.approvalThresholdBps": "share of For votes needed to pass, in basis points - only used if the proposal is challenged",
  "optimistic.votingPeriod": "BLOCKS the vote runs - only if the proposal is challenged",
  // Delegate / Sortition
  councilSize: "number of council seats",
  termLength: "SECONDS each council term lasts",
  candidacyThreshold: `staked tokens needed to run for the council or start a recall, ${RAW}`,
  candidacyPeriod: "BLOCKS the window to declare candidacy stays open after an election starts",
  electionVotingPeriod: "BLOCKS election voting runs after candidacy closes",
  councilQuorum: "number of council members who must vote on a proposal",
  councilApprovalThresholdBps: "share of council votes cast (excluding abstain) needed to pass, in basis points",
  recallQuorumBps: "share of total token supply that must vote in a recall, in basis points",
  recallApprovalThresholdBps: "share of recall votes cast (excluding abstain) needed to recall, in basis points",
  recallVotingPeriod: "BLOCKS recall voting runs",
  eligibilityThreshold: `staked tokens needed to enter the sortition pool, ${RAW}`,
  // Sowellian
  proposalBondAmount: `bond to open a proposal, ${RAW}`,
  approvalVotingDelay: "BLOCKS before approval voting opens",
  approvalVotingPeriod: "BLOCKS approval voting runs",
  approvalQuorumBps: "share of supply that must vote on approval, in basis points",
  positionsWindow: "SECONDS positions can be taken after approval passes",
  executionTimelockDelay: "SECONDS after the positions window closes before execution",
  resolutionBondAmount: `bond to propose a resolution, ${RAW}`,
  challengeBondAmount: `bond to challenge a resolution, ${RAW}`,
  adjudicationVotingPeriod: "BLOCKS adjudication voting runs",
  adjudicationQuorumBps: "share of supply that must vote in adjudication, in basis points",
  adjudicationThresholdBps: "share of adjudication votes needed, in basis points",
  maxOracleStaleness: "SECONDS - oracle data older than this is rejected",
  // Decision Markets
  tradingPeriod: "SECONDS the pass/fail markets trade",
  thresholdBps: "how far the pass market's TWAP must beat the fail market's, in basis points",

  // Plain arguments
  newToken: "address of the new voting token (the staked token governance reads votes from)",
  newTreasury: "address of the new treasury contract",
  newSigner: "address to add as a signer",
  signer: "the signer's address",
  newRequiredApprovals: "how many signers must approve (a whole number, at most the signer count)",
  newSource: "address of the randomness source contract",
  recipient: "address that receives the funds",
  amountWhole: "amount in whole units, decimals allowed (e.g. 1.5)",
  token: "the token contract's address",
  target: "the contract to call",
  value: "native currency to send with the call, in wei (0 for none)",
  data: "the call's encoded calldata, as 0x-hex",
  newGovernance: "address that will control it from now on",
  tokenAddress: "the token contract's address (this DAO's token is shown by /dao)",
  to: "address that receives them",
  wrapperAddress: "this DAO's wrapper address",
  orderHash: "the order's EIP-712 digest (bytes32, 0x…)",
  tokenId: "the NFT's token ID",
  amount: "how many of that token ID",
  newSigners: "the full new signer list, comma-separated with no spaces (0xA…,0xB…)",
  newTenureLength: "SECONDS a signer set serves before it can be replaced",
  locker: "the governance contract allowed to lock balances",
  stakingTokenAddress: "the staked token contract's address (the one /stake mints)",
  newOwner: "address that will own it from now on",
};

export function fieldHelp(model, name) {
  return FIELD_HELP[`${model}.${name}`] ?? FIELD_HELP[name] ?? null;
}

const CONFIG_NOTE =
  "Replaces the WHOLE config: give every field, in this order. Run /dao first and copy the current values for anything you're not changing.";
const GUARD_SELF =
  "The guard wrapper only accepts this from itself: propose it through guardwrapper-propose-instruction with the wrapper as target, so signers confirm it.";

export const ACTION_HELP = {
  "set-governance-token": "Switches which token governance reads voting power from. Use the staked token (the one /stake mints), not the plain token, or no one will have votes.",
  "set-treasury": "Points governance at a different treasury contract. The new treasury must already name this governance as its own, or proposals that spend will fail.",
  "update-config-tokenweighted": CONFIG_NOTE,
  "update-config-liquid": CONFIG_NOTE,
  "update-config-quadratic": CONFIG_NOTE,
  "update-config-conviction": CONFIG_NOTE,
  "update-config-optimistic": CONFIG_NOTE,
  "update-config-delegate": CONFIG_NOTE,
  "update-config-sortition": CONFIG_NOTE,
  "update-config-sowellian": CONFIG_NOTE,
  "update-config-decisionmarkets": CONFIG_NOTE,
  "board-add-signer": "Adds a signer to the Board. Required approvals stay the same unless you also change them.",
  "board-remove-signer": "Removes a signer. It fails if that would leave fewer signers than required approvals - lower those first.",
  "board-set-required-approvals": "Sets how many Board signers must confirm a proposal.",
  "sortition-set-randomness-source": "Sets the contract Sortition draws council randomness from: this network's Pyth Entropy adapter, or any source with the same interface. Any round still waiting on the old source is abandoned, so a new draw can start (DAOs created after the Pyth update).",
  "treasury-transfer-eth": "Sends the network's native currency (MON, ETH or HYPE) from the Treasury.",
  "treasury-transfer-erc20": "Sends an ERC20 token from the Treasury. The amount is in whole tokens and assumes 18 decimals - for a token with fewer, like USDC, use treasury-execute with its own transfer calldata.",
  "treasury-execute": "Makes the Treasury call any contract with any calldata - the escape hatch for anything not in this list. The call runs as the Treasury, so check the calldata carefully.",
  "treasury-transfer-governance": "Hands control of the Treasury to a new address - e.g. a GuardWrapper during a handover. After this, this DAO's governance can no longer move treasury funds directly.",
  "token-mint": "Mints new tokens (amount in whole tokens), up to the token's max supply. Governance must own the token.",
  "token-transfer-ownership": "Hands ownership of a token (minting rights) to a new address - e.g. a GuardWrapper during a handover.",
  "staked-token-set-authorized-locker": "Sets the one governance contract allowed to lock and unlock staked balances (locked tokens can't be moved or unstaked). The zero address (0x0000000000000000000000000000000000000000) turns locking off.",
  "nftwrapper-approve-order-hash": "Approves an order so the wrapper answers a marketplace's EIP-1271 check. For Seaport this must be the order's EIP-712 digest, not the raw order hash. For OpenSea, opensea-list does all of this for you.",
  "nftwrapper-revoke-order-hash": "Withdraws an earlier approval, so that listing can no longer be filled.",
  "nftwrapper-execute": "Makes the NFT wrapper call any contract with any calldata - for marketplace calls not covered elsewhere.",
  "nftwrapper-set-treasury": "Changes where the wrapper sends sale proceeds.",
  "nftwrapper-transfer-erc721": "Sends an ERC721 the wrapper holds. The Treasury is refused as a recipient because it can't hold NFTs.",
  "nftwrapper-transfer-erc1155": "Sends ERC1155 tokens the wrapper holds. The Treasury is refused as a recipient.",
  "nftwrapper-sweep-native": "Sends native currency sitting in the wrapper (e.g. sale proceeds) to the Treasury.",
  "nftwrapper-sweep-erc20": "Sends an ERC20 sitting in the wrapper to the Treasury (amount in whole tokens, assumes 18 decimals).",
  "guardwrapper-propose-instruction": "Queues a call for the guard wrapper's signers to confirm; once enough confirm, the wrapper makes the call. This is how a DAO acts after handing its Treasury or token to the wrapper - /proposeaction does this wrapping for you automatically.",
  "guardwrapper-replace-signers": "Replaces the whole signer set and threshold. Only works once the current tenure has ended - the wrapper enforces this, even against governance.",
  "guardwrapper-set-tenure-length": `Sets how long a signer set serves. ${GUARD_SELF}`,
  "guardwrapper-set-governance": `Changes which governance the wrapper takes proposals from. ${GUARD_SELF}`,
};

const TARGETS = {
  governance: "this DAO's governance contract",
  treasury: "this DAO's Treasury",
};

export function actionTargetText(action) {
  if (TARGETS[action.targetKind]) return TARGETS[action.targetKind];
  const first = action.params[0]?.name;
  if (first === "wrapperAddress") return action.appliesTo === "guardWrapper" ? "this DAO's guard wrapper" : "this DAO's NFT wrapper";
  if (first === "tokenAddress" || first === "stakingTokenAddress") return "the token you name";
  return "the address you give";
}

export function actionAppliesText(action) {
  if (Array.isArray(action.appliesTo)) return action.appliesTo.join(", ") + " DAOs";
  return {
    treasury: "every DAO",
    token: "DAOs whose governance owns the token",
    nftWrapper: "DAOs with an NFT wrapper (/deploynftwrapper)",
    guardWrapper: "DAOs with a guard wrapper (/registerguardwrapper)",
    any: "every DAO",
  }[action.appliesTo] ?? String(action.appliesTo);
}
