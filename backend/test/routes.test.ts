import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { HttpError } from "../src/httpError.js";

vi.mock("../src/contractOps.js", () => ({
  deployEscrowContract: vi.fn(async () => ({
    contractId: "C" + "1".repeat(55),
    txHash: "mock-deploy-hash",
  })),
  callCreate: vi.fn(async () => "mock-create-hash"),
  callAttest: vi.fn(async () => "mock-attest-hash"),
  callClaim: vi.fn(async () => "mock-claim-hash"),
  callReclaim: vi.fn(async () => "mock-reclaim-hash"),
  callCancel: vi.fn(async () => "mock-cancel-hash"),
  callDispute: vi.fn(async () => "mock-dispute-hash"),
  callResolveDispute: vi.fn(async () => "mock-resolve-hash"),
  callRegistryCreateOrder: vi.fn(async () => "mock-reg-create-hash"),
  callRegistryAttest: vi.fn(async () => "mock-reg-attest-hash"),
  callRegistryClaim: vi.fn(async () => "mock-reg-claim-hash"),
  callRegistryReclaim: vi.fn(async () => "mock-reg-reclaim-hash"),
  callRegistryCancel: vi.fn(async () => "mock-reg-cancel-hash"),
  callRegistryDispute: vi.fn(async () => "mock-reg-dispute-hash"),
  callRegistryResolveDispute: vi.fn(async () => "mock-reg-resolve-hash"),
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
  submitSignedXDR: vi.fn(async () => ({ txHash: "mock-submit-tx-hash", status: "SUCCESS" })),
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
  readOnChainRegistryOrder: vi.fn(async () => ({
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

import { router } from "../src/routes.js";
import type { Server } from "node:http";

describe("API Routes (routes.ts)", () => {
  let server: Server;
  let baseUrl: string;

  const buyerAuth = { Authorization: `Bearer ${config.buyerApiKey}` };
  const attestorAuth = { Authorization: `Bearer ${config.attestorApiKey}` };
  const arbiterAuth = { Authorization: `Bearer ${config.arbiterApiKey}` };

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
    });

    server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it("POST /orders validates required fields and returns 400 when missing", async () => {
    const res = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        // missing attestorAddress, amountStroops, deadlineSeconds
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("required");
  });

  it("POST /orders returns 400 on malformed Stellar address", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const res = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: "not-a-stellar-address",
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "10000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("sellerAddress");
    expect(body.error).toContain("valid Stellar public key");
  });

  it("POST /orders returns 400 on past deadline", async () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 100;
    const res = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "10000000",
        deadlineSeconds: pastDeadline.toString(),
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("deadlineSeconds");
    expect(body.error).toContain("future");
  });

  it("POST /orders creates a new order and returns 201 with serialized order and tokens", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const res = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "10000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    expect(res.status).toBe(201);
    const order = (await res.json()) as any;
    expect(order.id).toBeDefined();
    expect(order.status).toBe("Created");
    expect(order.lifecycle).toBe("in-transit");
    expect(order.sellerAddress).toBe(sellerKeypair.publicKey());
    expect(order.attestorAddress).toBe(attestorKeypair.publicKey());
    expect(order.tokens).toBeDefined();
    expect(order.tokens.buyer).toBeDefined();
    expect(order.tokens.seller).toBeDefined();
    expect(order.tokens.attestor).toBeDefined();
    expect(order.txHashes.create).toBe("mock-create-hash");
  });

  it("POST /orders accepts custom tokenContractId and saves it on the order", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const customToken = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";
    const res = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "15000000",
        deadlineSeconds: deadline.toString(),
        tokenContractId: customToken,
      }),
    });
    expect(res.status).toBe(201);
    const order = (await res.json()) as any;
    expect(order.tokenContractId).toBe(customToken);
  });

  it("GET /orders returns a list of orders", async () => {
    const res = await fetch(`${baseUrl}/orders`);
    expect(res.status).toBe(200);
    const orders = (await res.json()) as any[];
    expect(Array.isArray(orders)).toBe(true);
    expect(orders.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /orders/:id returns 404 for unknown order", async () => {
    const res = await fetch(`${baseUrl}/orders/unknown-order-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not found");
  });

  it("completes full order cycle via endpoints: POST /orders -> POST /orders/:id/attest -> POST /orders/:id/claim", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "25000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    const order = (await createRes.json()) as any;

    const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${order.tokens.attestor}` },
    });
    expect(attestRes.status).toBe(200);
    const attestedOrder = (await attestRes.json()) as any;
    expect(attestedOrder.status).toBe("Attested");
    expect(attestedOrder.lifecycle).toBe("delivered/confirmed");

    const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${order.tokens.seller}` },
    });
    expect(claimRes.status).toBe(200);
    const claimedOrder = (await claimRes.json()) as any;
    expect(claimedOrder.status).toBe("Claimed");
    expect(claimedOrder.lifecycle).toBe("claimed");
  });

  it("POST /orders with Idempotency-Key returns 201 on first request and 200 on identical repeat request", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const idempotencyKey = "test-uuid-idem-alpha";
    const body = {
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: deadline.toString(),
    };

    const firstRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    expect(firstRes.status).toBe(201);
    const firstOrder = (await firstRes.json()) as any;
    expect(firstOrder.id).toBeDefined();

    // Repeat with identical key and body
    const secondRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    expect(secondRes.status).toBe(200);
    const secondOrder = (await secondRes.json()) as any;
    expect(secondOrder.id).toBe(firstOrder.id);
    expect(secondOrder.contractId).toBe(firstOrder.contractId);
  });

  it("POST /orders with same Idempotency-Key but different body returns 409 Conflict", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const idempotencyKey = "test-uuid-idem-conflict";
    const originalBody = {
      sellerAddress: sellerKeypair.publicKey(),
      attestorAddress: attestorKeypair.publicKey(),
      amountStroops: "10000000",
      deadlineSeconds: deadline.toString(),
    };

    const firstRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(originalBody),
    });
    expect(firstRes.status).toBe(201);

    // Repeat with same key but different amount
    const conflictRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        ...originalBody,
        amountStroops: "99999999",
      }),
    });
    expect(conflictRes.status).toBe(409);
    const errorBody = (await conflictRes.json()) as { error: string };
    expect(errorBody.error).toContain("Idempotency key");
  });

  it("POST /orders/:id/cancel mutually cancels order and updates status to Cancelled", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "30000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    const order = (await createRes.json()) as any;

    const cancelRes = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${order.tokens.buyer}` },
    });
    expect(cancelRes.status).toBe(200);
    const cancelledOrder = (await cancelRes.json()) as any;
    expect(cancelledOrder.status).toBe("Cancelled");
    expect(cancelledOrder.lifecycle).toBe("cancelled");
    expect(cancelledOrder.txHashes.cancel).toBe("mock-cancel-hash");
  });

  it("POST /orders/:id/cancel fails with 409 if order is not in Created status", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "30000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    const order = (await createRes.json()) as any;

    await fetch(`${baseUrl}/orders/${order.id}/attest`, {
      method: "POST",
      headers: attestorAuth,
    });

    const cancelRes = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
      method: "POST",
      headers: buyerAuth,
    });
    expect(cancelRes.status).toBe(409);
    const body = (await cancelRes.json()) as { error: string };
    expect(body.error).toContain("Attested");
    expect(body.error).toContain("Created");
  });

  it("POST /orders with attestors array and POST /orders/:id/attest with body", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestors: [attestorKeypair.publicKey(), buyerKeypair.publicKey()],
        threshold: 2,
        amountStroops: "20000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    expect(createRes.status).toBe(201);
    const order = (await createRes.json()) as any;
    expect(order.threshold).toBe(2);
    expect(order.attestors).toEqual([attestorKeypair.publicKey(), buyerKeypair.publicKey()]);

    // First attestation
    const attest1Res = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...attestorAuth },
      body: JSON.stringify({ attestorAddress: attestorKeypair.publicKey() }),
    });
    expect(attest1Res.status).toBe(200);
    const orderAttest1 = (await attest1Res.json()) as any;
    expect(orderAttest1.status).toBe("Created");
    expect(orderAttest1.confirmations).toEqual([attestorKeypair.publicKey()]);

    // Second attestation completes threshold
    const attest2Res = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...attestorAuth },
      body: JSON.stringify({ attestorAddress: buyerKeypair.publicKey() }),
    });
    expect(attest2Res.status).toBe(200);
    const orderAttest2 = (await attest2Res.json()) as any;
    expect(orderAttest2.status).toBe("Attested");
    expect(orderAttest2.confirmations).toHaveLength(2);
  });

  it("POST /orders/:id/dispute and POST /orders/:id/resolve flow", async () => {
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const createRes = await fetch(`${baseUrl}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sellerAddress: sellerKeypair.publicKey(),
        attestorAddress: attestorKeypair.publicKey(),
        amountStroops: "20000000",
        deadlineSeconds: deadline.toString(),
      }),
    });
    const order = (await createRes.json()) as any;

    // Attest order
    await fetch(`${baseUrl}/orders/${order.id}/attest`, {
      method: "POST",
      headers: attestorAuth,
    });

    // Dispute order
    const disputeRes = await fetch(`${baseUrl}/orders/${order.id}/dispute`, {
      method: "POST",
      headers: buyerAuth,
    });
    expect(disputeRes.status).toBe(200);
    const disputedOrder = (await disputeRes.json()) as any;
    expect(disputedOrder.status).toBe("Disputed");
    expect(disputedOrder.lifecycle).toBe("disputed");
    expect(disputedOrder.txHashes.dispute).toBe("mock-dispute-hash");

    // Resolve dispute releasing to seller
    const resolveRes = await fetch(`${baseUrl}/orders/${order.id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...arbiterAuth },
      body: JSON.stringify({ releaseToSeller: true }),
    });
    expect(resolveRes.status).toBe(200);
    const resolvedOrder = (await resolveRes.json()) as any;
    expect(resolvedOrder.status).toBe("Claimed");
    expect(resolvedOrder.lifecycle).toBe("claimed");
    expect(resolvedOrder.txHashes.resolve).toBe("mock-resolve-hash");
  });

  describe("Per-Role API Authentication (Issue #12)", () => {
    it("POST /orders/:id/attest rejects request missing API credentials with 401", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      const res = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("Missing API credential");
    });

    it("POST /orders/:id/attest rejects invalid API credentials with 401", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      const res = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: "Bearer bogus-invalid-token" },
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("Invalid API credential");
    });

    it("POST /orders/:id/claim rejects buyer credential with 403 Forbidden", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      // Attest first using attestor credentials
      await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });

      // Try to claim with buyer token
      const res = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("Forbidden");
    });

    it("POST /orders/:id/reclaim accepts buyer order token and config buyer token", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      // Set deadline in the past to allow reclaim
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 100,
        order.id,
      );

      const res = await fetch(`${baseUrl}/orders/${order.id}/reclaim`, {
        method: "POST",
        headers: { "x-api-key": order.tokens.buyer },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.status).toBe("Reclaimed");
    });
  });

  describe("Client-Side Wallet Signing Routes (?unsigned=true, /build-tx, /tx/submit)", () => {
    it("POST /orders?unsigned=true returns unsigned transaction XDR and order object", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const res = await fetch(`${baseUrl}/orders?unsigned=true`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.unsignedTxXdr).toBe("mock-unsigned-create-xdr");
      expect(data.action).toBe("create");
      expect(data.order.id).toBeDefined();
      expect(data.order.status).toBe("Created");
      expect(data.order.tokens).toBeDefined();
    });

    it("POST /orders/:id/attest?unsigned=true returns unsigned attest XDR with attestor auth", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest?unsigned=true`, {
        method: "POST",
        headers: attestorAuth,
      });
      expect(attestRes.status).toBe(200);
      const data = (await attestRes.json()) as any;
      expect(data.unsignedTxXdr).toBe("mock-unsigned-attest-xdr");
      expect(data.action).toBe("attest");
      expect(data.orderId).toBe(order.id);
    });

    it("POST /orders/:id/build-tx builds unsigned XDR for requested action with role auth", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      const buildRes = await fetch(`${baseUrl}/orders/${order.id}/build-tx`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...attestorAuth },
        body: JSON.stringify({ action: "attest" }),
      });
      expect(buildRes.status).toBe(200);
      const data = (await buildRes.json()) as any;
      expect(data.unsignedTxXdr).toBe("mock-unsigned-attest-xdr");
      expect(data.action).toBe("attest");
    });

    it("POST /tx/submit accepts signed XDR, submits, and updates order with role auth", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      const order = (await createRes.json()) as any;

      const submitRes = await fetch(`${baseUrl}/tx/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...attestorAuth },
        body: JSON.stringify({
          signedXdr: "mock-signed-base64-xdr",
          orderId: order.id,
          action: "attest",
        }),
      });
      expect(submitRes.status).toBe(200);
      const submitData = (await submitRes.json()) as any;
      expect(submitData.txHash).toBe("mock-submit-tx-hash");
      expect(submitData.status).toBe("SUCCESS");
      expect(submitData.order.id).toBe(order.id);
    });
  });

  describe("Webhook Notifications (Issue #13)", () => {
    it("POST /orders accepts valid webhookUrl and returns it in serialized response", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const res = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
          webhookUrl: "https://merchant.example.com/webhooks/orders",
        }),
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.webhookUrl).toBe("https://merchant.example.com/webhooks/orders");

      const getRes = await fetch(`${baseUrl}/orders/${data.id}`);
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as any;
      expect(fetched.webhookUrl).toBe("https://merchant.example.com/webhooks/orders");
    });

    it("POST /orders rejects malformed webhookUrl with 400 Bad Request", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const res = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
          webhookUrl: "not-a-valid-url",
        }),
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as any;
      expect(err.error).toContain("webhookUrl");
      expect(err.error).toContain("valid URL");
    });
  });

  describe("GET /orders Filtering (Issue #16)", () => {
    it("filters orders by role, participant address, and status", async () => {
      const buyerPk = buyerKeypair.publicKey();
      const sellerPk = sellerKeypair.publicKey();
      const attestorPk = attestorKeypair.publicKey();
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Create an order
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerAddress: buyerPk,
          sellerAddress: sellerPk,
          attestorAddress: attestorPk,
          amountStroops: "15000000",
          deadlineSeconds: deadline.toString(),
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as any;

      // Filter by role=seller and address=sellerPk
      const sellerOrdersRes = await fetch(
        `${baseUrl}/orders?role=seller&address=${encodeURIComponent(sellerPk)}`,
      );
      expect(sellerOrdersRes.status).toBe(200);
      const sellerOrders = (await sellerOrdersRes.json()) as any[];
      expect(sellerOrders.some((o) => o.id === created.id)).toBe(true);

      // Filter by role=attestor and address=attestorPk
      const attestorOrdersRes = await fetch(
        `${baseUrl}/orders?role=attestor&address=${encodeURIComponent(attestorPk)}`,
      );
      expect(attestorOrdersRes.status).toBe(200);
      const attestorOrders = (await attestorOrdersRes.json()) as any[];
      expect(attestorOrders.some((o) => o.id === created.id)).toBe(true);

      // Filter by generic address
      const addrOrdersRes = await fetch(`${baseUrl}/orders?address=${encodeURIComponent(buyerPk)}`);
      expect(addrOrdersRes.status).toBe(200);
      const addrOrders = (await addrOrdersRes.json()) as any[];
      expect(addrOrders.some((o) => o.id === created.id)).toBe(true);

      // Filter by status=Created
      const statusOrdersRes = await fetch(`${baseUrl}/orders?status=Created`);
      expect(statusOrdersRes.status).toBe(200);
      const statusOrders = (await statusOrdersRes.json()) as any[];
      expect(statusOrders.every((o) => o.status === "Created")).toBe(true);

      // Non-matching address returns empty or non-matching list
      const nonMatchingRes = await fetch(
        `${baseUrl}/orders?address=GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI`,
      );
      expect(nonMatchingRes.status).toBe(200);
      const nonMatching = (await nonMatchingRes.json()) as any[];
      expect(nonMatching.some((o) => o.id === created.id)).toBe(false);
    });
  });
});
