import { Router, type Request } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { BadRequestError } from "../errors.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";
import {
  createVariable,
  deleteVariable,
  getVariableDisplayOrder,
  listVariables,
  setVariable,
  setVariableDisplayOrder,
  updateVariable,
  type VariableActor,
} from "../services/variables.js";
import {
  variableDisplayOrderSchema,
  variableInputSchema,
  variableCreateInputSchema,
  variableKeySchema,
  variablePatchSchema,
  variableScopeSchema,
} from "../validation/schemas.js";

export function createVariablesRouter(db: AppDatabase, events: ChangeEventHub): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ variables: await listVariables(db, actorOf(req)) });
  });

  router.get("/order", async (req, res) => {
    res.json({ order: await getVariableDisplayOrder(db, authenticatedUserId(req)) });
  });

  router.put("/order", async (req, res) => {
    const { order } = variableDisplayOrderSchema.parse(req.body);
    res.json({ order: await setVariableDisplayOrder(db, authenticatedUserId(req), order) });
  });

  router.post("/:scope", async (req, res) => {
    const scope = variableScopeSchema.parse(req.params.scope);
    const parsed = variableCreateInputSchema.safeParse(req.body);
    if (!parsed.success) {
      const invalidKey = parsed.error.issues.some((issue) => issue.path[0] === "key");
      throw new BadRequestError(
        invalidKey ? "Variable key is invalid" : "Variable value is invalid",
        invalidKey ? "VARIABLE_KEY_INVALID" : "VARIABLE_VALUE_INVALID",
        parsed.error.issues,
      );
    }
    const actor = actorOf(req);
    const variable = await createVariable(db, actor, scope, parsed.data.key, parsed.data.value);
    if (scope === "global") {
      publishIfShared(events, actor.teamId, scope, variable.key, variable.updatedAt, "created");
    } else {
      events.publishToUser(actor.userId, {
        kind: "variable",
        id: variable.key,
        collectionId: null,
        operation: "created",
        changedAt: variable.updatedAt,
      });
    }
    res.status(201).json(variable);
  });

  router.put("/:scope/:key", async (req, res) => {
    const scope = variableScopeSchema.parse(req.params.scope);
    const key = variableKeySchema.parse(req.params.key);
    const { value } = variableInputSchema.parse(req.body);
    const actor = actorOf(req);
    const variable = await setVariable(db, actor, scope, key, value);
    publishIfShared(events, actor.teamId, variable.scope, key, variable.updatedAt, "updated");
    res.json(variable);
  });

  router.patch("/:scope/:key", async (req, res) => {
    const scope = variableScopeSchema.parse(req.params.scope);
    const key = variableKeySchema.parse(req.params.key);
    const patch = variablePatchSchema.parse(req.body);
    const actor = actorOf(req);
    const variable = await updateVariable(db, actor, scope, key, patch);
    if (patch.key !== undefined && patch.key !== key) {
      publishIfShared(events, actor.teamId, scope, key, variable.updatedAt, "trashed");
    }
    publishIfShared(events, actor.teamId, scope, variable.key, variable.updatedAt, "updated");
    res.json(variable);
  });

  router.delete("/:scope/:key", async (req, res) => {
    const scope = variableScopeSchema.parse(req.params.scope);
    const key = variableKeySchema.parse(req.params.key);
    const actor = actorOf(req);
    await deleteVariable(db, actor, scope, key);
    publishIfShared(events, actor.teamId, scope, key, new Date().toISOString(), "trashed");
    res.status(204).end();
  });

  return router;
}

/**
 * Only global writes are announced, and only to the team that owns them.
 *
 * A user-scope value concerns exactly one person, and broadcasting it would both cause every other
 * client to refetch for nothing and tell the whole team which keys that person holds.
 */
function actorOf(req: Request): VariableActor {
  return { userId: authenticatedUserId(req), teamId: requestTeamId(req) };
}

function publishIfShared(
  events: ChangeEventHub,
  teamId: string,
  scope: string,
  key: string,
  changedAt: string,
  operation: "created" | "updated" | "trashed",
): void {
  if (scope !== "global") return;
  events.publish(teamId, { kind: "variable", id: key, collectionId: null, operation, changedAt });
}
