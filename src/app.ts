import express, { type Express } from "express";
import type { Env } from "./config/env.js";
import type { AppDatabase } from "./db/client.js";
import { ChangeEventHub } from "./events/hub.js";
import { PresenceHub } from "./events/presence.js";
import { MemoryEmailCodeSender, SmtpEmailCodeSender, type EmailCodeSender } from "./auth/email.js";
import {
  createAuthenticationMiddleware,
  createTeamContextMiddleware,
  requireSystemAdmin,
} from "./middleware/authenticate.js";
import { requireTeamEditor } from "./middleware/teamPermissions.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { createErrorHandler, notFoundHandler, type ErrorHandlerOptions } from "./middleware/errorHandler.js";
import { createCollectionsRouter } from "./routes/collections.js";
import { createCollectionRunsRouter } from "./routes/collectionRuns.js";
import { createEnvironmentsRouter } from "./routes/environments.js";
import { createVariablesRouter } from "./routes/variables.js";
import { createEventsRouter } from "./routes/events.js";
import { createAuthRouter } from "./routes/auth.js";
import { createHealthRouter } from "./routes/health.js";
import { createProxyRouter } from "./routes/proxy.js";
import { createTrashRouter } from "./routes/trash.js";
import { createPreferencesRouter } from "./routes/preferences.js";
import { createPresenceRouter } from "./routes/presence.js";
import { createAdminRouter } from "./routes/admin.js";
import { createTeamsRouter } from "./routes/teams.js";
import { createActivityRouter } from "./routes/activity.js";
import type { CollectionsRouterOptions } from "./routes/collections.js";
import { IMPORT_BODY_LIMIT } from "./validation/schemas.js";
import { OPENAPI_BODY_LIMIT } from "./validation/openapiSchemas.js";

export interface CreateAppOptions {
  env: Env;
  db: AppDatabase;
  events?: ChangeEventHub;
  presence?: PresenceHub;
  emailCodeSender?: EmailCodeSender;
  logger?: ErrorHandlerOptions["logger"];
  collections?: CollectionsRouterOptions;
}

// SMTP is chosen by whether it is configured, not by NODE_ENV. Tying it to production meant
// settings could not be exercised until the one deployment where a mistake is most expensive, and
// production already refuses to start without a host and a sender. Configuring SMTP in development
// also withdraws the dev-inbox helper, which only ever reads the in-memory sender - so turning real
// delivery on cannot leave a code-revealing route behind.
export function defaultEmailCodeSender(env: Env): EmailCodeSender {
  return env.SMTP_HOST && env.SMTP_FROM ? new SmtpEmailCodeSender(env) : new MemoryEmailCodeSender();
}

export function createApp({
  env,
  db,
  events = new ChangeEventHub(),
  presence = new PresenceHub(),
  emailCodeSender = defaultEmailCodeSender(env),
  logger,
  collections: collectionsOptions,
}: CreateAppOptions): Express {
  const app = express();
  const reportError = logger ?? ((error: unknown) => console.error(error));

  events.observe((event) => {
    if (event.operation === "trashed" || event.operation === "move") {
      void presence.removeInactiveResources(db).catch(reportError);
    }
  });

  app.disable("x-powered-by");
  app.use(createCorsMiddleware(env.CORS_ORIGIN));

  app.use("/health", createHealthRouter());
  const requireAuth = createAuthenticationMiddleware(db, env.AUTH_COOKIE_NAME);
  const requireTeam = createTeamContextMiddleware(db);
  // A viewer only reads the team's content. Running collections and saving one's own (user-scope)
  // variables are not edits of shared content, so they stay open to every member.
  const collectionsEditor = requireTeamEditor((req) => /^\/[^/]+\/(items\/[^/]+\/)?run$/.test(req.path));
  const variablesEditor = requireTeamEditor((req) => /^\/(order|user(\/[^/]+)?)$/.test(req.path));
  const contentEditor = requireTeamEditor();
  app.use(
    "/api/v1/preferences",
    express.json({ limit: "256kb" }),
    requireAuth,
    createPreferencesRouter(db),
  );
  // Parsed here, ahead of the general parser, so an import gets its own smaller limit; the
  // general parser then sees the body as already read and leaves it alone.
  app.use("/api/v1/collections/:collectionId/import", express.json({ limit: IMPORT_BODY_LIMIT }));
  app.use("/api/v1/collections/:collectionId/sync/openapi", express.json({ limit: OPENAPI_BODY_LIMIT }));
  app.use("/api/v1/collections/openapi", express.json({ limit: OPENAPI_BODY_LIMIT }));
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/v1/auth", createAuthRouter(db, env, emailCodeSender, logger));
  app.use(
    "/api/v1/events",
    requireAuth,
    requireTeam,
    createEventsRouter(events, presence, db, { heartbeatMs: env.SSE_HEARTBEAT_MS, retryMs: env.SSE_RETRY_MS }),
  );

  app.use("/api/v1/presence", requireAuth, requireTeam, createPresenceRouter(db, presence));
  app.use("/api/v1/collections", requireAuth, requireTeam, collectionsEditor, createCollectionRunsRouter(db, env));
  app.use("/api/v1/collections", requireAuth, requireTeam, collectionsEditor, createCollectionsRouter(db, events, collectionsOptions));
  app.use("/api/v1/environments", requireAuth, requireTeam, contentEditor, createEnvironmentsRouter(db, events, env));
  app.use("/api/v1/variables", requireAuth, requireTeam, variablesEditor, createVariablesRouter(db, events));
  app.use("/api/v1/trash", requireAuth, requireTeam, contentEditor, createTrashRouter(db, events, env));
  app.use("/api/v1/proxy", requireAuth, createProxyRouter(env));
  app.use("/api/v1/teams", requireAuth, createTeamsRouter(db, { events, presence, corsOrigin: env.CORS_ORIGIN }));
  app.use("/api/v1/activity", requireAuth, requireTeam, createActivityRouter(db));
  app.use("/api/v1/admin", requireAuth, requireSystemAdmin, createAdminRouter(db, { events, presence, corsOrigin: env.CORS_ORIGIN }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ exposeInternalErrors: env.NODE_ENV !== "production", logger }));

  return app;
}
