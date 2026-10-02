import { describe, expect, it, vi } from "vitest";
import { ChangeEventHub, type ChangeEvent } from "../../src/events/hub.js";

const event = (id: string): ChangeEvent => ({
  kind: "request",
  id,
  collectionId: "c",
  operation: "updated",
  changedAt: "2026-01-01T00:00:00.000Z",
});

const alice = { userId: "alice", teamId: "team-a" };
const bob = { userId: "bob", teamId: "team-a" };
const carol = { userId: "carol", teamId: "team-b" };

describe("ChangeEventHub", () => {
  it("assigns increasing epoch-scoped IDs and strips unknown fields", () => {
    const hub = new ChangeEventHub();
    const listener = vi.fn();
    hub.subscribe(listener, alice);
    const first = hub.publish("team-a", { ...event("a"), url: "https://secret", value: "x" } as ChangeEvent);
    const second = hub.publish("team-a", event("b"));
    expect(first).toEqual({ ...event("a"), eventId: `${hub.epoch}:1` });
    expect(second.eventId).toBe(`${hub.epoch}:2`);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("isolates failing listeners", () => {
    const hub = new ChangeEventHub();
    const good = vi.fn();
    hub.subscribe(() => {
      throw new Error("boom");
    }, alice);
    hub.subscribe(good, alice);
    expect(() => hub.publish("team-a", event("a"))).not.toThrow();
    expect(hub.listenerCount).toBe(1);
    hub.publish("team-a", event("b"));
    expect(good).toHaveBeenCalledTimes(2);
  });

  it("delivers user-targeted events only to that user's listeners and replays them privately", () => {
    const hub = new ChangeEventHub();
    const aliceListener = vi.fn();
    const bobListener = vi.fn();
    const carolListener = vi.fn();
    hub.subscribe(aliceListener, alice);
    hub.subscribe(bobListener, bob);
    hub.subscribe(carolListener, carol);

    const privateEvent = hub.publishToUser("alice", event("private"));
    const sharedEvent = hub.publish("team-a", event("shared"));

    expect(aliceListener.mock.calls.map(([value]) => value.id)).toEqual(["private", "shared"]);
    expect(bobListener.mock.calls.map(([value]) => value.id)).toEqual(["shared"]);
    expect(carolListener.mock.calls.map(([value]) => value.id)).toEqual([]);
    expect(hub.replaySince(`${hub.epoch}:0`, bob).events).toEqual([sharedEvent]);
    expect(hub.replaySince(`${hub.epoch}:0`, alice).events).toEqual([privateEvent, sharedEvent]);
    expect(hub.replaySince(`${hub.epoch}:0`, carol).events).toEqual([]);
  });

  it("delivers a personal event to its user whichever team they are watching", () => {
    const hub = new ChangeEventHub();
    const inTeamB = vi.fn();
    hub.subscribe(inTeamB, { userId: "alice", teamId: "team-b" });
    hub.publishToUser("alice", event("private"));
    expect(inTeamB).toHaveBeenCalledOnce();
  });

  it("ends the streams of a removed member, or of a whole archived team", () => {
    const hub = new ChangeEventHub();
    const aliceRevoked = vi.fn();
    const bobRevoked = vi.fn();
    const carolRevoked = vi.fn();
    const aliceListener = vi.fn();
    hub.subscribe(aliceListener, alice, aliceRevoked);
    hub.subscribe(vi.fn(), bob, bobRevoked);
    hub.subscribe(vi.fn(), carol, carolRevoked);

    hub.revoke("team-a", "alice");
    expect(aliceRevoked).toHaveBeenCalledOnce();
    expect(bobRevoked).not.toHaveBeenCalled();
    hub.publish("team-a", event("after"));
    expect(aliceListener).not.toHaveBeenCalled();

    hub.revoke("team-a");
    expect(bobRevoked).toHaveBeenCalledOnce();
    expect(carolRevoked).not.toHaveBeenCalled();
    expect(hub.listenerCount).toBe(1);
  });

  it("replays within the buffer and reports gaps", () => {
    const hub = new ChangeEventHub({ replayBufferSize: 2 });
    const ids = ["a", "b", "c"].map((id) => hub.publish("team-a", event(id)).eventId);
    expect(hub.replaySince(ids[1]!, alice)).toEqual({ complete: true, events: [expect.objectContaining({ id: "c" })] });
    expect(hub.replaySince(ids[2]!, alice)).toEqual({ complete: true, events: [] });
    // Event "b" (seq 2) is the oldest buffered; resuming after seq 1 is still complete.
    expect(hub.replaySince(ids[0]!, alice).complete).toBe(true);
    expect(hub.replaySince(`${hub.epoch}:0`, alice).complete).toBe(false);
    expect(hub.replaySince("other:1", alice).complete).toBe(false);
    expect(hub.replaySince(`${hub.epoch}:-1`, alice).complete).toBe(false);
    expect(hub.replaySince(`${hub.epoch}:4`, alice).complete).toBe(false);
    expect(new ChangeEventHub({ replayBufferSize: 0 }).replaySince("x:0", alice).complete).toBe(false);
  });

  it("runs close handlers once and rejects subscriptions after close", () => {
    const hub = new ChangeEventHub();
    const onClose = vi.fn();
    hub.subscribe(vi.fn(), alice);
    const off = hub.onClose(vi.fn());
    off();
    hub.onClose(onClose);
    hub.close();
    hub.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(hub.listenerCount).toBe(0);
    hub.subscribe(vi.fn(), alice);
    expect(hub.listenerCount).toBe(0);
  });
});
