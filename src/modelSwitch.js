import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encodeFunctionData, getAddress, isAddress, zeroAddress } from "viem";
import { publicClient, FACTORY_ADDRESSES, FACTORY_ENV_NAMES, sortitionRandomnessSource } from "./config.js";
import { currentNetwork, networkEnvName } from "./networks.js";
import { hasToken, getGovernanceTokenAddress } from "./governance/common.js";
import { getAdapter, SUPPORTED_MODELS } from "./governance/index.js";
import { newTokenWeightedConfig } from "./contracts.js";

/**
 * Switching an EVM DAO to another governance model (/switchmodel).
 *
 * One proposal on the DAO's current governance does the whole switch, run
 * in order and all or nothing when it executes (Spaces README, "Switching
 * models"):
 *   1. targetFactory.createForSwitch(...) deploys only the new governance,
 *      on the DAO's own Treasury and staking contract, at the address the
 *      factory predicted for it (it reverts anywhere else);
 *   2. treasury.transferGovernance(new)
 *   3. token.transferOwnership(new)
 *   4. staking.setAuthorizedLocker(new for Conviction, else 0)
 *   5. staking.transferOwnership(new)
 * Steps 4-5 only when the current governance owns the staking contract:
 * DAOs from factories before switching existed have it owned by their
 * factory, so they keep it as is and can't switch into Conviction.
 *
 * Members keep their stake and voting power: nothing is re-staked. Once
 * the proposal executes, the event listener sees the Treasury's new
 * governance and moves the chat's link (followSwitch below).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abi = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8"));

const FACTORY_ABI_BY_MODEL = {
  tokenWeighted: abi("DAOFactory"),
  quadratic: abi("QuadraticDAOFactory"),
  liquid: abi("LiquidDAOFactory"),
  optimistic: abi("OptimisticDAOFactory"),
  sowellian: abi("SowellianDAOFactory"),
  conviction: abi("ConvictionDAOFactory"),
  delegate: abi("DelegateDAOFactory"),
  sortition: abi("SortitionDAOFactory"),
  decisionMarkets: abi("DecisionMarketsDAOFactory"),
  board: abi("BoardDAOFactory"),
};
const TREASURY_ABI = abi("Treasury");
const STAKING_ABI = abi("StakedGovernanceToken");
const TOKEN_ABI = abi("GovernanceToken");
const TREASURY_READ_ABI = [{ type: "function", name: "treasury", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }];
const NAME_ABI = [{ type: "function", name: "daoName", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }];

// Models whose new governance needs a list of people to start with.
const MEMBER_MODELS = { delegate: "starting council", sortition: "starting council", board: "signers" };

export class SwitchError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

/** Accepts the model names /createdao uses, case-insensitively. */
export function resolveModelWord(word) {
  const lower = String(word ?? "").toLowerCase();
  return SUPPORTED_MODELS.find((m) => m.toLowerCase() === lower) ?? null;
}

/** What a switch to `model` needs besides the model name, for usage text. */
export function switchExtrasUsage(model) {
  return MEMBER_MODELS[model] ? `<${MEMBER_MODELS[model]}: 0x… 0x… …>` : "";
}

/** The factory a switch into `model` goes through on this network. */
function switchFactory(model) {
  const configured = FACTORY_ADDRESSES[model];
  if (!configured) throw new SwitchError(`${networkEnvName(currentNetwork().id, FACTORY_ENV_NAMES[model])} isn't configured on this bot, so DAOs here can't switch to ${model}.`);
  return { address: getAddress(configured), abi: FACTORY_ABI_BY_MODEL[model] };
}

/** Refuses a factory that predates switching (no predictSwitchGovernance). */
async function predictGovernance(factory, model, previous) {
  try {
    return await publicClient.readContract({ ...factory, functionName: "predictSwitchGovernance", args: [previous] });
  } catch {
    throw new SwitchError(`The ${model} factory on ${currentNetwork().chain.name} was deployed before model switching existed. An admin has to deploy the current factories (Spaces) and update the bot's factory addresses first.`);
  }
}

/**
 * The token and staking contract a DAO governed by `governance` uses. A
 * Board has none of its own; one reached by a switch finds them through
 * the governance it replaced (BoardDAOFactory.predecessorOf).
 */
async function daoTokens(model, governance) {
  let current = getAddress(governance);
  let currentModel = model;
  for (let hops = 0; hops < 10; hops++) {
    if (hasToken(currentModel)) {
      const staking = getAddress(await getGovernanceTokenAddress(currentModel, current));
      const token = getAddress(await publicClient.readContract({ address: staking, abi: STAKING_ABI, functionName: "underlying" }));
      return { staking, token };
    }
    const boardFactory = FACTORY_ADDRESSES.board;
    const previous = boardFactory
      ? await publicClient.readContract({ address: getAddress(boardFactory), abi: FACTORY_ABI_BY_MODEL.board, functionName: "predecessorOf", args: [current] }).catch(() => zeroAddress)
      : zeroAddress;
    if (previous === zeroAddress) return { staking: zeroAddress, token: zeroAddress };
    // The predecessor's own model isn't recorded; any token model's ABI reads governanceToken().
    const staking = await getGovernanceTokenAddress("tokenWeighted", previous).catch(() => null);
    if (staking) {
      const token = getAddress(await publicClient.readContract({ address: getAddress(staking), abi: STAKING_ABI, functionName: "underlying" }));
      return { staking: getAddress(staking), token };
    }
    current = getAddress(previous);
    currentModel = "board";
  }
  return { staking: zeroAddress, token: zeroAddress };
}

/** The createForSwitch call for `toModel`. */
function deployCall(toModel, { name, treasury, token, staking, members, expected }) {
  const common = [name, treasury, token, staking];
  switch (toModel) {
    case "tokenWeighted":
      return [...common, newTokenWeightedConfig(), expected];
    case "delegate":
    case "board":
      return [...common, getAdapter(toModel).newDaoConfig(members), members, expected];
    case "sortition": {
      const source = sortitionRandomnessSource();
      if (!source) throw new SwitchError("This bot has no randomness source configured for Sortition on this network - ask an admin to set SORTITION_RANDOMNESS_SOURCE.");
      return [name, treasury, token, staking, getAddress(source), getAdapter(toModel).newDaoConfig(members), members, expected];
    }
    default:
      return [...common, getAdapter(toModel).newDaoConfig(), expected];
  }
}

/**
 * Builds the switch proposal's actions. Reads everything from the chain;
 * sends nothing. Returns { actions, newGovernance, treasury, token,
 * staking, movesStaking, notes }.
 */
export async function buildSwitch({ fromModel, governance, toModel, members = [], guardWrapperAddress = null, nftWrapperAddress = null }) {
  if (!SUPPORTED_MODELS.includes(toModel)) throw new SwitchError(`Unknown model "${toModel}". Models: ${SUPPORTED_MODELS.join(", ")}.`);
  if (toModel === fromModel) throw new SwitchError(`This DAO already uses ${toModel} governance.`);
  const previous = getAddress(governance);

  if (MEMBER_MODELS[toModel]) {
    if (members.length === 0) throw new SwitchError(`${toModel} needs its ${MEMBER_MODELS[toModel]}: list their addresses after the model.`);
    if (!members.every((m) => isAddress(m, { strict: false }))) throw new SwitchError(`Every ${MEMBER_MODELS[toModel]} entry must be an address.`);
  }
  const people = members.map((m) => getAddress(m.toLowerCase()));

  const treasury = getAddress(await publicClient.readContract({ address: previous, abi: TREASURY_READ_ABI, functionName: "treasury" }));
  const controller = getAddress(await publicClient.readContract({ address: treasury, abi: TREASURY_ABI, functionName: "governance" }));
  if (controller !== previous) {
    if (guardWrapperAddress && controller === getAddress(guardWrapperAddress)) {
      throw new SwitchError("This DAO's Treasury is held by its security council wrapper. Switching through the wrapper isn't supported yet.");
    }
    throw new SwitchError(`This DAO's governance no longer controls its Treasury (it answers to \`${controller}\`), so it can't switch models.`);
  }

  const { token, staking } = await daoTokens(fromModel, previous);
  if (hasToken(toModel) && staking === zeroAddress) {
    throw new SwitchError(`This DAO has no token, and ${toModel} governance needs one. Only DAOs that started with a token can switch to a token model.`);
  }

  // Steps 4-5 need the current governance to own the staking contract.
  const stakingOwner = staking === zeroAddress ? zeroAddress : getAddress(await publicClient.readContract({ address: staking, abi: STAKING_ABI, functionName: "owner" }));
  const movesStaking = stakingOwner === previous;
  if (toModel === "conviction" && !movesStaking) {
    throw new SwitchError("Conviction locks members' stake, so it needs the DAO to own its staking contract - this DAO's is owned by the factory that created it (DAOs created before switching existed). It can switch to any other model.");
  }
  const tokenOwner = token === zeroAddress ? zeroAddress : getAddress(await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "owner" }));

  const factory = switchFactory(toModel);
  const newGovernance = getAddress(await predictGovernance(factory, toModel, previous));
  const name = await publicClient.readContract({ address: previous, abi: NAME_ABI, functionName: "daoName" }).catch(() => "DAO");

  const actions = [
    {
      target: factory.address,
      value: 0n,
      data: encodeFunctionData({ abi: factory.abi, functionName: "createForSwitch", args: deployCall(toModel, { name, treasury, token, staking, members: people, expected: newGovernance }) }),
    },
    { target: treasury, value: 0n, data: encodeFunctionData({ abi: TREASURY_ABI, functionName: "transferGovernance", args: [newGovernance] }) },
  ];
  if (tokenOwner === previous) {
    actions.push({ target: token, value: 0n, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "transferOwnership", args: [newGovernance] }) });
  }
  if (movesStaking) {
    const locker = toModel === "conviction" ? newGovernance : zeroAddress;
    actions.push({ target: staking, value: 0n, data: encodeFunctionData({ abi: STAKING_ABI, functionName: "setAuthorizedLocker", args: [locker] }) });
    actions.push({ target: staking, value: 0n, data: encodeFunctionData({ abi: STAKING_ABI, functionName: "transferOwnership", args: [newGovernance] }) });
  }

  // Each action as the current governance, in order, before anyone votes:
  // the deploy (step 1) is the one that can refuse, so a bad switch fails
  // here rather than after the vote.
  try {
    await publicClient.call({ account: previous, to: actions[0].target, data: actions[0].data });
  } catch (err) {
    throw new SwitchError(`The ${toModel} factory refused this switch: ${err.shortMessage || err.message}`);
  }

  const notes = [];
  if (fromModel === "conviction") notes.push("Stake backing a Conviction proposal stays locked after the switch until its owner runs withdrawsupport, which keeps working on the old governance.");
  if (!movesStaking && staking !== zeroAddress) notes.push("The staking contract stays with the factory that created this DAO (older DAOs), so it isn't handed over; voting works the same.");
  if (tokenOwner !== previous && token !== zeroAddress) notes.push(`The token is owned by \`${tokenOwner}\`, not this governance, so minting rights don't move.`);
  if (nftWrapperAddress) notes.push("The NFT wrapper stays governed by the old governance - move any NFTs out before this executes.");
  return { actions, newGovernance, treasury, token, staking, movesStaking, notes };
}

/**
 * After a proposal executes on a chat's DAO: if the Treasury now answers to
 * a governance one of this network's factories deployed as that DAO's
 * successor, returns { governance, model }; otherwise null. Cheap when
 * nothing switched: one read.
 */
export async function detectSwitch(dao) {
  const previous = getAddress(dao.governanceAddress);
  const treasury = await publicClient
    .readContract({ address: previous, abi: TREASURY_READ_ABI, functionName: "treasury" })
    .catch(() => null);
  if (!treasury) return null;
  const controller = getAddress(await publicClient.readContract({ address: getAddress(treasury), abi: TREASURY_ABI, functionName: "governance" }));
  if (controller === previous) return null;
  for (const model of SUPPORTED_MODELS) {
    const configured = FACTORY_ADDRESSES[model];
    if (!configured) continue;
    const predecessor = await publicClient
      .readContract({ address: getAddress(configured), abi: FACTORY_ABI_BY_MODEL[model], functionName: "predecessorOf", args: [controller] })
      .catch(() => zeroAddress);
    if (getAddress(predecessor) === previous) return { governance: controller, model };
  }
  return null;
}
