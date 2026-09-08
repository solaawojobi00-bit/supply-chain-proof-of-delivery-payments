# Product Requirements Document

## Project

Supply Chain Proof-of-Delivery Payments — a Stellar-based payment service that
conditions release of a buyer's payment on independent confirmation that
goods were actually delivered.

## Problem

In physical supply chains, buyers and sellers routinely transact with parties
they don't fully trust and often can't easily litigate against (different
jurisdictions, small transaction sizes, informal relationships). Today this is
handled with blunt, expensive instruments:

- **Pre-payment**: buyer pays upfront and trusts the seller to ship. Buyer
  bears all the risk.
- **Payment on invoice / net-30**: seller ships and trusts the buyer to pay
  later. Seller bears all the risk, and working capital is tied up.
- **Letters of credit / escrow via a bank**: works, but is slow, paperwork
  heavy, and expensive — usually not viable for small or frequent shipments.

What's missing is a lightweight, programmable escrow: funds move on-chain
immediately (so the seller can see the money is real and committed), but are
only released to the seller once delivery is attested, and automatically
return to the buyer if delivery is never confirmed by an agreed deadline.
Stellar is a good fit because settlement is fast and cheap enough to make this
viable even for small-value, high-frequency shipments where a bank escrow
would never be worth the fee.

## Target Users

- **Buyers**: procurement teams, small importers, marketplace buyers who want
  assurance their payment isn't released until goods actually arrive.
- **Sellers / shippers**: suppliers, exporters, small manufacturers who want
  assurance that once they can prove delivery, payment is guaranteed and
  immediate — no chasing invoices.
- **Attestors** (Phase 1): a courier, freight forwarder, or warehouse operator
  already physically present at the point of delivery, who is willing to hold
  a signing key and submit a confirmation transaction as part of their
  existing delivery workflow (e.g. scanning a package on arrival).

None of these users are expected to be Stellar experts. The service is the
interface; Stellar is the settlement layer underneath.

## Core Scope — Phase 1 (single trusted attestor)

Phase 1 delivers a genuinely working, end-to-end flow on Stellar testnet:

1. **Create order**: buyer funds an order for a seller, for a given amount
   and delivery deadline. Funds move into an escrow mechanism on-chain
   immediately.
2. **In-transit**: order sits in escrow. No party can unilaterally move the
   funds — not even the buyer — until either an attestation or the deadline
   condition is met.
3. **Delivery confirmation**: a single, pre-designated attestor (identified by
   its Stellar public key at order-creation time) submits a signed
   confirmation transaction once it has independently verified delivery
   (e.g. courier scan, warehouse receipt). The service does not try to
   automatically detect delivery in Phase 1 — the attestor's signature _is_
   the confirmation.
4. **Claim**: once attested, the seller can claim the escrowed funds.
5. **Reclaim**: if the deadline passes with no attestation, the buyer can
   reclaim the funds. This is the buyer's safety net against a
   non-performing seller or an unresponsive attestor.

The backend service exposes an API to create orders, fetch order status,
submit an attestation, and trigger claim/reclaim, and tracks order state
(created → in-transit → delivered/confirmed → claimed, or
deadline-passed → reclaimed) so users don't need to inspect the ledger
directly.

Trust model for Phase 1 is explicit and singular: the buyer and seller trust
one designated attestor to tell the truth about delivery. This is a
deliberate simplification, not a hidden limitation — it is the honest,
buildable v1.

## Out of Scope (Phase 2+)

- **Multi-attestor / M-of-N confirmation**: requiring agreement from multiple
  independent attestors (e.g. 2-of-3 couriers/warehouses) before releasing
  payment, removing single-party trust. (Implemented in smart contract and backend).
- **GPS / IoT-based automated attestation**: deriving delivery confirmation
  automatically from device telemetry (geofencing arrival, RFID/NFC scans, IoT sensor
  data) authenticated via HMAC-SHA256 device signatures. (Implemented in backend integration layer).
- **Dispute arbitration**: any mechanism for a buyer or seller to contest an
  attestation after the fact (e.g. "the attestor was wrong/colluding"),
  including arbitration panels, staking/slashing for dishonest attestors, or
  appeals processes.
- **Attestor Directory & Discovery**: Discovering, registering, and tracking
  attestor reliability. A lightweight public directory (`/attestors`) tracks
  registered verifiers and derives objective reputation summaries (attestations,
  successful claims, expiration rates, disputes, and composite reputation scores)
  directly from on-chain order history. Buyers can reference attestors by directory
  ID (`attestorId`) or raw Stellar address.
- **Multi-asset / multi-currency support**: Phase 1 targets a single asset
  (XLM or one test credit asset) to keep the core flow provable; broader
  asset support is a straightforward but deferred extension.
- **Partial delivery / partial payment**: an order is all-or-nothing in
  Phase 1.

## Success Criteria for Phase 1

- A full order lifecycle (create → attest → claim, and separately
  deadline-passed → reclaim) runs successfully against real Stellar testnet,
  not a mocked chain.
- Funds are demonstrably held such that neither buyer nor seller can move
  them unilaterally before the relevant condition (attestation or deadline)
  is met.
- The backend service persists and correctly reports order state through
  every transition.
- The codebase and documentation are in a state a Stellar Wave contributor
  could pick up a well-scoped Phase 2 issue and start productive work without
  needing to talk to the maintainer first.
