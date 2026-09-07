import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { logStructured, requestLogger } from "../src/logger.js";
import express from "express";
import type { Request, Response } from "express";
import type { Server } from "node:http";

describe("Structured Logger (logger.ts)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats log entries as valid JSON lines with timestamp and default level info", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    logStructured({ type: "test_event", key: "value" });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const loggedString = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedString);
    expect(parsed.type).toBe("test_event");
    expect(parsed.key).toBe("value");
    expect(parsed.level).toBe("info");
    expect(parsed.timestamp).toBeDefined();
    expect(new Date(parsed.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("routes warn level to console.warn as JSON line", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logStructured({ level: "warn", type: "warning_event", code: 400 });

    expect(warnSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(warnSpy.mock.calls[0][0]);
    expect(parsed.level).toBe("warn");
    expect(parsed.type).toBe("warning_event");
    expect(parsed.code).toBe(400);
  });

  it("routes error level to console.error as JSON line", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logStructured({ level: "error", type: "error_event", error: "Something broke" });

    expect(errorSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(errorSpy.mock.calls[0][0]);
    expect(parsed.level).toBe("error");
    expect(parsed.type).toBe("error_event");
    expect(parsed.error).toBe("Something broke");
  });

  it("requestLogger middleware captures method, path, status, and duration", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const app = express();
    app.use(requestLogger);
    app.get("/test-route", (_req: Request, res: Response) => {
      res.status(200).json({ ok: true });
    });

    const server: Server = app.listen(0);
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/test-route`);
      expect(res.status).toBe(200);

      expect(logSpy).toHaveBeenCalled();
      const logs = logSpy.mock.calls.map((c) => JSON.parse(c[0]));
      const reqLog = logs.find((l) => l.type === "http_request");
      expect(reqLog).toBeDefined();
      expect(reqLog.method).toBe("GET");
      expect(reqLog.path).toBe("/test-route");
      expect(reqLog.status).toBe(200);
      expect(typeof reqLog.duration).toBe("number");
      expect(reqLog.duration).toBeGreaterThanOrEqual(0);
    } finally {
      server.close();
    }
  });
});
