import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import {
  deleteVariable,
  getVariableDisplayOrder,
  listVariables,
  setVariable,
  setVariableDisplayOrder,
} from "../services/variables.js";
import { variableDisplayOrderSchema, variableInputSchema, variableKeySchema, variableScopeSchema } from "../validation/schemas.js";

export function createVariablesRouter(db: AppDatabase, events: ChangeEventHub): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ variables: await listVariables(db, authenticatedUserId(req)) });
  });

  router.get("/order", async (req, res) => {
    res.json({ order: await getVariableDisplayOrder(db, authenticatedUserId(req)) });
  });

  router.put("/order", async (req, res) => {
    const { order } = variableDisplayOrderSchema.parse(req.body);
    res.json({ order: await setVariableDisplayOrder(db, authenticatedUserId(req), order) });
  });

  router.put("/:scope/:key", async (req, res) => {
    const scope = variableScopeSchema.parse(req.params.scope);
    const key = variableKeySchema.parse(req.params.key);
    const { value } = variableInputSchema.parse(req.body);
    const variable = await setVariable(db, authenticatedUserId(req), scope, key, value);
    publishIfShared(events, variable.scope, key, variable.updatedAt, "updated");
    res.json(variable);
  });

  router.delete("/:scope/:key", async (req, res) => {
    const scope = variableScopeSchema.parse(req.params.scope);
    const key = variableKeySchema.parse(req.params.key);
    await deleteVariable(db, authenticatedUserId(req), scope, key);
    publishIfShared(events, scope, key, new Date().toISOString(), "trashed");
    res.status(204).end();
  });

  return router;
}

/**
 * Only global writes are announced.
 *
 * A user-scope value concerns exactly one person, and broadcasting it would both cause every other
 * client to refetch for nothing and tell the whole team which keys that person holds.
 */
function publishIfShared(
  events: ChangeEventHub,
  scope: string,
  key: string,
  changedAt: string,
  operation: "updated" | "trashed",
): void {
  if (scope !== "global") return;
  events.publish({ kind: "variable", id: key, collectionId: null, operation, changedAt });
}
