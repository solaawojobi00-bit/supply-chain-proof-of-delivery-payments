import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { HttpError } from "./httpError.js";
import { router } from "./routes.js";

const app = express();
app.use(express.json());
app.use(router);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
});

app.listen(config.port, () => {
  console.log(`Escrow backend listening on http://localhost:${config.port}`);
});
