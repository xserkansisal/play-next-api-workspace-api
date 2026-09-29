import express, { type Express } from "express";
import type { Env } from "./config/env.js";
import type { AppDatabase } from "./db/client.js";
import { ChangeEventHub } from "./events/hub.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { createErrorHandler, notFoundHandler, type ErrorHandlerOptions } from "./middleware/errorHandler.js";
import { createCollectionsRouter } from "./routes/collections.js";
import { createEnvironmentsRouter } from "./routes/environments.js";
import { createEventsRouter } from "./routes/events.js";
import { createHealthRouter } from "./routes/health.js";
import { createTrashRouter } from "./routes/trash.js";

export interface CreateAppOptions {
  env: Pick<Env, "NODE_ENV"> & Partial<Pick<Env, "CORS_ORIGIN" | "SSE_HEARTBEAT_MS" | "SSE_RETRY_MS">>;
  db: AppDatabase;
  events?: ChangeEventHub;
  logger?: ErrorHandlerOptions["logger"];
}

export function createApp({ env, db, events = new ChangeEventHub(), logger }: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(createCorsMiddleware(env.CORS_ORIGIN));

  app.use("/health", createHealthRouter());
  // Registered before the JSON body parser: the stream takes no request body.
  app.use(
    "/api/v1/events",
    createEventsRouter(events, { heartbeatMs: env.SSE_HEARTBEAT_MS ?? 15_000, retryMs: env.SSE_RETRY_MS ?? 3_000 }),
  );

  app.use(express.json({ limit: "5mb" }));
  app.use("/api/v1/collections", createCollectionsRouter(db, events));
  app.use("/api/v1/environments", createEnvironmentsRouter(db, events));
  app.use("/api/v1/trash", createTrashRouter(db, events));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: env.NODE_ENV !== "production", logger }));

  return app;
}
