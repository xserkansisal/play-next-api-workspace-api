import { Router } from "express";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";
import { guardEnvironmentParam } from "./teamGuards.js";
import {
  addEnvironmentVariable,
  cloneEnvironment,
  createEnvironment,
  listEnvironments,
  readEnvironment,
  trashEnvironment,
  updateEnvironment,
} from "../services/environments.js";
import { BadRequestError } from "../errors.js";
import { environmentInputSchema, environmentVariableCreateInputSchema } from "../validation/schemas.js";

export function createEnvironmentsRouter(db: AppDatabase, events: ChangeEventHub, env: Env): Router {
  const router = Router();
  guardEnvironmentParam(router, db);

  router.get("/", async (req, res) => {
    res.json({
      environments: await listEnvironments(db, requestTeamId(req), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS),
    });
  });

  router.post("/", async (req, res) => {
    const environment = await createEnvironment(
      db,
      requestTeamId(req),
      environmentInputSchema.parse(req.body),
      authenticatedUserId(req),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    events.publish(requestTeamId(req), { kind: "environment", id: environment.id, collectionId: null, operation: "created", changedAt: environment.updatedAt });
    res.status(201).json(environment);
  });

  router.get("/:environmentId", async (req, res) => {
    res.json(await readEnvironment(db, req.params.environmentId, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS));
  });

  router.post("/:environmentId/variables", async (req, res) => {
    const parsed = environmentVariableCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      const invalidKey = parsed.error.issues.some((issue) => issue.path[0] === "key");
      throw new BadRequestError(
        invalidKey ? "Variable key is invalid" : "Variable value is invalid",
        invalidKey ? "VARIABLE_KEY_INVALID" : "VARIABLE_VALUE_INVALID",
        parsed.error.issues,
      );
    }
    const environment = await addEnvironmentVariable(
      db,
      req.params.environmentId,
      parsed.data,
      authenticatedUserId(req),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    events.publish(requestTeamId(req), { kind: "environment", id: environment.id, collectionId: null, operation: "updated", changedAt: environment.updatedAt });
    res.status(201).json(environment);
  });

  router.put("/:environmentId", async (req, res) => {
    const environment = await updateEnvironment(
      db,
      req.params.environmentId,
      environmentInputSchema.parse(req.body),
      authenticatedUserId(req),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    events.publish(requestTeamId(req), { kind: "environment", id: environment.id, collectionId: null, operation: "updated", changedAt: environment.updatedAt });
    res.json(environment);
  });

  router.post("/:environmentId/clone", async (req, res) => {
    const environment = await cloneEnvironment(
      db,
      req.params.environmentId,
      authenticatedUserId(req),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    events.publish(requestTeamId(req), { kind: "environment", id: environment.id, collectionId: null, operation: "created", changedAt: environment.updatedAt });
    res.status(201).json(environment);
  });

  router.delete("/:environmentId", async (req, res) => {
    const trashed = await trashEnvironment(db, req.params.environmentId, authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: "environment", id: trashed.id, collectionId: null, operation: "trashed", changedAt: trashed.deletedAt });
    res.status(204).end();
  });

  return router;
}
