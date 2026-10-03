import { Router } from "express";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEvent, ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";
import { checkRestore, listTrash, restoreFromTrash, type RestoredResource } from "../services/trash.js";
import { restoreSchema } from "../validation/schemas.js";

function restoredEventTarget(resource: RestoredResource): Pick<ChangeEvent, "kind" | "id" | "collectionId"> {
  switch (resource.kind) {
    case "collection":
      return { kind: "collection", id: resource.collection.id, collectionId: null };
    case "environment":
      return { kind: "environment", id: resource.environment.id, collectionId: null };
    default:
      return { kind: resource.item.type, id: resource.item.id, collectionId: resource.item.collectionId };
  }
}

export function createTrashRouter(db: AppDatabase, events: ChangeEventHub, env: Env): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ entries: await listTrash(db, requestTeamId(req)) });
  });

  router.post("/:id/restore/check", async (req, res) => {
    res.json(await checkRestore(db, requestTeamId(req), req.params.id, restoreSchema.parse(req.body ?? {})));
  });

  router.post("/:id/restore", async (req, res) => {
    const { resource, restoredAt } = await restoreFromTrash(
      db,
      requestTeamId(req),
      req.params.id,
      restoreSchema.parse(req.body ?? {}),
      authenticatedUserId(req),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    events.publish(requestTeamId(req), { ...restoredEventTarget(resource), operation: "restored", changedAt: restoredAt });
    res.json(resource);
  });

  return router;
}
