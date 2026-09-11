import { Keypair } from "@stellar/stellar-sdk";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertOrder, type OrderRow } from "../src/db.js";
import { HttpError } from "../src/httpError.js";
import { router } from "../src/routes.js";
import type { Server } from "node:http";

describe("Orders Filtering & Keyset Pagination (Issue #73)", () => {
  let server: Server;
  let baseUrl: string;

  const buyer1 = Keypair.random().publicKey();
  const buyer2 = Keypair.random().publicKey();
  const seller1 = Keypair.random().publicKey();
  const seller2 = Keypair.random().publicKey();
  const attestor1 = Keypair.random().publicKey();
  const attestor2 = Keypair.random().publicKey();
  const arbiter1 = Keypair.random().publicKey();

  const seedOrders: OrderRow[] = [
    {
      id: "page-ord-001",
      contract_id: "C" + "1".repeat(55),
      numeric_id: 1,
      buyer_address: buyer1,
      seller_address: seller1,
      attestor_address: attestor1,
      attestors: JSON.stringify([attestor1]),
      threshold: 1,
      token_contract_id: "CTOKEN1",
      amount: "1000000",
      deadline: 1800000000,
      status: "Created",
      create_tx_hash: "hash-001",
      attest_tx_hash: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      created_at: "2026-09-08T10:00:00.000Z",
    },
    {
      id: "page-ord-002",
      contract_id: "C" + "2".repeat(55),
      numeric_id: 2,
      buyer_address: buyer1,
      seller_address: seller2,
      attestor_address: attestor1,
      attestors: JSON.stringify([attestor1, attestor2]),
      threshold: 2,
      token_contract_id: "CTOKEN1",
      amount: "2000000",
      deadline: 1800000000,
      status: "Attested",
      create_tx_hash: "hash-002",
      attest_tx_hash: "attest-hash-002",
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      created_at: "2026-09-08T11:00:00.000Z",
    },
    {
      id: "page-ord-003",
      contract_id: "C" + "3".repeat(55),
      numeric_id: 3,
      buyer_address: buyer2,
      seller_address: seller1,
      attestor_address: attestor2,
      attestors: JSON.stringify([attestor2]),
      threshold: 1,
      token_contract_id: "CTOKEN1",
      amount: "3000000",
      deadline: 1800000000,
      status: "Claimed",
      create_tx_hash: "hash-003",
      attest_tx_hash: "attest-hash-003",
      claim_tx_hash: "claim-hash-003",
      reclaim_tx_hash: null,
      created_at: "2026-09-08T12:00:00.000Z",
    },
    {
      id: "page-ord-004",
      contract_id: "C" + "4".repeat(55),
      numeric_id: 4,
      buyer_address: buyer2,
      seller_address: seller2,
      attestor_address: attestor1,
      attestors: JSON.stringify([attestor1]),
      threshold: 1,
      token_contract_id: "CTOKEN1",
      amount: "4000000",
      deadline: 1800000000,
      status: "Disputed",
      arbiter_address: arbiter1,
      create_tx_hash: "hash-004",
      attest_tx_hash: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      created_at: "2026-09-08T13:00:00.000Z",
    },
    {
      id: "page-ord-005",
      contract_id: "C" + "5".repeat(55),
      numeric_id: 5,
      buyer_address: buyer1,
      seller_address: seller1,
      attestor_address: attestor2,
      attestors: JSON.stringify([attestor2]),
      threshold: 1,
      token_contract_id: "CTOKEN1",
      amount: "5000000",
      deadline: 1800000000,
      status: "Cancelled",
      create_tx_hash: "hash-005",
      attest_tx_hash: null,
      claim_tx_hash: null,
      reclaim_tx_hash: null,
      created_at: "2026-09-08T14:00:00.000Z",
    },
  ];

  beforeAll(async () => {
    // Seed test orders. Awaited individually so a duplicate-key rejection is
    // caught here rather than surfacing as an unhandled rejection.
    for (const order of seedOrders) {
      try {
        await insertOrder(order);
      } catch {
        // ignore if already seeded
      }
    }

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
    server?.close();
  });

  describe("Response Shape & Default Querying", () => {
    it("returns paginated shape with orders array and next_cursor", async () => {
      const res = await fetch(`${baseUrl}/orders`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("orders");
      expect(body).toHaveProperty("next_cursor");
      expect(Array.isArray(body.orders)).toBe(true);
      expect(body.orders.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("Keyset Pagination Across Multi-Page Sets", () => {
    it("pages sequentially without duplicates or missing items", async () => {
      // Page 1: limit 2
      const res1 = await fetch(`${baseUrl}/orders?limit=2&buyer=${buyer1}`);
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.orders.length).toBe(2);
      expect(body1.next_cursor).not.toBeNull();
      expect(body1.orders[0].id).toBe("page-ord-005");
      expect(body1.orders[1].id).toBe("page-ord-002");

      // Page 2: limit 2 with cursor
      const res2 = await fetch(
        `${baseUrl}/orders?limit=2&buyer=${buyer1}&cursor=${encodeURIComponent(body1.next_cursor)}`,
      );
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.orders.length).toBe(1);
      expect(body2.orders[0].id).toBe("page-ord-001");
      expect(body2.next_cursor).toBeNull();
    });

    it("clamps limit above 200 to 200 without throwing 400", async () => {
      const res = await fetch(`${baseUrl}/orders?limit=500`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.orders)).toBe(true);
    });
  });

  describe("Filtering by Single and Multiple Fields", () => {
    it("filters by single status (case-insensitive)", async () => {
      const res = await fetch(`${baseUrl}/orders?status=created`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orders.every((o: { status: string }) => o.status === "Created")).toBe(true);
    });

    it("filters by multiple comma-separated statuses", async () => {
      const res = await fetch(`${baseUrl}/orders?status=Created,Attested`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(
        body.orders.every(
          (o: { status: string }) => o.status === "Created" || o.status === "Attested",
        ),
      ).toBe(true);
    });

    it("filters by buyer address", async () => {
      const res = await fetch(`${baseUrl}/orders?buyer=${buyer2}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orders.every((o: { buyerAddress: string }) => o.buyerAddress === buyer2)).toBe(
        true,
      );
      expect(body.orders.length).toBe(2);
    });

    it("filters by seller address", async () => {
      const res = await fetch(`${baseUrl}/orders?seller=${seller2}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orders.every((o: { sellerAddress: string }) => o.sellerAddress === seller2)).toBe(
        true,
      );
    });

    it("filters by attestor address including M-of-N roster matches", async () => {
      const res = await fetch(`${baseUrl}/orders?attestor=${attestor2}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      // ord-002 has attestors [attestor1, attestor2], ord-003 has attestor2, ord-005 has attestor2
      const ids = body.orders.map((o: { id: string }) => o.id);
      expect(ids).toContain("page-ord-002");
      expect(ids).toContain("page-ord-003");
      expect(ids).toContain("page-ord-005");
      expect(ids).not.toContain("page-ord-001");
    });

    it("combines multiple filters simultaneously", async () => {
      const res = await fetch(`${baseUrl}/orders?buyer=${buyer1}&seller=${seller1}&status=Created`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.orders.length).toBe(1);
      expect(body.orders[0].id).toBe("page-ord-001");
    });
  });

  describe("Validation & Rejection of Invalid Parameters", () => {
    it("rejects unknown query parameters with 400", async () => {
      const res = await fetch(`${baseUrl}/orders?unknownParam=xyz`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeDefined();
    });

    it("rejects invalid status with 400", async () => {
      const res = await fetch(`${baseUrl}/orders?status=NonExistentStatus`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("status must be one or more valid order statuses");
    });

    it("rejects invalid Stellar addresses with 400", async () => {
      const res = await fetch(`${baseUrl}/orders?buyer=not-a-stellar-key`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("buyer must be a valid Stellar public key");
    });

    it("rejects negative or invalid limits with 400", async () => {
      const res = await fetch(`${baseUrl}/orders?limit=-10`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("limit must be a positive integer");
    });

    it("rejects malformed cursor with 400", async () => {
      const res = await fetch(`${baseUrl}/orders?cursor=not-a-valid-base64-json`);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid pagination cursor format");
    });
  });
});
