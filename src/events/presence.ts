import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items } from "../db/schema.js";

export type PresenceLocation =
  | { kind: "collection"; collectionId: string }
  | { kind: "folder" | "request"; collectionId: string; itemId: string }
  | null;

export interface PresenceUser {
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: null;
  avatarColor: null;
  location: Exclude<PresenceLocation, null>;
}

export interface PresenceSnapshot {
  users: PresenceUser[];
}

export interface PresenceIdentity {
  userId: string;
  firstName: string;
  lastName: string;
  /** The team whose collection the location is in; only that team's members see the entry. */
  teamId: string;
}

export interface PresenceHubOptions {
  ttlMs?: number;
  sweepIntervalMs?: number;
}

interface PresenceEntry extends PresenceIdentity {
  clientId: string;
  location: Exclude<PresenceLocation, null>;
  lastSeenAt: number;
}

type PresenceListener = (snapshot: PresenceSnapshot) => void;

interface PresenceSubscription {
  teamId: string;
  listener: PresenceListener;
}

function sameLocation(left: Exclude<PresenceLocation, null>, right: Exclude<PresenceLocation, null>): boolean {
  return (
    left.kind === right.kind &&
    left.collectionId === right.collectionId &&
    ("itemId" in left ? left.itemId : undefined) === ("itemId" in right ? right.itemId : undefined)
  );
}

export class PresenceHub {
  readonly ttlMs: number;
  private readonly entries = new Map<string, PresenceEntry>();
  private readonly listeners = new Set<PresenceSubscription>();
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;

  constructor(options: PresenceHubOptions = {}) {
    this.ttlMs = Math.min(45_000, Math.max(1, options.ttlMs ?? 45_000));
    this.sweepTimer = setInterval(() => this.expire(), options.sweepIntervalMs ?? 5_000);
    this.sweepTimer.unref();
  }

  private entryKey(userId: string, clientId: string): string {
    return `${userId}\0${clientId}`;
  }

  private expire(now = Date.now()): boolean {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenAt >= this.ttlMs) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.publishSnapshot();
    return changed;
  }

  private createSnapshot(teamId: string): PresenceSnapshot {
    return {
      users: [...this.entries.values()]
        .filter((entry) => entry.teamId === teamId)
        .sort((left, right) => left.userId.localeCompare(right.userId) || left.clientId.localeCompare(right.clientId))
        .map(({ userId, firstName, lastName, location }) => ({
          userId,
          firstName,
          lastName,
          avatarUrl: null,
          avatarColor: null,
          location,
        })),
    };
  }

  private publishSnapshot(): void {
    const snapshots = new Map<string, PresenceSnapshot>();
    for (const subscription of [...this.listeners]) {
      let snapshot = snapshots.get(subscription.teamId);
      if (!snapshot) {
        snapshot = this.createSnapshot(subscription.teamId);
        snapshots.set(subscription.teamId, snapshot);
      }
      try {
        subscription.listener(snapshot);
      } catch {
        this.listeners.delete(subscription);
      }
    }
  }

  heartbeat(identity: PresenceIdentity, clientId: string, location: PresenceLocation, now = Date.now()): void {
    if (this.closed) return;
    this.expire(now);
    const key = this.entryKey(identity.userId, clientId);
    if (location === null) {
      if (this.entries.delete(key)) this.publishSnapshot();
      return;
    }

    const previous = this.entries.get(key);
    this.entries.set(key, { ...identity, clientId, location, lastSeenAt: now });
    if (
      !previous ||
      previous.firstName !== identity.firstName ||
      previous.lastName !== identity.lastName ||
      previous.teamId !== identity.teamId ||
      !sameLocation(previous.location, location)
    ) {
      this.publishSnapshot();
    }
  }

  snapshot(teamId: string, now = Date.now()): PresenceSnapshot {
    this.expire(now);
    return this.createSnapshot(teamId);
  }

  subscribe(teamId: string, listener: PresenceListener): () => void {
    if (this.closed) return () => {};
    const subscription = { teamId, listener };
    this.listeners.add(subscription);
    return () => this.listeners.delete(subscription);
  }

  /** Drops the entries of one member of a team, or of everyone in it when `userId` is omitted. */
  removeTeamMember(teamId: string, userId?: string): void {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.teamId === teamId && (userId === undefined || entry.userId === userId)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    if (changed) this.publishSnapshot();
  }

  async removeInactiveResources(db: AppDatabase): Promise<void> {
    const current = [...this.entries.values()];
    if (current.length === 0) return;
    const collectionIds = [...new Set(current.map((entry) => entry.location.collectionId))];
    const itemIds = [...new Set(current.flatMap((entry) => ("itemId" in entry.location ? [entry.location.itemId] : [])))];

    const [activeCollections, activeItems] = await Promise.all([
      db
        .select({ id: collections.id })
        .from(collections)
        .where(and(inArray(collections.id, collectionIds), isNull(collections.deletedAt))),
      itemIds.length > 0
        ? db
            .select({ id: items.id, collectionId: items.collectionId, kind: items.kind })
            .from(items)
            .where(and(inArray(items.id, itemIds), isNull(items.deletedAt)))
        : Promise.resolve([]),
    ]);
    const activeCollectionIds = new Set(activeCollections.map((collection) => collection.id));
    const activeItemsById = new Map(activeItems.map((item) => [item.id, item]));
    const checkedEntries = new Set(current);
    let changed = false;

    for (const [key, entry] of this.entries) {
      if (!checkedEntries.has(entry)) continue;
      const location = entry.location;
      if (!activeCollectionIds.has(location.collectionId)) {
        this.entries.delete(key);
        changed = true;
        continue;
      }
      if ("itemId" in location) {
        const item = activeItemsById.get(location.itemId);
        if (!item || item.collectionId !== location.collectionId || item.kind !== location.kind) {
          this.entries.delete(key);
          changed = true;
        }
      }
    }
    if (changed) this.publishSnapshot();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    this.entries.clear();
    this.listeners.clear();
  }
}
