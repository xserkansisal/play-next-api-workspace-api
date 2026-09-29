import { afterEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";
import { connectSse, sleep, startServer, waitUntil, type RunningServer, type SseClient } from "../sse.js";

let ctx: TestContext;
let server: RunningServer;
const clients: SseClient[] = [];

async function setup(options: Parameters<typeof createTestContext>[1] = {}) {
  ctx = createTestContext(":memory:", options);
  server = await startServer(ctx.app);
}

async function connect(headers: Record<string, string> = {}, path?: string) {
  const client = await connectSse(server.url, headers, path);
  clients.push(client);
  return client;
}

async function connectReady(headers: Record<string, string> = {}, path?: string) {
  const client = await connect(headers, path);
  await client.waitFor((f) => f.some((x) => x.event === "ready"));
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  ctx.close();
  await server.close();
});

const EVENT_KEYS = ["changedAt", "collectionId", "eventId", "id", "kind", "operation"];

describe("GET /api/v1/events", () => {
  it("opens an event stream with retry advice and a ready event", async () => {
    await setup({ retryMs: 1500 });
    const client = await connectReady();
    expect(client.response.statusCode).toBe(200);
    expect(client.response.headers["content-type"]).toMatch(/^text\/event-stream/);
    expect(client.response.headers["cache-control"]).toContain("no-cache");
    expect(client.response.headers["x-accel-buffering"]).toBe("no");
    expect(client.frames[0]).toEqual({ event: "retry", retry: 1500 });
    const ready = client.frames.find((f) => f.event === "ready")!;
    expect(JSON.parse(ready.data!)).toEqual({ epoch: ctx.events.epoch });
    expect(client.changes()).toEqual([]);
  });

  it("sends heartbeat comments periodically", async () => {
    await setup({ heartbeatMs: 20 });
    const client = await connectReady();
    await client.waitFor((f) => f.filter((x) => x.comment?.startsWith("heartbeat")).length >= 2);
  });

  it("publishes value-free events for every committed collection, item, and environment write", async () => {
    await setup();
    const client = await connectReady();
    const other = await connectReady();
    const expected: Array<{ kind: string; id: string; collectionId: string | null; operation: string; changedAt?: string }> = [];

    const col = (await ctx.api.post("/api/v1/collections").send({ name: "C" }).expect(201)).body;
    expected.push({ kind: "collection", id: col.id, collectionId: null, operation: "created", changedAt: col.updatedAt });
    const colSaved = (await ctx.api.put(`/api/v1/collections/${col.id}`).send({ name: "C2" }).expect(200)).body;
    expected.push({ kind: "collection", id: col.id, collectionId: null, operation: "updated", changedAt: colSaved.updatedAt });

    const items = `/api/v1/collections/${col.id}/items`;
    const folder = (await ctx.api.post(items).send({ type: "folder", name: "F" }).expect(201)).body;
    expected.push({ kind: "folder", id: folder.id, collectionId: col.id, operation: "created", changedAt: folder.updatedAt });
    const req = (await ctx.api.post(items).send({ type: "request", name: "R", parentId: folder.id, ...requestFields }).expect(201)).body;
    expected.push({ kind: "request", id: req.id, collectionId: col.id, operation: "created", changedAt: req.updatedAt });
    const reqSaved = (await ctx.api.put(`${items}/${req.id}`).send({ type: "request", name: "R2", ...requestFields }).expect(200)).body;
    expected.push({ kind: "request", id: req.id, collectionId: col.id, operation: "updated", changedAt: reqSaved.updatedAt });
    const folderSaved = (await ctx.api.put(`${items}/${folder.id}`).send({ type: "folder", name: "F2" }).expect(200)).body;
    expected.push({ kind: "folder", id: folder.id, collectionId: col.id, operation: "updated", changedAt: folderSaved.updatedAt });

    await ctx.api.delete(`${items}/${req.id}`).expect(204);
    expected.push({ kind: "request", id: req.id, collectionId: col.id, operation: "trashed" });
    await ctx.api.post(`/api/v1/trash/${req.id}/restore`).expect(200);
    expected.push({ kind: "request", id: req.id, collectionId: col.id, operation: "restored" });
    await ctx.api.delete(`${items}/${folder.id}`).expect(204);
    expected.push({ kind: "folder", id: folder.id, collectionId: col.id, operation: "trashed" });
    await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).expect(200);
    expected.push({ kind: "folder", id: folder.id, collectionId: col.id, operation: "restored" });
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(204);
    expected.push({ kind: "collection", id: col.id, collectionId: null, operation: "trashed" });
    await ctx.api.post(`/api/v1/trash/${col.id}/restore`).expect(200);
    expected.push({ kind: "collection", id: col.id, collectionId: null, operation: "restored" });

    const env = (await ctx.api.post("/api/v1/environments").send({ name: "E" }).expect(201)).body;
    expected.push({ kind: "environment", id: env.id, collectionId: null, operation: "created", changedAt: env.updatedAt });
    const envSaved = (await ctx.api.put(`/api/v1/environments/${env.id}`).send({ name: "E2" }).expect(200)).body;
    expected.push({ kind: "environment", id: env.id, collectionId: null, operation: "updated", changedAt: envSaved.updatedAt });
    await ctx.api.delete(`/api/v1/environments/${env.id}`).expect(204);
    expected.push({ kind: "environment", id: env.id, collectionId: null, operation: "trashed" });
    await ctx.api.post(`/api/v1/trash/${env.id}/restore`).expect(200);
    expected.push({ kind: "environment", id: env.id, collectionId: null, operation: "restored" });

    for (const c of [client, other]) {
      await c.waitFor(() => c.changes().length === expected.length);
      const changes = c.changes();
      changes.forEach((change, i) => {
        expect(Object.keys(change).sort()).toEqual(EVENT_KEYS);
        expect(change).toMatchObject(expected[i]!);
        expect(Number.isNaN(Date.parse(change.changedAt as string))).toBe(false);
      });
      const ids = changes.map((ch) => ch.eventId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => id!.startsWith(`${ctx.events.epoch}:`))).toBe(true);
    }
    expect(other.changes()).toEqual(client.changes());
  });

  it("never includes names, URLs, headers, bodies, or environment variable values", async () => {
    await setup();
    const client = await connectReady();
    const secret = "SECRET_MARKER_9f2c";

    const col = (await ctx.api.post("/api/v1/collections").send({
      name: `Col ${secret}`,
      description: secret,
      items: [{ type: "request", name: `Req ${secret}`, ...requestFields, url: `https://${secret}.test` }],
    }).expect(201)).body;
    await ctx.api.post(`/api/v1/collections/${col.id}/items`).send({
      type: "request",
      name: `R ${secret}`,
      ...requestFields,
      url: `https://x.test/${secret}`,
      queryParams: [{ key: secret, value: secret, description: secret }],
      headers: [{ key: "Authorization", value: `Bearer ${secret}` }],
      body: { type: "json", content: JSON.stringify({ token: secret }) },
    }).expect(201);
    const env = (await ctx.api.post("/api/v1/environments").send({
      name: `Env ${secret}`,
      variables: [{ key: "token", value: secret }],
    }).expect(201)).body;
    await ctx.api.put(`/api/v1/environments/${env.id}`).send({ name: "Env", variables: [{ key: "token", value: `${secret}-2` }] }).expect(200);

    await client.waitFor(() => client.changes().length === 4);
    expect(client.raw()).not.toContain(secret);
    for (const change of client.changes()) expect(Object.keys(change).sort()).toEqual(EVENT_KEYS);
  });

  it("does not publish events for reads, checks, or failed writes", async () => {
    await setup();
    const col = (await ctx.api.post("/api/v1/collections").send({ name: "C", items: [{ type: "folder", name: "F" }] }).expect(201)).body;
    const folderId = col.items[0].id;
    const req = (await ctx.api.post(`/api/v1/collections/${col.id}/items`).send({ type: "request", name: "R", ...requestFields }).expect(201)).body;
    const env = (await ctx.api.post("/api/v1/environments").send({ name: "E" }).expect(201)).body;
    await ctx.api.post("/api/v1/environments").send({ name: "Taken" }).expect(201);
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${folderId}`).expect(204);
    await ctx.api.post(`/api/v1/collections/${col.id}/items`).send({ type: "folder", name: "f" }).expect(201);

    const client = await connectReady();
    const missing = "00000000-0000-4000-8000-000000000000";
    const items = `/api/v1/collections/${col.id}/items`;

    // Reads and read-only checks.
    await ctx.api.get("/api/v1/collections").expect(200);
    await ctx.api.get(`/api/v1/collections/${col.id}`).expect(200);
    await ctx.api.get(`${items}/${req.id}`).expect(200);
    await ctx.api.get("/api/v1/environments").expect(200);
    await ctx.api.get("/api/v1/trash").expect(200);
    await ctx.api.post(`/api/v1/trash/${folderId}/restore/check`).expect(200);

    // Validation, not-found, and conflict failures.
    await ctx.api.post("/api/v1/collections").send({ name: "" }).expect(400);
    await ctx.api.post("/api/v1/collections").send({ name: "c" }).expect(409);
    await ctx.api.put(`/api/v1/collections/${missing}`).send({ name: "X" }).expect(404);
    await ctx.api.delete(`/api/v1/collections/${missing}`).expect(404);
    await ctx.api.post(items).send({ type: "request", name: "R", ...requestFields, method: "TRACE" }).expect(400);
    await ctx.api.post(items).send({ type: "folder", name: "F", parentId: req.id }).expect(400);
    await ctx.api.put(`${items}/${req.id}`).send({ type: "folder", name: "X" }).expect(400);
    await ctx.api.delete(`${items}/${missing}`).expect(404);
    await ctx.api.post("/api/v1/environments").send({ name: "taken" }).expect(409);
    await ctx.api.put(`/api/v1/environments/${env.id}`).send({ name: "E", variables: [{ key: "a", value: "1" }, { key: "a", value: "2" }] }).expect(400);
    await ctx.api.delete(`/api/v1/environments/${missing}`).expect(404);
    await ctx.api.post(`/api/v1/trash/${folderId}/restore`).expect(409);
    await ctx.api.post(`/api/v1/trash/${missing}/restore`).expect(404);

    // Database failures inside the transaction roll back and publish nothing.
    ctx.db.$client.exec("CREATE TRIGGER fail_headers BEFORE INSERT ON request_headers BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await ctx.api.put(`${items}/${req.id}`).send({ type: "request", name: "R2", ...requestFields, headers: [{ key: "a", value: "b" }] }).expect(500);
    ctx.db.$client.exec("CREATE TRIGGER fail_env BEFORE UPDATE ON environments BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await ctx.api.delete(`/api/v1/environments/${env.id}`).expect(500);
    ctx.db.$client.exec("CREATE TRIGGER fail_col BEFORE UPDATE ON collections BEGIN SELECT RAISE(ABORT, 'injected'); END;");
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(500);
    ctx.db.$client.exec("DROP TRIGGER fail_col");

    // A later successful write must be the first event received.
    await ctx.api.put(`/api/v1/collections/${col.id}`).send({ name: "Renamed" }).expect(200);
    await client.waitFor(() => client.changes().length >= 1);
    await sleep(20);
    expect(client.changes()).toHaveLength(1);
    expect(client.changes()[0]).toMatchObject({ kind: "collection", id: col.id, operation: "updated" });
  });
});

describe("SSE lifecycle", () => {
  it("unsubscribes and stops heartbeats when a client disconnects", async () => {
    await setup({ heartbeatMs: 10 });
    const a = await connectReady();
    const b = await connectReady();
    expect(ctx.events.listenerCount).toBe(2);

    a.close();
    await waitUntil(() => ctx.events.listenerCount === 1);
    b.close();
    await waitUntil(() => ctx.events.listenerCount === 0);

    // Publishing with no listeners is harmless.
    await ctx.api.post("/api/v1/collections").send({ name: "After" }).expect(201);
  });

  it("ends every open stream when the hub closes and refuses new streams afterwards", async () => {
    await setup({ retryMs: 2000 });
    const a = await connectReady();
    const b = await connectReady();
    ctx.events.close();
    await Promise.all([a.ended, b.ended]);
    expect(ctx.events.listenerCount).toBe(0);

    const late = await connect();
    await late.ended;
    expect(late.response.statusCode).toBe(503);
    expect(late.response.headers["retry-after"]).toBe("2");
  });
});

describe("SSE reconnect", () => {
  async function publishCollections(names: string[]) {
    for (const name of names) await ctx.api.post("/api/v1/collections").send({ name }).expect(201);
  }

  it("replays missed events after Last-Event-ID before going live", async () => {
    await setup();
    const first = await connectReady();
    await publishCollections(["A", "B", "C"]);
    await first.waitFor(() => first.changes().length === 3);
    const [a, b, c] = first.changes();
    first.close();

    const resumed = await connectReady({ "Last-Event-ID": a!.eventId! });
    expect(resumed.changes().map((ch) => ch.eventId)).toEqual([b!.eventId, c!.eventId]);
    const order = resumed.frames.map((f) => f.event);
    expect(order.indexOf("ready")).toBeGreaterThan(order.lastIndexOf("change"));
    expect(resumed.frames.some((f) => f.event === "resync")).toBe(false);

    await publishCollections(["D"]);
    await resumed.waitFor(() => resumed.changes().length === 3);

    // Resuming from the latest event replays nothing.
    const upToDate = await connectReady({ "Last-Event-ID": resumed.changes()[2]!.eventId! });
    expect(upToDate.changes()).toEqual([]);
    expect(upToDate.frames.some((f) => f.event === "resync")).toBe(false);

    // The lastEventId query parameter is accepted for clients that cannot set headers.
    const viaQuery = await connectReady({}, `/api/v1/events?lastEventId=${encodeURIComponent(c!.eventId!)}`);
    expect(viaQuery.changes()).toHaveLength(1);
  });

  it("asks the client to resync when history is unavailable", async () => {
    await setup({ replayBufferSize: 2 });
    const first = await connectReady();
    await publishCollections(["A", "B", "C", "D"]);
    await first.waitFor(() => first.changes().length === 4);
    const oldest = first.changes()[0]!.eventId!;

    for (const lastEventId of [oldest, "other-process:5", `${ctx.events.epoch}:999`, "garbage"]) {
      const client = await connectReady({ "Last-Event-ID": lastEventId });
      const resync = client.frames.find((f) => f.event === "resync");
      expect(resync && JSON.parse(resync.data!)).toEqual({ reason: "history_unavailable" });
      expect(client.changes()).toEqual([]);
    }

    // A cursor still inside the buffer replays normally.
    const recent = await connectReady({ "Last-Event-ID": first.changes()[2]!.eventId! });
    expect(recent.changes()).toHaveLength(1);
  });
});
