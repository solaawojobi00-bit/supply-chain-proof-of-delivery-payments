import { Keypair } from "@stellar/stellar-sdk";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";
import { config } from "../src/config.js";
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
    callDispute: vi.fn(async () => "mock-dispute-tx-hash"),
    callResolveDispute: vi.fn(async () => "mock-resolve-tx-hash"),
    callRegistryCreateOrder: vi.fn(async () => "mock-reg-create-tx-hash"),
    callRegistryAttest: vi.fn(async () => "mock-reg-attest-tx-hash"),
    callRegistryClaim: vi.fn(async () => "mock-reg-claim-tx-hash"),
    callRegistryReclaim: vi.fn(async () => "mock-reg-reclaim-tx-hash"),
    callRegistryCancel: vi.fn(async () => "mock-reg-cancel-tx-hash"),
    callRegistryDispute: vi.fn(async () => "mock-reg-dispute-hash"),
    callRegistryResolveDispute: vi.fn(async () => "mock-reg-resolve-hash"),
    buildUnsignedCreateTx: vi.fn(async () => "mock-unsigned-create-tx-hash"),
    buildUnsignedAttestTx: vi.fn(async () => "mock-unsigned-attest-tx-hash"),
    buildUnsignedClaimTx: vi.fn(async () => "mock-unsigned-claim-tx-hash"),
    buildUnsignedReclaimTx: vi.fn(async () => "mock-unsigned-reclaim-tx-hash"),
    buildUnsignedCancelTx: vi.fn(async () => "mock-unsigned-cancel-tx-hash"),
    buildUnsignedDisputeTx: vi.fn(async () => "mock-unsigned-dispute-tx-hash"),
    buildUnsignedResolveTx: vi.fn(async () => "mock-unsigned-resolve-tx-hash"),
    buildRegistryUnsignedCreateTx: vi.fn(async () => "mock-reg-unsigned-create-tx"),
    buildRegistryUnsignedAttestTx: vi.fn(async () => "mock-reg-unsigned-attest-tx"),
    buildRegistryUnsignedClaimTx: vi.fn(async () => "mock-reg-unsigned-claim-tx"),
    buildRegistryUnsignedReclaimTx: vi.fn(async () => "mock-reg-unsigned-reclaim-tx"),
    buildRegistryUnsignedCancelTx: vi.fn(async () => "mock-reg-unsigned-cancel-tx"),
    buildRegistryUnsignedDisputeTx: vi.fn(async () => "mock-reg-unsigned-dispute-tx"),
    buildRegistryUnsignedResolveTx: vi.fn(async () => "mock-reg-unsigned-resolve-tx"),
    submitSignedXDR: vi.fn(async () => ({
      txHash: "mock-wallet-signed-tx-hash",
      status: "SUCCESS",
    })),
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

  const buyerAuth = { Authorization: `Bearer ${config.buyerApiKey}` };
  const sellerAuth = { Authorization: `Bearer ${config.sellerApiKey}` };
  const attestorAuth = { Authorization: `Bearer ${config.attestorApiKey}` };
  const arbiterAuth = { Authorization: `Bearer ${config.arbiterApiKey}` };
  const adminAuth = { Authorization: `Bearer ${config.adminApiKey}` };

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
        tokens?: { buyer: string; seller: string; attestor: string };
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
      expect(created.tokens).toBeDefined();
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

      // 3. Attest Delivery with attestor credentials
      const attestRes = await fetch(`${baseUrl}/orders/${created.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${created.tokens!.attestor}` },
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

      // 4. Seller Claims Escrowed Funds with seller credentials
      const claimRes = await fetch(`${baseUrl}/orders/${created.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${created.tokens!.seller}` },
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
      const created = (await createRes.json()) as {
        id: string;
        status: string;
        tokens: { buyer: string };
      };

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

      // Buyer reclaims funds with buyer credential
      const reclaimRes = await fetch(`${baseUrl}/orders/${created.id}/reclaim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${created.tokens.buyer}` },
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
      const created = (await createRes.json()) as {
        id: string;
        status: string;
        tokens: { buyer: string };
      };

      // Cancel order mutually with buyer credential
      const cancelRes = await fetch(`${baseUrl}/orders/${created.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${created.tokens.buyer}` },
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
      const order = (await createRes.json()) as {
        id: string;
        tokens: { attestor: string; seller: string };
      };

      // Attest and claim
      await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
      const firstClaimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(firstClaimRes.status).toBe(200);

      // Attempt second claim
      const secondClaimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
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
      const order = (await createRes.json()) as {
        id: string;
        tokens: { attestor: string; seller: string; buyer: string };
      };

      await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
      await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });

      const reclaimRes = await fetch(`${baseUrl}/orders/${order.id}/reclaim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
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
      const order = (await createRes.json()) as { id: string; tokens: { attestor: string } };

      // Expire order in DB
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 100,
        order.id,
      );

      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
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
      const order = (await createRes.json()) as { id: string; tokens: { seller: string } };

      // Attempt claim directly
      const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
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
      const order = (await createRes.json()) as { id: string; tokens: { buyer: string } };

      const reclaimRes = await fetch(`${baseUrl}/orders/${order.id}/reclaim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
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
      const order = (await createRes.json()) as {
        id: string;
        tokens: { buyer: string; attestor: string };
      };

      // Expire and reclaim
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 10,
        order.id,
      );
      await fetch(`${baseUrl}/orders/${order.id}/reclaim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });

      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
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
      const order1 = (await createRes1.json()) as { id: string; tokens: { attestor: string } };

      const attestRes = await fetch(`${baseUrl}/orders/${order1.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order1.tokens.attestor}` },
      });
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
      const order2 = (await createRes2.json()) as {
        id: string;
        tokens: { attestor: string; seller: string };
      };

      // Attest succeeds because attestor is local
      const attestRes2 = await fetch(`${baseUrl}/orders/${order2.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order2.tokens.attestor}` },
      });
      expect(attestRes2.status).toBe(200);

      // Claim fails because seller is external
      const claimRes2 = await fetch(`${baseUrl}/orders/${order2.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order2.tokens.seller}` },
      });
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
        headers: attestorAuth,
      });
      expect(attestRes.status).toBe(404);

      const claimRes = await fetch(`${baseUrl}/orders/${nonExistentId}/claim`, {
        method: "POST",
        headers: sellerAuth,
      });
      expect(claimRes.status).toBe(404);

      const reclaimRes = await fetch(`${baseUrl}/orders/${nonExistentId}/reclaim`, {
        method: "POST",
        headers: buyerAuth,
      });
      expect(reclaimRes.status).toBe(404);

      const cancelRes = await fetch(`${baseUrl}/orders/${nonExistentId}/cancel`, {
        method: "POST",
        headers: buyerAuth,
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
      const order = (await createRes.json()) as {
        id: string;
        tokens: { attestor: string; buyer: string };
      };

      await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });

      const cancelRes = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
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
      const order = (await createRes.json()) as { id: string; tokens: { buyer: string } };

      // Expire and reclaim
      db.prepare("UPDATE orders SET deadline = ? WHERE id = ?").run(
        Math.floor(Date.now() / 1000) - 10,
        order.id,
      );
      await fetch(`${baseUrl}/orders/${order.id}/reclaim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });

      const cancelRes = await fetch(`${baseUrl}/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
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
        tokens: { attestor: string; seller: string };
      };
      expect(order.tokenContractId).toBe(customToken);
      expect(order.status).toBe("Created");

      // Attest
      const attestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
      expect(attestRes.status).toBe(200);

      // Claim
      const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
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
        tokens: { attestor: string; seller: string };
      };
      expect(order.threshold).toBe(2);
      expect(order.status).toBe("Created");

      // 2. Attempt claim before any attestation -> 409
      const earlyClaim = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(earlyClaim.status).toBe(409);

      // 3. First attestor confirms -> status remains Created, 1 confirmation recorded
      const attest1 = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.attestor}`,
        },
        body: JSON.stringify({ attestorAddress: attestorKeypair.publicKey() }),
      });
      expect(attest1.status).toBe(200);
      const partialOrder = (await attest1.json()) as { status: string; confirmations: string[] };
      expect(partialOrder.status).toBe("Created");
      expect(partialOrder.confirmations).toHaveLength(1);

      // 4. Attempt claim after 1 of 2 confirmations -> 409
      const stillEarlyClaim = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(stillEarlyClaim.status).toBe(409);

      // 5. Second attestor confirms -> threshold (2) reached, transitions to Attested
      const attest2 = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.attestor}`,
        },
        body: JSON.stringify({ attestorAddress: buyerKeypair.publicKey() }),
      });
      expect(attest2.status).toBe(200);
      const fullOrder = (await attest2.json()) as { status: string; confirmations: string[] };
      expect(fullOrder.status).toBe("Attested");
      expect(fullOrder.confirmations).toHaveLength(2);

      // 6. Seller can now claim
      const finalClaim = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(finalClaim.status).toBe(200);
      const finalOrder = (await finalClaim.json()) as { status: string };
      expect(finalOrder.status).toBe("Claimed");
    });
  });

  describe("Full Lifecycle 4: Dispute & Arbiter Resolution Paths", () => {
    it("executes Dispute -> Arbiter resolves releasing to seller", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // 1. Create order
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
      const order = (await createRes.json()) as {
        id: string;
        tokens: { attestor: string; buyer: string; seller: string; arbiter: string };
      };

      // 2. Attest order
      await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });

      // 3. Buyer disputes
      const disputeRes = await fetch(`${baseUrl}/orders/${order.id}/dispute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
      expect(disputeRes.status).toBe(200);
      const disputed = (await disputeRes.json()) as { status: string; lifecycle: string };
      expect(disputed.status).toBe("Disputed");
      expect(disputed.lifecycle).toBe("disputed");

      // 4. Seller claim is blocked while disputed -> 409 Conflict
      const claimRes = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(claimRes.status).toBe(409);

      // 5. Arbiter resolves releasing to seller
      const resolveRes = await fetch(`${baseUrl}/orders/${order.id}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.arbiter}`,
        },
        body: JSON.stringify({ releaseToSeller: true }),
      });
      expect(resolveRes.status).toBe(200);
      const resolved = (await resolveRes.json()) as {
        status: string;
        lifecycle: string;
        txHashes: { resolve: string };
      };
      expect(resolved.status).toBe("Claimed");
      expect(resolved.lifecycle).toBe("claimed");
      expect(resolved.txHashes.resolve).toBe("mock-resolve-tx-hash");
    });

    it("executes Dispute -> Arbiter resolves refunding to buyer", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // 1. Create order
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "40000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as {
        id: string;
        tokens: { attestor: string; buyer: string; arbiter: string };
      };

      // 2. Attest order
      await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });

      // 3. Buyer disputes
      await fetch(`${baseUrl}/orders/${order.id}/dispute`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });

      // 4. Arbiter resolves refunding to buyer
      const resolveRes = await fetch(`${baseUrl}/orders/${order.id}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.arbiter}`,
        },
        body: JSON.stringify({ releaseToSeller: false }),
      });
      expect(resolveRes.status).toBe(200);
      const resolved = (await resolveRes.json()) as { status: string; lifecycle: string };
      expect(resolved.status).toBe("Reclaimed");
      expect(resolved.lifecycle).toBe("reclaimed");
    });
  });

  describe("Full Lifecycle 5: Client-Side Wallet Signing Flow (Unconfigured Wallets)", () => {
    it("allows addresses without local server keys to complete flow via unsigned XDR and /tx/submit", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const externalSeller = Keypair.random();
      const externalAttestor = Keypair.random();

      // 1. Create order with external seller and attestor
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: externalSeller.publicKey(),
          attestorAddress: externalAttestor.publicKey(),
          amountStroops: "100000000",
          deadlineSeconds: String(deadline),
        }),
      });
      expect(createRes.status).toBe(201);
      const order = (await createRes.json()) as {
        id: string;
        tokens: { attestor: string; seller: string };
      };

      // 2. Direct server signing fails for unconfigured attestor
      const directAttestRes = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
      expect(directAttestRes.status).toBe(400);

      // 3. Client-side wallet signing requests unsigned attest XDR
      const buildAttestRes = await fetch(`${baseUrl}/orders/${order.id}/attest?unsigned=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.attestor}`,
        },
        body: JSON.stringify({ attestorAddress: externalAttestor.publicKey() }),
      });
      expect(buildAttestRes.status).toBe(200);
      const unsignedData = (await buildAttestRes.json()) as {
        unsignedTxXdr: string;
        action: string;
      };
      expect(unsignedData.unsignedTxXdr).toBeDefined();
      expect(unsignedData.action).toBe("attest");

      // 4. Wallet signs XDR and submits to /tx/submit
      const submitAttestRes = await fetch(`${baseUrl}/tx/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.attestor}`,
        },
        body: JSON.stringify({
          signedXdr: "mock-freighter-signed-attest-xdr",
          orderId: order.id,
          action: "attest",
        }),
      });
      expect(submitAttestRes.status).toBe(200);
      const attestResult = (await submitAttestRes.json()) as { txHash: string; status: string };
      expect(attestResult.txHash).toBe("mock-wallet-signed-tx-hash");
      expect(attestResult.status).toBe("SUCCESS");

      // 5. Build unsigned claim XDR for external seller
      const buildClaimRes = await fetch(`${baseUrl}/orders/${order.id}/claim?unsigned=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(buildClaimRes.status).toBe(200);
      const claimUnsigned = (await buildClaimRes.json()) as {
        unsignedTxXdr: string;
        action: string;
      };
      expect(claimUnsigned.action).toBe("claim");

      // 6. Submit signed claim XDR
      const submitClaimRes = await fetch(`${baseUrl}/orders/${order.id}/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${order.tokens.seller}`,
        },
        body: JSON.stringify({
          signedXdr: "mock-freighter-signed-claim-xdr",
          action: "claim",
        }),
      });
      expect(submitClaimRes.status).toBe(200);
      const claimResult = (await submitClaimRes.json()) as { txHash: string };
      expect(claimResult.txHash).toBe("mock-wallet-signed-tx-hash");
    });
  });

  describe("Full Lifecycle 6: Per-Role API Authentication (Issue #12)", () => {
    it("enforces role isolation and rejects unauthorized parties with 403 Forbidden", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      // 1. Create order
      const createRes = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorAddress: attestorKeypair.publicKey(),
          amountStroops: "100000000",
          deadlineSeconds: String(deadline),
        }),
      });
      const order = (await createRes.json()) as {
        id: string;
        tokens: { buyer: string; seller: string; attestor: string; arbiter: string };
      };

      // 2. Attest endpoint rejects buyer, seller, arbiter with 403
      const attestBuyer = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.buyer}` },
      });
      expect(attestBuyer.status).toBe(403);

      const attestSeller = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(attestSeller.status).toBe(403);

      // 3. Attest endpoint accepts attestor token
      const attestAttestor = await fetch(`${baseUrl}/orders/${order.id}/attest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
      expect(attestAttestor.status).toBe(200);

      // 4. Claim endpoint rejects attestor with 403
      const claimAttestor = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.attestor}` },
      });
      expect(claimAttestor.status).toBe(403);

      // 5. Claim endpoint accepts seller token
      const claimSeller = await fetch(`${baseUrl}/orders/${order.id}/claim`, {
        method: "POST",
        headers: { Authorization: `Bearer ${order.tokens.seller}` },
      });
      expect(claimSeller.status).toBe(200);
    });
  });
});
