import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import {
  createEnvironment,
  listEnvironments,
  readEnvironment,
  trashEnvironment,
  updateEnvironment,
} from "../services/environments.js";
import { environmentInputSchema } from "../validation/schemas.js";

export function createEnvironmentsRouter(db: AppDatabase, events: ChangeEventHub): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ environments: listEnvironments(db) });
  });

  router.post("/", (req, res) => {
    const environment = createEnvironment(db, environmentInputSchema.parse(req.body));
    events.publish({ kind: "environment", id: environment.id, collectionId: null, operation: "created", changedAt: environment.updatedAt });
    res.status(201).json(environment);
  });

  router.get("/:environmentId", (req, res) => {
    res.json(readEnvironment(db, req.params.environmentId));
  });

  router.put("/:environmentId", (req, res) => {
    const environment = updateEnvironment(db, req.params.environmentId, environmentInputSchema.parse(req.body));
    events.publish({ kind: "environment", id: environment.id, collectionId: null, operation: "updated", changedAt: environment.updatedAt });
    res.json(environment);
  });

  router.delete("/:environmentId", (req, res) => {
    const trashed = trashEnvironment(db, req.params.environmentId);
    events.publish({ kind: "environment", id: trashed.id, collectionId: null, operation: "trashed", changedAt: trashed.deletedAt });
    res.status(204).end();
  });

  return router;
}
