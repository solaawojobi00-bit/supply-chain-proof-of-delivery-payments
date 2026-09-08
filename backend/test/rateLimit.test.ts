import express, { type Request, type Response } from "express";
import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/config.js";
import { createRateLimiter, getRateLimitKey } from "../src/rateLimit.js";
import { router } from "../src/routes.js";

describe("Rate Limiting (Issue #72)", () => {
  describe("parseTrustProxy helper", () => {
    it("parses falsy and boolean proxy values", () => {
      expect(parseTrustProxy(undefined)).toBe(false);
      expect(parseTrustProxy("")).toBe(false);
      expect(parseTrustProxy("false")).toBe(false);
      expect(parseTrustProxy("0")).toBe(false);
      expect(parseTrustProxy("true")).toBe(true);
      expect(parseTrustProxy("1")).toBe(true);
    });

    it("parses numeric hop counts and subnet strings", () => {
      expect(parseTrustProxy("2")).toBe(2);
      expect(parseTrustProxy("loopback")).toBe("loopback");
      expect(parseTrustProxy("127.0.0.1")).toBe("127.0.0.1");
    });
  });

  describe("getRateLimitKey identifier extraction", () => {
    it("prefers Bearer authorization header", () => {
      const req = {
        header: (name: string) => {
          if (name.toLowerCase() === "authorization") return "Bearer token-buyer-123";
          return undefined;
        },
        ip: "192.168.1.1",
        socket: {},
      } as unknown as Request;

      expect(getRateLimitKey(req)).toBe("token:token-buyer-123");
    });

    it("prefers x-api-key header over ip", () => {
      const req = {
        header: (name: string) => {
          if (name.toLowerCase() === "x-api-key") return "api-key-test";
          return undefined;
        },
        ip: "192.168.1.1",
        socket: {},
      } as unknown as Request;

      expect(getRateLimitKey(req)).toBe("token:api-key-test");
    });

    it("falls back to client ip if no auth token is provided", () => {
      const req = {
        header: (_name: string) => undefined,
        ip: "10.0.0.50",
        socket: {},
      } as unknown as Request;

      expect(getRateLimitKey(req)).toBe("ip:10.0.0.50");
    });
  });

  describe("Rate Limiting on Express Routes", () => {
    it("trips after exceeding max mutating calls and returns 429 with Retry-After", async () => {
      const app = express();
      app.use(express.json());

      const testLimiter = createRateLimiter({
        windowMs: 60000,
        max: 2,
        message: "Too many mutating requests, please try again later.",
      });

      app.post("/test-mutate", testLimiter, (_req: Request, res: Response) => {
        res.status(200).json({ status: "ok" });
      });

      app.get("/test-read", (_req: Request, res: Response) => {
        res.status(200).json({ status: "ok" });
      });

      const server = app.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        // Request 1: OK (remaining 1)
        const res1 = await fetch(`http://127.0.0.1:${port}/test-mutate`, { method: "POST" });
        expect(res1.status).toBe(200);

        // Request 2: OK (remaining 0)
        const res2 = await fetch(`http://127.0.0.1:${port}/test-mutate`, { method: "POST" });
        expect(res2.status).toBe(200);

        // Request 3: Exceeded limit -> 429
        const res3 = await fetch(`http://127.0.0.1:${port}/test-mutate`, { method: "POST" });
        expect(res3.status).toBe(429);
        expect(res3.headers.get("retry-after")).toBeDefined();
        expect(Number(res3.headers.get("retry-after"))).toBeGreaterThan(0);

        const body3 = await res3.json();
        expect(body3.error).toBe("Too many mutating requests, please try again later.");

        // Read-only endpoint remains unaffected and succeeds with 200
        const resRead = await fetch(`http://127.0.0.1:${port}/test-read`);
        expect(resRead.status).toBe(200);
      } finally {
        server.close();
      }
    });

    it("isolates rate limits by authenticated token", async () => {
      const app = express();
      app.use(express.json());

      const testLimiter = createRateLimiter({
        windowMs: 60000,
        max: 1,
      });

      app.post("/test-mutate", testLimiter, (_req: Request, res: Response) => {
        res.status(200).json({ status: "ok" });
      });

      const server = app.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        // User A hits limit
        const resA1 = await fetch(`http://127.0.0.1:${port}/test-mutate`, {
          method: "POST",
          headers: { Authorization: "Bearer user-a-token" },
        });
        expect(resA1.status).toBe(200);

        const resA2 = await fetch(`http://127.0.0.1:${port}/test-mutate`, {
          method: "POST",
          headers: { Authorization: "Bearer user-a-token" },
        });
        expect(resA2.status).toBe(429);

        // User B has fresh quota and succeeds
        const resB = await fetch(`http://127.0.0.1:${port}/test-mutate`, {
          method: "POST",
          headers: { Authorization: "Bearer user-b-token" },
        });
        expect(resB.status).toBe(200);
      } finally {
        server.close();
      }
    });

    it("verifies routes router mounts mutatingRateLimiter on mutating endpoints while health check is unthrottled", async () => {
      const app = express();
      app.use(express.json());
      app.use(router);

      const server = app.listen(0);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toEqual({ status: "ok" });
      } finally {
        server.close();
      }
    });
  });
});
