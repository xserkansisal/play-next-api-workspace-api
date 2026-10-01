import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { BadRequestError } from "../errors.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import {
  getVariableOrderPreferences,
  setVariableOrderPreferences,
} from "../services/variables.js";
import { variableOrderPreferencesSchema } from "../validation/schemas.js";

export function createPreferencesRouter(db: AppDatabase): Router {
  const router = Router();

  router.get("/variable-order", async (req, res) => {
    res.json({
      preferences: await getVariableOrderPreferences(db, authenticatedUserId(req)),
    });
  });

  router.put("/variable-order", async (req, res) => {
    const parsed = variableOrderPreferencesSchema.safeParse(req.body?.preferences);
    if (!parsed.success) {
      throw new BadRequestError(
        "Variable order preferences are invalid",
        "PREFERENCES_INVALID",
        parsed.error.issues,
      );
    }
    const preferences = await setVariableOrderPreferences(db, authenticatedUserId(req), parsed.data);
    res.json({ preferences });
  });

  return router;
}
