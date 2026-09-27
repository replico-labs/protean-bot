import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getAddress } from "viem";
import { publicClient, writeWithGasBuffer } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const guardWrapperArtifact = loadAbi("GuardWrapperArtifact");

function wrapperContract(address) {
  return { address: getAddress(address), abi: guardWrapperArtifact.abi };
}

/**
 * Deploys a fresh GuardWrapper for a DAO - one per DAO, matching the
 * same on-demand pattern as deployNftWrapper and deployChainlinkOracle.
 * governanceAddress is baked in at deployment: only that specific
 * Governance contract will ever be able to call proposeInstruction on
 * the resulting wrapper.
 */
export async function deployGuardWrapper(client, governanceAddress, initialSigners, requiredApprovals, tenureLengthSeconds) {
  const hash = await client.deployContract({
    abi: guardWrapperArtifact.abi,
    bytecode: guardWrapperArtifact.bytecode,
    args: [
      getAddress(governanceAddress),
      initialSigners.map((s) => getAddress(s.toLowerCase())),
      BigInt(requiredApprovals),
      BigInt(tenureLengthSeconds),
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, wrapperAddress: receipt.contractAddress };
}

/**
 * A signer confirms a pending instruction. Executes automatically,
 * on-chain, the moment enough confirmations accumulate - this call
 * itself may or may not be the one that triggers execution, depending
 * on how many other signers already confirmed.
 */
export async function confirmInstruction(client, wrapperAddress, instructionId) {
  const wrapper = wrapperContract(wrapperAddress);
  const hash = await writeWithGasBuffer(client, {
    ...wrapper,
    functionName: "confirmInstruction",
    args: [BigInt(instructionId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** A signer flags an instruction as one that should never execute. */
export async function rejectInstruction(client, wrapperAddress, instructionId) {
  const wrapper = wrapperContract(wrapperAddress);
  const hash = await writeWithGasBuffer(client, {
    ...wrapper,
    functionName: "rejectInstruction",
    args: [BigInt(instructionId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** A signer withdraws their own earlier confirmation, before execution. */
export async function revokeConfirmation(client, wrapperAddress, instructionId) {
  const wrapper = wrapperContract(wrapperAddress);
  const hash = await writeWithGasBuffer(client, {
    ...wrapper,
    functionName: "revokeConfirmation",
    args: [BigInt(instructionId)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}

/** Full detail on one specific instruction - target, value, data, and its current confirm/reject tally. */
export async function getInstruction(wrapperAddress, instructionId) {
  const wrapper = wrapperContract(wrapperAddress);
  const result = await publicClient.readContract({
    ...wrapper,
    functionName: "getInstruction",
    args: [BigInt(instructionId)],
  });
  const [target, value, data, executed, rejected, confirmations, rejections] = result;
  return { target, value, data, executed, rejected, confirmations, rejections };
}

/** The wrapper's current signer set. */
export async function getSigners(wrapperAddress) {
  const wrapper = wrapperContract(wrapperAddress);
  return publicClient.readContract({ ...wrapper, functionName: "getSigners" });
}

/** Whether a given address is currently a signer on this wrapper. */
export async function isSigner(wrapperAddress, address) {
  const wrapper = wrapperContract(wrapperAddress);
  return publicClient.readContract({ ...wrapper, functionName: "isSigner", args: [getAddress(address)] });
}

/** Real-time wrapper state: required approvals, tenure end, current governance and instruction count. */
export async function getWrapperInfo(wrapperAddress) {
  const wrapper = wrapperContract(wrapperAddress);
  const [governance, requiredApprovals, tenureEnd, instructionCount] = await Promise.all([
    publicClient.readContract({ ...wrapper, functionName: "governance" }),
    publicClient.readContract({ ...wrapper, functionName: "requiredApprovals" }),
    publicClient.readContract({ ...wrapper, functionName: "tenureEnd" }),
    publicClient.readContract({ ...wrapper, functionName: "instructionCount" }),
  ]);
  return { governance, requiredApprovals, tenureEnd, instructionCount };
}

/**
 * Once tenure has genuinely ended (enforced on-chain, not by this
 * function), replaces the entire signer set. Only callable by
 * governance - meaning in practice, only reachable via a passed DAO
 * proposal whose action targets the wrapper directly with this
 * encoded call, same as any other governance-gated action.
 */
export async function replaceSigners(client, wrapperAddress, newSigners, newRequiredApprovals) {
  const wrapper = wrapperContract(wrapperAddress);
  const hash = await writeWithGasBuffer(client, {
    ...wrapper,
    functionName: "replaceSigners",
    args: [newSigners.map((s) => getAddress(s.toLowerCase())), BigInt(newRequiredApprovals)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return { hash };
}