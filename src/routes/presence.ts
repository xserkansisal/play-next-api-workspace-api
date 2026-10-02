import { and, eq, isNull } from "drizzle-orm";
import { Router } from "express";
import { z } from "zod";
import type { AppDatabase } from "../db/client.js";
import { collections, items } from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import type { PresenceHub } from "../events/presence.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";
import { idSchema } from "../validation/schemas.js";

const locationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("collection"), collectionId: idSchema }),
  z.strictObject({ kind: z.literal("folder"), collectionId: idSchema, itemId: idSchema }),
  z.strictObject({ kind: z.literal("request"), collectionId: idSchema, itemId: idSchema }),
]);

const presenceInputSchema = z.strictObject({
  clientId: z.string().min(1).max(128),
  location: locationSchema.nullable(),
});

export function createPresenceRouter(db: AppDatabase, presence: PresenceHub): Router {
  const router = Router();

  router.put("/", async (req, res, next) => {
    try {
      const input = presenceInputSchema.parse(req.body);
      const userId = authenticatedUserId(req);
      const teamId = requestTeamId(req);

      if (input.location) {
        const activeCollection = await db
          .select({ id: collections.id })
          .from(collections)
          .where(and(
            eq(collections.id, input.location.collectionId),
            eq(collections.teamId, teamId),
            isNull(collections.deletedAt),
          ))
          .limit(1);
        if (activeCollection.length === 0) throw new NotFoundError("Presence resource not found");

        if ("itemId" in input.location) {
          const activeItem = await db
            .select({ id: items.id })
            .from(items)
            .where(
              and(
                eq(items.id, input.location.itemId),
                eq(items.collectionId, input.location.collectionId),
                eq(items.kind, input.location.kind),
                isNull(items.deletedAt),
              ),
            )
            .limit(1);
          if (activeItem.length === 0) throw new NotFoundError("Presence resource not found");
        }
      }

      const user = req.authUser;
      if (!user) throw new Error("Authenticated user disappeared before presence was updated");
      presence.heartbeat(
        { userId, firstName: user.firstName, lastName: user.lastName, teamId },
        input.clientId,
        input.location,
      );
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
