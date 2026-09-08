import cors, { type CorsOptions } from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { config } from "./config.js";
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

if (process.env.NODE_ENV !== "test") {
  app.listen(config.port, () => {
    logStructured({
      type: "server_start",
      port: config.port,
      message: `Escrow backend listening on http://localhost:${config.port}`,
    });
  });
}
