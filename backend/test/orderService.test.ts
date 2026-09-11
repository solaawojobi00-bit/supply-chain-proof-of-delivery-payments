import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";

vi.mock("../src/contractOps.js", () => ({
  deployEscrowContract: vi.fn(async () => ({
    contractId: "C" + "0".repeat(55),
    txHash: "mock-deploy-tx-hash",
  })),
  callCreate: vi.fn(async () => "mock-create-tx-hash"),
  callAttest: vi.fn(async () => "mock-attest-tx-hash"),
  callClaim: vi.fn(async () => "mock-claim-tx-hash"),
  callReclaim: vi.fn(async () => "mock-reclaim-tx-hash"),
  callCancel: vi.fn(async () => "mock-cancel-tx-hash"),
  callDispute: vi.fn(async () => "mock-dispute-tx-hash"),
  callResolveDispute: vi.fn(async () => "mock-resolve-tx-hash"),
  buildUnsignedCreateTx: vi.fn(async () => "mock-unsigned-create-xdr"),
  buildUnsignedAttestTx: vi.fn(async () => "mock-unsigned-attest-xdr"),
  buildUnsignedClaimTx: vi.fn(async () => "mock-unsigned-claim-xdr"),
  buildUnsignedReclaimTx: vi.fn(async () => "mock-unsigned-reclaim-xdr"),
  buildUnsignedCancelTx: vi.fn(async () => "mock-unsigned-cancel-xdr"),
  buildUnsignedDisputeTx: vi.fn(async () => "mock-unsigned-dispute-xdr"),
  buildUnsignedResolveTx: vi.fn(async () => "mock-unsigned-resolve-xdr"),
  buildRegistryUnsignedCreateTx: vi.fn(async () => "mock-unsigned-create-xdr"),
  buildRegistryUnsignedAttestTx: vi.fn(async () => "mock-unsigned-attest-xdr"),
  buildRegistryUnsignedClaimTx: vi.fn(async () => "mock-unsigned-claim-xdr"),
  buildRegistryUnsignedReclaimTx: vi.fn(async () => "mock-unsigned-reclaim-xdr"),
  buildRegistryUnsignedCancelTx: vi.fn(async () => "mock-unsigned-cancel-xdr"),
  buildRegistryUnsignedDisputeTx: vi.fn(async () => "mock-unsigned-dispute-xdr"),
  buildRegistryUnsignedResolveTx: vi.fn(async () => "mock-unsigned-resolve-xdr"),
  submitSignedXDR: vi.fn(async () => ({ txHash: "mock-submitted-tx-hash", status: "SUCCESS" })),
  readOnChainOrder: vi.fn(async () => ({
    buyer: buyerKeypair.publicKey(),
    seller: sellerKeypair.publicKey(),
    attestors: [attestorKeypair.publicKey()],
    threshold: 1,
    confirmations: [],
    token: "mock-token-id",
    amount: 10000000n,
    deadline: 9999999999n,
    status: "Created",
  })),
}));

import {
  attestOrder,
  buildUnsignedAttest,
  buildUnsignedCancel,
  buildUnsignedClaim,
  buildUnsignedCreateOrder,
  buildUnsignedDispute,
  buildUnsignedReclaim,
  buildUnsignedResolve,
  claimOrder,
  createOrder,
  disputeOrder,
  getAllOrders,
  getOrderById,
  getOrderWithChainState,
  reclaimOrder,
  resolveDispute,
  submitSignedTx,
} from "../src/orderService.js";
import { HttpError } from "../src/httpError.js";

describe("Order Service Unit & Integration (orderService.ts)", () => {
  it("creates an order successfully and stores in db", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const order = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });

    expect(order.id).toBeDefined();
    expect(order.status).toBe("Created");
    expect(order.seller_address).toBe(sellerKeypair.publicKey());
    expect(order.attestor_address).toBe(attestorKeypair.publicKey());
    expect(order.create_tx_hash).toBe("mock-create-tx-hash");

    const fetched = await getOrderById(order.id);
    expect(fetched.id).toBe(order.id);

    const all = await getAllOrders();
    expect(all.orders.some((o) => o.id === order.id)).toBe(true);
  });

  it("throws 404 when querying nonexistent order", async () => {
    await expect(getOrderById("nonexistent-order-id")).rejects.toThrowError(HttpError);
  });

  it("fetches order along with on-chain state", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const order = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 5000000n,
      deadlineSeconds: deadline,
    });

    const result = await getOrderWithChainState(order.id);
    expect(result.order.id).toBe(order.id);
    expect(result.onChain.status).toBe("Created");
    expect(result.lifecycle).toBe("in-transit");
  });

  it("progresses order through happy path: Create -> Attest -> Claim", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });
    expect(created.status).toBe("Created");

    const attested = await attestOrder(created.id);
    expect(attested.status).toBe("Attested");
    expect(attested.attest_tx_hash).toBe("mock-attest-tx-hash");

    const claimed = await claimOrder(created.id);
    expect(claimed.status).toBe("Claimed");
    expect(claimed.claim_tx_hash).toBe("mock-claim-tx-hash");
  });

  it("rejects attestation if order is already claimed or not in Created status", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });
    await attestOrder(created.id);
    await claimOrder(created.id);

    await expect(attestOrder(created.id)).rejects.toThrowError(
      /Order is Claimed; can only attest an order that is Created/,
    );
  });

  it("rejects claim if order has not been attested yet", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });

    await expect(claimOrder(created.id)).rejects.toThrowError(
      /Order is Created; can only claim an order that has been Attested/,
    );
  });

  it("rejects attestation if deadline has already elapsed", async () => {
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: expiredDeadline,
    });

    await expect(attestOrder(created.id)).rejects.toThrowError(/Deadline has already passed/);
  });

  it("supports buyer reclaim after deadline has expired on unattested order", async () => {
    const expiredDeadline = BigInt(Math.floor(Date.now() / 1000) - 100);
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: expiredDeadline,
    });

    const reclaimed = await reclaimOrder(created.id);
    expect(reclaimed.status).toBe("Reclaimed");
    expect(reclaimed.reclaim_tx_hash).toBe("mock-reclaim-tx-hash");
  });

  it("supports M-of-N multi-attestor confirmation and status transition", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    // Use buyerKeypair as a second authorized signer for testing
    const attestors = [attestorKeypair.publicKey(), buyerKeypair.publicKey()];
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestors,
      threshold: 2,
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });

    expect(created.status).toBe("Created");
    expect(created.threshold).toBe(2);

    // 1st confirmation (by primary attestor) -> order remains Created but confirmation recorded
    const partial = await attestOrder(created.id, attestorKeypair.publicKey());
    expect(partial.status).toBe("Created");
    expect(JSON.parse(partial.confirmations ?? "[]")).toContain(attestorKeypair.publicKey());

    // Duplicate confirmation by the same attestor is rejected
    await expect(attestOrder(created.id, attestorKeypair.publicKey())).rejects.toThrowError(
      /already confirmed/,
    );

    // Unauthorized attestor is rejected
    const unauthorized = Keypair.random();
    await expect(attestOrder(created.id, unauthorized.publicKey())).rejects.toThrowError(
      /not authorized/,
    );

    // 2nd confirmation (by second attestor) -> reaches threshold (2), transitions to Attested
    const fullyAttested = await attestOrder(created.id, buyerKeypair.publicKey());
    expect(fullyAttested.status).toBe("Attested");
    const confs = JSON.parse(fullyAttested.confirmations ?? "[]");
    expect(confs).toHaveLength(2);
  });

  it("supports dispute raising and arbiter resolution releasing to seller or buyer", async () => {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const created = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });

    // Dispute before attestation fails
    await expect(disputeOrder(created.id)).rejects.toThrowError(
      /Order is Created; can only dispute an order that is Attested/,
    );

    // Attest order
    await attestOrder(created.id);

    // Raise dispute
    const disputed = await disputeOrder(created.id);
    expect(disputed.status).toBe("Disputed");
    expect(disputed.dispute_tx_hash).toBe("mock-dispute-tx-hash");

    // Claim fails when disputed
    await expect(claimOrder(created.id)).rejects.toThrowError(/Order is Disputed/);

    // Resolve dispute -> release to seller
    const resolvedSeller = await resolveDispute(created.id, true);
    expect(resolvedSeller.status).toBe("Claimed");
    expect(resolvedSeller.resolve_tx_hash).toBe("mock-resolve-tx-hash");

    // Create another order for refunding to buyer
    const created2 = await createOrder({
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: 10000000n,
      deadlineSeconds: deadline,
    });
    await attestOrder(created2.id);
    await disputeOrder(created2.id);

    // Resolve dispute -> refund to buyer
    const resolvedBuyer = await resolveDispute(created2.id, false);
    expect(resolvedBuyer.status).toBe("Reclaimed");
    expect(resolvedBuyer.resolve_tx_hash).toBe("mock-resolve-tx-hash");
  });

  describe("Unsigned Transaction Builders & Client-Side Wallet Signing Flow", () => {
    it("builds unsigned create order and submits signed XDR", async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const { unsignedTxXdr, order } = await buildUnsignedCreateOrder({
        sellerAddress: sellerKeypair.publicKey(),
        buyerAddress: buyerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: 10000000n,
        deadlineSeconds: deadline,
      });

      expect(unsignedTxXdr).toBe("mock-unsigned-create-xdr");
      expect(order.id).toBeDefined();
      expect(order.status).toBe("Created");

      const submitRes = await submitSignedTx("signed-create-xdr-blob", order.id, "create");
      expect(submitRes.txHash).toBe("mock-submitted-tx-hash");
      expect(submitRes.status).toBe("SUCCESS");
    });

    it("builds unsigned attest, claim, reclaim, cancel, dispute, and resolve transactions", async () => {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const created = await createOrder({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: 10000000n,
        deadlineSeconds: deadline,
      });

      // 1. Unsigned attest
      const unsignedAttest = await buildUnsignedAttest(created.id, attestorKeypair.publicKey());
      expect(unsignedAttest.unsignedTxXdr).toBe("mock-unsigned-attest-xdr");
      expect(unsignedAttest.action).toBe("attest");

      // 2. Unsigned cancel on created order
      const unsignedCancel = await buildUnsignedCancel(created.id, buyerKeypair.publicKey());
      expect(unsignedCancel.unsignedTxXdr).toBe("mock-unsigned-cancel-xdr");
      expect(unsignedCancel.action).toBe("cancel");

      // 3. Unsigned reclaim (requires deadline to be passed)
      const { db } = await import("../src/db.js");
      await db.execute({
        sql: "UPDATE orders SET deadline = ? WHERE id = ?",
        args: [Math.floor(Date.now() / 1000) - 100, created.id],
      });
      const unsignedReclaim = await buildUnsignedReclaim(created.id);
      expect(unsignedReclaim.unsignedTxXdr).toBe("mock-unsigned-reclaim-xdr");
      expect(unsignedReclaim.action).toBe("reclaim");

      // Restore deadline and attest order to test claim and dispute
      await db.execute({
        sql: "UPDATE orders SET deadline = ? WHERE id = ?",
        args: [Math.floor(Date.now() / 1000) + 3600, created.id],
      });
      await attestOrder(created.id);

      // 4. Unsigned claim
      const unsignedClaim = await buildUnsignedClaim(created.id);
      expect(unsignedClaim.unsignedTxXdr).toBe("mock-unsigned-claim-xdr");
      expect(unsignedClaim.action).toBe("claim");

      // 5. Unsigned dispute
      const unsignedDispute = await buildUnsignedDispute(created.id, buyerKeypair.publicKey());
      expect(unsignedDispute.unsignedTxXdr).toBe("mock-unsigned-dispute-xdr");
      expect(unsignedDispute.action).toBe("dispute");

      // Transition to disputed
      await disputeOrder(created.id);

      // 6. Unsigned resolve
      const unsignedResolve = await buildUnsignedResolve(created.id, true);
      expect(unsignedResolve.unsignedTxXdr).toBe("mock-unsigned-resolve-xdr");
      expect(unsignedResolve.action).toBe("resolve");
    });
  });
});
