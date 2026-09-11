import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";
import { db } from "../src/db.js";
import { router } from "../src/routes.js";
import { HttpError } from "../src/httpError.js";

vi.mock("../src/contractOps.js", () => ({
  deployEscrowContract: vi.fn(async () => ({
    contractId: "C" + "0".repeat(55),
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
}));
import {
  registerAttestor,
  getAttestorById,
  getAttestorByAddress,
  listAttestors,
  computeReputationForAddress,
} from "../src/attestorDirectory.js";

describe("Attestor Reputation & Discovery Subsystem (Issue #17)", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;

  const testAttestorAddress = attestorKeypair.publicKey();
  const secondaryAttestorAddress = "GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(router);
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (typeof address === "object" && address) {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    await db.execute(`DELETE FROM attestor_directory`);
    await db.execute(`DELETE FROM orders`);
  });

  describe("Attestor Registration & Profile Management", () => {
    it("registers a new attestor profile with initial unblemished reputation (score 100)", async () => {
      const res = await fetch(`${baseUrl}/attestors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: testAttestorAddress,
          name: "Global Freight Verifiers",
          description: "Certified logistics and proof-of-delivery verifier",
          coverageArea: "North America & Europe",
          feeBps: 25,
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.id).toBeDefined();
      expect(data.address).toBe(testAttestorAddress);
      expect(data.name).toBe("Global Freight Verifiers");
      expect(data.coverageArea).toBe("North America & Europe");
      expect(data.feeBps).toBe(25);
      expect(data.active).toBe(true);
      expect(data.reputation.totalAssigned).toBe(0);
      expect(data.reputation.reputationScore).toBe(100);
      expect(data.reputation.successRate).toBe(1);
    });

    it("rejects registration with invalid Stellar address or missing name", async () => {
      const badAddressRes = await fetch(`${baseUrl}/attestors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: "invalid-stellar-key",
          name: "Bad Attestor",
        }),
      });
      expect(badAddressRes.status).toBe(400);
      const badAddrJson = (await badAddressRes.json()) as any;
      expect(badAddrJson.error).toContain("address");

      const missingNameRes = await fetch(`${baseUrl}/attestors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: testAttestorAddress,
          name: "",
        }),
      });
      expect(missingNameRes.status).toBe(400);
    });

    it("updates existing registration when the same address registers again", async () => {
      await registerAttestor({
        address: testAttestorAddress,
        name: "Original Name",
        feeBps: 10,
      });

      const res = await fetch(`${baseUrl}/attestors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: testAttestorAddress,
          name: "Updated Logistics Inc.",
          coverageArea: "Global",
          feeBps: 50,
        }),
      });

      expect(res.status).toBe(201);
      const updated = (await res.json()) as any;
      expect(updated.name).toBe("Updated Logistics Inc.");
      expect(updated.coverageArea).toBe("Global");
      expect(updated.feeBps).toBe(50);

      const all = await listAttestors();
      expect(all).toHaveLength(1);

      const byId = await getAttestorById(all[0].id);
      expect(byId?.name).toBe("Updated Logistics Inc.");

      const byAddr = await getAttestorByAddress(testAttestorAddress);
      expect(byAddr?.id).toBe(all[0].id);

      const notFoundId = await getAttestorById("non-existent-id");
      expect(notFoundId).toBeUndefined();

      const notFoundAddr = await getAttestorByAddress(
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      );
      expect(notFoundAddr).toBeUndefined();
    });
  });

  describe("Dynamic Reputation Computation from Real Order History", () => {
    it("computes reputation metrics dynamically based on Claimed, Reclaimed, and Disputed orders", async () => {
      // 1. Insert 3 successful claimed orders
      for (let i = 1; i <= 3; i++) {
        await db.execute({
          sql: `INSERT INTO orders (
            id, contract_id, numeric_id, buyer_address, seller_address, attestor_address,
            attestors, threshold, confirmations, arbiter_address,
            token_contract_id, amount, deadline, status,
            create_tx_hash, attest_tx_hash, claim_tx_hash, reclaim_tx_hash, cancel_tx_hash,
            dispute_tx_hash, resolve_tx_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            `order-success-${i}`,
            `C-mock-contract-${i}`,
            100 + i,
            buyerKeypair.publicKey(),
            sellerKeypair.publicKey(),
            testAttestorAddress,
            JSON.stringify([testAttestorAddress]),
            1,
            JSON.stringify([testAttestorAddress]),
            null,
            "CTOKEN",
            "10000000",
            Math.floor(Date.now() / 1000) + 3600,
            "Claimed",
            "tx-create",
            "tx-attest",
            "tx-claim",
            null,
            null,
            null,
            null,
            new Date().toISOString(),
          ],
        });
      }

      // 2. Insert 1 expired reclaimed order
      await db.execute({
        sql: `INSERT INTO orders (
          id, contract_id, numeric_id, buyer_address, seller_address, attestor_address,
          attestors, threshold, confirmations, arbiter_address,
          token_contract_id, amount, deadline, status,
          create_tx_hash, attest_tx_hash, claim_tx_hash, reclaim_tx_hash, cancel_tx_hash,
          dispute_tx_hash, resolve_tx_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "order-expired-1",
          "C-mock-contract-expired",
          104,
          buyerKeypair.publicKey(),
          sellerKeypair.publicKey(),
          testAttestorAddress,
          JSON.stringify([testAttestorAddress]),
          1,
          JSON.stringify([]),
          null,
          "CTOKEN",
          "10000000",
          Math.floor(Date.now() / 1000) - 100,
          "Reclaimed",
          "tx-create",
          null,
          null,
          "tx-reclaim",
          null,
          null,
          null,
          new Date().toISOString(),
        ],
      });

      // 3. Insert 1 disputed order
      await db.execute({
        sql: `INSERT INTO orders (
          id, contract_id, numeric_id, buyer_address, seller_address, attestor_address,
          attestors, threshold, confirmations, arbiter_address,
          token_contract_id, amount, deadline, status,
          create_tx_hash, attest_tx_hash, claim_tx_hash, reclaim_tx_hash, cancel_tx_hash,
          dispute_tx_hash, resolve_tx_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "order-disputed-1",
          "C-mock-contract-disputed",
          105,
          buyerKeypair.publicKey(),
          sellerKeypair.publicKey(),
          testAttestorAddress,
          JSON.stringify([testAttestorAddress]),
          1,
          JSON.stringify([testAttestorAddress]),
          null,
          "CTOKEN",
          "10000000",
          Math.floor(Date.now() / 1000) + 3600,
          "Disputed",
          "tx-create",
          "tx-attest",
          null,
          null,
          null,
          "tx-dispute",
          null,
          new Date().toISOString(),
        ],
      });

      const rep = await computeReputationForAddress(testAttestorAddress);
      expect(rep.totalAssigned).toBe(5);
      expect(rep.totalAttested).toBe(4);
      expect(rep.successfulClaims).toBe(3);
      expect(rep.reclaimedAfterExpiry).toBe(1);
      expect(rep.disputedOrders).toBe(1);
      expect(rep.successRate).toBe(0.6); // 3/5
      expect(rep.disputeRate).toBe(0.2); // 1/5
      expect(rep.reputationScore).toBeGreaterThan(0);
      expect(rep.reputationScore).toBeLessThanOrEqual(100);
    });
  });

  describe("Directory Discovery & Listing Endpoints", () => {
    it("GET /attestors returns list sorted by reputation score and supports coverage area filter", async () => {
      await registerAttestor({
        address: testAttestorAddress,
        name: "North America Carrier",
        coverageArea: "North America",
        feeBps: 20,
      });

      await registerAttestor({
        address: secondaryAttestorAddress,
        name: "Asia Pacific Express",
        coverageArea: "APAC",
        feeBps: 30,
      });

      const listRes = await fetch(`${baseUrl}/attestors`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as any[];
      expect(list).toHaveLength(2);

      const filterRes = await fetch(`${baseUrl}/attestors?coverageArea=APAC`);
      expect(filterRes.status).toBe(200);
      const filtered = (await filterRes.json()) as any[];
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe("Asia Pacific Express");
    });

    it("GET /attestors/:id returns single attestor profile and 404 for unknown id", async () => {
      const created = await registerAttestor({
        address: testAttestorAddress,
        name: "Express Verifier",
      });

      const getRes = await fetch(`${baseUrl}/attestors/${created.id}`);
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as any;
      expect(body.id).toBe(created.id);
      expect(body.name).toBe("Express Verifier");

      const notFoundRes = await fetch(`${baseUrl}/attestors/non-existent-id`);
      expect(notFoundRes.status).toBe(404);
    });
  });

  describe("Order Creation with attestorId", () => {
    it("POST /orders accepts attestorId and resolves address from directory", async () => {
      const registered = await registerAttestor({
        address: testAttestorAddress,
        name: "Directory Registered Attestor",
      });

      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const res = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorId: registered.id,
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });

      expect(res.status).toBe(201);
      const order = (await res.json()) as any;
      expect(order.attestorAddress).toBe(testAttestorAddress);
    });

    it("POST /orders returns 400 when provided attestorId does not exist in directory", async () => {
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const res = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sellerAddress: sellerKeypair.publicKey(),
          attestorId: "unknown-attestor-id",
          amountStroops: "10000000",
          deadlineSeconds: deadline.toString(),
        }),
      });

      expect(res.status).toBe(400);
      const err = (await res.json()) as any;
      expect(err.error).toContain("not found in directory");
    });
  });
});
