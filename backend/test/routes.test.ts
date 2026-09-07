import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";
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
  readOnChainOrder: vi.fn(async () => ({
    buyer: buyerKeypair.publicKey(),
    seller: sellerKeypair.publicKey(),
    attestor: attestorKeypair.publicKey(),
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

  it("POST /orders creates a new order and returns 201 with serialized order", async () => {
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
    expect(order.txHashes.create).toBe("mock-create-hash");
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
    });
    expect(attestRes.status).toBe(200);
    const attestedOrder = (await attestRes.json()) as any;
    expect(attestedOrder.status).toBe("Attested");
    expect(attestedOrder.lifecycle).toBe("delivered/confirmed");

    const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
      method: "POST",
    });
    expect(claimRes.status).toBe(200);
    const claimedOrder = (await claimRes.json()) as any;
    expect(claimedOrder.status).toBe("Claimed");
    expect(claimedOrder.lifecycle).toBe("claimed");
  });
});
