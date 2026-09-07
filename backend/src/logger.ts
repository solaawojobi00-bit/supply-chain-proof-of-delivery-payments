import type { NextFunction, Request, Response } from "express";

export interface LogEntry {
  timestamp?: string;
  level?: "info" | "warn" | "error";
  [key: string]: unknown;
}

export function logStructured(entry: LogEntry): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level: "info",
    ...entry,
  };
  const line = JSON.stringify(payload);
  if (payload.level === "error") {
    console.error(line);
  } else if (payload.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logStructured({
      type: "http_request",
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      duration,
    });
  });
  next();
}
