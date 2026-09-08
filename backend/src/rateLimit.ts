import type { NextFunction, Request, Response } from "express";
import { rateLimit, type Options } from "express-rate-limit";
import { extractApiToken } from "./auth.js";
import { config } from "./config.js";

/**
 * Derives rate limit identifier: prefers authenticated API credential / token,
 * falling back to client IP address.
 */
export function getRateLimitKey(req: Request): string {
  const token = extractApiToken(req);
  if (token) {
    return `token:${token}`;
  }
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return `ip:${ip}`;
}

export interface RateLimiterCustomOptions {
  windowMs?: number;
  max?: number;
  message?: string;
  skip?: (req: Request) => boolean;
}

/**
 * Creates an Express rate limiter instance adhering to standard draft-7 headers and JSON 429 response.
 */
export function createRateLimiter(options: RateLimiterCustomOptions = {}) {
  const windowMs = options.windowMs ?? config.rateLimitWindowMs;
  const max = options.max ?? config.rateLimitMaxGeneral;
  const message = options.message ?? "Too many requests, please try again later.";

  return rateLimit({
    windowMs,
    limit: config.rateLimitEnabled ? max : 0,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req: Request) => getRateLimitKey(req),
    skip: (req: Request) => {
      if (!config.rateLimitEnabled) return true;
      if (options.skip) return options.skip(req);
      return false;
    },
    handler: (_req: Request, res: Response, _next: NextFunction, opts: Options) => {
      const retryAfterSeconds = Math.ceil(opts.windowMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(opts.statusCode || 429).json({
        error: typeof opts.message === "string" ? opts.message : message,
      });
    },
    message,
    validate: {
      trustProxy: false,
      xForwardedForHeader: false,
    },
  });
}

export const mutatingRateLimiter = createRateLimiter({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxMutating,
  message: "Too many mutating requests, please try again later.",
});

export const generalRateLimiter = createRateLimiter({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxGeneral,
  message: "Too many requests, please try again later.",
});
