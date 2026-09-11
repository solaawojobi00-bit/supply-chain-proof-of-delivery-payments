import express, { type NextFunction, type Request, type Response } from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { db } from "../src/db.js";
import { router } from "../src/routes.js";
import { HttpError } from "../src/httpError.js";
import { listAttestors, registerAttestor } from "../src/attestorDirectory.js";

interface AttestorResponse {
  address: string;
  name: string;
  feeBps: number;
  coverageArea: string | null;
  reputation: {
    totalAssigned: number;
    totalAttested: number;
    successRate: number;
    disputeRate: number;
    reputationScore: number;
  };
}

describe("Attestor Reputation Sort & Filter (Issue #78)", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;

  // Generated rather than hard-coded so every fixture is a genuinely valid
  // Ed25519 public key: these flow through registerAttestor and the reputation
  // queries, and should stay valid if address validation is tightened later.
  const FLAWLESS = Keypair.random().publicKey();
  const MIXED = Keypair.random().publicKey();
  const DISPUTED = Keypair.random().publicKey();
  const THIN_SAMPLE = Keypair.random().publicKey();

  /** Inserts an order attributed to `attestor` with the given terminal status. */
  async function seedOrder(attestor: string, status: string, opts: { disputed?: boolean } = {}) {
    const id = `${attestor.slice(0, 6)}-${status}-${Math.random().toString(36).slice(2, 10)}`;
    await db.execute({
      sql: `INSERT INTO orders (
        id, contract_id, buyer_address, seller_address, attestor_address,
        attestors, threshold, confirmations, token_contract_id, amount,
        deadline, status, dispute_tx_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        "C" + "0".repeat(55),
        FLAWLESS,
        MIXED,
        attestor,
        JSON.stringify([attestor]),
        1,
        JSON.stringify([attestor]),
        "C" + "1".repeat(55),
        "10000000",
        Math.floor(Date.now() / 1000) + 3600,
        status,
        opts.disputed ? "mock-dispute-hash" : null,
        new Date().toISOString(),
      ],
    });
  }

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

    await registerAttestor({
      address: FLAWLESS,
      name: "Flawless Freight",
      coverageArea: "North America",
      feeBps: 300,
    });
    await registerAttestor({
      address: MIXED,
      name: "Mixed Record Logistics",
      coverageArea: "Europe",
      feeBps: 100,
    });
    await registerAttestor({
      address: DISPUTED,
      name: "Disputed Deliveries",
      coverageArea: "Asia Pacific",
      feeBps: 50,
    });
    await registerAttestor({
      address: THIN_SAMPLE,
      name: "Brand New Attestor",
      coverageArea: "North America",
      feeBps: 25,
    });

    // FLAWLESS: 4/4 claimed -> successRate 1.0, disputeRate 0
    for (let i = 0; i < 4; i++) await seedOrder(FLAWLESS, "Claimed");

    // MIXED: 2/4 claimed -> successRate 0.5, disputeRate 0
    await seedOrder(MIXED, "Claimed");
    await seedOrder(MIXED, "Claimed");
    await seedOrder(MIXED, "Reclaimed");
    await seedOrder(MIXED, "Reclaimed");

    // DISPUTED: 1/4 claimed, 2 disputed -> successRate 0.25, disputeRate 0.5
    await seedOrder(DISPUTED, "Claimed");
    await seedOrder(DISPUTED, "Reclaimed");
    await seedOrder(DISPUTED, "Disputed", { disputed: true });
    await seedOrder(DISPUTED, "Disputed", { disputed: true });

    // THIN_SAMPLE: exactly one claimed order -> successRate 1.0 on n=1
    await seedOrder(THIN_SAMPLE, "Claimed");
  });

  async function get(query: string): Promise<{ status: number; body: AttestorResponse[] }> {
    const res = await fetch(`${baseUrl}/attestors${query}`);
    return { status: res.status, body: (await res.json()) as AttestorResponse[] };
  }

  describe("sort keys", () => {
    it("sorts by reputationScore descending by default", async () => {
      const { status, body } = await get("?sort=reputationScore");
      expect(status).toBe(200);
      const scores = body.map((a) => a.reputation.reputationScore);
      expect(scores).toEqual([...scores].sort((x, y) => y - x));
    });

    it("sorts by successRate, honouring an explicit ascending order", async () => {
      const { body } = await get("?sort=successRate&order=asc");
      const rates = body.map((a) => a.reputation.successRate);
      expect(rates).toEqual([...rates].sort((x, y) => x - y));
      expect(rates[0]).toBeCloseTo(0.25);
    });

    it("sorts by disputeRate ascending by default, so the cleanest record leads", async () => {
      const { body } = await get("?sort=disputeRate");
      const rates = body.map((a) => a.reputation.disputeRate);
      expect(rates).toEqual([...rates].sort((x, y) => x - y));
      expect(body[body.length - 1].address).toBe(DISPUTED);
    });

    it("sorts by feeBps ascending by default, since a lower fee is better", async () => {
      const { body } = await get("?sort=feeBps");
      expect(body.map((a) => a.feeBps)).toEqual([25, 50, 100, 300]);
    });

    it("reverses feeBps when order=desc is given", async () => {
      const { body } = await get("?sort=feeBps&order=desc");
      expect(body.map((a) => a.feeBps)).toEqual([300, 100, 50, 25]);
    });
  });

  describe("filters", () => {
    it("filters by minSuccessRate", async () => {
      const { body } = await get("?minSuccessRate=0.5");
      const addresses = body.map((a) => a.address).sort();
      expect(addresses).toEqual([FLAWLESS, MIXED, THIN_SAMPLE].sort());
      expect(addresses).not.toContain(DISPUTED);
    });

    it("filters by maxDisputeRate", async () => {
      const { body } = await get("?maxDisputeRate=0");
      expect(body.map((a) => a.address)).not.toContain(DISPUTED);
      expect(body).toHaveLength(3);
    });

    it("filters by maxFeeBps", async () => {
      const { body } = await get("?maxFeeBps=100");
      expect(body.every((a) => a.feeBps <= 100)).toBe(true);
      expect(body.map((a) => a.address)).not.toContain(FLAWLESS);
    });

    it("filters by coverageArea", async () => {
      const { body } = await get("?coverageArea=North America");
      expect(body.map((a) => a.address).sort()).toEqual([FLAWLESS, THIN_SAMPLE].sort());
    });

    it("combines filters with a sort", async () => {
      const { body } = await get("?maxDisputeRate=0&sort=feeBps&order=asc");
      expect(body.map((a) => a.address)).not.toContain(DISPUTED);
      expect(body.map((a) => a.feeBps)).toEqual([25, 100, 300]);
    });

    it("preserves activeOnly default behaviour", async () => {
      await db.execute({
        sql: `UPDATE attestor_directory SET active = 0 WHERE address = ?`,
        args: [MIXED],
      });

      const { body: defaulted } = await get("");
      expect(defaulted.map((a) => a.address)).not.toContain(MIXED);

      const { body: explicit } = await get("?active=false");
      expect(explicit.map((a) => a.address)).toContain(MIXED);
    });
  });

  describe("thin-sample guard", () => {
    it("exposes sample size alongside every rate", async () => {
      const { body } = await get("");
      for (const attestor of body) {
        expect(typeof attestor.reputation.totalAssigned).toBe("number");
        expect(typeof attestor.reputation.totalAttested).toBe("number");
      }
      const thin = body.find((a) => a.address === THIN_SAMPLE);
      // A 100% success rate over a single order must be distinguishable from a
      // 100% rate over a long record, which is the whole point of the criterion.
      expect(thin?.reputation.successRate).toBe(1);
      expect(thin?.reputation.totalAssigned).toBe(1);
    });

    it("excludes thin samples via minCompletedOrders", async () => {
      const { body } = await get("?minCompletedOrders=4");
      const addresses = body.map((a) => a.address);
      expect(addresses).not.toContain(THIN_SAMPLE);
      expect(addresses).toContain(FLAWLESS);
    });
  });

  describe("validation", () => {
    it("rejects an unknown sort key with 400 rather than silently falling back", async () => {
      const res = await fetch(`${baseUrl}/attestors?sort=reputatoinScore`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("sort must be one of");
    });

    it("rejects an unknown order direction with 400", async () => {
      const res = await fetch(`${baseUrl}/attestors?sort=feeBps&order=sideways`);
      expect(res.status).toBe(400);
    });

    it("rejects a non-numeric numeric filter with 400", async () => {
      const res = await fetch(`${baseUrl}/attestors?minSuccessRate=high`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("minSuccessRate must be a number");
    });

    it("rejects an out-of-range rate with 400", async () => {
      const res = await fetch(`${baseUrl}/attestors?maxDisputeRate=5`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("maxDisputeRate must be <= 1");
    });

    it("rejects an unrecognised query param so a client typo is visible", async () => {
      const res = await fetch(`${baseUrl}/attestors?minSucessRate=0.5`);
      expect(res.status).toBe(400);
    });
  });

  describe("listAttestors() unit behaviour", () => {
    it("applies the documented default direction per sort key", async () => {
      const fees = (await listAttestors({ sort: "feeBps" })).map((a) => a.feeBps);
      expect(fees).toEqual([25, 50, 100, 300]);
      const scores = (await listAttestors({ sort: "reputationScore" })).map(
        (a) => a.reputation.reputationScore,
      );
      expect(scores).toEqual([...scores].sort((x, y) => y - x));
    });

    it("returns every registered attestor when no filters are supplied", async () => {
      expect(await listAttestors()).toHaveLength(4);
    });
  });
});
