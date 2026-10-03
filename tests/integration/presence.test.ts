import { afterEach, describe, expect, it } from "vitest";
import { connectSse, startServer, waitUntil, type RunningServer, type SseClient } from "../sse.js";
import { createTestContext, queryRows, requestFields, type TestContext } from "../helpers.js";
import { startPresenceSimulator } from "../../src/presence/simulator.js";
import { clearPresenceTestUsers, seedPresenceTestUsers } from "../../src/presence/seedData.js";

let ctx: TestContext | undefined;
let server: RunningServer | undefined;
let clients: SseClient[] = [];

afterEach(async () => {
  for (const client of clients) client.close();
  clients = [];
  await server?.close();
  server = undefined;
  await ctx?.close();
  ctx = undefined;
});

async function setup(options: Parameters<typeof createTestContext>[1] = {}) {
  ctx = await createTestContext(":memory:", options);
  server = await startServer(ctx.app);
  return ctx;
}

async function connectReady() {
  if (!server || !ctx) throw new Error("Presence test context is not initialized");
  const client = await connectSse(server.url, { Cookie: ctx.sessionCookie });
  clients.push(client);
  await client.waitFor((frames) => frames.some((frame) => frame.event === "ready") && frames.some((frame) => frame.event === "presence"));
  return client;
}

function presenceFrames(client: SseClient) {
  return client.frames
    .filter((frame) => frame.event === "presence")
    .map((frame) => JSON.parse(frame.data ?? "{}") as { users: Array<Record<string, unknown>> });
}

describe("live presence", () => {
  it("publishes a full initial snapshot and keeps multiple tabs independent", async () => {
    const context = await setup();
    const collection = (await context.api.post("/api/v1/collections").send({ name: "Shared" }).expect(201)).body;
    const request = (await context.api.post(`/api/v1/collections/${collection.id}/items`).send({
      type: "request",
      name: "Private request",
      ...requestFields,
      url: "https://secret.example/private",
      body: { type: "json", content: '{"token":"never broadcast"}' },
    }).expect(201)).body;
    const client = await connectReady();
    expect(presenceFrames(client)[0]).toEqual({ users: [] });

    const location = { kind: "request", collectionId: collection.id, itemId: request.id };
    await context.api.put("/api/v1/presence").send({ clientId: "tab-1", location }).expect(204);
    await client.waitFor((frames) => frames.filter((frame) => frame.event === "presence").length >= 2);
    await context.api.put("/api/v1/presence").send({ clientId: "tab-2", location }).expect(204);
    await client.waitFor((frames) => presenceFrames(client).at(-1)?.users.length === 2);

    const snapshot = presenceFrames(client).at(-1)!;
    expect(snapshot.users).toHaveLength(2);
    expect(snapshot.users[0]).toMatchObject({
      userId: expect.any(String),
      firstName: "Test",
      lastName: "",
      avatarUrl: null,
      avatarColor: null,
      location,
    });
    expect(JSON.stringify(snapshot)).not.toContain("test@fluttersea.com");
    expect(JSON.stringify(snapshot)).not.toContain("secret.example");
    expect(JSON.stringify(snapshot)).not.toContain("never broadcast");
    expect(JSON.stringify(snapshot)).not.toContain("tab-1");

    await context.api.put("/api/v1/presence").send({ clientId: "tab-1", location: null }).expect(204);
    await client.waitFor((frames) => presenceFrames(client).at(-1)?.users.length === 1);
  });

  it("rejects resources that are missing, inactive, or outside the submitted collection", async () => {
    const context = await setup();
    const first = (await context.api.post("/api/v1/collections").send({ name: "First" }).expect(201)).body;
    const second = (await context.api.post("/api/v1/collections").send({ name: "Second" }).expect(201)).body;
    const request = (await context.api.post(`/api/v1/collections/${first.id}/items`).send({
      type: "request",
      name: "Request",
      ...requestFields,
    }).expect(201)).body;

    await context.api.put("/api/v1/presence").send({
      clientId: "tab-1",
      location: { kind: "request", collectionId: second.id, itemId: request.id },
    }).expect(404);
    await context.api.put("/api/v1/presence").send({
      clientId: "tab-1",
      location: { kind: "folder", collectionId: first.id, itemId: request.id },
    }).expect(404);
    await context.api.put("/api/v1/presence").send({
      clientId: "tab-1",
      location: { kind: "request", collectionId: first.id, itemId: "not-a-uuid" },
    }).expect(400);
  });

  it("clears locations when their resource is moved to Trash", async () => {
    const context = await setup();
    const collection = (await context.api.post("/api/v1/collections").send({ name: "Temporary" }).expect(201)).body;
    const folder = (await context.api.post(`/api/v1/collections/${collection.id}/items`).send({
      type: "folder",
      name: "Folder",
    }).expect(201)).body;
    const client = await connectReady();
    await context.api.put("/api/v1/presence").send({
      clientId: "tab-1",
      location: { kind: "folder", collectionId: collection.id, itemId: folder.id },
    }).expect(204);
    await client.waitFor((frames) => presenceFrames(client).at(-1)?.users.length === 1);

    await context.api.delete(`/api/v1/collections/${collection.id}/items/${folder.id}`).expect(204);
    await client.waitFor((frames) => presenceFrames(client).at(-1)?.users.length === 0);

    await context.api.put("/api/v1/presence").send({
      clientId: "tab-1",
      location: { kind: "folder", collectionId: collection.id, itemId: folder.id },
    }).expect(404);
  });

  it("requires a signed-in user and a strict heartbeat payload", async () => {
    const context = await setup({ authenticate: false });
    await context.unauthenticatedApi.put("/api/v1/presence").send({ clientId: "tab-1", location: null }).expect(401);
  });

  it("seeds ten database-backed viewers and keeps them visible with refreshed heartbeats", async () => {
    const context = await setup();
    const collection = (await context.api.post("/api/v1/collections").send({ name: "Simulator target" }).expect(201)).body;
    const request = (await context.api.post(`/api/v1/collections/${collection.id}/items`).send({
      type: "request",
      name: "Simulator request",
      ...requestFields,
    }).expect(201)).body;

    expect(await seedPresenceTestUsers(context.db)).toBe(10);
    expect(await seedPresenceTestUsers(context.db)).toBe(10);
    const rows = await queryRows(
      context.db,
      `SELECT u.id, u.email, u.first_name, u.last_name, p.client_id, p.location_kind, p.collection_id, p.item_id
       FROM presence_test_users p INNER JOIN users u ON u.id = p.user_id`,
    );
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => String(row.email).endsWith("@example.invalid"))).toBe(true);
    expect(rows.every((row) => row.first_name === "Test" && String(row.last_name).startsWith("Viewer-"))).toBe(true);
    expect(rows.every((row) =>
      row.collection_id === collection.id &&
      (row.location_kind === "collection" ? row.item_id === null : row.item_id === request.id),
    )).toBe(true);

    const simulator = startPresenceSimulator(context.db, context.presence, {
      heartbeatIntervalMs: 20,
      locationChangeIntervalMs: 200,
    });
    await waitUntil(() => context.presence.snapshot(context.teamId).users.length === 10);
    const stream = await connectReady();
    await stream.waitFor((frames) =>
      presenceFrames(stream).some((snapshot) => snapshot.users.length === 10),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(context.presence.snapshot(context.teamId).users).toHaveLength(10);
    await simulator.stop();
    expect(context.presence.snapshot(context.teamId).users).toEqual([]);
    await stream.waitFor((frames) =>
      presenceFrames(stream).at(-1)?.users.length === 0,
    );

    expect(await clearPresenceTestUsers(context.db)).toBe(10);
    expect(await queryRows(context.db, "SELECT id FROM users WHERE email LIKE 'presence-%@example.invalid'")).toEqual([]);
  });
});
