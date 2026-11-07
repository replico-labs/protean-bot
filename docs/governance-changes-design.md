# Token changes, switching and the security council: design

Status: **built and tested locally** (decisions in section 8 agreed; see section 9 for where the build differs). Not yet deployed to the testnets or devnet. Covers Spaces (EVM), Vortexes (Solana) and the bot.

## Goals

1. A DAO can change its token without changing its governance, and nothing breaks.
2. A DAO can switch between any two models, Board included, in either direction, as often as it likes.
3. Both work whether or not the token has changed in between.
4. Members' stake survives a model switch untouched, on both chains.
5. A security council (GuardWrapper) can be turned on or off in one proposal, and stays in place through switches and token changes.
6. Wrappers are cheap to create.

## The pieces

| | EVM (Spaces) | Solana (Vortexes) |
|---|---|---|
| Treasury | `Treasury`, one per DAO, unchanged | The hub's treasury PDA, unchanged |
| DAO record | The governance's own fields (`treasury`, `governanceToken`) | The hub's `Dao` and `DaoToken` records |
| Stake pool | `StakedGovernanceToken`, one per DAO per token | **New:** a `vortex-stake` program, one pool per DAO per token |
| Governance | One contract per switch (factory clone) | **Changed:** one account per switch (epoch in its address) |
| Security council | `GuardWrapper`, **now a clone** made by a `WrapperFactory` | **New:** an optional council on the hub's `Dao` record |
| NFT wrapper | `NFTMarketplaceWrapper`, **now a clone** | not applicable |

Rules that hold everywhere:

- **Stake belongs to the DAO, not to a governance.** A governance reads voting power from the DAO's current pool and owns no stake.
- **A proposal fixes its pool when it's created.** Votes, quorum and payouts for that proposal always use that pool, whatever happens after.
- **A DAO has one current pool, and may have older ones.** Older pools are withdraw-only: no new stake, no voting power for new proposals, but members can always take their tokens out.
- **Every new governance is set up against the DAO's current token.** It can't start on an old one.

---

## 1. Changing the token

### EVM, step by step

Starting point: governance G, staking contract S1 (wrapping token A), Treasury T.

1. **One proposal**, with these actions in order:
   1. `factory.createStaking(tokenB, salt)`: clones a new `StakedGovernanceToken` S2 wrapping token B, owned by G (or by the wrapper, see section 4), at a predicted address.
   2. Conviction only: `S2.setAuthorizedLocker(G)`.
   3. `G.setGovernanceToken(S2)`.
   4. Optional: `converter.setup(S1, S2, rate)`, funded from T (see the converter below).
2. **It passes and executes** atomically. From now on new proposals use S2.
3. **Open proposals** keep using S1 for votes, quorum and (for Decision Markets) payouts and refunds, because each stored its token when it was created.
4. **Members move their stake:** unstake A from S1, which keeps working, then stake B into S2. With a converter, it's one call that does both, or nothing at all if the DAO runs the conversion for them.
5. The bot reads `governanceToken()` from the chain, so it follows by itself.

Contract changes:
- Every governance stores the voting token in each proposal at creation (`p.token`) and uses it in `castVote`, quorum and state. `Governance.sol:161, 222, 365, 383, 409` and their copies in each model.
- `DecisionMarketsGovernance` stores the base token per proposal and uses it in `cancel` (refund, `:491`) and `reclaimLiquidity` (`:525`).
- `BoardGovernance` gets `governanceToken`, `staking` and `setGovernanceToken`: it doesn't vote with them, but stores them so a token change can happen while on Board, and the next switch carries them.
- `StakedGovernanceToken` gets `stakeFor(account, amount)` so a converter can stake on a member's behalf.
- Every factory gets `createStaking(token, salt)` and `predictStaking(...)`.

### Solana, step by step

Starting point: DAO D on governance G (epoch n), pool P1 for mint A, the hub's `DaoToken` record says A and P1.

1. **One proposal**, run by the hub with the treasury's signature:
   1. `stake.create_pool(D, mintB)`: opens pool P2 for mint B. Only the DAO's treasury can create its pools.
   2. `hub.set_dao_token(mintB, P2)`: the record now says B and P2, and P1 is marked withdraw-only. This works whatever model is running, Board included.
   3. Optional: converter setup, funded from the treasury.
2. **It passes and executes.** G doesn't change: it reads the current pool from the hub's record each time someone proposes.
3. **Open proposals** keep P1, which each stored when it was created.
4. **Members move their stake** from P1 to P2, by hand or through the converter.

### The converter (optional, both chains)

The DAO votes a rate (old per new, e.g. 1:1) and funds it with token B from the Treasury.

- A member calls `convert(amount)`. Their old stake is taken out of the old pool, the old tokens go to the Treasury, and the same value of B, at the rate, is staked into the new pool for them, in one step.
- It only converts what's funded. When it runs out, the DAO tops it up by proposal or closes it.
- The DAO can close it by proposal, returning what's left to the Treasury.

---

## 2. Switching models

### EVM, step by step (no council)

Starting point: governance G1 (any model), Treasury T, token GT, staking S.

1. **One proposal on G1** (as today, `src/modelSwitch.js`):
   1. `factoryOfNewModel.createForSwitch(name, T, GT, S, config, …, expected)`: deploys G2 at the predicted address.
   2. `T.transferGovernance(G2)`.
   3. `GT.transferOwnership(G2)`.
   4. `S.setAuthorizedLocker(G2 for Conviction, else 0)`.
   5. `S.transferOwnership(G2)`.
2. **It executes atomically.** G2 runs the DAO. Members' stake in S doesn't move.
3. **G1's open proposals die:** G1 no longer controls anything.

What changes:
- **Board in either direction:** Board now stores GT and S. A switch from Board passes them on, instead of the bot walking back through earlier governances to find them (`daoTokens`, `src/modelSwitch.js:96`).
- **A DAO that started as Board** can switch into a token model. The switch proposal's first action creates the token and staking contract, or wraps an existing ERC20, before `createForSwitch`:
  - `factory.createTokenForSwitch(name, symbol, supply, T)`: clones GovernanceToken (supply minted to the Treasury) and StakedGovernanceToken.
  - or `factory.createStaking(existingToken, salt)`.
- **Token changed while on Board:** Board's `setGovernanceToken` updates what it stores, and the next switch uses it.

### Solana, step by step (no council)

Starting point: DAO D on program X, governance account G1 at `[governance, D, n]`, current pool P.

1. **A proposal on G1:** `hub.propose_switch(Y)` (Y may be any approved program, including one D used before, or even X itself).
2. **Set up the new governance** (anyone, any time during the delay): `Y.init_governance(D, config)` creates G2 at `[governance, D, n+1]`. Token models check the hub's record and read its current pool. Board gets its signers.
3. **After the 2-day delay,** anyone calls `hub.apply_switch()`. The hub checks G2 is at the address for epoch n+1 in program Y, points D at it, and moves to epoch n+1.
4. **G1's open proposals die** (wrong epoch). Members' stake in P doesn't move.

What changes:
- **The governance address includes the epoch.** Every switch makes a fresh account, so going back to an earlier model, or to the same model, always starts clean, with the current token and the signers it's given. This fixes switching back reusing old state.
- **The hub no longer refuses a switch to the running program** (`AlreadyActive`, `programs/hub/src/lib.rs:179`).
- **Stake lives in the pool,** so there's no `/migrate` after a switch.

### What still ends at a switch, by design

Open proposals, a Board's or council's signers (named again for the new model), Conviction support (released by members on the old governance), open Decision Markets positions and Sowellian bonds (settled on the old governance), and on Solana, Liquid's delegations.

The bot checks before proposing a switch, lists anything still open, and asks the proposer to settle it first or confirm leaving it.

---

## 3. Stake pools on Solana (new program `vortex-stake`)

- **Pool:** `[pool, D, mint]`, holding the vault for that mint, the DAO, total staked, and whether it's current or withdraw-only.
- **Member stake:** `[stake, pool, member]`: amount and total locked.
- **Locks:** `[lock, pool, member, locker]`: what one governance has locked. Only that governance can release it, even after a switch, matching EVM's `lockedBy`.
- **Who can lock:** only the DAO's current governance, signing with its account. The pool checks against the hub's `Dao` record.
- **Voting:** token models vote-lock instead of snapshotting, as now: a member who votes can't withdraw until every proposal they voted on has closed. The lock moves from each model's vault into the pool.
- **Quadratic and others** read the member's amount from the pool and apply their own weight, e.g. √n.
- **Withdraw:** any time, for the unlocked amount, from current and withdraw-only pools alike.

Every token model loses its vault, `deposit` and `withdraw`, and reads stake from the pool. Decision Markets keeps its per-proposal collateral vaults, which aren't stake.

---

## 4. The security council

### EVM, step by step

**Turning it on: one proposal**
1. `wrapperFactory.createGuardWrapper(G, signers, required, tenure, salt)`: clones a GuardWrapper W at a predicted address.
2. `T.transferGovernance(W)`.
3. `GT.transferOwnership(W)`.
4. `S.transferOwnership(W)`. The locker stays G (Conviction) or none.

All four succeed or fail together.

**After that:** members vote, stake and support as normal. A passed proposal that touches T, GT or S is sent to W (`proposeInstruction`), the council confirms or rejects, and W carries it out. `/proposeaction` already routes Treasury and token actions this way.

**Changing the token with a council:** the same steps as section 1, but S2 is created owned by W, and `G.setGovernanceToken(S2)` is a call on G itself, which doesn't need the council. Funding a converter from T goes through the council.

**Switching with a council:**
1. A proposal on G1:
   1. `createForSwitch(...)`: the factory now also accepts a caller whose Treasury answers to a wrapper that answers to the caller.
   2. `W.proposeBatch([W.setGovernance(G2), S.setAuthorizedLocker(G2 or 0)])`.
2. The council confirms the batch, and W points at G2 in one step. T, GT and S stay owned by W and never move.
3. If the council rejects, G2 exists but controls nothing; nothing has changed.

**Turning it off:** a proposal sends W a batch (`T.transferGovernance(G)`, `GT.transferOwnership(G)`, `S.transferOwnership(G)`), which the council confirms. If the council refuses, the DAO replaces the signers once their tenure ends (no council confirmation needed, as today), then turns it off.

**GuardWrapper changes:** `initialize` instead of a constructor (clone-ready), and `proposeBatch`, so several calls are confirmed and run together.

### Solana, step by step

The council lives on the hub's `Dao` record: signers, required approvals, tenure.

1. **Turning it on:** a proposal calls `hub.set_council(signers, required, tenure)`, signed by the treasury. One instruction, so it's atomic.
2. **After that:** when a proposal passes, `hub.execute` records it as waiting for the council instead of running it. Council members call `hub.council_confirm` (or `council_reject`); once enough confirm, anyone runs it.
3. **Switching and token changes** are ordinary proposals that go through the council the same way. The council belongs to the DAO, not the model, so it survives every switch.
4. **Turning it off:** a proposal calling `hub.clear_council()`, which the council confirms, or replacing the signers after their tenure with no confirmation, matching EVM.

---

## 5. Cheap wrappers on EVM

- GuardWrapper and NFTMarketplaceWrapper become EIP-1167 clones, like governance and the Treasury: one implementation per network, a tiny proxy per DAO, `initialize(...)` once, the implementation's own initializer locked.
- A `WrapperFactory` per network creates them at predicted addresses, which is what makes the one-proposal handover possible.
- They aren't shared contracts like the Pyth adapters, because they hold DAO assets: each DAO keeps its own address and storage, so a problem stays inside one DAO.

---

## 6. Bot changes

- `/settoken <token> [rate=…]`: builds the token-change proposal for the chat's chain, with an optional converter.
- `/convert`: a member converts their old stake.
- `/switchmodel`: any model in either direction, Board included; with a council, builds the batch; checks for open items first.
- `/council on|off|replace`: replaces `/deployguardwrapper` and `/handovertowrapper` with one-proposal flows on both chains.
- `/deploynftwrapper` uses the factory.
- Solana: stake through the pool, no `/migrate` after a switch, governance addresses with the epoch, IDLs re-extracted.

---

## 7. Deployment

Nothing is on mainnet, so this is the time.

**EVM, redeploy on each testnet** (Monad testnet, Base Sepolia, HyperEVM testnet):
- New implementations: every governance, StakedGovernanceToken, GuardWrapper, NFTMarketplaceWrapper, the converter.
- New factories and a WrapperFactory, with the same deploy scripts.
- Treasury and GovernanceToken are unchanged.
- The bot's factory env vars are updated. Old testnet DAOs aren't carried over; fresh ones are made for testing.

**Solana, upgrade in place on devnet:**
- The hub and every model are upgraded at the same addresses (`scripts/upgrade-devnet.sh`), and `vortex-stake` is deployed as a new program and approved where the hub needs it.
- Account layouts change, so devnet DAOs are made fresh.

**Then:** every lifecycle test, every switch test (all pairs, including Board both ways and back to a model already used), token changes with open proposals and with a converter, the council on and off and through a switch, and the smoke test on devnet.

---

## 8. Decisions

1. **Converter:** in this round.
2. **Locks need the member's consent:** yes. A governance can only lock stake the member committed to it (by voting or supporting).
3. **`reclaimLiquidity`** (EVM Decision Markets) pays the **proposer**, as the code does; its comment is corrected to say so.
4. **Solana's 2-day switch delay:** kept.
5. **Board-born DAO into a token model:** both, create a new token or adopt an existing one.
6. **Turning the council off needs the council,** or a tenure-based replacement of the signers first. Kept.
7. **Same-model switch** (a fresh copy of the running model): allowed on both chains.

---

## 9. As built

Where the code differs from the plan above:

- **Solana pools:** anyone may create a DAO's pool for a mint (`create_pool`); it's inert until the treasury points the DAO at it with `set_dao_token`. Locks are keyed `[lock, stake, governance]`.
- **Solana council:** a passed proposal goes to the council with `hub.submit_to_council` (the bot's `/execute` does this when a council is set), and a confirmed one runs with `hub.run_confirmed`. Waiting proposals live at `[waiting, dao, proposal]`.
- **Solana per-mint vaults:** the optimistic bond vault, the Sowellian escrow and the Decision Markets base vault include the mint in their seeds, so proposals opened before a token change keep paying out in the old token.
- **Solana converter:** `open_converter(rate_num, rate_den, fund)` funds it from the treasury in the same instruction, so a token change with its converter fits one legacy proposal transaction (with a description of about 60 characters or fewer). Otherwise the bot proposes the converter after the change with `openconverter`; `fundconverter` tops it up.
- **Sortition:** its draw pool account is named `DrawPool`, so it doesn't clash with the stake program's `Pool` in IDLs.
- **EVM:** every model exposes `proposalToken(id)` for the token a proposal was opened with; Decision Markets keeps the staked token as its base.
- **Tests:** Vortexes e2e (stake, council, switching, all models), the smoke test on a local validator, Spaces' forge suite (both profiles), and the bot's local scripts (`test-evm-changes.mjs`, `test-evm-switch.mjs`, `test-solana-switch.mjs`).

