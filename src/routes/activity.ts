import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { requestTeamId } from "../middleware/authenticate.js";
import { listActivity } from "../services/activity.js";
import { activityQuerySchema } from "../validation/activitySchemas.js";

export function createActivityRouter(db: AppDatabase): Router {
  const router = Router();
  router.get("/", async (req, res) => {
    res.json(await listActivity(db, requestTeamId(req), activityQuerySchema.parse(req.query)));
  });
  return router;
}
