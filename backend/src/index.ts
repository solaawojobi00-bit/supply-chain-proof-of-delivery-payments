import cors, { type CorsOptions } from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { config } from "./config.js";
import { initSchema } from "./db.js";
import { HttpError } from "./httpError.js";
import { logStructured, requestLogger } from "./logger.js";
import { router } from "./routes.js";

export const allowedCorsHeaders = [
  "Content-Type",
  "Authorization",
  "x-authorization",
  "x-api-key",
  "x-auth-token",
  "x-role-key",
  "x-role-token",
  "idempotency-key",
  "x-idempotency-key",
  "x-unsigned",
  "x-iot-signature",
  "x-iot-secret",
];

export function createCorsOptions(
  allowedOrigins: string[] = config.corsAllowedOrigins,
): CorsOptions {
  return {
    origin: (origin, callback) => {
      // Allow requests with no Origin header (e.g. server-to-server, curl, non-browser clients)
      if (!origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: allowedCorsHeaders,
    credentials: true,
  };
}

export const app = express();
if (config.trustProxy !== false) {
  app.set("trust proxy", config.trustProxy);
}
app.use(helmet());
app.use(cors(createCorsOptions()));
app.use(express.json());
app.use(requestLogger);
app.use(router);

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    logStructured({
      level: "warn",
      type: "http_error",
      method: req.method,
      path: req.originalUrl || req.url,
      status: err.status,
      message: err.message,
    });
    res.status(err.status).json({ error: err.message });
    return;
  }
  logStructured({
    level: "error",
    type: "unhandled_error",
    method: req.method,
    path: req.originalUrl || req.url,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
});

/**
 * A public deployment holds server-side signing keys, so REQUIRE_TESTNET pins it
 * to testnet where the blast radius of a leaked key is worthless funds. Enforced
 * here rather than in resolveConfig, which must still resolve mainnet and local
 * configurations for local operators and tests.
 */
export function assertNetworkAllowed(): void {
  if (config.requireTestnet && config.network !== "testnet") {
    throw new Error(
      `REQUIRE_TESTNET is set but STELLAR_NETWORK is "${config.network}". This deployment holds signing keys and refuses to start outside testnet.`,
    );
  }
}

export async function startServer(): Promise<void> {
  assertNetworkAllowed();
  // Schema must exist before the first request is served.
  await initSchema();
  app.listen(config.port, () => {
    logStructured({
      type: "server_start",
      port: config.port,
      network: config.network,
      message: `Escrow backend listening on http://localhost:${config.port} (network: ${config.network})`,
    });
  });
}

if (process.env.NODE_ENV !== "test") {
  startServer().catch((err: unknown) => {
    logStructured({
      level: "error",
      type: "server_start_failed",
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
