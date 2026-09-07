import type { OrderRow } from "./db.js";
import { logStructured } from "./logger.js";

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
}

const DEFAULT_RETRY_CONFIG: Required<WebhookRetryConfig> = {
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
  config: WebhookRetryConfig = {},
): Promise<{ success: boolean; attempts: number; error?: string }> {
  const { maxAttempts, initialBackoffMs, backoffMultiplier, timeoutMs } = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
  };

  let attempt = 0;
  let currentBackoff = initialBackoffMs;
  let lastError: string | undefined;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "SupplyChainEscrow-Webhook/0.1.0",
          "X-Escrow-Event": payload.event,
        },
        body: JSON.stringify(payload),
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
