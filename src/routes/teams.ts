import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import { listMyTeams } from "../services/teams.js";

/** Team information for the signed-in user; drives the team switcher. */
export function createTeamsRouter(db: AppDatabase): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ teams: await listMyTeams(db, authenticatedUserId(req)) });
  });

  return router;
}
