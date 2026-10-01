import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SequencedChangeEvent } from "../../src/events/hub.js";
import { createTestContext, queryRows, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
let published: SequencedChangeEvent[];

async function setup(options: Parameters<typeof createTestContext>[1] = {}) {
  ctx = await createTestContext(":memory:", options);
  published = [];
  ctx.events.subscribe((event) => published.push(event));
}

afterEach(async () => ctx.close());

const names = (list: { name: string }[]) => list.map((entry) => entry.name);

async function createCollection(body: Record<string, unknown> = { name: "Target" }) {
  return (await ctx.api.post("/api/v1/collections").send(body).expect(201)).body;
}

async function readTree(collectionId: string) {
  return (await ctx.api.get(`/api/v1/collections/${collectionId}`).expect(200)).body;
}

function importInto(collectionId: string, body: Record<string, unknown>) {
  return ctx.api.post(`/api/v1/collections/${collectionId}/import`).send(body);
}

async function countItems(collectionId: string): Promise<number> {
  const [row] = await queryRows(ctx.db, "SELECT COUNT(*) AS n FROM items WHERE collection_id = ?", [collectionId]);
  return Number(row!.n);
}

const sampleTree = [
  {
    type: "folder",
    name: "Auth",
    description: "Sign-in",
    auth: { type: "basic", username: "{{username}}", password: "{{password}}" },
    items: [
      { type: "folder", name: "Tokens", items: [{ type: "request", name: "Refresh", ...requestFields, method: "POST" }] },
      {
        type: "request",
        name: "Login",
        ...requestFields,
        method: "POST",
        url: "{{baseUrl}}/login",
        auth: { type: "bearer", token: "{{loginToken}}" },
        preRequestScript: `pm.request.headers.push({ key: "X-Trace", value: "generated" });`,
        postResponseScript: `pm.test("login", () => pm.expect(pm.response.code).to.eql(200));`,
        queryParams: [
          { key: "b", value: "2" },
          { key: "a", value: "1", enabled: false },
        ],
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "X-Trace", value: "1", description: "debug" },
        ],
        body: { type: "json", content: '{"user":"{{user}}"}' },
      },
    ],
  },
  { type: "request", name: "Health", ...requestFields },
];

describe("POST /api/v1/collections/:collectionId/import", () => {
  beforeEach(async () => setup());

  it("imports a nested tree at the collection root, keeping request details and row order", async () => {
    const collection = await createCollection({ name: "Target", items: [{ type: "request", name: "Existing", ...requestFields }] });

    const res = await importInto(collection.id, { items: sampleTree }).expect(201);
    expect(res.body).toMatchObject({
      collectionId: collection.id,
      parentId: null,
      dryRun: false,
      created: { folders: 2, requests: 3 },
      renamed: [],
      warnings: [],
    });
    expect(res.body.roots).toHaveLength(2);

    const tree = await readTree(collection.id);
    expect(names(tree.items)).toEqual(["Auth", "Existing", "Health"]);
    const auth = tree.items[0];
    expect(auth).toMatchObject({ type: "folder", description: "Sign-in", parentId: null, createdBy: "test@sisal.com" });
    expect(names(auth.items)).toEqual(["Login", "Tokens"]);
    expect(auth.items[0]).toMatchObject({
      method: "POST",
      url: "{{baseUrl}}/login",
      auth: { type: "bearer", token: "{{loginToken}}" },
      effectiveAuth: { type: "bearer", token: "{{loginToken}}" },
      body: { type: "json", content: '{"user":"{{user}}"}' },
      preRequestScript: `pm.request.headers.push({ key: "X-Trace", value: "generated" });`,
      postResponseScript: `pm.test("login", () => pm.expect(pm.response.code).to.eql(200));`,
      queryParams: [
        { key: "b", value: "2", description: "", enabled: true },
        { key: "a", value: "1", description: "", enabled: false },
      ],
      headers: [
        { key: "Content-Type", value: "application/json", description: "", enabled: true },
        { key: "X-Trace", value: "1", description: "debug", enabled: true },
      ],
    });
    expect(auth.items[1].items[0]).toMatchObject({
      name: "Refresh",
      parentId: auth.items[1].id,
      auth: { type: "inherit" },
      effectiveAuth: { type: "basic", username: "{{username}}", password: "{{password}}" },
    });
  });

  it("imports beneath a nested folder", async () => {
    const collection = await createCollection({
      name: "Target",
      items: [{ type: "folder", name: "API", items: [{ type: "folder", name: "V1", items: [] }] }],
    });
    const v1 = collection.items[0].items[0];

    await importInto(collection.id, { parentId: v1.id, items: sampleTree }).expect(201);

    const tree = await readTree(collection.id);
    expect(names(tree.items[0].items[0].items)).toEqual(["Auth", "Health"]);
    expect(tree.items[0].items[0].items[0].parentId).toBe(v1.id);
  });

  it("renames colliding root folders like a copy, leaves requests and nested folders alone", async () => {
    const collection = await createCollection({
      name: "Target",
      items: [
        { type: "folder", name: "Auth", items: [] },
        { type: "folder", name: "auth (copy)", items: [] },
        { type: "request", name: "Health", ...requestFields },
      ],
    });

    const res = await importInto(collection.id, {
      items: [...sampleTree, { type: "folder", name: "AUTH", items: [] }],
    }).expect(201);
    expect(res.body.renamed).toEqual([
      { path: ["Auth"], from: "Auth", to: "Auth (copy 2)" },
      { path: ["AUTH"], from: "AUTH", to: "AUTH (copy 3)" },
    ]);

    const tree = await readTree(collection.id);
    expect(names(tree.items)).toEqual(["Auth", "Auth (copy 2)", "AUTH (copy 3)", "auth (copy)", "Health", "Health"]);
    expect(names(tree.items[1].items)).toEqual(["Login", "Tokens"]);
  });

  it("fails without writing anything when asked to on a conflict", async () => {
    const collection = await createCollection({ name: "Target", items: [{ type: "folder", name: "Auth", items: [] }] });
    const existingId = collection.items[0].id;

    const res = await importInto(collection.id, { items: sampleTree, onConflict: "fail" }).expect(409);
    expect(res.body.error).toMatchObject({
      code: "FOLDER_NAME_CONFLICT",
      details: { parentId: null, conflicts: [{ name: "Auth", conflictingId: existingId }] },
    });
    expect(await countItems(collection.id)).toBe(1);
    expect(published.filter((e) => e.operation === "created" && e.kind !== "collection")).toEqual([]);
  });

  it("rejects duplicate folder names below the roots of the payload", async () => {
    const collection = await createCollection();
    const res = await importInto(collection.id, {
      items: [{ type: "folder", name: "A", items: [{ type: "folder", name: "X", items: [] }, { type: "folder", name: "x", items: [] }] }],
    }).expect(400);
    expect(res.body.error).toMatchObject({ code: "DUPLICATE_FOLDER_NAME", details: { path: ["A", "x"] } });
    expect(await countItems(collection.id)).toBe(0);
  });

  it("rejects a parent that is not an active folder of this collection", async () => {
    const collection = await createCollection({
      name: "Target",
      items: [
        { type: "folder", name: "Gone", items: [] },
        { type: "request", name: "Req", ...requestFields },
      ],
    });
    const other = await createCollection({ name: "Other", items: [{ type: "folder", name: "Elsewhere", items: [] }] });
    const [gone, req] = collection.items;
    await ctx.api.delete(`/api/v1/collections/${collection.id}/items/${gone.id}`).expect(204);

    for (const parentId of [gone.id, req.id, other.items[0].id, "00000000-0000-4000-8000-000000000000"]) {
      const res = await importInto(collection.id, { parentId, items: sampleTree }).expect(400);
      expect(res.body.error.code).toBe("INVALID_PARENT");
    }
    expect(await countItems(collection.id)).toBe(2);
  });

  it("answers 404 for a trashed or unknown collection", async () => {
    const collection = await createCollection();
    await ctx.api.delete(`/api/v1/collections/${collection.id}`).expect(204);
    await importInto(collection.id, { items: sampleTree }).expect(404);
    await importInto("00000000-0000-4000-8000-000000000000", { items: sampleTree }).expect(404);
  });

  it("previews with dryRun without writing or publishing", async () => {
    const collection = await createCollection({ name: "Target", items: [{ type: "folder", name: "Auth", items: [] }] });
    published = [];

    const res = await importInto(collection.id, { items: sampleTree, dryRun: true }).expect(200);
    expect(res.body).toMatchObject({
      dryRun: true,
      created: { folders: 2, requests: 3 },
      renamed: [{ path: ["Auth"], from: "Auth", to: "Auth (copy)" }],
      roots: [],
    });
    expect(await countItems(collection.id)).toBe(1);
    expect(published).toEqual([]);
  });

  it("validates the body", async () => {
    const collection = await createCollection();
    expect((await importInto(collection.id, { items: [] }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    expect((await importInto(collection.id, { items: [{ type: "request", name: "X", method: "HEAD", url: "/" }] }).expect(400)).body.error.code).toBe(
      "VALIDATION_ERROR",
    );
    expect((await importInto(collection.id, { items: sampleTree, onConflict: "merge" }).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
  });

  it("enforces node count, depth including the target, and body size", async () => {
    const collection = await createCollection();

    const many = Array.from({ length: 2001 }, (_, i) => ({ type: "request", name: `R${i}`, ...requestFields }));
    expect((await importInto(collection.id, { items: many }).expect(413)).body.error.code).toBe("IMPORT_TOO_LARGE");

    const chain = (levels: number) => {
      let node: Record<string, unknown> = { type: "request", name: "Leaf", ...requestFields };
      for (let i = 0; i < levels - 1; i += 1) node = { type: "folder", name: `L${i}`, items: [node] };
      return node;
    };
    // Built as text: a body this deep overflows the test client's own serializer.
    const deep = '{"items":[' + '{"type":"folder","name":"L","items":['.repeat(5000) + "]}".repeat(5000) + "]}";
    const deepRes = await ctx.api
      .post(`/api/v1/collections/${collection.id}/import`)
      .set("Content-Type", "application/json")
      .send(deep)
      .expect(400);
    expect(deepRes.body.error.code).toBe("IMPORT_TOO_DEEP");

    const parent = (await ctx.api.post(`/api/v1/collections/${collection.id}/items`).send({ type: "folder", name: "P" }).expect(201)).body;
    expect((await importInto(collection.id, { parentId: parent.id, items: [chain(32)] }).expect(400)).body.error.code).toBe("IMPORT_TOO_DEEP");
    await importInto(collection.id, { parentId: parent.id, items: [chain(31)] }).expect(201);

    const huge = { items: [{ type: "request", name: "Big", ...requestFields, body: { type: "json", content: "x".repeat(11 * 1024 * 1024) } }] };
    expect((await importInto(collection.id, huge).expect(413)).body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("warns about credential headers and auth settings without echoing their values", async () => {
    const collection = await createCollection();
    const res = await importInto(collection.id, {
      items: [
        {
          type: "folder",
          name: "F",
          items: [
            {
              type: "request",
              name: "Secret",
              ...requestFields,
              auth: { type: "bearer", token: "live-token-value" },
              headers: [
                { key: "Authorization", value: "Bearer abc.def" },
                { key: "x-api-key", value: "{{apiKey}}" },
                { key: "Cookie", value: "" },
              ],
            },
          ],
        },
        { type: "request", name: "Placeholder", ...requestFields, headers: [{ key: "Authorization", value: "Bearer {{token}}" }] },
      ],
    }).expect(201);
    expect(res.body.warnings).toEqual([
      { path: ["F", "Secret"], code: "SENSITIVE_HEADER", header: "Authorization" },
      { path: ["F", "Secret"], code: "SENSITIVE_AUTH", authType: "bearer" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("live-token-value");
  });

  it("publishes one created event per root", async () => {
    const collection = await createCollection();
    published = [];
    const res = await importInto(collection.id, { items: sampleTree }).expect(201);

    expect(published.map(({ eventId: _id, ...rest }) => rest)).toEqual(
      res.body.roots.map((root: { id: string; kind: string }) => ({
        kind: root.kind,
        id: root.id,
        collectionId: collection.id,
        operation: "created",
        changedAt: res.body.changedAt,
      })),
    );
  });

  it("publishes a single collection update when there are many roots", async () => {
    const collection = await createCollection();
    published = [];
    const items = Array.from({ length: 51 }, (_, i) => ({ type: "request", name: `R${i}`, ...requestFields }));
    const res = await importInto(collection.id, { items }).expect(201);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: "collection", id: collection.id, collectionId: null, operation: "updated", changedAt: res.body.changedAt });
  });

  it("requires authentication", async () => {
    const collection = await createCollection();
    await ctx.unauthenticatedApi.post(`/api/v1/collections/${collection.id}/import`).send({ items: sampleTree }).expect(401);
  });
});

describe("import rate limit", () => {
  it("limits imports per user", async () => {
    await setup({ collections: { importRateLimit: { limit: 2, windowMs: 60_000 } } });
    const collection = await createCollection();
    await importInto(collection.id, { items: sampleTree, dryRun: true }).expect(200);
    await importInto(collection.id, { items: sampleTree, dryRun: true }).expect(200);
    const res = await importInto(collection.id, { items: sampleTree, dryRun: true }).expect(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
