import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { extractApiToken, getGrantedRoles, verifyRole } from "../src/auth.js";
import { config } from "../src/config.js";
import type { OrderRow } from "../src/db.js";
import { HttpError } from "../src/httpError.js";

describe("Role Authentication Module (auth.ts)", () => {
  const mockOrder: OrderRow = {
    id: "ord-test-auth-123",
    contract_id: "C" + "0".repeat(55),
    buyer_address: "GBUYER123",
    seller_address: "GSELLER123",
    attestor_address: "GATTESTOR123",
    token_contract_id: "CTOKEN123",
    amount: "10000000",
    deadline: 9999999999,
    status: "Created",
    create_tx_hash: null,
    attest_tx_hash: null,
    claim_tx_hash: null,
    reclaim_tx_hash: null,
    buyer_token: "order-buyer-secret-uuid",
    seller_token: "order-seller-secret-uuid",
    attestor_token: "order-attestor-secret-uuid",
    arbiter_token: "order-arbiter-secret-uuid",
    created_at: new Date().toISOString(),
  };

  describe("extractApiToken", () => {
    it("extracts token from Authorization: Bearer <token>", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? "Bearer secret-token-123" : undefined,
      } as unknown as Request;
      expect(extractApiToken(req)).toBe("secret-token-123");
    });

    it("extracts token from Authorization: ApiKey <token>", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "authorization" ? "ApiKey secret-token-456" : undefined,
      } as unknown as Request;
      expect(extractApiToken(req)).toBe("secret-token-456");
    });

    it("extracts token from x-api-key header", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "x-api-key" ? "api-key-header-val" : undefined,
      } as unknown as Request;
      expect(extractApiToken(req)).toBe("api-key-header-val");
    });

    it("extracts token from x-auth-token header", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "x-auth-token" ? "auth-token-val" : undefined,
      } as unknown as Request;
      expect(extractApiToken(req)).toBe("auth-token-val");
    });

    it("returns undefined when no auth header is present", () => {
      const req = {
        header: () => undefined,
      } as unknown as Request;
      expect(extractApiToken(req)).toBeUndefined();
    });
  });

  describe("getGrantedRoles", () => {
    it("grants all roles for admin API key", () => {
      const roles = getGrantedRoles(config.adminApiKey, mockOrder);
      expect(roles).toContain("admin");
      expect(roles).toContain("buyer");
      expect(roles).toContain("seller");
      expect(roles).toContain("attestor");
      expect(roles).toContain("arbiter");
    });

    it("grants buyer role for static buyerApiKey and order.buyer_token", () => {
      expect(getGrantedRoles(config.buyerApiKey, mockOrder)).toEqual(["buyer"]);
      expect(getGrantedRoles("order-buyer-secret-uuid", mockOrder)).toEqual(["buyer"]);
    });

    it("grants seller role for static sellerApiKey and order.seller_token", () => {
      expect(getGrantedRoles(config.sellerApiKey, mockOrder)).toEqual(["seller"]);
      expect(getGrantedRoles("order-seller-secret-uuid", mockOrder)).toEqual(["seller"]);
    });

    it("grants attestor role for static attestorApiKey and order.attestor_token", () => {
      expect(getGrantedRoles(config.attestorApiKey, mockOrder)).toEqual(["attestor"]);
      expect(getGrantedRoles("order-attestor-secret-uuid", mockOrder)).toEqual(["attestor"]);
    });

    it("grants arbiter role for static arbiterApiKey and order.arbiter_token", () => {
      expect(getGrantedRoles(config.arbiterApiKey, mockOrder)).toEqual(["arbiter"]);
      expect(getGrantedRoles("order-arbiter-secret-uuid", mockOrder)).toEqual(["arbiter"]);
    });

    it("returns empty array for invalid/unrecognized token", () => {
      expect(getGrantedRoles("completely-invalid-token", mockOrder)).toEqual([]);
    });
  });

  describe("verifyRole", () => {
    it("throws 401 when credential is missing", () => {
      const req = { header: () => undefined } as unknown as Request;
      expect(() => verifyRole(req, mockOrder, "seller")).toThrowError(HttpError);
      try {
        verifyRole(req, mockOrder, "seller");
      } catch (err: unknown) {
        expect((err as HttpError).status).toBe(401);
        expect((err as HttpError).message).toContain("Missing API credential");
      }
    });

    it("throws 401 when credential is unknown / invalid", () => {
      const req = {
        header: (name: string) => (name.toLowerCase() === "x-api-key" ? "wrong-token" : undefined),
      } as unknown as Request;
      expect(() => verifyRole(req, mockOrder, "seller")).toThrowError(HttpError);
      try {
        verifyRole(req, mockOrder, "seller");
      } catch (err: unknown) {
        expect((err as HttpError).status).toBe(401);
        expect((err as HttpError).message).toContain("Invalid API credential");
      }
    });

    it("throws 403 when credential is valid for buyer but role requires seller", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "x-api-key" ? "order-buyer-secret-uuid" : undefined,
      } as unknown as Request;
      expect(() => verifyRole(req, mockOrder, "seller")).toThrowError(HttpError);
      try {
        verifyRole(req, mockOrder, "seller");
      } catch (err: unknown) {
        expect((err as HttpError).status).toBe(403);
        expect((err as HttpError).message).toContain("Forbidden");
      }
    });

    it("succeeds when credential matches required role", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "x-api-key" ? "order-seller-secret-uuid" : undefined,
      } as unknown as Request;
      expect(() => verifyRole(req, mockOrder, "seller")).not.toThrow();
    });

    it("succeeds when credential matches one of multiple allowed roles", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "x-api-key" ? "order-buyer-secret-uuid" : undefined,
      } as unknown as Request;
      expect(() => verifyRole(req, mockOrder, ["buyer", "seller"])).not.toThrow();
    });

    it("succeeds when admin credential is used for any role", () => {
      const req = {
        header: (name: string) =>
          name.toLowerCase() === "x-api-key" ? config.adminApiKey : undefined,
      } as unknown as Request;
      expect(() => verifyRole(req, mockOrder, "attestor")).not.toThrow();
      expect(() => verifyRole(req, mockOrder, "seller")).not.toThrow();
      expect(() => verifyRole(req, mockOrder, "buyer")).not.toThrow();
      expect(() => verifyRole(req, mockOrder, "arbiter")).not.toThrow();
    });
  });
});
