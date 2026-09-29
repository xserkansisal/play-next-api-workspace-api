import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => ctx.close());

async function createCollection(body: Record<string, unknown>) {
  return (await ctx.api.post("/api/v1/collections").send(body).expect(201)).body;
}

async function createItem(collectionId: string, body: Record<string, unknown>) {
  return (await ctx.api.post(`/api/v1/collections/${collectionId}/items`).send(body).expect(201)).body;
}

function tableSnapshot() {
  const client = ctx.db.$client;
  return {
    collections: client.prepare("SELECT * FROM collections ORDER BY id").all(),
    items: client.prepare("SELECT * FROM items ORDER BY id").all(),
    environments: client.prepare("SELECT * FROM environments ORDER BY id").all(),
  };
}

describe("Trash API", () => {
  it("lists only restorable deleted roots with kind and deletion time", async () => {
    const col = await createCollection({ name: "C" });
    const folder = await createItem(col.id, { type: "folder", name: "F" });
    const inner = await createItem(col.id, { type: "request", name: "Inner", parentId: folder.id, ...requestFields });
    const loose = await createItem(col.id, { type: "request", name: "Loose", ...requestFields });
    const env = (await ctx.api.post("/api/v1/environments").send({ name: "E" }).expect(201)).body;
    const col2 = await createCollection({ name: "C2", items: [{ type: "folder", name: "X" }] });

    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${inner.id}`).expect(204);
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${folder.id}`).expect(204);
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${loose.id}`).expect(204);
    await ctx.api.delete(`/api/v1/environments/${env.id}`).expect(204);
    await ctx.api.delete(`/api/v1/collections/${col2.id}`).expect(204);

    const res = await ctx.api.get("/api/v1/trash").expect(200);
    const byId = Object.fromEntries(res.body.entries.map((e: { id: string }) => [e.id, e]));
    // `inner` was deleted before its parent folder, so it is hidden until the folder is restored.
    expect(Object.keys(byId).sort()).toEqual([folder.id, loose.id, env.id, col2.id].sort());
    expect(byId[folder.id]).toMatchObject({ kind: "folder", name: "F", collectionId: col.id, parentId: null });
    expect(byId[loose.id]).toMatchObject({ kind: "request" });
    expect(byId[env.id]).toMatchObject({ kind: "environment", collectionId: null });
    expect(byId[col2.id]).toMatchObject({ kind: "collection", name: "C2" });
    expect(Date.parse(byId[col2.id].deletedAt)).not.toBeNaN();

    await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).expect(200);
    const after = await ctx.api.get("/api/v1/trash").expect(200);
    expect(after.body.entries.map((e: { id: string }) => e.id)).toContain(inner.id);
  });

  it("restores a collection with its whole subtree, but not items trashed separately earlier", async () => {
    const col = await createCollection({
      name: "C",
      items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields }] }, { type: "request", name: "Solo", ...requestFields }],
    });
    const solo = col.items.find((i: { name: string }) => i.name === "Solo");
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${solo.id}`).expect(204);
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(204);

    const check = await ctx.api.post(`/api/v1/trash/${col.id}/restore/check`).expect(200);
    expect(check.body).toMatchObject({ id: col.id, kind: "collection", canRestore: true, blocker: null, conflicts: [] });

    const restored = await ctx.api.post(`/api/v1/trash/${col.id}/restore`).expect(200);
    expect(restored.body.kind).toBe("collection");
    expect(restored.body.collection.items.map((i: { name: string }) => i.name)).toEqual(["F"]);
    expect(restored.body.collection.items[0].items[0].name).toBe("R");

    const trash = await ctx.api.get("/api/v1/trash").expect(200);
    expect(trash.body.entries.map((e: { id: string }) => e.id)).toEqual([solo.id]);
  });

  it("reports collection and folder name conflicts read-only, then restores atomically with overrides", async () => {
    const col = await createCollection({ name: "Orders" });
    const folder = await createItem(col.id, { type: "folder", name: "Shared" });
    const nested = await createItem(col.id, { type: "folder", name: "Nested", parentId: folder.id });
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${folder.id}`).expect(204);
    const replacement = await createItem(col.id, { type: "folder", name: "SHARED" });

    const snapshot = tableSnapshot();
    const check = await ctx.api.post(`/api/v1/trash/${folder.id}/restore/check`).expect(200);
    expect(check.body).toMatchObject({
      kind: "folder",
      canRestore: false,
      conflicts: [{ id: folder.id, kind: "folder", name: "Shared", parentId: null, conflictingId: replacement.id }],
    });
    expect(tableSnapshot()).toEqual(snapshot);

    const rejected = await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).send({}).expect(409);
    expect(rejected.body.error.code).toBe("RESTORE_CONFLICT");
    expect(rejected.body.error.details.conflicts).toHaveLength(1);
    expect(tableSnapshot()).toEqual(snapshot);

    // Checking with a still-conflicting override reports it, without writing.
    const stillBad = await ctx.api
      .post(`/api/v1/trash/${folder.id}/restore/check`)
      .send({ nameOverrides: { [folder.id]: "shared" } })
      .expect(200);
    expect(stillBad.body.canRestore).toBe(false);

    const restored = await ctx.api
      .post(`/api/v1/trash/${folder.id}/restore`)
      .send({ nameOverrides: { [folder.id]: "Shared (restored)" } })
      .expect(200);
    expect(restored.body).toMatchObject({ kind: "folder", item: { id: folder.id, name: "Shared (restored)" } });
    expect(restored.body.item.items[0].id).toBe(nested.id);
    expect((await ctx.api.get("/api/v1/trash")).body.entries).toEqual([]);
  });

  it("resolves collection name conflicts with collectionName", async () => {
    const col = await createCollection({ name: "Orders", items: [{ type: "folder", name: "F" }] });
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(204);
    const active = await createCollection({ name: "orders" });

    const check = await ctx.api.post(`/api/v1/trash/${col.id}/restore/check`).expect(200);
    expect(check.body.conflicts).toEqual([
      { id: col.id, kind: "collection", name: "Orders", collectionId: null, parentId: null, conflictingId: active.id },
    ]);
    await ctx.api.post(`/api/v1/trash/${col.id}/restore`).expect(409);

    const restored = await ctx.api.post(`/api/v1/trash/${col.id}/restore`).send({ collectionName: "Orders v1" }).expect(200);
    expect(restored.body.collection).toMatchObject({ id: col.id, name: "Orders v1" });
    expect(restored.body.collection.items).toHaveLength(1);
  });

  it("blocks restoring an item whose parent is still in Trash", async () => {
    const col = await createCollection({ name: "C" });
    const folder = await createItem(col.id, { type: "folder", name: "F" });
    const req = await createItem(col.id, { type: "request", name: "R", parentId: folder.id, ...requestFields });
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${req.id}`).expect(204);
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${folder.id}`).expect(204);

    const check = await ctx.api.post(`/api/v1/trash/${req.id}/restore/check`).expect(200);
    expect(check.body).toMatchObject({ canRestore: false, blocker: { code: "PARENT_IN_TRASH" } });
    const res = await ctx.api.post(`/api/v1/trash/${req.id}/restore`).expect(409);
    expect(res.body.error.code).toBe("RESTORE_BLOCKED");
  });

  it("validates overrides", async () => {
    const col = await createCollection({ name: "C" });
    const folder = await createItem(col.id, { type: "folder", name: "F" });
    const other = await createItem(col.id, { type: "folder", name: "Other" });
    await ctx.api.delete(`/api/v1/collections/${col.id}/items/${folder.id}`).expect(204);

    const outside = await ctx.api
      .post(`/api/v1/trash/${folder.id}/restore`)
      .send({ nameOverrides: { [other.id]: "X" } })
      .expect(400);
    expect(outside.body.error.code).toBe("INVALID_RESTORE_OVERRIDE");
    await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).send({ collectionName: "X" }).expect(400);
    await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).send({ nameOverrides: { [folder.id]: "" } }).expect(400);
    await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).send({ nameOverrides: { "not-a-uuid": "X" } }).expect(400);
    await ctx.api.post(`/api/v1/trash/${folder.id}/restore`).send({ unknown: 1 }).expect(400);
  });

  it("checks environment name conflicts and restores with an override keyed by the environment ID", async () => {
    const env = (await ctx.api.post("/api/v1/environments").send({ name: "Dev" }).expect(201)).body;
    await ctx.api.delete(`/api/v1/environments/${env.id}`).expect(204);
    const active = (await ctx.api.post("/api/v1/environments").send({ name: "DEV" }).expect(201)).body;

    const check = await ctx.api.post(`/api/v1/trash/${env.id}/restore/check`).expect(200);
    expect(check.body).toMatchObject({
      kind: "environment",
      canRestore: false,
      conflicts: [{ id: env.id, kind: "environment", name: "Dev", conflictingId: active.id }],
    });
    const snapshot = tableSnapshot();
    const rejected = await ctx.api.post(`/api/v1/trash/${env.id}/restore`).expect(409);
    expect(rejected.body.error.code).toBe("RESTORE_CONFLICT");
    expect(tableSnapshot()).toEqual(snapshot);

    await ctx.api.post(`/api/v1/trash/${env.id}/restore`).send({ collectionName: "X" }).expect(400);
    const restored = await ctx.api
      .post(`/api/v1/trash/${env.id}/restore`)
      .send({ nameOverrides: { [env.id]: "Dev (old)" } })
      .expect(200);
    expect(restored.body).toMatchObject({ kind: "environment", environment: { id: env.id, name: "Dev (old)" } });
  });

  it("restores environments and returns 404 for unknown or non-root ids", async () => {
    const env = (await ctx.api.post("/api/v1/environments").send({ name: "E", variables: [{ key: "k", value: "v" }] }).expect(201)).body;
    await ctx.api.delete(`/api/v1/environments/${env.id}`).expect(204);
    const restored = await ctx.api.post(`/api/v1/trash/${env.id}/restore`).expect(200);
    expect(restored.body).toEqual({ kind: "environment", environment: env });
    await ctx.api.post(`/api/v1/trash/${env.id}/restore`).expect(404);

    const col = await createCollection({ name: "C", items: [{ type: "folder", name: "F" }] });
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(204);
    // A descendant moved with its collection is not itself a Trash root.
    await ctx.api.post(`/api/v1/trash/${col.items[0].id}/restore/check`).expect(404);
    await ctx.api.post("/api/v1/trash/00000000-0000-4000-8000-000000000000/restore").expect(404);
  });
});
