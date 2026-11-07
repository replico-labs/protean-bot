import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { encodeFunctionData, getAddress, isAddress, keccak256, toHex, zeroAddress, parseUnits } from "viem";
import { publicClient, FACTORY_ADDRESSES, wrapperFactoryAddress } from "./config.js";
import { currentNetwork, networkEnvName } from "./networks.js";
import { hasToken, getGovernanceTokenAddress } from "./governance/common.js";

/**
 * EVM (Spaces) builders for changing a DAO's token, its stake converter,
 * and its security council (GuardWrapper). Each returns the actions of one
 * proposal on the DAO's current governance; nothing is sent here.
 *
 * Changing the token (docs/governance-changes-design.md, section 1):
 *   1. factory.createTokenForSwitch(...) for a new token, or
 *      factory.createStaking(token, governance, salt) to adopt an existing
 *      ERC20: a new staking contract S2 at a predicted address, owned by
 *      the governance;
 *   2. Conviction: S2.setAuthorizedLocker(governance);
 *   3. with a council: the new token and S2 handed to the wrapper;
 *   4. governance.setGovernanceToken(S2) - a call on the governance itself;
 *   5. optional: wrapperFactory.createConverter(S1, S2, rate, ...) and the
 *      Treasury funding it (through the council, if there is one).
 * Open proposals keep the token they were made with.
 *
 * The council (section 4): turning it on is one proposal (create the
 * wrapper, hand it the Treasury, token and staking contract); turning it
 * off is one proposal sending the wrapper a batch that hands them back,
 * which the council confirms; replacing the signers after their tenure
 * needs no confirmation.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abi = (name) => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8"));
  return Array.isArray(j) ? j : j.abi;
};
const FACTORY_ABI = abi("DAOFactory");
const TREASURY_ABI = abi("Treasury");
const STAKING_ABI = abi("StakedGovernanceToken");
const TOKEN_ABI = abi("GovernanceToken");
const BOARD_ABI = abi("BoardGovernance");
const WRAPPER_FACTORY_ABI = abi("WrapperFactory");
export const GUARD_ABI = abi("GuardWrapperArtifact");
export const CONVERTER_ABI = abi("StakeConverter");
const SET_TOKEN_ABI = [{ type: "function", name: "setGovernanceToken", inputs: [{ name: "newToken", type: "address" }], outputs: [], stateMutability: "nonpayable" }];
const TREASURY_READ_ABI = [{ type: "function", name: "treasury", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }];
const MAX_SUPPLY_MULTIPLE = 10n;

export class ChangeError extends Error {
  constructor(message) {
    super(message);
    this.userFacing = true;
  }
}

const call = (target, contractAbi, functionName, args = []) => ({ target: getAddress(target), value: 0n, data: encodeFunctionData({ abi: contractAbi, functionName, args }) });
const read = (address, contractAbi, functionName, args = []) => publicClient.readContract({ address: getAddress(address), abi: contractAbi, functionName, args });

/** A salt nobody else's proposal will reuse: the governance, what it's for, and the time. */
function freshSalt(governance, what) {
  return keccak256(toHex(`${getAddress(governance)}:${what}:${Date.now()}:${Math.random()}`));
}

export function requireWrapperFactory() {
  const configured = wrapperFactoryAddress();
  if (!configured) throw new ChangeError(`${networkEnvName(currentNetwork().id, "WRAPPER_FACTORY_ADDRESS")} isn't configured on this bot, so it can't make security councils, NFT wrappers or converters on ${currentNetwork().chain.name}.`);
  return { address: getAddress(configured), abi: WRAPPER_FACTORY_ABI };
}

/** Any token-model factory on this network: they all make tokens and staking contracts. */
function tokenFactory() {
  for (const model of ["tokenWeighted", "quadratic", "liquid", "optimistic", "conviction", "delegate", "sortition", "sowellian", "decisionMarkets"]) {
    if (FACTORY_ADDRESSES[model]) return { address: getAddress(FACTORY_ADDRESSES[model]), abi: FACTORY_ABI };
  }
  throw new ChangeError(`No token-model factory is configured on ${currentNetwork().chain.name}.`);
}

/**
 * The DAO's Treasury, who controls it (the governance, or a council
 * wrapper answering to it), and its token and staking contract: Board
 * keeps them too (zero if the DAO never had one).
 */
export async function daoState(model, governance) {
  const g = getAddress(governance);
  const treasury = getAddress(await read(g, TREASURY_READ_ABI, "treasury"));
  const controller = getAddress(await read(treasury, TREASURY_ABI, "governance"));
  let staking = zeroAddress;
  if (hasToken(model)) staking = getAddress(await getGovernanceTokenAddress(model, g));
  else staking = getAddress(await read(g, BOARD_ABI, "governanceToken").catch(() => zeroAddress));
  const token = staking === zeroAddress ? zeroAddress : getAddress(await read(staking, STAKING_ABI, "underlying"));
  let wrapper = null;
  if (controller !== g) {
    const answersTo = await read(controller, GUARD_ABI, "governance").catch(() => null);
    if (!answersTo || getAddress(answersTo) !== g) throw new ChangeError(`This DAO's governance no longer controls its Treasury (it answers to \`${controller}\`).`);
    wrapper = controller;
  }
  return { governance: g, treasury, controller, wrapper, token, staking };
}

/**
 * `token=new:NAME:SYMBOL:SUPPLY` or an existing ERC20's address, as the
 * first actions of a proposal: returns { actions, token, staking } with
 * the new staking contract owned by `governance`.
 */
export async function newTokenActions(governance, treasury, spec) {
  const factory = tokenFactory();
  const salt = freshSalt(governance, "token");
  const word = String(spec ?? "");
  if (/^new:/i.test(word)) {
    const [, name, symbol, supply] = word.split(":");
    if (!name || !symbol || !/^\d+$/.test(supply ?? "") || BigInt(supply) === 0n) throw new ChangeError("A new token is `new:<name>:<symbol>:<supply>`, e.g. `new:Acme:ACME:1000000` (the whole supply goes to the Treasury).");
    const initial = parseUnits(supply, 18);
    const [token, staking] = await read(factory.address, factory.abi, "predictTokenForSwitch", [getAddress(governance), salt]);
    return {
      actions: [call(factory.address, factory.abi, "createTokenForSwitch", [name, symbol, initial, initial * MAX_SUPPLY_MULTIPLE, getAddress(treasury), salt])],
      token: getAddress(token),
      staking: getAddress(staking),
      created: { name, symbol, supply },
    };
  }
  if (!isAddress(word, { strict: false })) throw new ChangeError("Give the new token as an ERC20 address, or `new:<name>:<symbol>:<supply>` for a new one.");
  const token = getAddress(word);
  await read(token, TOKEN_ABI, "totalSupply").catch(() => {
    throw new ChangeError(`\`${token}\` doesn't look like an ERC20 token.`);
  });
  const staking = getAddress(await read(factory.address, factory.abi, "predictStaking", [getAddress(governance), salt]));
  return { actions: [call(factory.address, factory.abi, "createStaking", [token, getAddress(governance), salt])], token, staking, created: null };
}

/** `rate=N:D` (N new per D old; `rate=N` means N:1), or null. */
export function parseRate(text) {
  if (!text) return null;
  const m = String(text).match(/^(\d+)(?::(\d+))?$/);
  if (!m || BigInt(m[1]) === 0n || (m[2] && BigInt(m[2]) === 0n)) throw new ChangeError("rate= is new tokens per old, as whole numbers: rate=1 (one for one), rate=2:1 or rate=1:10.");
  return { num: BigInt(m[1]), den: BigInt(m[2] ?? "1") };
}

/**
 * A token change: { actions, token, staking, converter, notes }. `rate`
 * and `fund` (raw, in the new token) open and fund a converter for
 * members' old stake.
 */
export async function buildTokenChange({ model, governance, tokenSpec, rate = null, fundRaw = 0n }) {
  const s = await daoState(model, governance);
  const made = await newTokenActions(s.governance, s.treasury, tokenSpec);
  if (made.token === s.token) throw new ChangeError("That's already this DAO's token.");
  const actions = [...made.actions];
  if (model === "conviction") actions.push(call(made.staking, STAKING_ABI, "setAuthorizedLocker", [s.governance]));
  if (s.wrapper) {
    // Under a council, the new token and staking contract belong to the wrapper, like the old ones.
    if (made.created) actions.push(call(made.token, TOKEN_ABI, "transferOwnership", [s.wrapper]));
    actions.push(call(made.staking, STAKING_ABI, "transferOwnership", [s.wrapper]));
  }
  actions.push(call(s.governance, SET_TOKEN_ABI, "setGovernanceToken", [made.staking]));

  const notes = [];
  let converter = null;
  if (rate) {
    if (s.staking === zeroAddress) throw new ChangeError("This DAO has no old stake to convert.");
    const wf = requireWrapperFactory();
    const salt = freshSalt(s.governance, "converter");
    converter = getAddress(await read(wf.address, wf.abi, "predictConverter", [s.governance, salt]));
    actions.push(call(wf.address, wf.abi, "createConverter", [s.staking, made.staking, rate.num, rate.den, s.treasury, salt]));
    if (fundRaw > 0n) {
      const fund = encodeFunctionData({ abi: TREASURY_ABI, functionName: "transferERC20", args: [made.token, converter, fundRaw] });
      if (s.wrapper) {
        actions.push(call(s.wrapper, GUARD_ABI, "proposeInstruction", [s.treasury, 0n, fund]));
        notes.push("Funding the converter moves Treasury tokens, so the security council confirms it after this passes.");
      } else actions.push({ target: s.treasury, value: 0n, data: fund });
    }
  }
  if (model === "decisionMarkets") notes.push("New markets trade the new token; open proposals keep the one they were seeded in.");
  return { actions, token: made.token, staking: made.staking, created: made.created, converter, oldStaking: s.staking, notes };
}

/** Turning a council on: { actions, wrapper }. */
export async function buildCouncilOn({ model, governance, signers, required, tenureSeconds }) {
  const s = await daoState(model, governance);
  if (s.wrapper) throw new ChangeError(`This DAO already has a security council (\`${s.wrapper}\`).`);
  const wf = requireWrapperFactory();
  const people = signers.map((x) => getAddress(x.toLowerCase()));
  if (new Set(people).size !== people.length) throw new ChangeError("The same signer is listed twice.");
  if (!Number.isInteger(required) || required < 1 || required > people.length) throw new ChangeError(`<required> must be a whole number from 1 to ${people.length}.`);
  const salt = freshSalt(s.governance, "council");
  const wrapper = getAddress(await read(wf.address, wf.abi, "predictGuardWrapper", [s.governance, salt]));
  const actions = [
    call(wf.address, wf.abi, "createGuardWrapper", [s.governance, people, BigInt(required), BigInt(tenureSeconds), salt]),
    call(s.treasury, TREASURY_ABI, "transferGovernance", [wrapper]),
  ];
  if (s.token !== zeroAddress && getAddress(await read(s.token, TOKEN_ABI, "owner")) === s.governance) actions.push(call(s.token, TOKEN_ABI, "transferOwnership", [wrapper]));
  if (s.staking !== zeroAddress && getAddress(await read(s.staking, STAKING_ABI, "owner")) === s.governance) actions.push(call(s.staking, STAKING_ABI, "transferOwnership", [wrapper]));
  return { actions, wrapper, treasury: s.treasury };
}

/** Turning it off: a batch the council confirms, handing everything back to the governance. */
export async function buildCouncilOff({ model, governance }) {
  const s = await daoState(model, governance);
  if (!s.wrapper) throw new ChangeError("This DAO has no security council in front of its Treasury.");
  const back = [{ target: s.treasury, value: 0n, data: encodeFunctionData({ abi: TREASURY_ABI, functionName: "transferGovernance", args: [s.governance] }) }];
  if (s.token !== zeroAddress && getAddress(await read(s.token, TOKEN_ABI, "owner")) === s.wrapper) back.push({ target: s.token, value: 0n, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "transferOwnership", args: [s.governance] }) });
  if (s.staking !== zeroAddress && getAddress(await read(s.staking, STAKING_ABI, "owner")) === s.wrapper) back.push({ target: s.staking, value: 0n, data: encodeFunctionData({ abi: STAKING_ABI, functionName: "transferOwnership", args: [s.governance] }) });
  return { actions: [call(s.wrapper, GUARD_ABI, "proposeBatch", [back])], wrapper: s.wrapper };
}

/** Replacing the signers once their tenure is over (no confirmation needed). */
export async function buildCouncilReplace({ model, governance, signers, required }) {
  const s = await daoState(model, governance);
  if (!s.wrapper) throw new ChangeError("This DAO has no security council in front of its Treasury.");
  const people = signers.map((x) => getAddress(x.toLowerCase()));
  if (!Number.isInteger(required) || required < 1 || required > people.length) throw new ChangeError(`<required> must be a whole number from 1 to ${people.length}.`);
  const tenureEnd = Number(await read(s.wrapper, GUARD_ABI, "tenureEnd"));
  const now = Number((await publicClient.getBlock()).timestamp);
  return { actions: [call(s.wrapper, GUARD_ABI, "replaceSigners", [people, BigInt(required)])], wrapper: s.wrapper, tenureEnd, early: now < tenureEnd };
}
