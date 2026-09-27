import { encodeFunctionData, getAddress } from "viem";
import { publicClient } from "./config.js";
import { getAction, encodeAction } from "./actionLibrary.js";
import { getDaoInfo, hasToken } from "./governance/common.js";
import { getAdapter } from "./governance/index.js";

/**
 * The verified-action proposal path, shared by every chat platform so
 * Telegram, Discord and Slack all run the exact same GuardWrapper checks
 * rather than three copies of them. Moved out of index.js's
 * /proposeaction unchanged in behavior.
 */

/** DAO info for any model - Board has no token, so it has its own getDaoInfo. */
function daoInfoFor(model, governanceAddress) {
  return hasToken(model) ? getDaoInfo(model, governanceAddress) : getAdapter(model).getDaoInfo(governanceAddress);
}

const PROPOSE_INSTRUCTION_ABI = [
  {
    type: "function",
    name: "proposeInstruction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "instructionId", type: "uint256" }],
  },
];

/** Whether `action` can be proposed by a DAO of `model`, given which optional wrappers this chat has linked. */
export function actionAppliesTo(action, model, { nftWrapperAddress, guardWrapperAddress } = {}) {
  return Boolean(
    action.appliesTo === "any" ||
      action.appliesTo === model ||
      (Array.isArray(action.appliesTo) && action.appliesTo.includes(model)) ||
      action.appliesTo === "treasury" ||
      action.appliesTo === "token" ||
      (action.appliesTo === "nftWrapper" && nftWrapperAddress) ||
      (action.appliesTo === "guardWrapper" && guardWrapperAddress)
  );
}

/** How many positional arguments `action` takes, and their display names for a usage line. */
export function actionArgSpec(action) {
  const isTuple = action.params.length === 1 && action.params[0].type === "tuple";
  return {
    count: isTuple ? action.params[0].fields.length : action.params.length,
    names: isTuple ? action.params[0].fields : action.params.map((p) => p.name),
  };
}

/**
 * Encodes `actionId` and works out where the proposal must point.
 *
 * Treasury and token contracts may no longer accept calls from this
 * DAO's own governance - after a GuardWrapper handover
 * (Treasury.transferGovernance / token.transferOwnership) they only
 * accept the wrapper. Proposing a direct call in that state would pass
 * its vote and timelock, then fail only at execution. So this reads the
 * target's real, current governance()/owner() and, on a mismatch, wraps
 * the call in proposeInstruction() ONLY if the mismatched address is
 * exactly this chat's registered guard wrapper. Any other mismatch
 * throws rather than guessing.
 *
 * Returns { target, data } ready for adapter.propose(); value is always 0.
 */
export async function buildActionProposal({ model, governanceAddress, actionId, actionArgs, guardWrapperAddress }) {
  const action = getAction(actionId);
  if (!action) throw new Error(`Unknown action "${actionId}"`);

  let { data, target: fixedTarget } = encodeAction(actionId, actionArgs);
  let target;

  if (action.targetKind === "governance") {
    target = governanceAddress;
  } else if (action.targetKind === "treasury") {
    const { treasuryAddress } = await daoInfoFor(model, governanceAddress);
    target = treasuryAddress;

    const currentTreasuryGovernance = await publicClient.readContract({
      address: getAddress(treasuryAddress),
      abi: [{ type: "function", name: "governance", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
      functionName: "governance",
    });

    if (getAddress(currentTreasuryGovernance) !== getAddress(governanceAddress)) {
      if (!guardWrapperAddress || getAddress(guardWrapperAddress) !== getAddress(currentTreasuryGovernance)) {
        throw new Error(
          `Treasury's governance has changed to ${currentTreasuryGovernance}, which isn't this chat's registered guard wrapper` +
            (guardWrapperAddress ? ` (${guardWrapperAddress})` : " (none registered)") +
            `. Won't guess - link it first with /registerguardwrapper if that address is genuinely a GuardWrapper, or investigate if it's not.`
        );
      }
      data = encodeFunctionData({
        abi: PROPOSE_INSTRUCTION_ABI,
        functionName: "proposeInstruction",
        args: [getAddress(treasuryAddress), 0n, data],
      });
      target = currentTreasuryGovernance; // confirmed to be the registered wrapper
    }
  } else {
    target = fixedTarget; // supplied inline as the action's own first arg

    // Token and staking-wrapper contracts are Ownable (owner(), not
    // governance()). Only checked for "token" actions, since NFT/Guard
    // wrapper targets aren't ordinarily handed over to a further wrapper.
    if (action.appliesTo === "token") {
      const currentOwner = await publicClient.readContract({
        address: target,
        abi: [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "owner",
      });

      if (getAddress(currentOwner) !== getAddress(governanceAddress)) {
        if (!guardWrapperAddress || getAddress(guardWrapperAddress) !== getAddress(currentOwner)) {
          throw new Error(
            `This token's owner has changed to ${currentOwner}, which isn't this chat's registered guard wrapper` +
              (guardWrapperAddress ? ` (${guardWrapperAddress})` : " (none registered)") +
              `. Won't guess - link it first with /registerguardwrapper if that address is genuinely a GuardWrapper, or investigate if it's not.`
          );
        }
        data = encodeFunctionData({
          abi: PROPOSE_INSTRUCTION_ABI,
          functionName: "proposeInstruction",
          args: [target, 0n, data],
        });
        target = currentOwner; // confirmed to be the registered wrapper
      }
    }
  }

  return { target: getAddress(target), data };
}

const HANDOVER_ABI = [
  { type: "function", name: "transferGovernance", stateMutability: "nonpayable", inputs: [{ name: "newGovernance", type: "address" }], outputs: [] },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "newOwner", type: "address" }], outputs: [] },
  { type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

/**
 * The two proposals that hand a DAO's Treasury and token-minting control
 * to a GuardWrapper: Treasury.transferGovernance(wrapper) and, on the
 * raw underlying token (not the staking wrapper that governanceToken()
 * returns), transferOwnership(wrapper). Token-less models get only the
 * Treasury one (underlyingTokenAddress and tokenData are null). Computes
 * calldata only - each still has to be proposed and pass a vote.
 */
export async function computeHandoverProposals(model, governanceAddress, wrapperAddress) {
  const wrapper = getAddress(wrapperAddress);
  const { treasuryAddress, tokenAddress } = await daoInfoFor(model, governanceAddress);
  const treasury = {
    treasuryAddress: getAddress(treasuryAddress),
    treasuryData: encodeFunctionData({ abi: HANDOVER_ABI, functionName: "transferGovernance", args: [wrapper] }),
  };
  // Token-less models (Board) only have a Treasury to hand over.
  if (!hasToken(model)) return { ...treasury, underlyingTokenAddress: null, tokenData: null };
  const underlyingTokenAddress = await publicClient.readContract({
    address: getAddress(tokenAddress),
    abi: HANDOVER_ABI,
    functionName: "underlying",
  });
  return {
    ...treasury,
    underlyingTokenAddress: getAddress(underlyingTokenAddress),
    tokenData: encodeFunctionData({ abi: HANDOVER_ABI, functionName: "transferOwnership", args: [wrapper] }),
  };
}
