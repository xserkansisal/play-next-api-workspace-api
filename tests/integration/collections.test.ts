import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => ctx.close());

describe("collections API", () => {
  it("creates, lists (alphabetically), reads, and saves collection metadata", async () => {
    const created = await ctx.api.post("/api/v1/collections").send({ name: "  Zeta  " }).expect(201);
    expect(created.body).toMatchObject({ name: "Zeta", description: "", items: [] });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.body.createdAt).toBe(created.body.updatedAt);

    await ctx.api.post("/api/v1/collections").send({ name: "alpha", description: "first" }).expect(201);

    const list = await ctx.api.get("/api/v1/collections").expect(200);
    expect(list.body.collections.map((c: { name: string }) => c.name)).toEqual(["alpha", "Zeta"]);

    const saved = await ctx.api
      .put(`/api/v1/collections/${created.body.id}`)
      .send({ name: "Zeta API", description: "Updated" })
      .expect(200);
    expect(saved.body).toMatchObject({ id: created.body.id, name: "Zeta API", description: "Updated" });
    expect(saved.body.createdAt).toBe(created.body.createdAt);
    expect(saved.body.updatedAt >= created.body.updatedAt).toBe(true);

    const read = await ctx.api.get(`/api/v1/collections/${created.body.id}`).expect(200);
    expect(read.body.name).toBe("Zeta API");
  });

  it("creates a collection with a nested tree and returns it alphabetically sorted", async () => {
    const res = await ctx.api
      .post("/api/v1/collections")
      .send({
        name: "Commerce",
        items: [
          {
            type: "folder",
            name: "Orders",
            items: [
              { type: "request", name: "List", ...requestFields },
              { type: "folder", name: "Archive", items: [{ type: "request", name: "Old", ...requestFields }] },
            ],
          },
          { type: "request", name: "Health", ...requestFields, method: "POST" },
        ],
      })
      .expect(201);

    const [health, orders] = res.body.items;
    expect(health).toMatchObject({ type: "request", name: "Health", method: "POST", parentId: null });
    expect(orders).toMatchObject({ type: "folder", name: "Orders", parentId: null });
    expect(orders.items.map((i: { name: string }) => i.name)).toEqual(["Archive", "List"]);
    expect(orders.items[0].items[0]).toMatchObject({ name: "Old", parentId: orders.items[0].id });
  });

  it("rejects case-insensitive duplicate active collection names but allows reuse after Trash", async () => {
    const first = await ctx.api.post("/api/v1/collections").send({ name: "Orders" }).expect(201);
    const dup = await ctx.api.post("/api/v1/collections").send({ name: "ORDERS" }).expect(409);
    expect(dup.body.error).toMatchObject({ code: "COLLECTION_NAME_CONFLICT" });
    expect(dup.body.error.details.conflictingId).toBe(first.body.id);

    const other = await ctx.api.post("/api/v1/collections").send({ name: "Other" }).expect(201);
    await ctx.api.put(`/api/v1/collections/${other.body.id}`).send({ name: "orders" }).expect(409);
    // Renaming to its own name with different case is allowed.
    await ctx.api.put(`/api/v1/collections/${first.body.id}`).send({ name: "ORDERS" }).expect(200);

    await ctx.api.delete(`/api/v1/collections/${first.body.id}`).expect(204);
    await ctx.api.post("/api/v1/collections").send({ name: "orders" }).expect(201);
  });

  it("rejects the whole create atomically when a nested folder name conflicts", async () => {
    const res = await ctx.api
      .post("/api/v1/collections")
      .send({
        name: "Broken",
        items: [
          { type: "folder", name: "A", items: [{ type: "folder", name: "Dup" }, { type: "folder", name: "dup" }] },
        ],
      })
      .expect(409);
    expect(res.body.error.code).toBe("FOLDER_NAME_CONFLICT");

    const list = await ctx.api.get("/api/v1/collections").expect(200);
    expect(list.body.collections).toEqual([]);
    const counts = ctx.db.$client.prepare("SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM collections) AS collections").get();
    expect(counts).toEqual({ items: 0, collections: 0 });
  });

  it("allows duplicate request names in the same parent", async () => {
    const res = await ctx.api
      .post("/api/v1/collections")
      .send({ name: "Dupes", items: [{ type: "request", name: "Same", ...requestFields }, { type: "request", name: "same", ...requestFields }] })
      .expect(201);
    expect(res.body.items).toHaveLength(2);
  });

  it("validates input and rejects unknown fields without persisting", async () => {
    const cases = [
      {},
      { name: "   " },
      { name: "x".repeat(201) },
      { name: "Ok", unexpected: true },
      { name: "Ok", items: [{ type: "request", name: "R", ...requestFields, method: "OPTIONS" }] },
      { name: "Ok", items: [{ type: "request", name: "R", ...requestFields, auth: { type: "bearer" } }] },
      { name: "Ok", items: [{ type: "request", name: "R", ...requestFields, body: { type: "form", content: "" } }] },
      { name: "Ok", items: [{ type: "folder", name: "F", extra: 1 }] },
    ];
    for (const body of cases) {
      const res = await ctx.api.post("/api/v1/collections").send(body).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await ctx.api.get("/api/v1/collections")).body.collections).toEqual([]);
  });

  it("does not modify items when saving collection metadata", async () => {
    const created = await ctx.api
      .post("/api/v1/collections")
      .send({ name: "C", items: [{ type: "request", name: "R", ...requestFields }] })
      .expect(201);
    await ctx.api.put(`/api/v1/collections/${created.body.id}`).send({ name: "C2" }).expect(200);
    const read = await ctx.api.get(`/api/v1/collections/${created.body.id}`).expect(200);
    expect(read.body.items).toEqual(created.body.items);
  });

  it("returns 404 for missing or trashed collections", async () => {
    await ctx.api.get("/api/v1/collections/00000000-0000-4000-8000-000000000000").expect(404);
    const created = await ctx.api.post("/api/v1/collections").send({ name: "Gone" }).expect(201);
    await ctx.api.delete(`/api/v1/collections/${created.body.id}`).expect(204);
    await ctx.api.get(`/api/v1/collections/${created.body.id}`).expect(404);
    await ctx.api.put(`/api/v1/collections/${created.body.id}`).send({ name: "Back" }).expect(404);
    await ctx.api.delete(`/api/v1/collections/${created.body.id}`).expect(404);
    expect((await ctx.api.get("/api/v1/collections")).body.collections).toEqual([]);
  });
});
