import express, { type Express } from "express";
import type { Env } from "./config/env.js";
import type { AppDatabase } from "./db/client.js";
import { createErrorHandler, notFoundHandler, type ErrorHandlerOptions } from "./middleware/errorHandler.js";
import { createCollectionsRouter } from "./routes/collections.js";
import { createEnvironmentsRouter } from "./routes/environments.js";
import { createHealthRouter } from "./routes/health.js";
import { createTrashRouter } from "./routes/trash.js";

export interface CreateAppOptions {
  env: Pick<Env, "NODE_ENV">;
  db: AppDatabase;
  logger?: ErrorHandlerOptions["logger"];
}

export function createApp({ env, db, logger }: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  app.use("/health", createHealthRouter());
  app.use("/api/v1/collections", createCollectionsRouter(db));
  app.use("/api/v1/environments", createEnvironmentsRouter(db));
  app.use("/api/v1/trash", createTrashRouter(db));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: env.NODE_ENV !== "production", logger }));

  return app;
}
