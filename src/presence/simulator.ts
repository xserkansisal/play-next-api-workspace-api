import { randomInt } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items, presenceTestUsers, users } from "../db/schema.js";
import type { PresenceHub, PresenceLocation } from "../events/presence.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const LOCATION_CHANGE_INTERVAL_MS = 60_000;

interface SimulatedLocation {
  kind: "collection" | "folder" | "request";
  collectionId: string;
  itemId: string | null;
}

interface SimulatedUser {
  userId: string;
  clientId: string;
  firstName: string;
  lastName: string;
  locationKind: SimulatedLocation["kind"];
  collectionId: string;
  itemId: string | null;
  locationUpdatedAt: string;
}

export async function activePresenceLocations(db: AppDatabase): Promise<SimulatedLocation[]> {
  const [activeCollections, activeItems] = await Promise.all([
    db
      .select({ collectionId: collections.id })
      .from(collections)
      .where(isNull(collections.deletedAt)),
    db
      .select({ collectionId: items.collectionId, itemId: items.id, kind: items.kind })
      .from(items)
      .innerJoin(collections, eq(items.collectionId, collections.id))
      .where(and(isNull(items.deletedAt), isNull(collections.deletedAt))),
  ]);

  return [
    ...activeCollections.map(({ collectionId }) => ({ kind: "collection" as const, collectionId, itemId: null })),
    ...activeItems.map(({ collectionId, itemId, kind }) => ({ kind, collectionId, itemId })),
  ];
}

function randomLocation(locations: SimulatedLocation[]): SimulatedLocation | undefined {
  if (locations.length === 0) return undefined;
  return locations[randomInt(locations.length)];
}

function sameLocation(left: SimulatedLocation, right: SimulatedLocation): boolean {
  return left.kind === right.kind && left.collectionId === right.collectionId && left.itemId === right.itemId;
}

function toPresenceLocation(location: SimulatedLocation): Exclude<PresenceLocation, null> {
  if (location.kind === "collection") return { kind: location.kind, collectionId: location.collectionId };
  if (!location.itemId) throw new Error(`Simulated ${location.kind} location is missing its item ID`);
  return { kind: location.kind, collectionId: location.collectionId, itemId: location.itemId };
}

export interface PresenceSimulatorOptions {
  heartbeatIntervalMs?: number;
  locationChangeIntervalMs?: number;
  logger?: (error: unknown) => void;
}

export function startPresenceSimulator(
  db: AppDatabase,
  presence: PresenceHub,
  options: PresenceSimulatorOptions = {},
): { stop: () => Promise<void> } {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const locationChangeIntervalMs = options.locationChangeIntervalMs ?? LOCATION_CHANGE_INTERVAL_MS;
  const logger = options.logger ?? ((error: unknown) => console.error("Presence simulator failed:", error));
  const activeUsers = new Map<string, { clientId: string; firstName: string; lastName: string }>();
  let running = false;
  let stopped = false;
  let warnedNoUsers = false;

  const refresh = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const [simulatedUsers, locations] = await Promise.all([
        db
          .select({
            userId: presenceTestUsers.userId,
            clientId: presenceTestUsers.clientId,
            firstName: users.firstName,
            lastName: users.lastName,
            locationKind: presenceTestUsers.locationKind,
            collectionId: presenceTestUsers.collectionId,
            itemId: presenceTestUsers.itemId,
            locationUpdatedAt: presenceTestUsers.locationUpdatedAt,
          })
          .from(presenceTestUsers)
          .innerJoin(users, eq(presenceTestUsers.userId, users.id)),
        activePresenceLocations(db),
      ]);
      const now = Date.now();
      const latestUsers = new Set(simulatedUsers.map((user) => user.userId));
      if (simulatedUsers.length === 0 && !warnedNoUsers) {
        warnedNoUsers = true;
        logger(new Error("No presence simulator users are configured; run npm run presence:seed"));
      } else if (simulatedUsers.length > 0) {
        warnedNoUsers = false;
      }

      for (const [userId, identity] of activeUsers) {
        if (!latestUsers.has(userId)) presence.heartbeat({ userId, ...identity }, identity.clientId, null, now);
      }
      activeUsers.clear();

      for (const user of simulatedUsers) {
        const identity = { clientId: user.clientId, firstName: user.firstName, lastName: user.lastName };
        activeUsers.set(user.userId, identity);
        const assigned: SimulatedLocation = {
          kind: user.locationKind,
          collectionId: user.collectionId,
          itemId: user.itemId,
        };
        const assignedIsActive = locations.some((location) => sameLocation(location, assigned));
        const shouldMove =
          !assignedIsActive || now - Date.parse(user.locationUpdatedAt) >= locationChangeIntervalMs;
        const location = shouldMove ? randomLocation(locations) : assigned;

        if (!location) {
          presence.heartbeat(user, user.clientId, null, now);
          continue;
        }

        if (shouldMove) {
          await db
            .update(presenceTestUsers)
            .set({
              locationKind: location.kind,
              collectionId: location.collectionId,
              itemId: location.itemId,
              locationUpdatedAt: new Date(now).toISOString(),
            })
            .where(eq(presenceTestUsers.userId, user.userId));
        }
        presence.heartbeat(user, user.clientId, toPresenceLocation(location), now);
      }
    } catch (error) {
      logger(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void refresh(), heartbeatIntervalMs);
  timer.unref();
  void refresh();

  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 5));
      for (const [userId, identity] of activeUsers) {
        presence.heartbeat({ userId, firstName: identity.firstName, lastName: identity.lastName }, identity.clientId, null);
      }
      activeUsers.clear();
    },
  };
}

export function choosePresenceTestLocation(locations: SimulatedLocation[]): SimulatedLocation | undefined {
  return randomLocation(locations);
}

export type { SimulatedLocation };
