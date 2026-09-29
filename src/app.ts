import express, { type Express } from "express";
import type { Env } from "./config/env.js";
import type { AppDatabase } from "./db/client.js";
import { ChangeEventHub } from "./events/hub.js";
import { MemoryEmailCodeSender, SmtpEmailCodeSender, type EmailCodeSender } from "./auth/email.js";
import { createAuthenticationMiddleware } from "./middleware/authenticate.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { createErrorHandler, notFoundHandler, type ErrorHandlerOptions } from "./middleware/errorHandler.js";
import { createCollectionsRouter } from "./routes/collections.js";
import { createEnvironmentsRouter } from "./routes/environments.js";
import { createEventsRouter } from "./routes/events.js";
import { createAuthRouter } from "./routes/auth.js";
import { createHealthRouter } from "./routes/health.js";
import { createTrashRouter } from "./routes/trash.js";

export interface CreateAppOptions {
  env: Env;
  db: AppDatabase;
  events?: ChangeEventHub;
  emailCodeSender?: EmailCodeSender;
  logger?: ErrorHandlerOptions["logger"];
}

export function createApp({
  env,
  db,
  events = new ChangeEventHub(),
  emailCodeSender = env.NODE_ENV === "production" ? new SmtpEmailCodeSender(env) : new MemoryEmailCodeSender(),
  logger,
}: CreateAppOptions): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(createCorsMiddleware(env.CORS_ORIGIN));

  app.use("/health", createHealthRouter());
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/v1/auth", createAuthRouter(db, env, emailCodeSender));
  const requireAuth = createAuthenticationMiddleware(db, env.AUTH_COOKIE_NAME);
  app.use(
    "/api/v1/events",
    requireAuth,
    createEventsRouter(events, { heartbeatMs: env.SSE_HEARTBEAT_MS, retryMs: env.SSE_RETRY_MS }),
  );

  app.use("/api/v1/collections", requireAuth, createCollectionsRouter(db, events));
  app.use("/api/v1/environments", requireAuth, createEnvironmentsRouter(db, events));
  app.use("/api/v1/trash", requireAuth, createTrashRouter(db, events));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: env.NODE_ENV !== "production", logger }));

  return app;
}
