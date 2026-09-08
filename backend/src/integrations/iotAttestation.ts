import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../httpError.js";
import { logStructured } from "../logger.js";
import { attestOrder } from "../orderService.js";
import type { OrderRow } from "../db.js";

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface GeofenceTarget extends Coordinates {
  maxRadiusMeters?: number;
}

export interface IoTTelemetryEventInput {
  orderId: string;
  deviceId: string;
  eventType: "geofence_entry" | "rfid_scan" | "telemetry_reading";
  coordinates?: Coordinates;
  targetCoordinates?: GeofenceTarget;
  scanCode?: string;
  timestamp: string | number;
  attestorAddress?: string;
  metadata?: Record<string, unknown>;
}

export interface IoTAttestationResult {
  success: boolean;
  orderId: string;
  deviceId: string;
  eventType: string;
  txHash: string;
  order: OrderRow;
}

/**
 * Calculates distance between two GPS coordinates in meters using the Haversine formula.
 */
export function calculateDistanceMeters(point1: Coordinates, point2: Coordinates): number {
  const R = 6371e3; // Earth radius in meters
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const lat1Rad = toRadians(point1.latitude);
  const lat2Rad = toRadians(point2.latitude);
  const deltaLatRad = toRadians(point2.latitude - point1.latitude);
  const deltaLonRad = toRadians(point2.longitude - point1.longitude);

  const a =
    Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLonRad / 2) * Math.sin(deltaLonRad / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(R * c);
}

/**
 * Verifies HMAC-SHA256 signature for incoming IoT telemetry webhook payloads.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyIoTEventSignature(
  rawBody: string | Buffer | object,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }

  const payloadString =
    typeof rawBody === "string"
      ? rawBody
      : Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf-8")
        : JSON.stringify(rawBody);

  const hmac = createHmac("sha256", secret);
  hmac.update(payloadString);
  const calculatedHex = hmac.digest("hex");

  const cleanSignature = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  if (calculatedHex.length !== cleanSignature.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(calculatedHex, "hex"), Buffer.from(cleanSignature, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verifies authentication of an IoT event via HMAC signature or shared secret.
 */
export function authenticateIoTRequest(
  payload: IoTTelemetryEventInput,
  headers: {
    signature?: string;
    secret?: string;
  },
  expectedSecret: string,
): boolean {
  if (!expectedSecret) {
    return false;
  }

  // 1. Direct shared-secret token match (timing safe)
  if (headers.secret) {
    const secretBuf = Buffer.from(headers.secret);
    const expectedBuf = Buffer.from(expectedSecret);
    if (secretBuf.length === expectedBuf.length && timingSafeEqual(secretBuf, expectedBuf)) {
      return true;
    }
  }

  // 2. HMAC-SHA256 signature check
  if (headers.signature) {
    return verifyIoTEventSignature(payload, headers.signature, expectedSecret);
  }

  return false;
}

/**
 * Processes an IoT telemetry event, verifies geofence/scan parameters, and triggers on-chain attestation.
 */
export async function processIoTTelemetryEvent(
  event: IoTTelemetryEventInput,
  authHeaders: { signature?: string; secret?: string },
  configuredSecret?: string,
): Promise<IoTAttestationResult> {
  const secret = configuredSecret || process.env.IOT_WEBHOOK_SECRET || "default-iot-secret";

  const isAuthenticated = authenticateIoTRequest(event, authHeaders, secret);
  if (!isAuthenticated) {
    throw new HttpError(
      401,
      "Unauthorized: Invalid or missing IoT device authentication signature/secret",
    );
  }

  // If geofence verification is requested, validate distance within max radius (default 150m)
  if (event.eventType === "geofence_entry") {
    if (!event.coordinates) {
      throw new HttpError(
        400,
        "coordinates (latitude, longitude) are required for geofence_entry events",
      );
    }
    if (event.targetCoordinates) {
      const radiusThreshold = event.targetCoordinates.maxRadiusMeters ?? 150;
      const distance = calculateDistanceMeters(event.coordinates, event.targetCoordinates);
      if (distance > radiusThreshold) {
        throw new HttpError(
          422,
          `Geofence validation failed: device distance (${distance}m) exceeds allowed radius (${radiusThreshold}m)`,
        );
      }
    }
  }

  // Execute on-chain delivery confirmation using designated attestor
  const updatedOrder = await attestOrder(event.orderId, event.attestorAddress);

  logStructured({
    type: "iot_attestation_triggered",
    orderId: event.orderId,
    deviceId: event.deviceId,
    eventType: event.eventType,
    txHash: updatedOrder.attest_tx_hash,
  });

  return {
    success: true,
    orderId: event.orderId,
    deviceId: event.deviceId,
    eventType: event.eventType,
    txHash: updatedOrder.attest_tx_hash || "",
    order: updatedOrder,
  };
}
