import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEvent, ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
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

export function createTrashRouter(db: AppDatabase, events: ChangeEventHub): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ entries: listTrash(db) });
  });

  router.post("/:id/restore/check", (req, res) => {
    res.json(checkRestore(db, req.params.id, restoreSchema.parse(req.body ?? {})));
  });

  router.post("/:id/restore", (req, res) => {
    const { resource, restoredAt } = restoreFromTrash(
      db,
      req.params.id,
      restoreSchema.parse(req.body ?? {}),
      authenticatedUserId(req),
    );
    events.publish({ ...restoredEventTarget(resource), operation: "restored", changedAt: restoredAt });
    res.json(resource);
  });

  return router;
}
