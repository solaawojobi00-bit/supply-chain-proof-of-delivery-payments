import express from "express";
import { describe, expect, it } from "vitest";
import { app as mainApp } from "../src/index.js";
import { router } from "../src/routes.js";

describe("Backend Smoke Tests", () => {
  it("mounts router and responds to GET /health", async () => {
    const app = express();
    app.use(express.json());
    app.use(router);

    const server = app.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body).toEqual({ status: "ok" });
    } finally {
      server.close();
    }
  });

  it("serves security HTTP headers via helmet and omits X-Powered-By (Issue #70)", async () => {
    const server = mainApp.listen(0);
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-powered-by")).toBeNull();
      expect(res.headers.get("x-frame-options")).toBeTruthy();
    } finally {
      server.close();
    }
  });
});
