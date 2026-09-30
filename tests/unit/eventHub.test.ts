import { describe, expect, it, vi } from "vitest";
import { ChangeEventHub, type ChangeEvent } from "../../src/events/hub.js";

const event = (id: string): ChangeEvent => ({
  kind: "request",
  id,
  collectionId: "c",
  operation: "updated",
  changedAt: "2026-01-01T00:00:00.000Z",
});

describe("ChangeEventHub", () => {
  it("assigns increasing epoch-scoped IDs and strips unknown fields", () => {
    const hub = new ChangeEventHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const first = hub.publish({ ...event("a"), url: "https://secret", value: "x" } as ChangeEvent);
    const second = hub.publish(event("b"));
    expect(first).toEqual({ ...event("a"), eventId: `${hub.epoch}:1` });
    expect(second.eventId).toBe(`${hub.epoch}:2`);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("isolates failing listeners", () => {
    const hub = new ChangeEventHub();
    const good = vi.fn();
    hub.subscribe(() => {
      throw new Error("boom");
    });
    hub.subscribe(good);
    expect(() => hub.publish(event("a"))).not.toThrow();
    expect(hub.listenerCount).toBe(1);
    hub.publish(event("b"));
    expect(good).toHaveBeenCalledTimes(2);
  });

  it("replays within the buffer and reports gaps", () => {
    const hub = new ChangeEventHub({ replayBufferSize: 2 });
    const ids = ["a", "b", "c"].map((id) => hub.publish(event(id)).eventId);
    expect(hub.replaySince(ids[1]!)).toEqual({ complete: true, events: [expect.objectContaining({ id: "c" })] });
    expect(hub.replaySince(ids[2]!)).toEqual({ complete: true, events: [] });
    // Event "b" (seq 2) is the oldest buffered; resuming after seq 1 is still complete.
    expect(hub.replaySince(ids[0]!).complete).toBe(true);
    expect(hub.replaySince(`${hub.epoch}:0`).complete).toBe(false);
    expect(hub.replaySince("other:1").complete).toBe(false);
    expect(hub.replaySince(`${hub.epoch}:-1`).complete).toBe(false);
    expect(hub.replaySince(`${hub.epoch}:4`).complete).toBe(false);
    expect(new ChangeEventHub({ replayBufferSize: 0 }).replaySince("x:0").complete).toBe(false);
  });

  it("runs close handlers once and rejects subscriptions after close", () => {
    const hub = new ChangeEventHub();
    const onClose = vi.fn();
    hub.subscribe(vi.fn());
    const off = hub.onClose(vi.fn());
    off();
    hub.onClose(onClose);
    hub.close();
    hub.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(hub.listenerCount).toBe(0);
    hub.subscribe(vi.fn());
    expect(hub.listenerCount).toBe(0);
  });
});
