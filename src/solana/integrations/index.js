import * as jito from "./jito.js";
import * as marinade from "./marinade.js";
import * as juplend from "./juplend.js";
import * as pumpfun from "./pumpfun.js";
import * as jupiter from "./jupiter.js";
import * as phoenix from "./phoenix.js";

/** Every Solana protocol integration (src/solana/integrations/*), for actions.js and the verify script. */
export const PROTOCOLS = [jito, marinade, juplend, pumpfun, jupiter, phoenix];

/**
 * Their /proposeaction actions, merged into actions.js's ACTIONS, each
 * marked with the clusters its protocol is pinned on (`networks`), and
 * whether its proposals need v1 transactions (`needsV1Transactions`: only
 * offered where the network has them on) or Vortexes' fill program
 * (`needsFillProgram`: only where the network sets it).
 */
export const INTEGRATION_ACTIONS = Object.assign(
  {},
  ...PROTOCOLS.map((p) =>
    Object.fromEntries(Object.entries(p.actions).map(([id, a]) => [id, { ...a, protocol: p.protocol.id, networks: Object.keys(p.protocol.deployments), needsV1Transactions: Boolean(p.protocol.needsV1Transactions), needsFillProgram: Boolean(p.protocol.needsFillProgram) }]))
  )
);
