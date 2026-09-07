# Supply Chain Proof-of-Delivery Payments

A buyer's payment is held in escrow on Stellar and only released to the
seller once a trusted attestor (e.g. a courier or warehouse operator)
confirms delivery. If delivery isn't confirmed by an agreed deadline, the
buyer can reclaim the funds instead.

See [PRD.md](PRD.md) for the problem, target users, and scope, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how it's built (a Soroban escrow
contract, and why Claimable Balances don't fit this use case).

## Status: Phase 1

Phase 1 is a genuinely working, end-to-end flow, run against real Stellar
testnet (not mocked): create an order, attest delivery, seller claims — and
separately, deadline passes with no attestation, buyer reclaims. See the
[Phase 2+ backlog](#phase-2-backlog) for what's deliberately deferred.

## Repo layout

```
contracts/escrow/   Soroban escrow contract (Rust)
backend/             REST API + order tracking (Node/TypeScript)
PRD.md
ARCHITECTURE.md
```

## Prerequisites

- Rust with the `wasm32v1-none` target, and the [Stellar CLI](https://developers.stellar.org/docs/build/smart-contracts/getting-started/setup) (`stellar`)
- Node.js 20+

## 1. Build and deploy the contract

```bash
stellar contract build
stellar keys generate deployer --network testnet --fund
stellar contract upload --wasm target/wasm32v1-none/release/escrow.wasm --source deployer --network testnet
# note the returned wasm hash
```

Run the contract's own unit tests (in-memory, no network needed):

```bash
cargo test --manifest-path contracts/escrow/Cargo.toml
```

## 2. Set up demo identities

The Phase 1 backend holds a fixed set of demo keypairs server-side (buyer,
seller, attestor) since there's no wallet-connect UI yet — see
[ARCHITECTURE.md](ARCHITECTURE.md) for why. Generate and fund them on
testnet:

```bash
stellar keys generate buyer --network testnet --fund
stellar keys generate seller --network testnet --fund
stellar keys generate attestor --network testnet --fund
stellar contract id asset --asset native --network testnet
```

## 3. Configure and run the backend

```bash
cd backend
cp .env.example .env
# fill in ESCROW_WASM_HASH, PAYMENT_TOKEN_CONTRACT_ID (native asset id above),
# and the four secret keys from `stellar keys show <name>`
npm install
npm run dev
```

## 4. Run the demo

With the backend running:

```bash
npm run demo:claim     # create -> attest -> claim
npm run demo:reclaim   # create with a short deadline -> deadline passes -> reclaim
```

Each prints the order at every lifecycle step, including the real testnet
transaction hash for every state-changing call.

## API

A complete machine-readable OpenAPI 3.0 specification is available at [`backend/openapi.yaml`](backend/openapi.yaml).

| Endpoint | Effect |
|---|---|
| `POST /orders` | Create an order: `{ sellerAddress, attestorAddress, amountStroops, deadlineSeconds }` |
| `GET /orders` | List all orders |
| `GET /orders/:id` | Order status, including a live on-chain read |
| `POST /orders/:id/attest` | Attestor confirms delivery |
| `POST /orders/:id/claim` | Seller claims the escrowed funds |
| `POST /orders/:id/reclaim` | Buyer reclaims funds once the deadline has passed |

## Phase 2+ backlog

Everything explicitly out of scope for Phase 1 — multi-attestor M-of-N
confirmation, client-side wallet signing, a contract factory pattern,
non-XLM assets, dispute/arbitration, and more — is tracked as GitHub issues
rather than built here. See the repo's [Issues](../../issues) tab.
