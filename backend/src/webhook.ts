import { createHmac, timingSafeEqual } from "node:crypto";
import { config as appConfig } from "./config.js";
import type { OrderRow } from "./db.js";
import { logStructured } from "./logger.js";

/** Header carrying the `sha256=<hex>` HMAC over the transmitted body. */
export const SIGNATURE_HEADER = "X-Signature";
/** Header carrying the Unix-seconds timestamp that is covered by the signature. */
export const SIGNATURE_TIMESTAMP_HEADER = "X-Signature-Timestamp";
/** Scheme prefix on the signature value, so the algorithm can be rotated later. */
export const SIGNATURE_SCHEME = "sha256";

export type WebhookEventType =
  | "order.created"
  | "order.attested"
  | "order.claimed"
  | "order.reclaimed"
  | "order.cancelled"
  | "order.disputed"
  | "order.resolved";

export interface WebhookEventPayload {
  event: WebhookEventType | string;
  orderId: string;
  contractId: string;
  numericId: number | null;
  buyerAddress: string;
  sellerAddress: string;
  attestorAddress: string;
  attestors: string[];
  threshold: number;
  confirmations: string[];
  arbiterAddress: string | null;
  amountStroops: string;
  deadline: number;
  status: string;
  lifecycle: string;
  txHash: string | null;
  timestamp: string;
}

export interface WebhookRetryConfig {
  maxAttempts?: number;
  initialBackoffMs?: number;
  backoffMultiplier?: number;
  timeoutMs?: number;
  /** Overrides WEBHOOK_SIGNING_SECRET. Empty string disables signing. */
  signingSecret?: string;
}

/**
 * Builds the string the HMAC is computed over.
 *
 * The timestamp is prefixed rather than sent alongside so that it is covered by
 * the signature: a consumer that rejects stale timestamps can trust the one it
 * verified against, and an attacker cannot rewind it to replay an old delivery.
 */
export function buildSignaturePayload(rawBody: string, timestamp: string): string {
  return `${timestamp}.${rawBody}`;
}

/**
 * Computes the `sha256=<hex>` signature for an outgoing delivery.
 *
 * `rawBody` must be the exact string transmitted as the request body. Signing a
 * re-serialization risks a different key order than the bytes on the wire, which
 * fails verification intermittently and is painful to diagnose.
 */
export function computeWebhookSignature(
  rawBody: string,
  timestamp: string,
  secret: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(buildSignaturePayload(rawBody, timestamp), "utf8")
    .digest("hex");
  return `${SIGNATURE_SCHEME}=${digest}`;
}

/**
 * Constant-time comparison of two signature values. Exported so consumers in
 * this repo (and the documented verification example) share one implementation.
 */
export function verifyWebhookSignature(
  rawBody: string,
  timestamp: string,
  secret: string,
  receivedSignature: string,
): boolean {
  const expected = computeWebhookSignature(rawBody, timestamp, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(receivedSignature, "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a non-match.
  if (expectedBuf.length !== receivedBuf.length) return false;
  return timingSafeEqual(expectedBuf, receivedBuf);
}

const DEFAULT_RETRY_CONFIG: Required<Omit<WebhookRetryConfig, "signingSecret">> = {
  maxAttempts: 3,
  initialBackoffMs: 100,
  backoffMultiplier: 2,
  timeoutMs: 5000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendWebhookWithRetry(
  url: string,
  payload: WebhookEventPayload,
  retryConfig: WebhookRetryConfig = {},
): Promise<{ success: boolean; attempts: number; error?: string }> {
  const { maxAttempts, initialBackoffMs, backoffMultiplier, timeoutMs } = {
    ...DEFAULT_RETRY_CONFIG,
    ...retryConfig,
  };
  const signingSecret = retryConfig.signingSecret ?? appConfig.webhookSigningSecret;

  // Serialize once and reuse the identical string for both the signature and the
  // request body, so the signature always covers the exact transmitted bytes.
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "SupplyChainEscrow-Webhook/0.1.0",
    "X-Escrow-Event": payload.event,
  };

  if (signingSecret) {
    headers[SIGNATURE_TIMESTAMP_HEADER] = timestamp;
    headers[SIGNATURE_HEADER] = computeWebhookSignature(rawBody, timestamp, signingSecret);
  } else {
    logStructured({
      type: "webhook_unsigned",
      level: "warn",
      url,
      event: payload.event,
      orderId: payload.orderId,
      message:
        "WEBHOOK_SIGNING_SECRET is not configured; delivery sent unsigned and cannot be verified by the consumer",
    });
  }

  let attempt = 0;
  let currentBackoff = initialBackoffMs;
  let lastError: string | undefined;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: rawBody,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        logStructured({
          type: "webhook_dispatch",
          level: "info",
          url,
          event: payload.event,
          orderId: payload.orderId,
          attempts: attempt,
          status: response.status,
        });
        return { success: true, attempts: attempt };
      }

      lastError = `HTTP ${response.status} ${response.statusText}`;
      logStructured({
        type: "webhook_attempt_failed",
        level: "warn",
        url,
        event: payload.event,
        orderId: payload.orderId,
        attempt,
        status: response.status,
        error: lastError,
      });
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      logStructured({
        type: "webhook_attempt_failed",
        level: "warn",
        url,
        event: payload.event,
        orderId: payload.orderId,
        attempt,
        error: lastError,
      });
    }

    if (attempt < maxAttempts) {
      await sleep(currentBackoff);
      currentBackoff *= backoffMultiplier;
    }
  }

  logStructured({
    type: "webhook_delivery_failed",
    level: "warn",
    url,
    event: payload.event,
    orderId: payload.orderId,
    totalAttempts: attempt,
    error: lastError,
  });

  return { success: false, attempts: attempt, error: lastError };
}

export function buildWebhookPayload(
  order: OrderRow,
  event: WebhookEventType | string,
  txHash?: string | null,
): WebhookEventPayload {
  const attestors: string[] = order.attestors
    ? JSON.parse(order.attestors)
    : [order.attestor_address];
  const confirmations: string[] = order.confirmations ? JSON.parse(order.confirmations) : [];

  const deadlinePassed = Date.now() / 1000 >= order.deadline;
  let lifecycle = "in-transit";
  switch (order.status) {
    case "Created":
      lifecycle = deadlinePassed ? "deadline-passed" : "in-transit";
      break;
    case "Attested":
      lifecycle = "delivered/confirmed";
      break;
    case "Disputed":
      lifecycle = "disputed";
      break;
    case "Claimed":
      lifecycle = "claimed";
      break;
    case "Reclaimed":
      lifecycle = "reclaimed";
      break;
    case "Cancelled":
      lifecycle = "cancelled";
      break;
  }

  return {
    event,
    orderId: order.id,
    contractId: order.contract_id,
    numericId: order.numeric_id ?? null,
    buyerAddress: order.buyer_address,
    sellerAddress: order.seller_address,
    attestorAddress: order.attestor_address,
    attestors,
    threshold: order.threshold ?? 1,
    confirmations,
    arbiterAddress: order.arbiter_address ?? null,
    amountStroops: order.amount,
    deadline: order.deadline,
    status: order.status,
    lifecycle,
    txHash: txHash ?? null,
    timestamp: new Date().toISOString(),
  };
}

export async function dispatchWebhook(
  order: OrderRow,
  event: WebhookEventType | string,
  txHash?: string | null,
  retryConfig?: WebhookRetryConfig,
): Promise<void> {
  if (!order.webhook_url) {
    return;
  }

  const payload = buildWebhookPayload(order, event, txHash);
  try {
    await sendWebhookWithRetry(order.webhook_url, payload, retryConfig);
  } catch (err: unknown) {
    // Guaranteed non-blocking: never let webhook failure bubble up or fail order operations
    logStructured({
      type: "webhook_unhandled_error",
      level: "error",
      url: order.webhook_url,
      orderId: order.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
