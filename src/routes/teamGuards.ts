import type { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { NotFoundError } from "../errors.js";
import { requestTeamId } from "../middleware/authenticate.js";
import { collectionBelongsToTeam } from "../services/collections.js";
import { environmentBelongsToTeam } from "../services/environments.js";

/**
 * Rejects any route whose `:collectionId` names another team's collection, before the handler
 * runs. Everything under a collection - items, versions, runs - is reached through this parameter,
 * so this one check keeps the whole subtree inside the team. Another team's collection answers
 * exactly like a missing one.
 */
export function guardCollectionParam(router: Router, db: AppDatabase): void {
  router.param("collectionId", (req, _res, next, id: string) => {
    collectionBelongsToTeam(db, requestTeamId(req), id)
      .then((belongs) => next(belongs ? undefined : new NotFoundError(`Collection ${id} not found`)))
      .catch(next);
  });
}

export function guardEnvironmentParam(router: Router, db: AppDatabase): void {
  router.param("environmentId", (req, _res, next, id: string) => {
    environmentBelongsToTeam(db, requestTeamId(req), id)
      .then((belongs) => next(belongs ? undefined : new NotFoundError(`Environment ${id} not found`)))
      .catch(next);
  });
}
