import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createWalletClient, http, formatEther, parseEther, formatUnits, parseUnits, getAddress, isAddress } from "viem";
import { publicClient, walletClient, operatorAccount, FACTORY_ADDRESSES, writeWithGasBuffer, deployWithGasLimit } from "./config.js";
import { currentNetwork, scaleBlockFields } from "./networks.js";
import { ensureCanAfford } from "./gasSponsor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadAbi(name) {
  const raw = fs.readFileSync(path.join(__dirname, "abis", `${name}.json`), "utf8");
  return JSON.parse(raw);
}

const abis = {
  Governance: loadAbi("Governance"),
  Treasury: loadAbi("Treasury"),
  StakedGovernanceToken: loadAbi("StakedGovernanceToken"),
  GovernanceToken: loadAbi("GovernanceToken"),
  WelcomeDistributor: loadAbi("WelcomeDistributor"),
  DAOFactory: loadAbi("DAOFactory"),
};

const welcomeDistributorArtifact = loadAbi("WelcomeDistributorArtifact");
const nftMarketplaceWrapperArtifact = loadAbi("NFTMarketplaceWrapperArtifact");

// Mirrors Types.sol's ProposalState enum exactly - order and count matter.
export const PROPOSAL_STATE_LABELS = [
  "Pending",
  "Active",
  "Succeeded",
  "Queued",
  "Defeated",
  "Executed",
  "Cancelled",
  "Expired",
];

export const VOTE_TYPE = { Against: 0, For: 1, Abstain: 2 };

function governance(address) {
  return { address: getAddress(address), abi: abis.Governance };
}

export async function getDaoInfo(governanceAddress) {
  const gov = governance(governanceAddress);

  const [daoName, tokenAddress, treasuryAddress] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "daoName" }),
    publicClient.readContract({ ...gov, functionName: "governanceToken" }),
    publicClient.readContract({ ...gov, functionName: "treasury" }),
  ]);

  const config = await publicClient.readContract({ ...gov, functionName: "governanceConfig" });

  return { daoName, tokenAddress, treasuryAddress, config };
}

export async function getProposalCount(governanceAddress) {
  const gov = governance(governanceAddress);
  const count = await publicClient.readContract({ ...gov, functionName: "proposalCount" });
  return Number(count);
}

export async function getProposal(governanceAddress, proposalId) {
  const gov = governance(governanceAddress);

  const [proposal, stateIndex, quorumVotes, executableAfter] = await Promise.all([
    publicClient.readContract({ ...gov, functionName: "getProposal", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "state", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "quorumVotes", args: [BigInt(proposalId)] }),
    publicClient.readContract({ ...gov, functionName: "executableAfter", args: [BigInt(proposalId)] }),
  ]);

  return {
    ...proposal,
    stateLabel: PROPOSAL_STATE_LABELS[Number(stateIndex)] ?? "Unknown",
    quorumVotes,
    executableAfter,
  };
}

export async function getTreasuryBalance(treasuryAddress) {
  const ethBalance = await publicClient.readContract({
    address: getAddress(treasuryAddress),
    abi: abis.Treasury,
    functionName: "ethBalance",
  });
  return formatEther(ethBalance);
}

export async function getVotingPower(tokenAddress, account) {
  const token = { address: getAddress(tokenAddress), abi: abis.StakedGovernanceToken };

  const [staked, votes, delegatedTo] = await Promise.all([
    publicClient.readContract({ ...token, functionName: "balanceOf", args: [getAddress(account)] }),
    publicClient.readContract({ ...token, functionName: "getVotes", args: [getAddress(account)] }),
    publicClient.readContract({ ...token, functionName: "delegates", args: [getAddress(account)] }),
  ]);

  return {
    staked: formatEther(staked),
    activeVotes: formatEther(votes),
    delegatedTo,
  };
}

export async function getDistributorInfo(distributorAddress) {
  const dist = { address: getAddress(distributorAddress), abi: abis.WelcomeDistributor };

  const [amountPerClaim, remainingCapacity, balance] = await Promise.all([
    publicClient.readContract({ ...dist, functionName: "amountPerClaim" }),
    publicClient.readContract({ ...dist, functionName: "remainingCapacity" }),
    publicClient.readContract({ ...dist, functionName: "balance" }),
  ]);

  return {
    amountPerClaim: formatEther(amountPerClaim),
    remainingCapacity: formatEther(remainingCapacity),
    balance: formatEther(balance),
  };
}

export async function hasAlreadyClaimed(distributorAddress, memberAddress) {
  return publicClient.readContract({
    address: getAddress(distributorAddress),
    abi: abis.WelcomeDistributor,
    functionName: "hasClaimed",
    args: [getAddress(memberAddress)],
  });
}

/**
 * Distributes the welcome grant to `memberAddress` via the operator wallet.
 * Throws if OPERATOR_PRIVATE_KEY isn't configured - callers should check
 * `operatorAccount` is non-null before calling, or catch and surface a
 * clear message.
 */
export async function distributeWelcomeGrant(distributorAddress, memberAddress) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }

  const hash = await writeWithGasBuffer(walletClient, {
    address: getAddress(distributorAddress),
    abi: abis.WelcomeDistributor,
    functionName: "distribute",
    args: [getAddress(memberAddress)],
  });

  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// Same defaults as script/CreateDAO.s.sol, kept in sync deliberately - see
// that script if you want to understand what each field means.
const DEFAULT_GOVERNANCE_CONFIG = {
  quorumBps: 1_000,
  approvalThresholdBps: 6_000,
  votingDelay: 1,
  votingPeriod: 50_400,
  timelockDelay: 60n * 60n * 24n, // 1 day, seconds
  executionPeriod: 60n * 60n * 24n * 7n, // 7 days, seconds
  proposalThreshold: 0n,
};

/**
 * Creates a DAO via the factory using the bot's operator wallet.
 *
 * NOTE: the operator wallet becomes both `creator` and the recipient of
 * the entire initial token supply - this is the bot-operator shortcut
 * (Option B from earlier discussion), not the "correct" flow where a
 * user's own linked wallet creates the DAO. Fine for now; the plan is to
 * move DAO creation to protean-connect once that's built out further, at
 * which point the initial supply would go to the actual creator's wallet.
 */
export async function createDaoOnChain(name, symbol, initialSupplyWhole, maxSupplyWhole) {
  if (!walletClient || !operatorAccount) {
    throw new Error("OPERATOR_PRIVATE_KEY is not configured on this bot instance");
  }
  const FACTORY_ADDRESS = FACTORY_ADDRESSES.tokenWeighted;
  if (!FACTORY_ADDRESS) {
    throw new Error(`No tokenWeighted factory configured for ${currentNetwork().chain.name} on this bot instance`);
  }

  const hash = await writeWithGasBuffer(walletClient, {
    address: getAddress(FACTORY_ADDRESS),
    abi: abis.DAOFactory,
    functionName: "createDAO",
    args: [
      name,
      symbol,
      parseEther(String(initialSupplyWhole)),
      parseEther(String(maxSupplyWhole)),
      scaleBlockFields("tokenWeighted", DEFAULT_GOVERNANCE_CONFIG),
    ],
  });

  await publicClient.waitForTransactionReceipt({ hash });

  const daoCount = await publicClient.readContract({
    address: getAddress(FACTORY_ADDRESS),
    abi: abis.DAOFactory,
    functionName: "daoCount",
  });

  const [, , governanceToken, underlyingToken, governance, treasury] = await publicClient.readContract({
    address: getAddress(FACTORY_ADDRESS),
    abi: abis.DAOFactory,
    functionName: "daos",
    args: [daoCount],
  });

  return { hash, governance, governanceToken, underlyingToken, treasury };
}

/*//////////////////////////////////////////////////////////////
            PER-USER WALLET ACTIONS (derived wallets)
//////////////////////////////////////////////////////////////*/

function walletClientFor(account) {
  return createWalletClient({ account, chain: currentNetwork().chain, transport: http() });
}

/**
 * Makes sure `account` holds at least the network's minimum gas balance
 * (or its full first-time allowance with `forceFullTopup`), topped up from
 * the operator wallet. See gasSponsor.js for the per-transaction funding
 * that actually guarantees a transaction can be paid for.
 */
export async function ensureGasFunded(account, forceFullTopup = false) {
  // Kept for existing callers as a cheap "has some gas" pre-check. The real
  // guarantee is per transaction: writeWithGasBuffer and sendNativeSponsored
  // fund each one for its own up-front cost (gasSponsor.js), which is what
  // stops a wallet being judged funded while every transaction is rejected.
  const { gas } = currentNetwork();
  await ensureCanAfford(account.address, forceFullTopup ? gas.first : gas.min);
}

/**
 * Approves and stakes `amountWhole` of the underlying token into the
 * staking wrapper, signed by `account` (the user's own derived wallet).
 * Two on-chain transactions: approve, then stake.
 */
export async function stakeTokens(account, stakingTokenAddress, amountWhole) {
  const client = walletClientFor(account);
  const amount = parseEther(String(amountWhole));

  const underlyingAddress = await publicClient.readContract({
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "underlying",
  });

  const approveHash = await writeWithGasBuffer(client, {
    address: underlyingAddress,
    abi: abis.GovernanceToken,
    functionName: "approve",
    args: [getAddress(stakingTokenAddress), amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // Two separate transactions here, only one gas check before both -
  // if approve's own gas cost isn't yet reflected in the wallet's
  // balance by the time this second transaction's own gas estimation
  // runs (the same mined-vs-visible race already fixed once in
  // ensureGasFunded itself), the stake call can genuinely fail on gas
  // even though approve just succeeded. Re-checking here is cheap in
  // the common case - ensureGasFunded returns immediately once the
  // balance is already sufficient - and closes this exact gap.
  await ensureGasFunded(account);

  const stakeHash = await writeWithGasBuffer(client, {
    address: getAddress(stakingTokenAddress),
    abi: abis.StakedGovernanceToken,
    functionName: "stake",
    args: [amount],
  });
  await publicClient.waitForTransactionReceipt({ hash: stakeHash });

  return { approveHash, stakeHash };
}

/**
 * Creates a single-action proposal, signed by `account`.
 */
export async function proposeOnChain(account, governanceAddress, target, value, data, metadataURI) {
  const client = walletClientFor(account);

  const actions = [{ target: getAddress(target), value: parseEther(String(value || "0")), data: data || "0x" }];

  const hash = await writeWithGasBuffer(client, {
    address: getAddress(governanceAddress),
    abi: abis.Governance,
    functionName: "propose",
    args: [actions, metadataURI],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // Proposal count right after this tx reflects the new proposal's ID,
  // since IDs are sequential and this account just created the latest one.
  const proposalId = await publicClient.readContract({
    address: getAddress(governanceAddress),
    abi: abis.Governance,
    functionName: "proposalCount",
  });

  return { hash, receipt, proposalId };
}

/**
 * Casts a vote, signed by `account`. `support` is 0=Against, 1=For, 2=Abstain.
 */
export async function castVoteOnChain(account, governanceAddress, proposalId, support) {
  const client = walletClientFor(account);

  const hash = await writeWithGasBuffer(client, {
    address: getAddress(governanceAddress),
    abi: abis.Governance,
    functionName: "castVote",
    args: [BigInt(proposalId), support],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { hash };
}

function stakedToken(address) {
  return { address: getAddress(address), abi: abis.StakedGovernanceToken };
}

function underlyingToken(address) {
  return { address: getAddress(address), abi: abis.GovernanceToken };
}

/** The DAO's registered creator address - /tip's authorization check reads this. */
export async function getDaoCreator(governanceAddress) {
  return publicClient.readContract({ ...governance(governanceAddress), functionName: "creator" });
}

/**
 * Resolves the DAO's own underlying (raw, transferable) governance
 * token address - the StakedGovernanceToken wrapper holds voting power,
 * but tipping and everyday balances are about the underlying token
 * itself, which is what people can actually hold, transfer, and spend.
 */
export async function getUnderlyingTokenAddress(governanceAddress) {
  const stakedTokenAddress = await publicClient.readContract({ ...governance(governanceAddress), functionName: "governanceToken" });
  return publicClient.readContract({ ...stakedToken(stakedTokenAddress), functionName: "underlying" });
}

/**
 * Resolves a token reference to a real address - either the reference
 * already IS a valid address (used as-is), or it's treated as a ticker
 * and matched (case-insensitively) against the DAO's own underlying
 * token's real, on-chain symbol(). There's no separate ticker registry:
 * "the DAO's own token" is the only ticker this currently resolves,
 * since it's the only token this bot has any other relationship with.
 * Throws with a clear, specific message on no match, rather than
 * silently falling back to something unexpected.
 */
export async function resolveTokenReference(governanceAddress, reference) {
  if (isAddress(reference)) return getAddress(reference);

  const underlyingAddress = await getUnderlyingTokenAddress(governanceAddress);
  const symbol = await publicClient.readContract({ ...underlyingToken(underlyingAddress), functionName: "symbol" });

  if (symbol.toLowerCase() === reference.toLowerCase()) return underlyingAddress;

  throw new Error(`"${reference}" isn't a valid address and doesn't match this DAO's token symbol (${symbol})`);
}

/**
 * Sends `amountWhole` of `tokenAddress` (the DAO's underlying token, or
 * any other ERC20 sharing this ABI's transfer signature) from `client`
 * to `recipientAddress`. No authorization check here - by design,
 * matching this file's existing pattern (see castVoteOnChain,
 * stakeTokens): callers decide who's allowed to call this and with
 * which client; this function only executes what it's asked.
 */
export async function tipTokens(client, tokenAddress, recipientAddress, amountWhole) {
  const token = underlyingToken(tokenAddress);
  // Any ERC20 can be sent, so scale by its own decimals (USDC has 6).
  const [decimals, symbol, held] = await Promise.all([
    tokenDecimalsOf(tokenAddress),
    publicClient.readContract({ ...token, functionName: "symbol" }).catch(() => "tokens"),
    publicClient.readContract({ ...token, functionName: "balanceOf", args: [client.account.address] }),
  ]);
  const amount = parseUnits(String(amountWhole), decimals);
  if (held < amount) {
    const err = new Error(`You hold ${formatUnits(held, decimals)} ${symbol} in ${client.account.address} - not enough to send ${amountWhole}.`);
    err.userFacing = true;
    throw err;
  }

  const hash = await writeWithGasBuffer(client, {
    ...token,
    functionName: "transfer",
    args: [getAddress(recipientAddress), amount],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  return { hash };
}

/** Raw ERC20 balanceOf on any token sharing GovernanceToken's ABI, formatted as a whole-token string. */
export async function getTokenBalance(tokenAddress, holderAddress) {
  const [balance, decimals] = await Promise.all([
    publicClient.readContract({ ...underlyingToken(tokenAddress), functionName: "balanceOf", args: [getAddress(holderAddress)] }),
    tokenDecimalsOf(tokenAddress),
  ]);
  return formatUnits(balance, decimals);
}

/** An ERC20's decimals (18 when it doesn't say). */
export async function tokenDecimalsOf(tokenAddress) {
  try {
    return Number(await publicClient.readContract({ ...underlyingToken(tokenAddress), functionName: "decimals" }));
  } catch {
    return 18;
  }
}

/** Reads a token's real on-chain symbol - for display labels, not resolution (see resolveTokenReference for that). */
export async function getTokenSymbol(tokenAddress) {
  return publicClient.readContract({ ...underlyingToken(tokenAddress), functionName: "symbol" });
}

/**
 * Deploys a fresh WelcomeDistributor for a DAO, closing the gap where
 * the only way to get one live was a manual `forge script` run outside
 * the bot entirely. `operator_` (the address WelcomeDistributor itself
 * authorizes to call its distribute function - confirmed directly from
 * the contract's own onlyOperator check, not assumed) is always this
 * bot's own operator wallet, since that's who actually calls
 * distributeWelcomeGrant elsewhere in this file - a distributor
 * deployed with any other operator address would be permanently
 * uncallable by this bot.
 *
 * Real, verified bytecode - extracted directly from compiling
 * WelcomeDistributor.sol against the actual OpenZeppelin v5.6.1
 * IERC20/SafeERC20 it imports, not assumed or hand-written.
 *
 * Deliberately does NOT fund the new distributor or call /setdistributor
 * for the caller - those are separate, visible steps (transfer tokens to
 * it, then /setdistributor its address) rather than silently bundled in.
 */
export async function deployWelcomeDistributor(client, tokenAddress, governanceAddress, amountPerClaimWhole, distributionCapWhole) {
  const hash = await deployWithGasLimit(client, {
    abi: welcomeDistributorArtifact.abi,
    bytecode: welcomeDistributorArtifact.bytecode,
    args: [
      getAddress(tokenAddress),
      getAddress(governanceAddress),
      operatorAccount.address,
      parseEther(String(amountPerClaimWhole)),
      parseEther(String(distributionCapWhole)),
    ],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, distributorAddress: receipt.contractAddress };
}

/**
 * Deploys a fresh NFTMarketplaceWrapper for a DAO - one per DAO, not
 * shared, since this one holds the DAO's NFTs. Real,
 * verified bytecode - extracted directly from compiling
 * NFTMarketplaceWrapper.sol against the actual installed OpenZeppelin
 * package, not assumed or hand-written.
 */
export async function deployNftWrapper(client, governanceAddress, treasuryAddress) {
  const hash = await deployWithGasLimit(client, {
    abi: nftMarketplaceWrapperArtifact.abi,
    bytecode: nftMarketplaceWrapperArtifact.bytecode,
    args: [getAddress(governanceAddress), getAddress(treasuryAddress)],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, wrapperAddress: receipt.contractAddress };
}

export { formatEther };