import { createHmac } from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildWebhookPayload,
  computeWebhookSignature,
  dispatchWebhook,
  sendWebhookWithRetry,
  verifyWebhookSignature,
  SIGNATURE_HEADER,
  SIGNATURE_TIMESTAMP_HEADER,
  type WebhookEventPayload,
} from "../src/webhook.js";
import type { OrderRow } from "../src/db.js";

describe("Webhook Dispatcher & Retries (webhook.ts)", () => {
  const mockOrder: OrderRow = {
    id: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    contract_id: "CA3D5KRYMCMUZGAPOETEZ2NZNOME4H664X4UIRGFW6UR47X7U6GFF6MS",
    numeric_id: 101,
    buyer_address: "GB6NVEN5HSUBKMYCE5ZOWSK5RPO5RDTBWTJHQ35YKVGFFL3U2NOSVNQI",
    seller_address: "GC5H3W256B3QW4A44GAK36XN763K2KRN7O2OESN553TUXW7R6AKN4V6E",
    attestor_address: "GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI",
    attestors: JSON.stringify(["GD6W556Z365UFX3E4K54KPNK3R257K4O53EESK5Q3X7W25N5RN7OESQI"]),
    threshold: 1,
    confirmations: JSON.stringify([]),
    arbiter_address: "GB6NVEN5HSUBKMYCE5ZOWSK5RPO5RDTBWTJHQ35YKVGFFL3U2NOSVNQI",
    token_contract_id: "CTOKEN123",
    amount: "10000000",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    status: "Created",
    create_tx_hash: "mock-create-tx-hash",
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    cancel_tx_hash: null,
    dispute_tx_hash: null,
    resolve_tx_hash: null,
    buyer_token: "buyer_secret_1",
    seller_token: "seller_secret_2",
    attestor_token: "attestor_secret_3",
    arbiter_token: "arbiter_secret_4",
    webhook_url: "https://example.com/webhook",
    idempotency_key: null,
    request_payload: null,
    created_at: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("buildWebhookPayload", () => {
    it("formats standard payload with order details and lifecycle", () => {
      const payload = buildWebhookPayload(mockOrder, "order.created", "tx-hash-123");
      expect(payload.event).toBe("order.created");
      expect(payload.orderId).toBe(mockOrder.id);
      expect(payload.contractId).toBe(mockOrder.contract_id);
      expect(payload.numericId).toBe(101);
      expect(payload.buyerAddress).toBe(mockOrder.buyer_address);
      expect(payload.sellerAddress).toBe(mockOrder.seller_address);
      expect(payload.attestorAddress).toBe(mockOrder.attestor_address);
      expect(payload.amountStroops).toBe("10000000");
      expect(payload.status).toBe("Created");
      expect(payload.lifecycle).toBe("in-transit");
      expect(payload.txHash).toBe("tx-hash-123");
      expect(payload.timestamp).toBeDefined();
    });

    it("maps all statuses to proper human-readable lifecycle labels", () => {
      const attestedOrder: OrderRow = { ...mockOrder, status: "Attested" };
      expect(buildWebhookPayload(attestedOrder, "order.attested").lifecycle).toBe(
        "delivered/confirmed",
      );

      const claimedOrder: OrderRow = { ...mockOrder, status: "Claimed" };
      expect(buildWebhookPayload(claimedOrder, "order.claimed").lifecycle).toBe("claimed");

      const reclaimedOrder: OrderRow = { ...mockOrder, status: "Reclaimed" };
      expect(buildWebhookPayload(reclaimedOrder, "order.reclaimed").lifecycle).toBe("reclaimed");

      const cancelledOrder: OrderRow = { ...mockOrder, status: "Cancelled" };
      expect(buildWebhookPayload(cancelledOrder, "order.cancelled").lifecycle).toBe("cancelled");

      const disputedOrder: OrderRow = { ...mockOrder, status: "Disputed" };
      expect(buildWebhookPayload(disputedOrder, "order.disputed").lifecycle).toBe("disputed");

      const expiredCreated: OrderRow = { ...mockOrder, deadline: 1000, status: "Created" };
      expect(buildWebhookPayload(expiredCreated, "order.created").lifecycle).toBe(
        "deadline-passed",
      );
    });
  });

  describe("sendWebhookWithRetry", () => {
    const testPayload: WebhookEventPayload = {
      event: "order.created",
      orderId: mockOrder.id,
      contractId: mockOrder.contract_id,
      numericId: 101,
      buyerAddress: mockOrder.buyer_address,
      sellerAddress: mockOrder.seller_address,
      attestorAddress: mockOrder.attestor_address,
      attestors: [mockOrder.attestor_address],
      threshold: 1,
      confirmations: [],
      arbiterAddress: null,
      amountStroops: "10000000",
      deadline: 1735689600,
      status: "Created",
      lifecycle: "in-transit",
      txHash: "tx-hash",
      timestamp: new Date().toISOString(),
    };

    it("succeeds on first attempt when server responds 200 OK", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const res = await sendWebhookWithRetry("https://example.com/webhook", testPayload, {
        maxAttempts: 3,
        initialBackoffMs: 1,
      });

      expect(res.success).toBe(true);
      expect(res.attempts).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("retries on HTTP 500 error and succeeds on subsequent attempt", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
        } as Response);

      const res = await sendWebhookWithRetry("https://example.com/webhook", testPayload, {
        maxAttempts: 3,
        initialBackoffMs: 1,
      });

      expect(res.success).toBe(true);
      expect(res.attempts).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("retries on network fetch exception and succeeds on retry", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
        } as Response);

      const res = await sendWebhookWithRetry("https://example.com/webhook", testPayload, {
        maxAttempts: 3,
        initialBackoffMs: 1,
      });

      expect(res.success).toBe(true);
      expect(res.attempts).toBe(2);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("exhausts all retries on continuous failure and returns failure without throwing", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      } as Response);

      const res = await sendWebhookWithRetry("https://example.com/webhook", testPayload, {
        maxAttempts: 3,
        initialBackoffMs: 1,
      });

      expect(res.success).toBe(false);
      expect(res.attempts).toBe(3);
      expect(res.error).toContain("502");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("dispatchWebhook", () => {
    it("no-ops if order has no webhook_url configured", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const orderWithoutWebhook: OrderRow = { ...mockOrder, webhook_url: null };

      await dispatchWebhook(orderWithoutWebhook, "order.created");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("dispatches webhook payload to order's webhook_url", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      await dispatchWebhook(mockOrder, "order.created", "tx-hash-789", {
        maxAttempts: 1,
        initialBackoffMs: 1,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOpts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toBe("https://example.com/webhook");
      expect(calledOpts.method).toBe("POST");
      const parsedBody = JSON.parse(calledOpts.body as string);
      expect(parsedBody.event).toBe("order.created");
      expect(parsedBody.orderId).toBe(mockOrder.id);
      expect(parsedBody.txHash).toBe("tx-hash-789");
    });

    it("guarantees non-blocking execution and never throws even on unhandled network crash", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fatal network crash"));

      await expect(
        dispatchWebhook(mockOrder, "order.created", "tx-hash", {
          maxAttempts: 2,
          initialBackoffMs: 1,
        }),
      ).resolves.not.toThrow();
    });
  });

  describe("HMAC-SHA256 payload signing (Issue #77)", () => {
    // Deliberately a low-entropy, obviously-fake identifier: a realistic
    // 32-byte hex value trips the gitleaks generic-api-key rule in CI. The
    // signature scheme does not care about the secret's shape.
    const SECRET = "webhook-signing-secret-for-tests";

    const signedPayload: WebhookEventPayload = {
      event: "order.claimed",
      orderId: mockOrder.id,
      contractId: mockOrder.contract_id,
      numericId: 101,
      buyerAddress: mockOrder.buyer_address,
      sellerAddress: mockOrder.seller_address,
      attestorAddress: mockOrder.attestor_address,
      attestors: [mockOrder.attestor_address],
      threshold: 1,
      confirmations: [],
      arbiterAddress: null,
      amountStroops: "10000000",
      deadline: 1735689600,
      status: "Claimed",
      lifecycle: "claimed",
      txHash: "tx-hash",
      timestamp: "2026-09-10T00:00:00.000Z",
    };

    function captureDelivery(fetchSpy: ReturnType<typeof vi.spyOn>) {
      const [, opts] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      return {
        body: opts.body as string,
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[SIGNATURE_TIMESTAMP_HEADER],
      };
    }

    it("matches a known signature vector", () => {
      // Locks the scheme: HMAC-SHA256 over "<timestamp>.<raw body>", hex encoded.
      const signature = computeWebhookSignature("{}", "1757462400", "test-secret");
      const expected = createHmac("sha256", "test-secret")
        .update("1757462400.{}", "utf8")
        .digest("hex");
      expect(signature).toBe(`sha256=${expected}`);
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it("sends X-Signature and X-Signature-Timestamp headers when a secret is configured", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 1,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      const { signature, timestamp } = captureDelivery(fetchSpy);
      expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
      expect(timestamp).toMatch(/^\d+$/);
    });

    it("signs the exact transmitted bytes, not a re-serialization", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 1,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      const { body, signature, timestamp } = captureDelivery(fetchSpy);
      // Verifying against the captured body proves the signature covers the
      // bytes actually sent; a re-serialization with different key order would
      // not reproduce this digest.
      expect(verifyWebhookSignature(body, timestamp, SECRET, signature)).toBe(true);
    });

    it("detects a tampered body", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 1,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      const { body, signature, timestamp } = captureDelivery(fetchSpy);
      const tampered = body.replace('"amountStroops":"10000000"', '"amountStroops":"99999999"');
      expect(tampered).not.toBe(body);
      expect(verifyWebhookSignature(tampered, timestamp, SECRET, signature)).toBe(false);
    });

    it("detects a rewound timestamp, so an old delivery cannot be replayed", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 1,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      const { body, signature, timestamp } = captureDelivery(fetchSpy);
      const rewound = (Number(timestamp) - 3600).toString();
      expect(verifyWebhookSignature(body, rewound, SECRET, signature)).toBe(false);
    });

    it("rejects a signature produced with a different secret", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 1,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      const { body, signature, timestamp } = captureDelivery(fetchSpy);
      expect(verifyWebhookSignature(body, timestamp, "wrong-secret", signature)).toBe(false);
    });

    it("keeps one signature across retries of the same delivery", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        } as Response)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 2,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [, first] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      const [, second] = fetchSpy.mock.calls[1] as unknown as [string, RequestInit];
      const firstHeaders = first.headers as Record<string, string>;
      const secondHeaders = second.headers as Record<string, string>;
      expect(secondHeaders[SIGNATURE_HEADER]).toBe(firstHeaders[SIGNATURE_HEADER]);
      expect(secondHeaders[SIGNATURE_TIMESTAMP_HEADER]).toBe(
        firstHeaders[SIGNATURE_TIMESTAMP_HEADER],
      );
    });

    it("omits signature headers and warns when no secret is configured", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 1,
        initialBackoffMs: 1,
        signingSecret: "",
      });

      const { signature, timestamp } = captureDelivery(fetchSpy);
      expect(signature).toBeUndefined();
      expect(timestamp).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("webhook_unsigned"));
    });

    it("never logs the signing secret", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

      await sendWebhookWithRetry("https://example.com/webhook", signedPayload, {
        maxAttempts: 2,
        initialBackoffMs: 1,
        signingSecret: SECRET,
      });

      const emitted = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .join("\n");
      expect(emitted.length).toBeGreaterThan(0);
      expect(emitted).not.toContain(SECRET);
    });
  });
});
