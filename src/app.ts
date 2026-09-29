import express, { type Express } from "express";
import type { Env } from "./config/env.js";
import { createErrorHandler, notFoundHandler, type ErrorHandlerOptions } from "./middleware/errorHandler.js";
import { createHealthRouter } from "./routes/health.js";

export interface CreateAppOptions {
  env: Pick<Env, "NODE_ENV">;
  logger?: ErrorHandlerOptions["logger"];
}

export function createApp({ env, logger }: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use("/health", createHealthRouter());

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: env.NODE_ENV !== "production", logger }));

  return app;
}
