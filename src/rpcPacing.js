/**
 * Keeps each process inside an RPC's request rate. Public RPCs cap
 * requests per second (Monad testnet's public one: 15/s per address), and
 * every bot process on one host shares that cap - so a busy moment, or ten
 * things at once, gets "Too Many Requests" or "requests limited to 15/sec"
 * back, and viem gives up on the second (it isn't an HTTP 429).
 *
 * pacedFetch spaces requests to one RPC out to at most `perSecond`, and
 * when the RPC still says it's overloaded - an HTTP 429, or a JSON-RPC
 * error about a rate limit - waits and sends the same request again, a few
 * times, backing off.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextSlot = new Map(); // rpc url -> earliest time the next request may go
const RETRIES = 6;

async function waitTurn(url, perSecond) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(url) ?? 0);
  nextSlot.set(url, at + 1000 / perSecond);
  if (at > now) await sleep(at - now);
}

const RATE_LIMITED = /too many requests|rate limit|limited to \d+|exceeded .*limit|request limit/i;

/** Whether a 200 response is really the RPC refusing for load (some send that as a JSON-RPC error). */
async function refusedForLoad(res) {
  if (res.status === 429) return true;
  if (!res.ok) return false;
  const length = Number(res.headers.get("content-length"));
  if (length > 4096) return false; // a real result, not an error object
  const text = await res.clone().text();
  return text.includes('"error"') && RATE_LIMITED.test(text);
}

/** A fetch for viem's http transport that paces requests to `url` and retries load refusals. */
export function pacedFetch(url, perSecond) {
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      await waitTurn(url, perSecond);
      const res = await fetch(input, init);
      if (attempt >= RETRIES || !(await refusedForLoad(res))) return res;
      // Back off: 0.5s, 1s, 2s, 4s... plus jitter, so processes don't retry in step.
      await sleep(500 * 2 ** attempt + Math.random() * 250);
    }
  };
}
