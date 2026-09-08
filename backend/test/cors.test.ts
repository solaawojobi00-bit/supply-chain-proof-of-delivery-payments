import cors from "cors";
import express from "express";
import { describe, expect, it } from "vitest";
import { parseCorsOrigins } from "../src/config.js";
import { allowedCorsHeaders, app as mainApp, createCorsOptions } from "../src/index.js";
import { router } from "../src/routes.js";

describe("CORS Configuration (Issue #71)", () => {
  describe("parseCorsOrigins helper", () => {
    it("returns empty array for undefined or empty string", () => {
      expect(parseCorsOrigins(undefined)).toEqual([]);
      expect(parseCorsOrigins("")).toEqual([]);
      expect(parseCorsOrigins("   ")).toEqual([]);
    });

    it("parses single and multiple comma-separated origins with whitespace trimming", () => {
      expect(parseCorsOrigins("http://localhost:5173")).toEqual(["http://localhost:5173"]);
      expect(
        parseCorsOrigins(
          "http://localhost:5173, https://app.example.com ,https://test.example.com",
        ),
      ).toEqual(["http://localhost:5173", "https://app.example.com", "https://test.example.com"]);
    });
  });

  describe("Default mainApp CORS behavior (deny by default / no wildcard)", () => {
    it("allows non-browser / same-origin requests (no Origin header)", async () => {
      const server = mainApp.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        server.close();
      }
    });

    it("does not set Access-Control-Allow-Origin for untrusted cross-origin requests", async () => {
      const server = mainApp.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: {
            Origin: "https://evil.attacker.com",
          },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        server.close();
      }
    });

    it("does not allow preflight OPTIONS from untrusted cross-origin requests", async () => {
      const server = mainApp.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/orders`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://evil.attacker.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
          },
        });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        server.close();
      }
    });
  });

  describe("Configured allowlist behavior", () => {
    function createTestApp(allowedOrigins: string[]) {
      const app = express();
      app.use(cors(createCorsOptions(allowedOrigins)));
      app.use(express.json());
      app.use(router);
      return app;
    }

    const testOrigins = ["http://localhost:5173", "https://app.escrow.example.com"];

    it("allows requests from an origin present in the allowlist", async () => {
      const app = createTestApp(testOrigins);
      const server = app.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: {
            Origin: "http://localhost:5173",
          },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
        expect(res.headers.get("vary")).toContain("Origin");
      } finally {
        server.close();
      }
    });

    it("handles preflight OPTIONS request for allowed origin with required headers", async () => {
      const app = createTestApp(testOrigins);
      const server = app.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/orders`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://app.escrow.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers":
              "Authorization, Content-Type, idempotency-key, x-unsigned",
          },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe(
          "https://app.escrow.example.com",
        );
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        const allowed = res.headers.get("access-control-allow-headers")?.toLowerCase() || "";
        expect(allowed).toContain("authorization");
        expect(allowed).toContain("idempotency-key");
        expect(allowed).toContain("x-unsigned");
      } finally {
        server.close();
      }
    });

    it("blocks preflight and requests from origins not in allowlist", async () => {
      const app = createTestApp(testOrigins);
      const server = app.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/orders`, {
          method: "OPTIONS",
          headers: {
            Origin: "https://unauthorized.domain.org",
            "Access-Control-Request-Method": "POST",
          },
        });
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
      } finally {
        server.close();
      }
    });

    it("includes required authentication, transaction, and idempotency headers in allowedCorsHeaders", () => {
      const lowercaseHeaders = allowedCorsHeaders.map((h) => h.toLowerCase());
      expect(lowercaseHeaders).toContain("content-type");
      expect(lowercaseHeaders).toContain("authorization");
      expect(lowercaseHeaders).toContain("x-api-key");
      expect(lowercaseHeaders).toContain("idempotency-key");
      expect(lowercaseHeaders).toContain("x-unsigned");
      expect(lowercaseHeaders).toContain("x-iot-signature");
    });
  });
});
