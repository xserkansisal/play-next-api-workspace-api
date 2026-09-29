import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import {
  createEnvironment,
  listEnvironments,
  readEnvironment,
  trashEnvironment,
  updateEnvironment,
} from "../services/environments.js";
import { environmentInputSchema } from "../validation/schemas.js";

export function createEnvironmentsRouter(db: AppDatabase): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ environments: listEnvironments(db) });
  });

  router.post("/", (req, res) => {
    res.status(201).json(createEnvironment(db, environmentInputSchema.parse(req.body)));
  });

  router.get("/:environmentId", (req, res) => {
    res.json(readEnvironment(db, req.params.environmentId));
  });

  router.put("/:environmentId", (req, res) => {
    res.json(updateEnvironment(db, req.params.environmentId, environmentInputSchema.parse(req.body)));
  });

  router.delete("/:environmentId", (req, res) => {
    trashEnvironment(db, req.params.environmentId);
    res.status(204).end();
  });

  return router;
}
