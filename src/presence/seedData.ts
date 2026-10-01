import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { presenceTestUsers, users } from "../db/schema.js";
import { activePresenceLocations, choosePresenceTestLocation, type SimulatedLocation } from "./simulator.js";

export const PRESENCE_TEST_USER_COUNT = 10;

export async function seedPresenceTestUsers(
  db: AppDatabase,
  count = PRESENCE_TEST_USER_COUNT,
): Promise<number> {
  const locations = await activePresenceLocations(db);
  if (locations.length === 0) {
    throw new Error("Create at least one active collection, folder, or request before seeding presence users");
  }

  return db.transaction(async (tx) => {
    const existing = await tx
      .select({ userId: presenceTestUsers.userId })
      .from(presenceTestUsers);
    const retained = existing.slice(0, count);
    const removed = existing.slice(count);
    if (removed.length > 0) {
      await tx.delete(users).where(inArray(users.id, removed.map(({ userId }) => userId)));
    }
    const now = new Date().toISOString();

    for (const { userId } of retained) {
      const location = requiredRandomLocation(locations);
      await tx
        .update(presenceTestUsers)
        .set({
          locationKind: location.kind,
          collectionId: location.collectionId,
          itemId: location.itemId,
          locationUpdatedAt: now,
        })
        .where(eq(presenceTestUsers.userId, userId));
    }

    for (let index = retained.length; index < count; index += 1) {
      const userId = randomUUID();
      const profileSuffix = randomUUID().slice(0, 8);
      const location = requiredRandomLocation(locations);
      await tx.insert(users).values({
        id: userId,
        email: `presence-${randomUUID()}@example.invalid`,
        firstName: "Test",
        lastName: `Viewer-${profileSuffix}`,
        createdAt: now,
      });
      await tx.insert(presenceTestUsers).values({
        userId,
        clientId: randomUUID(),
        locationKind: location.kind,
        collectionId: location.collectionId,
        itemId: location.itemId,
        locationUpdatedAt: now,
      });
    }

    return count;
  });
}

function requiredRandomLocation(locations: SimulatedLocation[]): SimulatedLocation {
  const location = choosePresenceTestLocation(locations);
  if (!location) throw new Error("No active resource is available for simulated presence");
  return location;
}

export async function clearPresenceTestUsers(db: AppDatabase): Promise<number> {
  const simulated = await db
    .select({ userId: presenceTestUsers.userId })
    .from(presenceTestUsers);
  if (simulated.length === 0) return 0;
  await db.delete(users).where(inArray(users.id, simulated.map(({ userId }) => userId)));
  return simulated.length;
}
