import type { Request } from "express";
import { config } from "./config.js";
import { type OrderRow } from "./db.js";
import { HttpError } from "./httpError.js";

export type Role = "buyer" | "seller" | "attestor" | "arbiter" | "admin";

/**
 * Extracts authentication credential from Authorization Bearer / ApiKey headers or x-api-key / x-auth-token headers.
 */
export function extractApiToken(req: Request): string | undefined {
  const authHeader = req.header("authorization") || req.header("x-authorization");
  if (authHeader) {
    const parts = authHeader.trim().split(" ");
    if (
      parts.length === 2 &&
      (parts[0].toLowerCase() === "bearer" || parts[0].toLowerCase() === "apikey")
    ) {
      return parts[1].trim();
    }
    if (parts.length === 1 && parts[0].length > 0) {
      return parts[0].trim();
    }
  }

  const apiKeyHeader =
    req.header("x-api-key") ||
    req.header("x-auth-token") ||
    req.header("x-role-key") ||
    req.header("x-role-token");
  if (typeof apiKeyHeader === "string" && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim();
  }

  return undefined;
}

/**
 * Resolves the roles granted by a provided token, optionally against a specific order.
 */
export function getGrantedRoles(token: string, order?: OrderRow): Role[] {
  const roles: Set<Role> = new Set();

  if (config.adminApiKey && token === config.adminApiKey) {
    roles.add("admin");
    roles.add("buyer");
    roles.add("seller");
    roles.add("attestor");
    roles.add("arbiter");
    return Array.from(roles);
  }

  if (config.buyerApiKey && token === config.buyerApiKey) {
    roles.add("buyer");
  }
  if (config.sellerApiKey && token === config.sellerApiKey) {
    roles.add("seller");
  }
  if (config.attestorApiKey && token === config.attestorApiKey) {
    roles.add("attestor");
  }
  if (config.arbiterApiKey && token === config.arbiterApiKey) {
    roles.add("arbiter");
  }

  if (order) {
    if (order.buyer_token && token === order.buyer_token) {
      roles.add("buyer");
    }
    if (order.seller_token && token === order.seller_token) {
      roles.add("seller");
    }
    if (order.attestor_token && token === order.attestor_token) {
      roles.add("attestor");
    }
    if (order.arbiter_token && token === order.arbiter_token) {
      roles.add("arbiter");
    }
  }

  return Array.from(roles);
}

/**
 * Verifies that the request contains a valid credential granting at least one of the allowed roles for the given order.
 * Throws 401 Unauthorized if credential is missing or invalid.
 * Throws 403 Forbidden if credential is valid but does not grant the required role.
 */
export function verifyRole(req: Request, order: OrderRow, allowedRoles: Role | Role[]): void {
  const token = extractApiToken(req);
  if (!token) {
    throw new HttpError(
      401,
      "Unauthorized: Missing API credential. Provide an Authorization Bearer token or x-api-key header.",
    );
  }

  const grantedRoles = getGrantedRoles(token, order);
  if (grantedRoles.length === 0) {
    throw new HttpError(401, "Unauthorized: Invalid API credential.");
  }

  const allowedList = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const isAllowed = allowedList.some((role) => grantedRoles.includes(role));
  if (!isAllowed) {
    throw new HttpError(
      403,
      `Forbidden: Provided credential does not grant required role (${allowedList.join(
        " or ",
      )}) for this order.`,
    );
  }
}
