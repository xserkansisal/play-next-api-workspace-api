import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";
import { idSchema, teamScriptSchema } from "../validation/schemas.js";
import {
  createTeamScript,
  deleteTeamScript,
  listTeamScripts,
  updateTeamScript,
} from "../services/teamScripts.js";

export function createTeamScriptsRouter(db: AppDatabase): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    res.json({ scripts: await listTeamScripts(db, requestTeamId(req)) });
  });

  router.post("/", async (req, res) => {
    const script = await createTeamScript(
      db,
      requestTeamId(req),
      teamScriptSchema.parse(req.body),
      authenticatedUserId(req),
    );
    res.status(201).json(script);
  });

  router.put("/:scriptId", async (req, res) => {
    const script = await updateTeamScript(
      db,
      requestTeamId(req),
      idSchema.parse(req.params.scriptId),
      teamScriptSchema.parse(req.body),
      authenticatedUserId(req),
    );
    res.json(script);
  });

  router.delete("/:scriptId", async (req, res) => {
    await deleteTeamScript(db, requestTeamId(req), idSchema.parse(req.params.scriptId));
    res.status(204).end();
  });

  return router;
}
