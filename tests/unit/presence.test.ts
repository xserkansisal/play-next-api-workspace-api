import { describe, expect, it } from "vitest";
import { PresenceHub } from "../../src/events/presence.js";

describe("PresenceHub", () => {
  it("keeps tabs independent and clears only the requested tab", () => {
    const presence = new PresenceHub({ ttlMs: 45_000 });
    const identity = { userId: "user-1", firstName: "Ada", lastName: "Lovelace" };
    const location = { kind: "collection" as const, collectionId: "collection-1" };
    const snapshots: Array<{ users: unknown[] }> = [];
    presence.subscribe((snapshot) => snapshots.push(snapshot));

    presence.heartbeat(identity, "tab-1", location, 1_000);
    presence.heartbeat(identity, "tab-2", location, 2_000);
    expect(presence.snapshot(2_000).users).toHaveLength(2);
    expect(snapshots).toHaveLength(2);

    presence.heartbeat(identity, "tab-1", null, 3_000);
    expect(presence.snapshot(3_000).users).toHaveLength(1);
    expect(snapshots.at(-1)?.users).toMatchObject([{ userId: "user-1", location }]);
    presence.close();
  });

  it("expires stale tabs and never allows a TTL longer than 45 seconds", () => {
    const presence = new PresenceHub({ ttlMs: 60_000 });
    presence.heartbeat(
      { userId: "user-1", firstName: "Ada", lastName: "" },
      "tab-1",
      { kind: "request", collectionId: "collection-1", itemId: "request-1" },
      1_000,
    );

    expect(presence.ttlMs).toBe(45_000);
    expect(presence.snapshot(45_999).users).toHaveLength(1);
    expect(presence.snapshot(46_000).users).toEqual([]);
    presence.close();
  });

  it("broadcasts an empty snapshot after the TTL when SSE clients disconnect", async () => {
    const presence = new PresenceHub({ ttlMs: 30, sweepIntervalMs: 5 });
    const snapshots: Array<{ users: unknown[] }> = [];
    presence.subscribe((snapshot) => snapshots.push(snapshot));
    presence.heartbeat(
      { userId: "user-1", firstName: "Ada", lastName: "" },
      "tab-1",
      { kind: "collection", collectionId: "collection-1" },
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Presence did not expire")), 500);
      const interval = setInterval(() => {
        if (snapshots.at(-1)?.users.length === 0) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });
    expect(snapshots.at(-1)).toEqual({ users: [] });
    presence.close();
  });

  it("broadcasts only the public profile and resource identifiers", () => {
    const presence = new PresenceHub();
    const snapshots: unknown[] = [];
    presence.subscribe((snapshot) => snapshots.push(snapshot));
    presence.heartbeat(
      { userId: "user-1", firstName: "Ada", lastName: "Lovelace" },
      "private-tab-id",
      { kind: "request", collectionId: "collection-1", itemId: "request-1" },
    );

    expect(snapshots[0]).toEqual({
      users: [{
        userId: "user-1",
        firstName: "Ada",
        lastName: "Lovelace",
        avatarUrl: null,
        avatarColor: null,
        location: { kind: "request", collectionId: "collection-1", itemId: "request-1" },
      }],
    });
    expect(JSON.stringify(snapshots[0])).not.toContain("private-tab-id");
    presence.close();
  });
});
