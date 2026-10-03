import { Router } from "express";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import { createUserRateLimit } from "../middleware/rateLimit.js";
import { guardCollectionParam } from "./teamGuards.js";
import { collectionRunSchema, idSchema, runHistoryQuerySchema } from "../validation/schemas.js";
import {
  getCollectionRun,
  listCollectionRuns,
  runCollection,
  type RunnerProxyOptions,
} from "../services/collectionRunner.js";
import { parseAllowedHosts } from "../services/proxy.js";

export interface CollectionRunsRouterOptions {
  proxy?: Partial<RunnerProxyOptions>;
  rateLimit?: { limit: number; windowMs: number };
}

export function createCollectionRunsRouter(
  db: AppDatabase,
  env: Env,
  options: CollectionRunsRouterOptions = {},
): Router {
  const router = Router();
  guardCollectionParam(router, db);
  const runRateLimit = createUserRateLimit(options.rateLimit ?? { limit: 3, windowMs: 60_000 });
  const proxyOptions: RunnerProxyOptions = {
    allowedHosts: parseAllowedHosts(env.PROXY_ALLOWED_HOSTS),
    timeoutMs: env.PROXY_TIMEOUT_MS,
    maxResponseBytes: env.PROXY_MAX_RESPONSE_BYTES,
    ...options.proxy,
  };

  router.post("/:collectionId/run", runRateLimit, async (req, res) => {
    const run = await runCollection(
      db,
      idSchema.parse(req.params.collectionId),
      authenticatedUserId(req),
      collectionRunSchema.parse(req.body),
      proxyOptions,
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    res.status(201).json(run);
  });

  router.post("/:collectionId/items/:itemId/run", runRateLimit, async (req, res) => {
    const run = await runCollection(
      db,
      idSchema.parse(req.params.collectionId),
      authenticatedUserId(req),
      collectionRunSchema.parse(req.body),
      proxyOptions,
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
      idSchema.parse(req.params.itemId),
    );
    res.status(201).json(run);
  });

  router.get("/:collectionId/runs", async (req, res) => {
    res.json(await listCollectionRuns(
      db,
      idSchema.parse(req.params.collectionId),
      authenticatedUserId(req),
      runHistoryQuerySchema.parse(req.query),
    ));
  });

  router.get("/:collectionId/runs/:runId", async (req, res) => {
    res.json(await getCollectionRun(
      db,
      idSchema.parse(req.params.collectionId),
      idSchema.parse(req.params.runId),
      authenticatedUserId(req),
    ));
  });

  return router;
}
