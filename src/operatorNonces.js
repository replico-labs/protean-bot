import { getTransactionCount } from "viem/actions";
import { maxPendingTxsForChain } from "./networks.js";

/**
 * The operator's nonce manager. The operator sends for many people at once
 * (DAO creation, gas top-ups, test funding), so each concurrent transaction
 * needs its own nonce - and two chain quirks make viem's default manager
 * fall over:
 *
 * - HyperEVM's mempool only accepts an address's next 8 nonces; a ninth
 *   waiting transaction is refused ("nonce too high"). Here a nonce is only
 *   handed out once fewer than maxPendingTxs of the operator's
 *   transactions are still waiting, so a burst queues up in the bot.
 * - After any failed send viem resets the manager, and the default one
 *   then re-reads the "pending" count - which some nodes report without
 *   the transactions still in their mempool, so the next transaction
 *   reuses a waiting one's nonce ("replacement transaction underpriced").
 *   Here a reset only gives back the nonce that failed, and only when it
 *   was the last one handed out; anything else is re-read from the chain
 *   but never below what's known to be in flight.
 */
export function operatorNonceManager() {
  const state = new Map(); // address.chainId -> { next, handedOut: [nonce...] }
  let queue = Promise.resolve();
  const keyOf = ({ address, chainId }) => `${address.toLowerCase()}.${chainId}`;

  async function waitForRoom(client, address, nonce, limit) {
    for (;;) {
      const mined = await getTransactionCount(client, { address, blockTag: "latest" });
      if (nonce - mined < limit) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return {
    consume({ address, chainId, client }) {
      const run = queue.then(async () => {
        const key = keyOf({ address, chainId });
        const s = state.get(key) ?? { next: 0, handedOut: [] };
        const pending = await getTransactionCount(client, { address, blockTag: "pending" });
        const nonce = Math.max(pending, s.next);
        const limit = maxPendingTxsForChain(chainId);
        if (limit) await waitForRoom(client, address, nonce, limit);
        s.next = nonce + 1;
        s.handedOut = [...s.handedOut.slice(-31), nonce];
        state.set(key, s);
        return nonce;
      });
      queue = run.catch(() => {});
      return run;
    },
    async get({ address, chainId, client }) {
      const s = state.get(keyOf({ address, chainId }));
      const pending = await getTransactionCount(client, { address, blockTag: "pending" });
      return Math.max(pending, s?.next ?? 0);
    },
    increment() {},
    reset({ address, chainId }) {
      // viem doesn't say which send failed. If nothing was handed out after
      // the last nonce, that's the one - give it back so no gap is left.
      const s = state.get(keyOf({ address, chainId }));
      if (s?.handedOut.length && s.handedOut.at(-1) === s.next - 1) {
        s.handedOut.pop();
        s.next -= 1;
      }
    },
  };
}
