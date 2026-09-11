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
contracts/escrow/          Per-order Soroban escrow contract (Rust - dual-supported reference)
contracts/escrow-registry/ Shared Soroban escrow registry (Rust - canonical production topology)
backend/                   REST API + order tracking (Node/TypeScript)
frontend/                  Web frontend with Freighter wallet connect (Vite/Vanilla JS/CSS)
scripts/                   Hygiene & audit tools (e.g. unified dependency audit gate)
.github/workflows/         CI, CodeQL, Gitleaks, and Release workflows
.github/dependabot.yml     Automated dependency update configuration
PRD.md
ARCHITECTURE.md
```

> **Contract Topology Note**: `contracts/escrow-registry` is the canonical production contract topology, while `contracts/escrow` is maintained as a dual-supported reference implementation with strict feature parity. See [ARCHITECTURE.md](ARCHITECTURE.md#contract-design-contractsescrow-and-contractsescrow-registry) for details and rationale.

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
# Set STELLAR_NETWORK (testnet | local | mainnet - defaults to testnet).
# Fill in ESCROW_WASM_HASH, PAYMENT_TOKEN_CONTRACT_ID (native asset id above),
# four secret keys from `stellar keys show <name>`, and optional CORS_ALLOWED_ORIGINS
# (e.g. CORS_ALLOWED_ORIGINS=http://localhost:5173 to allow frontend cross-origin access).
# Note: Targeting mainnet requires setting ALLOW_MAINNET=true as an explicit safety guardrail.
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

## 5. Web Frontend (Buyer, Attestor, Seller Portals)

The repository includes a modern single-page web frontend in `frontend/` featuring client-side wallet signing with [Freighter](https://www.freighter.app/) and simulated in-memory test keypairs.

### Running the Frontend Locally

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. Ensure the backend is running on `http://localhost:3000` (and `CORS_ALLOWED_ORIGINS` includes `http://localhost:5173` in `backend/.env`).

### Features & Role Portals
- **🛒 Buyer Portal**:
  - Connect wallet (Freighter or test keypair).
  - Create escrow orders with custom amounts, deadlines, tokens, and optional webhooks.
  - Transactions are constructed unsigned on the backend, signed client-side in your wallet, and submitted to Soroban.
  - Track status of all orders created by the connected wallet.
- **🚚 Attestor Portal**:
  - Automatically filters orders where your connected wallet is the designated delivery attestor.
  - One-click delivery confirmation (`Confirm Delivery`) signed directly via your wallet.
- **💰 Seller Portal**:
  - Automatically filters orders where your connected wallet is the seller.
  - Claim escrow funds (`Claim Funds`) once delivery has been attested.
- **🔍 Explorer & Inspector**:
  - Searchable explorer for all active/historical contracts, live lifecycle state, and on-chain transaction hashes.

### Client-Side Signing Guarantee
Secret keys are **never** transmitted to the backend. All on-chain actions use client-side signed XDR transactions submitted directly to the network via `/tx/submit`.

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

### Client-Side Wallet Signing (Freighter / SEP-43)

In addition to backend-held demo keypairs, the backend fully supports non-custodial client-side wallet signing (e.g. Freighter, SEP-43 smart wallets):

1. **Request Unsigned Transaction XDR**:
   Any state-changing endpoint can return an unsigned transaction envelope by adding `?unsigned=true` (or header `x-unsigned: true` / query `POST /orders/:id/build-tx`):

   ```bash
   # Example: Build an unsigned attest transaction for an external wallet
   curl -X POST "http://localhost:3000/orders/1/attest?unsigned=true" \
     -H "Content-Type: application/json" \
     -d '{"attestorAddress": "GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI"}'
   ```

   _Response:_

   ```json
   {
     "unsignedTx": "AAAAAgAAAAA...",
     "networkPassphrase": "Test SDF Network ; September 2015",
     "action": "attest",
     "orderId": 1
   }
   ```

2. **Sign Client-Side with Freighter**:

   ```typescript
   import { signTransaction } from "@stellar/freighter-api";

   const { signedTxXdr } = await signTransaction(unsignedTx, {
     networkPassphrase,
   });
   ```

3. **Submit Signed XDR**:
   ```bash
   curl -X POST "http://localhost:3000/tx/submit" \
     -H "Content-Type: application/json" \
     -d '{"signedXdr": "AAAAAgAAAAA...", "orderId": 1, "action": "attest"}'
   ```

### Per-Role API Authentication

Mutating endpoints require authentication corresponding to the authorized party's role (`buyer`, `seller`, `attestor`, `arbiter`):

1. **Authentication Headers**:
   Supply either a Bearer token or `x-api-key` header:
   ```bash
   Authorization: Bearer <token>
   # or
   x-api-key: <token>
   ```

2. **Order-Scoped Tokens**:
   When an order is created (`POST /orders`), the response provides unique order-scoped tokens:
   ```json
   {
     "id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
     "tokens": {
       "buyer": "buyer_...",
       "seller": "seller_...",
       "attestor": "attestor_...",
       "arbiter": "arbiter_..."
     }
   }
   ```

3. **Global Configured Role Keys**:
   Configured in `.env` (`BUYER_API_KEY`, `SELLER_API_KEY`, `ATTESTOR_API_KEY`, `ARBITER_API_KEY`, `ADMIN_API_KEY`) for backend services and test runners.

4. **Role Requirements Matrix**:
   - `POST /orders/:id/attest`: Requires `attestor` credential.
   - `POST /orders/:id/claim`: Requires `seller` credential.
   - `POST /orders/:id/reclaim`: Requires `buyer` credential.
   - `POST /orders/:id/cancel`: Requires `buyer` or `seller` credential.
   - `POST /orders/:id/dispute`: Requires `buyer` credential.
   - `POST /orders/:id/resolve`: Requires `arbiter` credential.
   - `POST /orders/:id/build-tx`: Requires role credential matching requested `action`.
   - *Mismatched credentials receive `403 Forbidden`; missing credentials receive `401 Unauthorized`.*

## Webhook Notifications

When creating an order via `POST /orders`, callers can provide an optional `webhookUrl`. The backend will issue real-time HTTP `POST` notifications to this endpoint upon every successful state transition.

### Event Types
- `order.created`: Initial escrow order creation and contract deployment/funding.
- `order.attested`: M-of-N attestation threshold met; order ready for claim.
- `order.claimed`: Seller successfully withdrawn funds from escrow.
- `order.reclaimed`: Buyer reclaimed funds after expiration.
- `order.cancelled`: Mutual cancellation executed; buyer refunded.
- `order.disputed`: Attestation disputed by buyer; funds frozen.
- `order.resolved`: Arbiter resolved the dispute (releasing to seller or refunding buyer).

### Payload Schema
```json
{
  "event": "order.attested",
  "orderId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
  "contractId": "CA3D5KRYMCMUZGAPOETEZ2NZNOME4H664X4UIRGFW6UR47X7U6GFF6MS",
  "numericId": 1725710000123,
  "buyerAddress": "GB6NVEN5HSUBKMYCE5ZOWSK5RPO5RDTBWTJHQ35YKVGFFL3U2NOSVNQI",
  "sellerAddress": "GC5H3W256B3QW4A44GAK36XN763K2KRN7O2OESN553TUXW7R6AKN4V6E",
  "attestorAddress": "GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI",
  "attestors": ["GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI"],
  "threshold": 1,
  "confirmations": ["GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI"],
  "arbiterAddress": "GB6NVEN5HSUBKMYCE5ZOWSK5RPO5RDTBWTJHQ35YKVGFFL3U2NOSVNQI",
  "amountStroops": "10000000",
  "deadline": 1735689600,
  "status": "Attested",
  "lifecycle": "delivered/confirmed",
  "txHash": "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "timestamp": "2026-09-08T00:00:00.000Z"
}
```

### Delivery Guarantees & Retries
- **Non-blocking**: Webhook delivery failures never fail or roll back the underlying on-chain state transition.
- **Automatic Retries**: Failed deliveries (network errors, timeouts, or 4xx/5xx responses) are retried up to 3 times with exponential backoff and logged for auditing.

### Signature Verification

These payloads describe state transitions that gate real payments, so a consumer must confirm a delivery genuinely came from this service before acting on it. Set `WEBHOOK_SIGNING_SECRET` (see [`backend/.env.example`](backend/.env.example)) and every outgoing delivery carries two additional headers:

| Header | Value |
| --- | --- |
| `X-Signature` | `sha256=<hex>` — HMAC-SHA256 digest, scheme-prefixed so the algorithm can be rotated later |
| `X-Signature-Timestamp` | Unix seconds at the time the delivery was signed |

The signed string is the timestamp and the **raw request body** joined by a period:

```
<X-Signature-Timestamp> + "." + <raw body bytes>
```

Two details matter when implementing a consumer:

1. **Verify against the raw body, before JSON parsing.** Re-serializing the parsed object can reorder keys and produce a different digest, which fails verification intermittently and is miserable to debug.
2. **Check the timestamp.** It is inside the signed string precisely so it cannot be rewound. Reject deliveries outside a tolerance window — 300 seconds is the recommended default, and is what `WEBHOOK_SIGNATURE_TOLERANCE_SECONDS` documents.

#### Worked example (Node / Express)

```js
import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";

const SECRET = process.env.WEBHOOK_SIGNING_SECRET;
const TOLERANCE_SECONDS = 300;

const app = express();

// express.raw keeps the exact transmitted bytes. express.json would discard
// them, leaving nothing to verify the signature against.
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.header("X-Signature") ?? "";
  const timestamp = req.header("X-Signature-Timestamp") ?? "";

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!timestamp || Number.isNaN(age) || age > TOLERANCE_SECONDS) {
    return res.status(400).send("stale or missing timestamp");
  }

  const rawBody = req.body.toString("utf8");
  const digest = createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  const expected = Buffer.from(`sha256=${digest}`, "utf8");
  const received = Buffer.from(signature, "utf8");

  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return res.status(401).send("invalid signature");
  }

  const event = JSON.parse(rawBody); // safe to parse only after verifying
  console.log("verified", event.event, event.orderId);
  res.sendStatus(204);
});
```

If `WEBHOOK_SIGNING_SECRET` is unset the headers are omitted, deliveries go out unsigned, and the backend logs a `webhook_unsigned` warning on every dispatch. That is acceptable for local development and should not be used anywhere a consumer acts on the payload. The secret is never written to logs.

Retries of the same delivery reuse the original signature and timestamp, so a consumer may safely deduplicate on the signature value.

## API

A complete machine-readable OpenAPI 3.0 specification is available at [`backend/openapi.yaml`](backend/openapi.yaml).

| Endpoint                    | Required Role           | Effect                                                                                                                                                                                                         |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /attestors`           | Public / Attestor       | Register a new delivery attestor in the public directory or update an existing profile (`{ address, name, description?, coverageArea?, feeBps? }`) |
| `GET /attestors`            | Public                  | List registered attestors with dynamically computed reputation summaries (supports `?coverageArea=...&minScore=...&active=true`) |
| `GET /attestors/:id`        | Public                  | Get single attestor profile and detailed reputation breakdown |
| `POST /integrations/iot/events` | Device / IoT Platform (`X-IoT-Signature` or `X-IoT-Secret`) | Ingest GPS geofence, RFID scan, or IoT telemetry event and trigger automated on-chain attestation (`{ orderId, deviceId, eventType, coordinates?, targetCoordinates?, scanCode?, timestamp }`) |
| `POST /orders`              | Public / Buyer          | Create an order: `{ buyerAddress?, sellerAddress, attestorAddress?, attestorId?, attestors?: string[], threshold?: number, arbiterAddress?, amountStroops, deadlineSeconds, tokenContractId?, webhookUrl? }` (supports `?unsigned=true`) |
| `GET /orders`               | Public                  | List all orders (supports `?role=...&address=...&status=...`)                                                                                  |
| `GET /orders/:id`           | Public                  | Order status, including a live on-chain read                                                                                                   |
| `POST /orders/:id/attest`   | `attestor`              | Authorized attestor confirms delivery (optional body: `{ attestorAddress }`; supports `?unsigned=true`)                                                                                                        |
| `POST /orders/:id/claim`    | `seller`                | Seller claims the escrowed funds (supports `?unsigned=true`)                                                                                                                                                   |
| `POST /orders/:id/reclaim`  | `buyer`                 | Buyer reclaims funds once the deadline has passed (supports `?unsigned=true`)                                                                                                                                  |
| `POST /orders/:id/cancel`   | `buyer` / `seller`      | Buyer and seller mutually cancel order before attestation, refunding buyer (supports `?unsigned=true`)                                                                                                         |
| `POST /orders/:id/dispute`  | `buyer`                 | Buyer disputes an attested order before claim, freezing the funds in Disputed state (supports `?unsigned=true`)                                                                                                |
| `POST /orders/:id/resolve`  | `arbiter`               | Designated arbiter resolves a dispute (`{ releaseToSeller: boolean }`), paying the seller or refunding the buyer (supports `?unsigned=true`)                                                                   |
| `POST /orders/:id/build-tx` | Action Role (`attestor` / `seller` / `buyer` / `arbiter`) | Build an unsigned transaction envelope for any action                                                                                                                                                        |
| `POST /orders/:id/submit`   | Any order party         | Submit a signed transaction XDR for a specific order and update status                                                                                                                                         |
| `POST /tx/submit`           | Any order party / Public| Submit an arbitrary signed transaction XDR to the Soroban network and sync order state                                                                                                                         |

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

# Compile TypeScript to dist/ (what the container runs)
npm run build

# Run unit and integration tests with coverage
npm test
```

`npm run dev` runs the server from source with hot reload. `npm start` runs the
compiled output and therefore requires `npm run build` first; `npm run start:tsx`
is the old behaviour of executing TypeScript directly, kept for convenience.

### Dependency Audit Gate & Maintenance

- **Dependency Audit Gate**: Run `node scripts/audit-deps.mjs` to execute the unified audit gate across npm and cargo dependencies (failing CI on high/critical advisories while gracefully handling registry warnings).
- **Audit Test Harness**: Run `node --test scripts/test-audit-deps.mjs` to run the regression test suite for the audit gate.
- **Dependabot**: Dependabot configuration lives in [`.github/dependabot.yml`](.github/dependabot.yml), providing weekly automated updates for npm (`/backend`), cargo (`/`), and GitHub Actions.

## Deployment

The two halves deploy separately, because they have different requirements: the
frontend is static, while the backend needs durable storage and an always-running
process.

| Piece | Host | Why |
| --- | --- | --- |
| `frontend/` | Vercel (static) | Vite build, no server needed |
| `backend/` | Koyeb (container) | Long-running process; scale-to-zero on the free tier |
| Order + attestor data | Turso (libSQL) | A container filesystem does not survive redeploys |

### Persistence

Data lives in libSQL, which is SQLite-compatible. Local development and tests use
a local file or `:memory:` via `DB_PATH`; deployments set `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN`, which take precedence. The schema is created by `initSchema()`
at startup and is idempotent, so no separate migration step is required.

### Backend (Koyeb)

Build from [`backend/Dockerfile`](backend/Dockerfile) with `backend/` as the build
context. Koyeb injects `PORT`. Required environment variables are the seven in
[`backend/.env.example`](backend/.env.example) plus:

- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — durable storage
- `REQUIRE_TESTNET=true` — refuses to boot outside testnet, since this service
  holds signing keys
- `CORS_ALLOWED_ORIGINS` — the deployed frontend origin
- `WEBHOOK_SIGNING_SECRET`, `IOT_WEBHOOK_SECRET` — both fall back to insecure
  defaults when unset

Use freshly generated testnet keypairs that are not used anywhere else. Health
check path is `/health`.

### Frontend (Vercel)

Set the project root directory to `frontend/`; [`frontend/vercel.json`](frontend/vercel.json)
supplies the rest. Set `VITE_API_BASE_URL` to the backend's public URL — it is
substituted into `index.html` at **build** time, so changing it requires a redeploy.
When unset, the app falls back to `http://localhost:3000`.

Because the frontend and backend are separate origins, the frontend URL must
appear in the backend's `CORS_ALLOWED_ORIGINS`. The allowlist is matched exactly,
so Vercel preview deployments (which get generated URLs) are rejected unless their
specific origins are added.

### Known limitations

- **Cold starts.** Koyeb's free instance scales to zero after an hour idle; the
  first request afterwards pays a cold start on top of Soroban RPC latency.
- **Rate limiting is per-instance.** `express-rate-limit` uses an in-memory store,
  which is correct on a single instance but would not hold across replicas.

## Phase 2+ backlog

Everything explicitly out of scope for Phase 1 — multi-attestor M-of-N
confirmation, client-side wallet signing, a contract factory pattern,
non-XLM assets, dispute/arbitration, and more — is tracked as GitHub issues
rather than built here. See the repo's [Issues](../../issues) tab.
