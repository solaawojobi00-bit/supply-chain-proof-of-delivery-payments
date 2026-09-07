# Architecture

## Escrow mechanism: Soroban contract, not Claimable Balances

Two native Stellar primitives could plausibly hold the buyer's payment:
**Claimable Balances** (CAP-0023) and a **Soroban smart contract**. This
project uses a Soroban contract. The reasoning:

Claimable Balances let you lock an amount for one or more claimants, each
gated by a `ClaimPredicate`. Predicates are combinators (`AND`/`OR`/`NOT`)
over exactly two primitive conditions: `BEFORE_ABSOLUTE_TIME` and
`BEFORE_RELATIVE_TIME`, plus `UNCONDITIONAL`. That's the entire predicate
language — there is no predicate that means "claimable once a specific third
party has submitted a signature." Claimable Balances are a perfect fit for
the buyer's _reclaim-after-deadline_ path in isolation (`claimant = buyer,
predicate = not(before_absolute_time(deadline))`), but they cannot express
the seller's _claim-only-after-attestor-confirms_ path, because that
condition depends on an event (the attestor's signed confirmation) that
doesn't exist yet at balance-creation time and isn't a timestamp. Once a
Claimable Balance is created, its claimants and predicates are immutable —
there's no operation to add a claimant or tighten a predicate later in
response to an attestation.

A Soroban contract has no such ceiling: it can hold funds, expose an
`attest()` method that only the designated attestor's key can invoke
(via `require_auth`), record that as contract state, and make `claim()`
check that state before releasing funds. It also gives Phase 2 a natural
upgrade path — swapping a single `attestor: Address` field for
`attestors: Vec<Address>` plus a signature-count threshold is a contract
change, not a re-architecture, whereas M-of-N confirmation has no
expression at all in the Claimable Balance predicate language. So the
choice here also front-loads Phase 2 (multi-attestor M-of-N) feasibility.

The tradeoff accepted: a Soroban contract is more machinery than a Claimable
Balance (a deployed WASM contract vs. a single ledger operation) and this
project's other two use Claimable Balances for their escrow needs — but
those don't need a third-party attestation event, only time-gated release,
so Claimable Balances were the right, simpler choice there. Here the
attestation requirement forces the more expressive tool.

## Contract design (`contracts/escrow` and `contracts/escrow-registry`)

The repository supports two contract topologies:

1. **Per-Order Escrow Instance (`contracts/escrow`)**: Each order is its own deployed WASM contract instance.
2. **Shared Escrow Registry (`contracts/escrow-registry`)**: A single deployed registry instance manages multiple orders identified by unique `order_id`s in persistent storage.

### 1. Per-Order Contract (`contracts/escrow`)

State:

```rust
pub struct Order {
    pub buyer: Address,
    pub seller: Address,
    pub attestors: Vec<Address>,
    pub threshold: u32,
    pub confirmations: Vec<Address>,
    pub arbiter: Address,
    pub token: Address,      // Stellar Asset Contract address (XLM or custom SAC)
    pub amount: i128,
    pub deadline: u64,       // unix timestamp
    pub status: OrderStatus, // Created | Attested | Disputed | Claimed | Reclaimed | Cancelled
}
```

Methods:

| Method                                                                          | Caller              | Precondition                                       | Effect                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `create(buyer, seller, attestors, threshold, arbiter, token, amount, deadline)` | buyer               | none (init)                                        | `require_auth(buyer)`; pulls `amount` of `token` from buyer into the contract via the token's `transfer`; stores `Order`, `status = Created` |
| `attest(attestor)`                                                              | authorized attestor | `status == Created`, `now < deadline`, unconfirmed | `require_auth(attestor)`; adds to `confirmations`; transitions `status = Attested` once `confirmations.len() >= threshold`                   |
| `claim()`                                                                       | seller              | `status == Attested`                               | `require_auth(seller)`; transfers `amount` of `token` to seller; `status = Claimed`                                                          |
| `reclaim()`                                                                     | buyer               | `status == Created`, `now >= deadline`             | `require_auth(buyer)`; transfers `amount` of `token` back to buyer; `status = Reclaimed`                                                     |
| `cancel()`                                                                      | buyer & seller      | `status == Created`                                | `require_auth(buyer)` & `require_auth(seller)`; transfers `amount` of `token` back to buyer; `status = Cancelled`                            |
| `dispute()`                                                                     | buyer               | `status == Attested`                               | `require_auth(buyer)`; freezes claim and transitions `status = Disputed`                                                                     |
| `resolve_dispute(release_to_seller)`                                            | arbiter             | `status == Disputed`                               | `require_auth(arbiter)`; transfers funds to seller (`Claimed`) or buyer (`Reclaimed`) based on `release_to_seller`                           |
| `get_order()`                                                                   | anyone              | —                                                  | read-only state view                                                                                                                         |

### 2. Shared Escrow Registry (`contracts/escrow-registry`)

State:

```rust
pub struct Order {
    pub order_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub attestors: Vec<Address>,
    pub threshold: u32,
    pub confirmations: Vec<Address>,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub deadline: u64,
    pub status: OrderStatus,
}
```

Methods:

| Method                                                                                          | Caller              | Precondition                                       | Effect                                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create_order(order_id, buyer, seller, attestors, threshold, arbiter, token, amount, deadline)` | buyer               | `order_id` not exists                              | `require_auth(buyer)`; transfers `amount` into registry contract; stores `DataKey::Order(order_id)` with status `Created`                        |
| `attest(order_id, attestor)`                                                                    | authorized attestor | `status == Created`, `now < deadline`, unconfirmed | `require_auth(attestor)`; adds to `confirmations`; updates order status to `Attested` once threshold is met                                      |
| `claim(order_id)`                                                                               | seller              | `status == Attested`                               | `require_auth(seller)`; transfers funds to seller; updates status to `Claimed`                                                                   |
| `reclaim(order_id)`                                                                             | buyer               | `status == Created`, `now >= deadline`             | `require_auth(buyer)`; refunds funds to buyer; updates status to `Reclaimed`                                                                     |
| `cancel(order_id)`                                                                              | buyer & seller      | `status == Created`                                | `require_auth(buyer)` & `require_auth(seller)`; refunds funds to buyer; updates status to `Cancelled`                                            |
| `dispute(order_id)`                                                                             | buyer               | `status == Attested`                               | `require_auth(buyer)`; freezes claim and updates status to `Disputed`                                                                            |
| `resolve_dispute(order_id, release_to_seller)`                                                  | arbiter             | `status == Disputed`                               | `require_auth(arbiter)`; transfers funds to seller (`Claimed`) or buyer (`Reclaimed`) based on `release_to_seller`; updates status appropriately |
| `get_order(order_id)`                                                                           | anyone              | `order_id` exists                                  | Returns `Order` state                                                                                                                            |

### Migration Note & Architectural Trade-offs

- **Per-Order Deployment (`contracts/escrow`)**:
  - _Pros_: Extreme isolation; contract storage automatically bounds to single order lifecycle.
  - _Cons_: High deployment fees and latency on every order creation (`ContractClient.deploy`).
- **Shared Registry (`contracts/escrow-registry`)**:
  - _Pros_: Zero per-order deployment cost; orders are created via standard contract invocations (`create_order`); faster throughput.
  - _Cons & Tradeoffs_: Persistent storage expands linearly with order volume. Each entry utilizes Soroban persistent storage with explicit TTL extensions (`extend_ttl`). For production scale, an archival/eviction policy or storage rent fee reclaim mechanism after finalization (`Claimed`/`Reclaimed`) is required to manage long-term state footprint.

Funds custody: both contracts call the token contract's `transfer` to pull
funds from the buyer into the contract instance in `create`/`create_order`, and to push funds out in
`claim`/`reclaim`. On testnet the token is the native XLM Stellar Asset
Contract (SAC), so this works with ordinary funded testnet accounts without
needing a custom fungible token.

Every state-changing method enforces its precondition and calls
`require_auth` for the relevant party, so:

- the buyer cannot claim (only `claim()`, called by seller, releases to
  seller)
- the seller cannot reclaim or self-attest (only the `attestor` key
  authorizes `attest()`)
- the attestor cannot move funds (their only power is flipping status to
  `Attested`)
- nothing is claimable/reclaimable before its precondition — status is
  checked and transitions are one-way

This is the enforcement of "neither buyer nor seller can unilaterally move
funds" from the PRD: it's structural (separate required signers per method),
not a convention the backend has to uphold.

## Attestor confirmation

In Phase 1 the attestor is a single Stellar keypair, chosen and shared with
the backend at order-creation time (e.g. a courier or warehouse operator's
existing signing key). "Delivery confirmed" _is_ "the attestor submitted a
signed `attest()` invocation" — there is no separate off-chain confirmation
step the backend trusts; the chain transaction is the source of truth. The
backend's job is only to hold the attestor's testnet keypair on their behalf
for Phase 1 (a real deployment would have the attestor sign with their own
wallet/HSM — tracked as a Phase 2+ issue) and to submit the transaction when
the attestor's operator calls the confirmation endpoint.

## Backend service

A thin Node/TypeScript service (`backend/`) using `@stellar/stellar-sdk` and
`@stellar/stellar-sdk`'s Soroban RPC client. It does not implement any trust
logic itself — every rule above is enforced on-chain by the contract. The
backend's job is:

1. Track orders in a local SQLite database (id, contract id, buyer/seller/
   attestor addresses, amount, deadline, status, tx hashes) so clients can
   query status without walking the ledger themselves.
2. Deploy a fresh contract instance and submit the `create` invocation when
   an order is created.
3. Submit `attest()` when the attestor confirms delivery.
4. Submit `claim()` / `reclaim()` on request, after checking the relevant
   precondition client-side first (contract re-checks it regardless — this
   is purely to return a clean error instead of a failed transaction).
5. Poll the contract's `get_order()` (or read from its own DB, kept in sync
   from submitted tx results) to answer status queries.
6. Expose everything over a small REST API (Express).

Signing keys: for Phase 1 demo purposes, the backend holds all three
parties' testnet keypairs (buyer, seller, attestor) server-side, since there
is no wallet-connect UI yet — this is explicitly a Phase 1 simplification
for demonstrating the full flow end-to-end, not a production custody design.
A real deployment would have each party sign client-side with their own
wallet; this is tracked as a Phase 2+ issue.

### API surface (Phase 1)

| Endpoint                   | Effect                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`             | Create order: deploys contract, calls `create()`, persists order row. Body: `sellerAddress, attestorAddress, amount, deadlineSeconds` |
| `GET /orders/:id`          | Return current order status and details                                                                                               |
| `POST /orders/:id/attest`  | Attestor confirms delivery: calls `attest()`                                                                                          |
| `POST /orders/:id/claim`   | Seller claims funds: calls `claim()`                                                                                                  |
| `POST /orders/:id/reclaim` | Buyer reclaims funds: calls `reclaim()` (only succeeds past deadline)                                                                 |

## Data flow: full order lifecycle

```
 buyer                 backend                  contract              attestor / seller
   |  POST /orders        |                         |
   |---------------------→|  deploy + create()      |
   |                       |------------------------→|  [Created]
   |                       |←— tx hash, contract id —|
   |←— order id, status ——|                          |
   |                       |                          |
   |         (shipment happens off-chain; courier scans / warehouse receives)
   |                       |                          |
   |                       |  POST /orders/:id/attest (attestor)
   |                       |←—————————————————————————————————————|
   |                       |  attest()               |
   |                       |------------------------→|  [Attested]
   |                       |                          |
   |                       |  POST /orders/:id/claim (seller)
   |                       |←—————————————————————————————————————|
   |                       |  claim()                |
   |                       |------------------------→|  transfer→seller
   |                       |                          |  [Claimed]
```

Reclaim path (attestation never happens):

```
 buyer                 backend                  contract
   |  POST /orders        |                         |
   |---------------------→|  deploy + create()      |
   |                       |------------------------→|  [Created]
   |                       |                          |
   |            (deadline passes, no attest() call)
   |                       |                          |
   |  POST /orders/:id/reclaim                        |
   |----------------------→|                          |
   |                       |  reclaim()               |
   |                       |------------------------→|  transfer→buyer
   |                       |                          |  [Reclaimed]
```

Order status in the backend DB mirrors contract `OrderStatus` one-to-one:
`created → in-transit` is a backend-only label (contract has no "shipped"
concept — shipment is off-chain and outside what the chain can observe)
covering the period between `Created` and `Attested`; `delivered/confirmed`
maps to contract `Attested`; `claimed`/`deadline-passed`/`reclaimed` map
directly to `Claimed`/`Reclaimed`.

## Development, CI/CD & Project Hygiene

To ensure high reliability, security, and supply-chain integrity, the repository employs automated quality gates and hygiene pipelines:

1. **Continuous Integration Pipeline (`.github/workflows/ci.yml`)**:
   - **Contract validation**: Verifies lockfile integrity via `cargo check --locked` and executes contract unit tests (`cargo test`) for `contracts/escrow`.
   - **Backend quality gates**: Runs ESLint (`npm run lint`), Prettier checks (`npm run format:check`), TypeScript typechecks (`npm run typecheck`), and Vitest unit/integration tests with coverage reporting (`npm test`).
   - **Dependency audit gate**: Audits all npm and cargo dependencies via `node scripts/audit-deps.mjs`.

2. **Dependency Management & Dependabot**:
   - Automated dependency update configurations live at [`.github/dependabot.yml`](.github/dependabot.yml).
   - Configured with weekly check intervals for npm (`/backend`), cargo (`/`), and GitHub Actions (`/`), grouping ecosystem updates (e.g., `@stellar/*`, `soroban-*`, `express`) to minimize PR noise.

3. **Dependency Audit Gate (`scripts/audit-deps.mjs`)**:
   - A unified Node.js audit gate that inspects both `npm audit` and `cargo audit` results.
   - Enforces security thresholds by failing CI only on high or critical severity advisories while treating low/medium vulnerabilities and network/offline reachability issues as non-blocking warnings.
   - Verified through a dedicated regression test suite ([`scripts/test-audit-deps.mjs`](scripts/test-audit-deps.mjs)).

4. **Security & Static Analysis**:
   - **CodeQL (`.github/workflows/codeql.yml`)**: Analyzes both TypeScript backend code and Rust contracts for security vulnerabilities.
   - **Gitleaks (`.github/workflows/gitleaks.yml`)**: Continuously scans commits and pull requests to prevent credentials, secrets, or testnet private keys from being committed.

5. **Release Automation**:
   - Automated semantic versioning and changelog updates are managed by Semantic Release ([`.releaserc.json`](.releaserc.json)) via [`.github/workflows/release.yml`](.github/workflows/release.yml).

## Phase boundaries

Phase 1 (this repo, now): single hardcoded attestor per order, contract
deployed fresh per order, backend holds all keys, native XLM only, no
dispute path, REST API with no auth beyond having the order id.

Everything else — multi-attestor M-of-N, client-side wallet signing,
contract factory pattern, non-XLM assets, dispute/arbitration, attestor
reputation — is Phase 2+ and tracked as GitHub issues rather than built now.
