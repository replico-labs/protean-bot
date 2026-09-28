import { encodeFunctionData, getAddress } from "viem";
import { publicClient } from "./config.js";
import { getAction, encodeAction } from "./actionLibrary.js";
import { getIntegrationAction, parseIntegrationWords, integrationUsage, IntegrationError } from "./integrations/index.js";
import { currentNetwork } from "./networks.js";
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
    const route = await treasuryRoute({ model, governanceAddress, guardWrapperAddress });
    ({ target, data } = route.wrap(data));
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

/**
 * Where a proposal must send a Treasury call. Normally straight to the
 * Treasury; after a GuardWrapper handover (Treasury.transferGovernance)
 * the Treasury only accepts the wrapper, so the call is wrapped in
 * proposeInstruction() - but only if the Treasury's governance is
 * exactly this chat's registered guard wrapper. Any other mismatch
 * throws rather than guessing.
 */
async function treasuryRoute({ model, governanceAddress, guardWrapperAddress }) {
  const { treasuryAddress } = await daoInfoFor(model, governanceAddress);
  const treasury = getAddress(treasuryAddress);
  const currentTreasuryGovernance = await publicClient.readContract({
    address: treasury,
    abi: [{ type: "function", name: "governance", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "governance",
  });

  if (getAddress(currentTreasuryGovernance) === getAddress(governanceAddress)) {
    return { treasury, guarded: false, wrap: (data) => ({ target: treasury, data }) };
  }
  if (!guardWrapperAddress || getAddress(guardWrapperAddress) !== getAddress(currentTreasuryGovernance)) {
    throw new Error(
      `Treasury's governance has changed to ${currentTreasuryGovernance}, which isn't this chat's registered guard wrapper` +
        (guardWrapperAddress ? ` (${guardWrapperAddress})` : " (none registered)") +
        `. Won't guess - link it first with /registerguardwrapper if that address is genuinely a GuardWrapper, or investigate if it's not.`
    );
  }
  const wrapper = getAddress(currentTreasuryGovernance); // confirmed to be the registered wrapper
  return {
    treasury,
    guarded: true,
    wrap: (data) => ({
      target: wrapper,
      data: encodeFunctionData({ abi: PROPOSE_INSTRUCTION_ABI, functionName: "proposeInstruction", args: [treasury, 0n, data] }),
    }),
  };
}

const EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
];

/**
 * An external-protocol action (src/integrations) as proposal actions.
 * The action's build() returns ordered calls made by the Treasury (or,
 * for NFT custody, the chat's NFT wrapper); each becomes one proposal
 * action - Treasury.execute(target, value, data) - so the protocol sees
 * the Treasury as the caller and the Treasury's own balance pays any
 * value. Runs on the chat's network (the caller's runOnNetwork context).
 *
 * `words` are the command words after the action id: positional args,
 * then name=value options, then the description.
 * Returns { actions, summary, description, guarded }.
 */
export async function buildIntegrationProposal({ model, governanceAddress, actionId, words, guardWrapperAddress, nftWrapperAddress, lookupTicker }) {
  const action = getIntegrationAction(actionId);
  if (!action) throw new Error(`Unknown action "${actionId}"`);
  const network = currentNetwork();
  if (!action.protocol.deployments[network.id]) {
    throw new IntegrationError(`${action.protocol.name} isn't available on ${network.chain.name}.`);
  }

  const { args, options, description } = parseIntegrationWords(action, words);
  if (args.length !== action.usage.length || args.some((a) => /^[A-Za-z][A-Za-z0-9]*=/.test(a))) {
    throw new IntegrationError(`Usage: ${actionId} ${integrationUsage(action)} <description>`);
  }

  const route = await treasuryRoute({ model, governanceAddress, guardWrapperAddress });
  const ctx = {
    network,
    publicClient,
    treasury: route.treasury,
    nftWrapper: nftWrapperAddress ? getAddress(nftWrapperAddress) : null,
    args,
    options,
    lookupTicker,
  };
  const { calls, summary } = await action.build(ctx);

  const actions = calls.map((c) => {
    const executeData = encodeFunctionData({ abi: EXECUTE_ABI, functionName: "execute", args: [c.target, c.value, c.data] });
    if (c.via === "nftWrapper") {
      if (!ctx.nftWrapper) throw new IntegrationError("This action needs the DAO's NFT wrapper - deploy one with /deploynftwrapper first.");
      // A call to the wrapper itself (approveOrderHash etc.) goes straight
      // to it; anything else is made by the wrapper via its execute().
      return c.target === ctx.nftWrapper
        ? { target: ctx.nftWrapper, value: 0n, data: c.data }
        : { target: ctx.nftWrapper, value: 0n, data: executeData };
    }
    return { ...route.wrap(executeData), value: 0n };
  });

  return { actions, summary, description, guarded: route.guarded };
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
