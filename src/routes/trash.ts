import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { checkRestore, listTrash, restoreFromTrash } from "../services/trash.js";
import { restoreSchema } from "../validation/schemas.js";

export function createTrashRouter(db: AppDatabase): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ entries: listTrash(db) });
  });

  router.post("/:id/restore/check", (req, res) => {
    res.json(checkRestore(db, req.params.id, restoreSchema.parse(req.body ?? {})));
  });

  router.post("/:id/restore", (req, res) => {
    res.json(restoreFromTrash(db, req.params.id, restoreSchema.parse(req.body ?? {})));
  });

  return router;
}
