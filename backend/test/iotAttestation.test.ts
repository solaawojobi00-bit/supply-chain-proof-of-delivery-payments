import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { attestorKeypair, buyerKeypair, sellerKeypair } from "../src/keys.js";
import { db } from "../src/db.js";
import { router } from "../src/routes.js";
import { HttpError } from "../src/httpError.js";
import {
  calculateDistanceMeters,
  verifyIoTEventSignature,
  authenticateIoTRequest,
  processIoTTelemetryEvent,
} from "../src/integrations/iotAttestation.js";

vi.mock("../src/contractOps.js", () => ({
  deployEscrowContract: vi.fn(async () => ({
    contractId: "C" + "0".repeat(55),
    txHash: "mock-deploy-hash",
  })),
  callCreate: vi.fn(async () => "mock-create-hash"),
  callAttest: vi.fn(async () => "mock-iot-attest-hash"),
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

describe("GPS/IoT Automated Attestation Integration (Issue #18)", () => {
  let server: ReturnType<typeof express.application.listen>;
  let baseUrl: string;
  const testSecret = "super-secret-iot-token-2026";

  beforeAll(async () => {
    process.env.IOT_WEBHOOK_SECRET = testSecret;

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

  beforeEach(() => {
    db.exec(`DELETE FROM orders`);
  });

  function createTestOrder(id: string, overrides: Partial<Record<string, unknown>> = {}) {
    const defaultDeadline = Math.floor(Date.now() / 1000) + 3600;
    db.prepare(
      `INSERT INTO orders (
        id, contract_id, numeric_id, buyer_address, seller_address, attestor_address,
        attestors, threshold, confirmations, arbiter_address, token_contract_id,
        amount, deadline, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      "C" + "0".repeat(55),
      101,
      overrides.buyerAddress || buyerKeypair.publicKey(),
      overrides.sellerAddress || sellerKeypair.publicKey(),
      overrides.attestorAddress || attestorKeypair.publicKey(),
      JSON.stringify(overrides.attestors || [attestorKeypair.publicKey()]),
      1,
      null,
      null,
      "C" + "0".repeat(55),
      "10000000",
      overrides.deadline !== undefined ? overrides.deadline : defaultDeadline,
      overrides.status || "Created",
      new Date().toISOString(),
    );
  }

  describe("Haversine Distance & Signature Verification Functions", () => {
    it("calculates distance between GPS coordinates accurately", () => {
      const warehouse = { latitude: 37.7749, longitude: -122.4194 };
      const deliveryTruckNearby = { latitude: 37.7751, longitude: -122.4192 };
      const distanceNearby = calculateDistanceMeters(warehouse, deliveryTruckNearby);
      expect(distanceNearby).toBeLessThan(100);
      expect(distanceNearby).toBeGreaterThan(10);

      const farAwayTruck = { latitude: 34.0522, longitude: -118.2437 }; // LA
      const distanceFar = calculateDistanceMeters(warehouse, farAwayTruck);
      expect(distanceFar).toBeGreaterThan(500000); // ~550km
    });

    it("verifies valid HMAC-SHA256 signatures and rejects tampered payloads", () => {
      const payload = {
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        deviceId: "TRUCK-99",
        eventType: "geofence_entry" as const,
        timestamp: "2026-09-08T10:00:00Z",
      };

      const hmac = createHmac("sha256", testSecret);
      hmac.update(JSON.stringify(payload));
      const validSig = hmac.digest("hex");

      expect(verifyIoTEventSignature(payload, validSig, testSecret)).toBe(true);
      expect(verifyIoTEventSignature(payload, `sha256=${validSig}`, testSecret)).toBe(true);
      expect(verifyIoTEventSignature(payload, "invalid-hex-signature", testSecret)).toBe(false);
      expect(verifyIoTEventSignature(payload, validSig, "wrong-secret")).toBe(false);
      expect(verifyIoTEventSignature(payload, undefined, testSecret)).toBe(false);
    });

    it("authenticates requests using shared secret header or signature", () => {
      const payload = {
        orderId: "550e8400-e29b-41d4-a716-446655440000",
        deviceId: "TRUCK-99",
        eventType: "rfid_scan" as const,
        timestamp: 1735689600,
      };

      expect(authenticateIoTRequest(payload, { secret: testSecret }, testSecret)).toBe(true);
      expect(authenticateIoTRequest(payload, { secret: "wrong-secret" }, testSecret)).toBe(false);
      expect(authenticateIoTRequest(payload, {}, testSecret)).toBe(false);
    });

    it("processIoTTelemetryEvent executes end-to-end direct programmatic invocation", async () => {
      const testOrderId = "660e8400-e29b-41d4-a716-446655440000";
      createTestOrder(testOrderId);

      const result = await processIoTTelemetryEvent(
        {
          orderId: testOrderId,
          deviceId: "DIRECT-TEST-DEVICE",
          eventType: "rfid_scan",
          timestamp: Date.now(),
        },
        { secret: testSecret },
        testSecret,
      );

      expect(result.success).toBe(true);
      expect(result.orderId).toBe(testOrderId);
      expect(result.order.status).toBe("Attested");
    });
  });

  describe("POST /integrations/iot/events Endpoint", () => {
    const testOrderId = "550e8400-e29b-41d4-a716-446655440000";

    it("successfully confirms delivery when receiving a valid GPS geofence arrival event with HMAC signature", async () => {
      createTestOrder(testOrderId);

      const payload = {
        orderId: testOrderId,
        deviceId: "GPS-TRACKER-007",
        eventType: "geofence_entry",
        coordinates: { latitude: 40.7128, longitude: -74.006 },
        targetCoordinates: { latitude: 40.7129, longitude: -74.0061, maxRadiusMeters: 200 },
        timestamp: new Date().toISOString(),
        metadata: { speedKmh: 0, engineStatus: "off" },
      };

      const hmac = createHmac("sha256", testSecret);
      hmac.update(JSON.stringify(payload));
      const sig = hmac.digest("hex");

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-signature": `sha256=${sig}`,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.orderId).toBe(testOrderId);
      expect(data.deviceId).toBe("GPS-TRACKER-007");
      expect(data.eventType).toBe("geofence_entry");
      expect(data.txHash).toBe("mock-iot-attest-hash");
      expect(data.order.status).toBe("Attested");

      // Verify DB order updated to Attested
      const updatedOrder = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(testOrderId) as any;
      expect(updatedOrder.status).toBe("Attested");
      expect(updatedOrder.attest_tx_hash).toBe("mock-iot-attest-hash");
    });

    it("successfully confirms delivery with shared-secret token and RFID scan event", async () => {
      createTestOrder(testOrderId);

      const payload = {
        orderId: testOrderId,
        deviceId: "RFID-GATE-SCANNER-NORTH",
        eventType: "rfid_scan",
        scanCode: "EPC-TAG-99881122",
        timestamp: Date.now(),
      };

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-secret": testSecret,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.success).toBe(true);
      expect(data.eventType).toBe("rfid_scan");
      expect(data.order.status).toBe("Attested");
    });

    it("rejects unauthenticated requests with 401 Unauthorized", async () => {
      createTestOrder(testOrderId);

      const payload = {
        orderId: testOrderId,
        deviceId: "UNAUTHORIZED-DEVICE",
        eventType: "telemetry_reading",
        timestamp: Date.now(),
      };

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-secret": "invalid-token",
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Unauthorized");
    });

    it("rejects geofence events when device is outside allowed radius with 422 Unprocessable Entity", async () => {
      createTestOrder(testOrderId);

      const payload = {
        orderId: testOrderId,
        deviceId: "GPS-TRUCK-5",
        eventType: "geofence_entry",
        coordinates: { latitude: 34.0522, longitude: -118.2437 }, // Los Angeles
        targetCoordinates: { latitude: 40.7128, longitude: -74.006, maxRadiusMeters: 500 }, // New York
        timestamp: new Date().toISOString(),
      };

      const hmac = createHmac("sha256", testSecret);
      hmac.update(JSON.stringify(payload));
      const sig = hmac.digest("hex");

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-signature": sig,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Geofence validation failed");
    });

    it("returns 400 when geofence_entry is missing coordinates", async () => {
      createTestOrder(testOrderId);

      const payload = {
        orderId: testOrderId,
        deviceId: "GPS-TRUCK-5",
        eventType: "geofence_entry",
        timestamp: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-secret": testSecret,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toContain("coordinates");
    });

    it("returns 404 when orderId is not found", async () => {
      const payload = {
        orderId: randomUUID(),
        deviceId: "GPS-TRUCK-5",
        eventType: "rfid_scan",
        timestamp: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-secret": testSecret,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(404);
    });

    it("returns 409 when order is already in Claimed or Attested state", async () => {
      createTestOrder(testOrderId, { status: "Claimed" });

      const payload = {
        orderId: testOrderId,
        deviceId: "GPS-TRUCK-5",
        eventType: "rfid_scan",
        timestamp: new Date().toISOString(),
      };

      const res = await fetch(`${baseUrl}/integrations/iot/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iot-secret": testSecret,
        },
        body: JSON.stringify(payload),
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as any;
      expect(data.error).toContain("Order is Claimed; can only attest an order that is Created");
    });
  });
});
