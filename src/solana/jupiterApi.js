import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/**
 * Jupiter's Swap API (v1): quotes, and a route's instructions for the fill
 * keeper. Without JUPITER_API_KEY it uses the free endpoint
 * (lite-api.jup.ag); with one, the paid endpoint (api.jup.ag) with the key
 * in `x-api-key`. Request and response fields as in Jupiter's own client
 * (@jup-ag/api: QuoteResponse, SwapRequest, SwapInstructionsResponse).
 * Jupiter routes on mainnet only.
 */

const KEY = process.env.JUPITER_API_KEY?.trim() || null;
const BASE = KEY ? "https://api.jup.ag/swap/v1" : "https://lite-api.jup.ag/swap/v1";
const headers = { "content-type": "application/json", ...(KEY ? { "x-api-key": KEY } : {}) };

async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Jupiter ${path.split("?")[0]}: ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  return JSON.parse(text);
}

/** The best route for `amount` (raw) of `inputMint` into `outputMint`; `outAmount` is a string of raw units. */
export async function quote(inputMint, outputMint, amount, slippageBps = 50) {
  const q = new URLSearchParams({ inputMint: inputMint.toBase58(), outputMint: outputMint.toBase58(), amount: amount.toString(), slippageBps: String(slippageBps) });
  return call(`/quote?${q}`);
}

const instruction = (ix) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });

/**
 * A quoted route's instructions, swapping `user`'s tokens and sending the
 * output to `destination` (an existing token account). SOL is never
 * wrapped or unwrapped here: the input is already wrapped SOL in the
 * user's account, and wrapped SOL output stays wrapped.
 * Returns { computeBudget, setup, swap, cleanup, lookupTables }.
 */
export async function swapInstructions(quoteResponse, user, destination) {
  const r = await call("/swap-instructions", {
    method: "POST",
    body: JSON.stringify({ quoteResponse, userPublicKey: user.toBase58(), destinationTokenAccount: destination.toBase58(), wrapAndUnwrapSol: false, dynamicComputeUnitLimit: true }),
  });
  return {
    computeBudget: (r.computeBudgetInstructions ?? []).map(instruction),
    setup: (r.setupInstructions ?? []).map(instruction),
    swap: instruction(r.swapInstruction),
    cleanup: r.cleanupInstruction ? [instruction(r.cleanupInstruction)] : [],
    lookupTables: (r.addressLookupTableAddresses ?? []).map((a) => new PublicKey(a)),
  };
}
