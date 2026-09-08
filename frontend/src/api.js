/**
 * api.js - Backend REST Client for Escrow Service with Client-Side Signing
 */

import { signTransactionClientSide } from "./wallet.js";

export function getApiBaseUrl() {
  if (typeof window !== "undefined" && window.__API_BASE_URL__) {
    return window.__API_BASE_URL__;
  }
  return "http://localhost:3000";
}

/**
 * Helper to execute fetch requests with JSON parsing and error handling
 */
async function apiRequest(endpoint, options = {}) {
  const url = `${getApiBaseUrl()}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const contentType = res.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    const errorMsg =
      (typeof data === "object" && data !== null && data.error) ||
      (typeof data === "string" && data) ||
      `HTTP ${res.status} ${res.statusText}`;
    const err = new Error(errorMsg);
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

/**
 * Fetch orders with optional query filtering
 * @param {object} [filters] - { role, address, status, buyer, seller, attestor }
 */
export async function getOrders(filters = {}) {
  const params = new URLSearchParams();
  if (filters.role) params.set("role", filters.role);
  if (filters.address) params.set("address", filters.address);
  if (filters.status) params.set("status", filters.status);
  if (filters.buyer) params.set("buyer", filters.buyer);
  if (filters.seller) params.set("seller", filters.seller);
  if (filters.attestor) params.set("attestor", filters.attestor);

  const query = params.toString() ? `?${params.toString()}` : "";
  return apiRequest(`/orders${query}`, { method: "GET" });
}

/**
 * Fetch single order with on-chain details and lifecycle
 */
export async function getOrder(id) {
  return apiRequest(`/orders/${encodeURIComponent(id)}`, { method: "GET" });
}

/**
 * Create a new escrow order with client-side wallet signing
 * @param {object} orderData - { buyerAddress, sellerAddress, attestorAddress, amountStroops, deadlineSeconds, tokenContractId, webhookUrl }
 * @param {object} [options] - { unsigned, roleToken }
 */
export async function createOrder(orderData, options = {}) {
  const unsigned = options.unsigned !== false; // Default to client-side signing flow

  if (unsigned) {
    // 1. Request unsigned create transaction
    const res = await apiRequest("/orders?unsigned=true", {
      method: "POST",
      body: JSON.stringify(orderData),
    });

    const { unsignedTxXdr, order } = res;
    if (!unsignedTxXdr) {
      throw new Error(
        "Backend did not return unsigned transaction XDR for order creation.",
      );
    }

    // 2. Sign transaction client-side via connected wallet
    const signedXdr = await signTransactionClientSide(unsignedTxXdr);

    // 3. Submit signed transaction
    const submitRes = await submitSignedTx(signedXdr, order.id, "create");
    return submitRes.order || order;
  }

  // Fallback: Direct server-managed creation (if configured)
  return apiRequest("/orders", {
    method: "POST",
    body: JSON.stringify(orderData),
  });
}

/**
 * Attest delivery for an order with client-side wallet signing
 * @param {string} orderId - Order ID
 * @param {object} [options] - { attestorAddress, roleToken, unsigned }
 */
export async function attestOrder(orderId, options = {}) {
  const unsigned = options.unsigned !== false;
  const headers = {};
  if (options.roleToken) {
    headers["Authorization"] = `Bearer ${options.roleToken}`;
  }

  const bodyPayload = options.attestorAddress
    ? { attestorAddress: options.attestorAddress }
    : {};

  if (unsigned) {
    // 1. Request unsigned attest transaction XDR
    const res = await apiRequest(
      `/orders/${encodeURIComponent(orderId)}/attest?unsigned=true`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(bodyPayload),
      },
    );

    const { unsignedTxXdr } = res;
    if (!unsignedTxXdr) {
      throw new Error(
        "Backend did not return unsigned transaction XDR for attestation.",
      );
    }

    // 2. Sign transaction client-side
    const signedXdr = await signTransactionClientSide(unsignedTxXdr);

    // 3. Submit signed transaction
    const submitRes = await submitSignedTx(
      signedXdr,
      orderId,
      "attest",
      options.roleToken,
    );
    return submitRes.order || { id: orderId, status: "Attested" };
  }

  return apiRequest(`/orders/${encodeURIComponent(orderId)}/attest`, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyPayload),
  });
}

/**
 * Claim funds for an attested order with client-side wallet signing
 * @param {string} orderId - Order ID
 * @param {object} [options] - { roleToken, unsigned }
 */
export async function claimOrder(orderId, options = {}) {
  const unsigned = options.unsigned !== false;
  const headers = {};
  if (options.roleToken) {
    headers["Authorization"] = `Bearer ${options.roleToken}`;
  }

  if (unsigned) {
    // 1. Request unsigned claim transaction XDR
    const res = await apiRequest(
      `/orders/${encodeURIComponent(orderId)}/claim?unsigned=true`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      },
    );

    const { unsignedTxXdr } = res;
    if (!unsignedTxXdr) {
      throw new Error(
        "Backend did not return unsigned transaction XDR for claim.",
      );
    }

    // 2. Sign transaction client-side
    const signedXdr = await signTransactionClientSide(unsignedTxXdr);

    // 3. Submit signed transaction
    const submitRes = await submitSignedTx(
      signedXdr,
      orderId,
      "claim",
      options.roleToken,
    );
    return submitRes.order || { id: orderId, status: "Claimed" };
  }

  return apiRequest(`/orders/${encodeURIComponent(orderId)}/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
}

/**
 * Submit client-side signed transaction XDR
 * @param {string} signedXdr - Signed transaction envelope XDR
 * @param {string} [orderId] - Order UUID
 * @param {string} [action] - Lifecycle action ("create" | "attest" | "claim" | "reclaim" | "cancel" | "dispute")
 * @param {string} [roleToken] - Optional role authorization token
 */
export async function submitSignedTx(signedXdr, orderId, action, roleToken) {
  const headers = {};
  if (roleToken) {
    headers["Authorization"] = `Bearer ${roleToken}`;
  }

  return apiRequest("/tx/submit", {
    method: "POST",
    headers,
    body: JSON.stringify({
      signedXdr,
      orderId,
      action,
    }),
  });
}
