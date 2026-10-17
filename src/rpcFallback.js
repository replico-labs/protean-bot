import { createTransport } from "viem";

/**
 * Several RPCs for one network, used in order: every request goes to the
 * first one that's up; one that fails (times out, refuses, runs out of
 * credits) is skipped for `cooldownMs` and the next takes the request. Once
 * the cooldown passes it's tried first again.
 *
 * viem's own fallback() tries the first RPC first on every request, so a
 * provider that hangs costs every call its full timeout before the backup
 * answers; this pays it once a minute.
 *
 * Only failures of the RPC itself switch: a reverted call or a bad
 * argument is the same answer from any node, so it's thrown as is.
 */
export function stickyFallback(transports, { cooldownMs = 60_000, log = console } = {}) {
  // Shared by every client built from this transport (one per user wallet,
  // per command), so they all skip the same failing RPC.
  const downUntil = transports.map(() => 0);
  return (options) => {
    const instances = transports.map((transport) => transport(options));
    const label = (i) => {
      try {
        return new URL(instances[i].value?.url ?? "").host || `RPC #${i + 1}`;
      } catch {
        return `RPC #${i + 1}`;
      }
    };

    return createTransport({
      key: "stickyFallback",
      name: "Sticky fallback",
      type: "stickyFallback",
      retryCount: 0, // each RPC retries on its own; switching is the retry here
      async request(args) {
        const now = Date.now();
        // Healthy ones in configured order, then the cooling ones (soonest back first).
        const order = instances.map((_, i) => i).sort((a, b) => (downUntil[a] > now) - (downUntil[b] > now) || (downUntil[a] > now ? downUntil[a] - downUntil[b] : a - b));
        let lastError;
        for (const i of order) {
          try {
            const result = await instances[i].request(args);
            if (downUntil[i]) {
              downUntil[i] = 0;
              log.log(`RPC ${label(i)} is answering again.`);
            }
            return result;
          } catch (err) {
            if (!isRpcFailure(err)) throw err;
            lastError = err;
            if (downUntil[i] <= Date.now() && instances.length > 1) {
              log.warn(`RPC ${label(i)} failed (${err.shortMessage ?? err.message}) - using the next one for ${cooldownMs / 1000}s.`);
            }
            downUntil[i] = Date.now() + cooldownMs;
          }
        }
        throw lastError;
      },
    });
  };
}

// The node's answer about the request itself - the same from every RPC.
// Includes "method not found": viem probes optional methods (eth_fillTransaction)
// and handles the refusal itself.
const SAME_EVERYWHERE = /execution reverted|revert|invalid argument|invalid params|nonce too low|already known|insufficient funds|replacement transaction|intrinsic gas|does not exist|method not found|not supported/i;

/** Whether `err` is the RPC failing (switch to the next) rather than an answer. */
function isRpcFailure(err) {
  const text = `${err?.shortMessage ?? ""} ${err?.details ?? ""} ${err?.message ?? ""}`;
  const name = err?.name ?? "";
  if (/HttpRequestError|TimeoutError|WebSocketRequestError|SocketClosedError/.test(name)) return true;
  if (err?.status === 429 || err?.status >= 500) return true;
  if (err?.walk?.((e) => e.code === -32601) || SAME_EVERYWHERE.test(text)) return false;
  // Plans and quotas: "limit exceeded", "out of credits", "limited to a 5 range", "Too Many Requests", unavailable.
  return /limit|exceeded|credit|quota|too many|unavailable|timed? ?out|internal error/i.test(text);
}
