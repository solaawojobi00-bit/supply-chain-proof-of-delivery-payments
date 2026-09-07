# Supply Chain Proof-of-Delivery Payments

[![CI](https://github.com/solaawojobi00-bit/supply-chain-proof-of-delivery-payments/actions/workflows/ci.yml/badge.svg)](https://github.com/solaawojobi00-bit/supply-chain-proof-of-delivery-payments/actions/workflows/ci.yml)

A buyer's payment is held in escrow on Stellar and only released to the
seller once a trusted attestor (e.g. a courier or warehouse operator)
confirms delivery. If delivery isn't confirmed by an agreed deadline, the
buyer can reclaim the funds instead.

See [PRD.md](PRD.md) for the problem, target users, and scope, and
[ARCHITECTURE.md](ARCHITECTURE.md) for how it's built (a Soroban escrow
contract, and why Claimable Balances don't fit this use case).

## Status: Phase 1

Phase 1 is a genuinely working, end-to-end flow, run against real Stellar
testnet (not mocked): create an order, attest delivery, seller claims — along
with deadline-based buyer reclaim, mutual buyer/seller order cancellation, and
dispute arbitration for contested attestations. See the
[Phase 2+ backlog](#phase-2-backlog) for what's deliberately deferred.

## Repo layout

```
contracts/escrow/        Soroban escrow contract (Rust)
backend/                 REST API + order tracking (Node/TypeScript)
scripts/                 Hygiene & audit tools (e.g. unified dependency audit gate)
.github/workflows/       CI, CodeQL, Gitleaks, and Release workflows
.github/dependabot.yml   Automated dependency update configuration
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

### Multi-Asset Support (Non-Native Tokens)

The escrow smart contracts and REST API accept any Stellar Asset Contract (SAC) or custom Soroban token. To test with a non-native asset on testnet:

1. **Derive or Deploy the Asset Contract ID**:

   ```bash
   # Example: Obtain the SAC contract address for an issued test asset
   stellar contract id asset --asset <ASSET_CODE>:<ISSUER_PUBLIC_KEY> --network testnet
   ```

2. **Supply `tokenContractId` in `POST /orders`**:

   ```json
   {
     "sellerAddress": "GC5H3W256B3QW4A44GAK36XN763K2KRN7O2OESN553TUXW7R6AKN4V6E",
     "attestorAddress": "GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI",
     "amountStroops": "10000000",
     "deadlineSeconds": "1735689600",
     "tokenContractId": "<TOKEN_CONTRACT_ID>"
   }
   ```

   _(If omitted, `tokenContractId` defaults to the native XLM Stellar Asset Contract configured in `.env`)._

3. **Run Demo with Custom Token**:
   ```bash
   npm run demo:claim -- --token=<TOKEN_CONTRACT_ID>
   ```

## API

A complete machine-readable OpenAPI 3.0 specification is available at [`backend/openapi.yaml`](backend/openapi.yaml).

| Endpoint                   | Effect                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /orders`             | Create an order: `{ sellerAddress, attestorAddress?, attestors?: string[], threshold?: number, arbiterAddress?, amountStroops, deadlineSeconds, tokenContractId? }` |
| `GET /orders`              | List all orders                                                                                                                                                     |
| `GET /orders/:id`          | Order status, including a live on-chain read                                                                                                                        |
| `POST /orders/:id/attest`  | Authorized attestor confirms delivery (optional body: `{ attestorAddress }`; transitions to Attested when threshold is met)                                         |
| `POST /orders/:id/claim`   | Seller claims the escrowed funds                                                                                                                                    |
| `POST /orders/:id/reclaim` | Buyer reclaims funds once the deadline has passed                                                                                                                   |
| `POST /orders/:id/cancel`  | Buyer and seller mutually cancel order before attestation, refunding buyer                                                                                          |
| `POST /orders/:id/dispute` | Buyer disputes an attested order before claim, freezing the funds in Disputed state                                                                                 |
| `POST /orders/:id/resolve` | Designated arbiter resolves a dispute (`{ releaseToSeller: boolean }`), paying the seller or refunding the buyer                                                    |

## Development & Quality Checks

Run linting, formatting, typechecking, tests, and security audits locally:

### Smart Contract (`contracts/escrow`)

```bash
# Check contract compilation and lockfile
cargo check --locked --manifest-path contracts/escrow/Cargo.toml

# Run contract unit tests
cargo test --manifest-path contracts/escrow/Cargo.toml
```

### Backend Service (`backend/`)

```bash
cd backend

# Run ESLint
npm run lint

# Check code formatting (or run `npm run format` to auto-format)
npm run format:check

# Run TypeScript typechecking
npm run typecheck

# Run unit and integration tests with coverage
npm test
```

### Dependency Audit Gate & Maintenance

- **Dependency Audit Gate**: Run `node scripts/audit-deps.mjs` to execute the unified audit gate across npm and cargo dependencies (failing CI on high/critical advisories while gracefully handling registry warnings).
- **Audit Test Harness**: Run `node --test scripts/test-audit-deps.mjs` to run the regression test suite for the audit gate.
- **Dependabot**: Dependabot configuration lives in [`.github/dependabot.yml`](.github/dependabot.yml), providing weekly automated updates for npm (`/backend`), cargo (`/`), and GitHub Actions.

## Phase 2+ backlog

Everything explicitly out of scope for Phase 1 — multi-attestor M-of-N
confirmation, client-side wallet signing, a contract factory pattern,
non-XLM assets, dispute/arbitration, and more — is tracked as GitHub issues
rather than built here. See the repo's [Issues](../../issues) tab.
