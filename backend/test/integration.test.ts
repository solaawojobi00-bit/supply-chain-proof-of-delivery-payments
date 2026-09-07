import { Keypair } from "@stellar/stellar-sdk";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";
import { db } from "../src/db.js";

// Mock contractOps so integration tests run deterministically and fast in CI
vi.mock("../src/contractOps.js", () => {
  let mockContractCounter = 1;
  return {
    deployEscrowContract: vi.fn(async () => {
      const idNum = (mockContractCounter++).toString().padStart(2, "0");
      return {
        contractId: `C${idNum}${"0".repeat(54)}`,
        txHash: `mock-deploy-tx-hash-${idNum}`,
      };
    }),
    callCreate: vi.fn(async () => "mock-create-tx-hash"),
    callAttest: vi.fn(async () => "mock-attest-tx-hash"),
    callClaim: vi.fn(async () => "mock-claim-tx-hash"),
    callReclaim: vi.fn(async () => "mock-reclaim-tx-hash"),
    callCancel: vi.fn(async () => "mock-cancel-tx-hash"),
    callRegistryCreateOrder: vi.fn(async () => "mock-reg-create-tx-hash"),
    callRegistryAttest: vi.fn(async () => "mock-reg-attest-tx-hash"),
    callRegistryClaim: vi.fn(async () => "mock-reg-claim-tx-hash"),
    callRegistryReclaim: vi.fn(async () => "mock-reg-reclaim-tx-hash"),
    callRegistryCancel: vi.fn(async () => "mock-reg-cancel-tx-hash"),
    readOnChainOrder: vi.fn(async (contractId: string) => ({
      buyer: buyerKeypair.publicKey(),
      seller: sellerKeypair.publicKey(),
      attestors: [attestorKeypair.publicKey()],
      threshold: 1,
      confirmations: [],
      token: "CDUMMYTOKENCONTRACTID00000000000000000000000000000000000000",
      amount: 100000000n,
      deadline: 9999999999n,
      status: "Created",
      contractId,
    })),
  };
});

import { app } from "../src/index.js";

describe("Backend Integration Test Suite (Full Order Lifecycles & Negative Matrix)", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  describe("API Health & Discovery", () => {
    it("GET /health responds with 200 ok", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { status: string };
      expect(data.status).toBe("ok");
    });

    it("GET /orders returns existing list of orders", async () => {
      const res = await fetch(`${baseUrl}/orders`);
      expect(res.status).toBe(200);
      const list = (await res.json()) as unknown[];
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe("Full Lifecycle 1: Happy Path (Create -> Attest -> Claim)", () => {
    it("executes the full delivery confirmation and seller payment flow", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 7200;
      const amountStroops = "100000000";

      // 1. Create Order
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops,
          deadlineSeconds: String(deadline),
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: string;
        contractId: string;
        status: string;
        lifecycle: string;
        buyerAddress: string;
        sellerAddress: string;
        attestorAddress: string;
        amountStroops: string;
        deadline: number;
        txHashes: {
          create: string;
          attest: string | null;
          claim: string | null;
          reclaim: string | null;
        };
      };

      expect(created.id).toBeDefined();
      expect(created.status).toBe("Created");
      expect(created.lifecycle).toBe("in-transit");
      expect(created.buyerAddress).toBe(buyerKeypair.publicKey());
      expect(created.sellerAddress).toBe(sellerKeypair.publicKey());
      expect(created.attestorAddress).toBe(attestorKeypair.publicKey());
      expect(created.amountStroops).toBe(amountStroops);
      expect(created.deadline).toBe(deadline);
      expect(created.txHashes.create).toBe("mock-create-tx-hash");
      expect(created.txHashes.attest).toBeNull();

      // 2. Fetch Order with on-chain status
      const getRes = await fetch(`${baseUrl}/orders/${created.id}`);
      expect(getRes.status).toBe(200);
      const fetched = (await getRes.json()) as {
        id: string;
        status: string;
        lifecycle: string;
        onChain: { status: string; amount: string; deadline: string };
      };
      expect(fetched.id).toBe(created.id);
      expect(fetched.status).toBe("Created");
      expect(fetched.lifecycle).toBe("in-transit");
      expect(fetched.onChain.status).toBe("Created");

      // 3. Attest Delivery
      const attestRes = await fetch(`${baseUrl}/orders/${created.id}/attest`, {
        method: "POST",
      });
      expect(attestRes.status).toBe(200);
      const attested = (await attestRes.json()) as {
        id: string;
        status: string;
        lifecycle: string;
        txHashes: { attest: string };
      };
      expect(attested.id).toBe(created.id);
      expect(attested.status).toBe("Attested");
      expect(attested.lifecycle).toBe("delivered/confirmed");
      expect(attested.txHashes.attest).toBe("mock-attest-tx-hash");

      // 4. Seller Claims Escrowed Funds
      const claimRes = await fetch(`${baseUrl}/orders/${created.id}/claim`, {
        method: "POST",
      });
      expect(claimRes.status).toBe(200);
      const claimed = (await claimRes.json()) as {
        id: string;
        status: string;
        lifecycle: string;
        txHashes: { claim: string };
      };
      expect(claimed.id).toBe(created.id);
      expect(claimed.status).toBe("Claimed");
      expect(claimed.lifecycle).toBe("claimed");
      expect(claimed.txHashes.claim).toBe("mock-claim-tx-hash");

      // 5. Final State Verification
      const finalRes = await fetch(`${baseUrl}/orders/${created.id}`);
      expect(finalRes.status).toBe(200);
      const finalOrder = (await finalRes.json()) as {
        id: string;
        status: string;
        lifecycle: string;
        txHashes: { create: string; attest: string; claim: string; reclaim: string | null };
      };
      expect(finalOrder.status).toBe("Claimed");
      expect(finalOrder.lifecycle).toBe("claimed");
      expect(finalOrder.txHashes.create).toBe("mock-create-tx-hash");
      expect(finalOrder.txHashes.attest).toBe("mock-attest-tx-hash");
      expect(finalOrder.txHashes.claim).toBe("mock-claim-tx-hash");
      expect(finalOrder.txHashes.reclaim).toBeNull();
    });
  });

  describe("Full Lifecycle 2: Expiration & Reclaim Path (Create -> Expired -> Reclaim)", () => {
    it("executes the buyer reclaim flow after deadline passes without attestation", async () => {
      // Create with a future deadline (to pass validation), then test reclaim after deadline
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "50000000",
          deadlineSeconds: String(deadline),
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; status: string };

      // Manually set deadline to past in database
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 60,
        created.id,
      );

      // Verify lifecycle reports deadline-passed
      const getRes = await fetch(`${baseUrl}/orders/${created.id}`);
      const fetched = (await getRes.json()) as { lifecycle: string; status: string };
      expect(fetched.status).toBe("Created");
      expect(fetched.lifecycle).toBe("deadline-passed");

      // Buyer reclaims funds
      const reclaimRes = await fetch(`${baseUrl}/orders/${created.id}/reclaim`, {
        method: "POST",
      });
      expect(reclaimRes.status).toBe(200);
      const reclaimed = (await reclaimRes.json()) as {
        id: string;
        status: string;
        lifecycle: string;
        txHashes: { reclaim: string };
      };
      expect(reclaimed.id).toBe(created.id);
      expect(reclaimed.status).toBe("Reclaimed");
      expect(reclaimed.lifecycle).toBe("reclaimed");
      expect(reclaimed.txHashes.reclaim).toBe("mock-reclaim-tx-hash");

      // Verify in order list
      const listRes = await fetch(`${baseUrl}/orders`);
      const allOrders = (await listRes.json()) as Array<{ id: string; status: string }>;
      const matching = allOrders.find((o) => o.id === created.id);
      expect(matching?.status).toBe("Reclaimed");
    });
  });

  describe("Full Lifecycle 3: Mutual Cancellation Path (Create -> Cancel)", () => {
    it("executes mutual order cancellation before attestation, refunding buyer", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "60000000",
          deadlineSeconds: String(deadline),
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; status: string };

      // Cancel order mutually
      const cancelRes = await fetch(`${baseUrl}/orders/${created.id}/cancel`, {
        method: "POST",
      });
      expect(cancelRes.status).toBe(200);
      const cancelled = (await cancelRes.json()) as {
        id: string;
        status: string;
        lifecycle: string;
        txHashes: { cancel: string };
      };
      expect(cancelled.id).toBe(created.id);
      expect(cancelled.status).toBe("Cancelled");
      expect(cancelled.lifecycle).toBe("cancelled");
      expect(cancelled.txHashes.cancel).toBe("mock-cancel-tx-hash");

      // Verify state in GET /orders/:id
      const getRes = await fetch(`${baseUrl}/orders/${created.id}`);
      const fetched = (await getRes.json()) as { status: string; lifecycle: string };
      expect(fetched.status).toBe("Cancelled");
      expect(fetched.lifecycle).toBe("cancelled");
    });
  });

  describe("Negative Integration Scenarios & State Guard Assertions", () => {
    it("Double-claim: rejects claim on an order that is already Claimed (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      // Attest and claim
      await fetch(`${baseUrl}/orders/${order.id}/attest`, { method: "POST" });
      const firstClaimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });
      expect(firstClaimRes.status).toBe(200);

      // Attempt second claim
      const secondClaimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });
      expect(secondClaimRes.status).toBe(409);
      const errorBody = (await secondClaimRes.json()) as { error: string };
      expect(errorBody.error).toContain(
        "Order is Claimed; can only claim an order that has been Attested",
      );
    });

    it("Reclaim-after-claim: rejects reclaim on an already claimed order (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      await fetch(`${baseUrl}/orders/${order.id}/attest`, { method: "POST" });
      await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });

      const reclaimRes = await fetch(`${baseUrl}/orders/${order.id}/reclaim`, { method: "POST" });
      expect(reclaimRes.status).toBe(409);
      const errorBody = (await reclaimRes.json()) as { error: string };
      expect(errorBody.error).toContain(
        "Order is Claimed; can only reclaim an order that is still Created",
      );
    });

    it("Attest-after-deadline: rejects attestation if deadline has passed (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      // Expire order in DB
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 100,
        order.id,
      );

      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, { method: "POST" });
      expect(attestRes.status).toBe(409);
      const errorBody = (await attestRes.json()) as { error: string };
      expect(errorBody.error).toContain("Deadline has already passed");
    });

    it("Claim-without-attestation: rejects claim on an unattested Created order (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      // Attempt claim directly
      const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });
      expect(claimRes.status).toBe(409);
      const errorBody = (await claimRes.json()) as { error: string };
      expect(errorBody.error).toContain(
        "Order is Created; can only claim an order that has been Attested",
      );
    });

    it("Reclaim-before-deadline: rejects buyer reclaim before deadline has elapsed (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      const reclaimRes = await fetch(`${baseUrl}/orders/${order.id}/reclaim`, { method: "POST" });
      expect(reclaimRes.status).toBe(409);
      const errorBody = (await reclaimRes.json()) as { error: string };
      expect(errorBody.error).toContain("Deadline has not passed yet");
    });

    it("Attest-after-reclaim: rejects attestation on a Reclaimed order (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      // Expire and reclaim
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 10,
        order.id,
      );
      await fetch(`${baseUrl}/orders/${order.id}/reclaim`, { method: "POST" });

      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, { method: "POST" });
      expect(attestRes.status).toBe(409);
      const errorBody = (await attestRes.json()) as { error: string };
      expect(errorBody.error).toContain(
        "Order is Reclaimed; can only attest an order that is Created",
      );
    });

    it("Missing local signer: rejects attest/claim for unconfigured external keypairs (400 Bad Request)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const externalKeypair = Keypair.random();

      // Order with unknown attestor
      const createRes1 = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: externalKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order1 = (await createRes1.json()) as { id: string };

      const attestRes = await fetch(`${baseUrl}/orders/${order1.id}/attest`, { method: "POST" });
      expect(attestRes.status).toBe(400);
      const attestError = (await attestRes.json()) as { error: string };
      expect(attestError.error).toContain("No local signer for this attestor address");

      // Order with unknown seller
      const createRes2 = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: externalKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order2 = (await createRes2.json()) as { id: string };

      // Attest succeeds because attestor is local
      const attestRes2 = await fetch(`${baseUrl}/orders/${order2.id}/attest`, { method: "POST" });
      expect(attestRes2.status).toBe(200);

      // Claim fails because seller is external
      const claimRes2 = await fetch(`${baseUrl}/orders/${order2.id}/claim`, { method: "POST" });
      expect(claimRes2.status).toBe(400);
      const claimError = (await claimRes2.json()) as { error: string };
      expect(claimError.error).toContain("No local signer for this seller address");
    });

    it("Non-existent Order: returns 404 Not Found on all endpoint operations", async () => {
      const nonExistentId = "non-existent-uuid-test";

      const getRes = await fetch(`${baseUrl}/orders/${nonExistentId}`);
      expect(getRes.status).toBe(404);

      const attestRes = await fetch(`${baseUrl}/orders/${nonExistentId}/attest`, {
        method: "POST",
      });
      expect(attestRes.status).toBe(404);

      const claimRes = await fetch(`${baseUrl}/orders/${nonExistentId}/claim`, { method: "POST" });
      expect(claimRes.status).toBe(404);

      const reclaimRes = await fetch(`${baseUrl}/orders/${nonExistentId}/reclaim`, {
        method: "POST",
      });
      expect(reclaimRes.status).toBe(404);

      const cancelRes = await fetch(`${baseUrl}/orders/${nonExistentId}/cancel`, {
        method: "POST",
      });
      expect(cancelRes.status).toBe(404);
    });

    it("Cancel after attest: rejects cancellation once delivery has been attested (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      await fetch(`${baseUrl}/orders/${order.id}/attest`, { method: "POST" });

      const cancelRes = await fetch(`${baseUrl}/orders/${order.id}/cancel`, { method: "POST" });
      expect(cancelRes.status).toBe(409);
      const errorBody = (await cancelRes.json()) as { error: string };
      expect(errorBody.error).toContain(
        "Order is Attested; can only cancel an order that is Created",
      );
    });

    it("Cancel after reclaim: rejects cancellation once order has been reclaimed (409 Conflict)", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as { id: string };

      // Expire and reclaim
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 10,
        order.id,
      );
      await fetch(`${baseUrl}/orders/${order.id}/reclaim`, { method: "POST" });

      const cancelRes = await fetch(`${baseUrl}/orders/${order.id}/cancel`, { method: "POST" });
      expect(cancelRes.status).toBe(409);
      const errorBody = (await cancelRes.json()) as { error: string };
      expect(errorBody.error).toContain(
        "Order is Reclaimed; can only cancel an order that is Created",
      );
    });

    it("Validation Errors: returns 400 with descriptive error on invalid inputs", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // Malformed seller address
      const res1 = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: "INVALID_ADDRESS",
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
        }),
      });
      expect(res1.status).toBe(400);

      // Non-positive amount
      const res2 = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "0",
          deadlineSeconds: String(deadline),
        }),
      });
      expect(res2.status).toBe(400);

      // Past deadline
      const res3 = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(Math.floor(Date.now() / 1000) - 100),
        }),
      });
      expect(res3.status).toBe(400);

      // Malformed tokenContractId
      const res4 = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "10000000",
          deadlineSeconds: String(deadline),
          tokenContractId: "not-a-valid-contract-id",
        }),
      });
      expect(res4.status).toBe(400);
      const error4 = (await res4.json()) as { error: string };
      expect(error4.error).toContain("tokenContractId");
    });

    it("Multi-asset: successfully creates, attests, and claims order with custom tokenContractId", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const customToken = "CAIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRCEIRDB3V";

      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "25000000",
          deadlineSeconds: String(deadline),
          tokenContractId: customToken,
        }),
      });
      expect(createRes.status).toBe(201);
      const order = (await createRes.json()) as {
        id: string;
        tokenContractId: string;
        status: string;
      };
      expect(order.tokenContractId).toBe(customToken);
      expect(order.status).toBe("Created");

      // Attest
      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, { method: "POST" });
      expect(attestRes.status).toBe(200);

      // Claim
      const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });
      expect(claimRes.status).toBe(200);
      const claimed = (await claimRes.json()) as { tokenContractId: string; status: string };
      expect(claimed.tokenContractId).toBe(customToken);
      expect(claimed.status).toBe("Claimed");
    });

    it("Multi-attestor M-of-N: requires threshold confirmations before allowing claim", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const attestors = [attestorKeypair.publicKey(), buyerKeypair.publicKey()];

      // 1. Create order with 2 attestors, threshold 2
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestors,
          threshold: 2,
          amountStroops: "50000000",
          deadlineSeconds: String(deadline),
        }),
      });
      expect(createRes.status).toBe(201);
      const order = (await createRes.json()) as {
        id: string;
        status: string;
        threshold: number;
        confirmations: string[];
      };
      expect(order.threshold).toBe(2);
      expect(order.status).toBe("Created");

      // 2. Attempt claim before any attestation -> 409
      const earlyClaim = await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });
      expect(earlyClaim.status).toBe(409);

      // 3. First attestor confirms -> status remains Created, 1 confirmation recorded
      const attest1 = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attestorAddress: attestorKeypair.publicKey() }),
      });
      expect(attest1.status).toBe(200);
      const partialOrder = (await attest1.json()) as { status: string; confirmations: string[] };
      expect(partialOrder.status).toBe("Created");
      expect(partialOrder.confirmations).toHaveLength(1);

      // 4. Attempt claim after 1 of 2 confirmations -> 409
      const stillEarlyClaim = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
      });
      expect(stillEarlyClaim.status).toBe(409);

      // 5. Second attestor confirms -> threshold (2) reached, transitions to Attested
      const attest2 = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attestorAddress: buyerKeypair.publicKey() }),
      });
      expect(attest2.status).toBe(200);
      const fullOrder = (await attest2.json()) as { status: string; confirmations: string[] };
      expect(fullOrder.status).toBe("Attested");
      expect(fullOrder.confirmations).toHaveLength(2);

      // 6. Seller can now claim
      const finalClaim = await fetch(`${baseUrl}/orders/${order.id}/claim`, { method: "POST" });
      expect(finalClaim.status).toBe(200);
      const finalOrder = (await finalClaim.json()) as { status: string };
      expect(finalOrder.status).toBe("Claimed");
    });
  });
});
