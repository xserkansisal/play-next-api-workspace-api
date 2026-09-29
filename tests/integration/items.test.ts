import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
let collectionId: string;

beforeEach(async () => {
  ctx = createTestContext();
  collectionId = (await ctx.api.post("/api/v1/collections").send({ name: "Main" }).expect(201)).body.id;
});
afterEach(() => ctx.close());

const itemsUrl = () => `/api/v1/collections/${collectionId}/items`;

async function createFolder(name: string, parentId: string | null = null) {
  return (await ctx.api.post(itemsUrl()).send({ type: "folder", name, parentId }).expect(201)).body;
}

async function createRequest(name: string, parentId: string | null = null, extra: Record<string, unknown> = {}) {
  return (await ctx.api.post(itemsUrl()).send({ type: "request", name, parentId, ...requestFields, ...extra }).expect(201)).body;
}

describe("collection items API", () => {
  it("creates nested folders and requests and reads them individually", async () => {
    const folder = await createFolder("Orders");
    const child = await createFolder("Archive", folder.id);
    const req = await createRequest("List orders", child.id, {
      method: "POST",
      url: "{{baseUrl}}:{{port}}/orders",
      queryParams: [
        { key: "b", value: "2", description: "second", enabled: false },
        { key: "a", value: "1" },
      ],
      headers: [{ key: "Accept", value: "application/json", description: "", enabled: true }],
      body: { type: "json", content: '{"id": {{id}}}' },
    });

    expect(req).toMatchObject({
      type: "request",
      collectionId,
      parentId: child.id,
      method: "POST",
      queryParams: [
        { key: "b", value: "2", description: "second", enabled: false },
        { key: "a", value: "1", description: "", enabled: true },
      ],
      body: { type: "json", content: '{"id": {{id}}}' },
      auth: { type: "none" },
    });

    const readFolder = await ctx.api.get(`${itemsUrl()}/${folder.id}`).expect(200);
    expect(readFolder.body.items[0].items[0].id).toBe(req.id);
    const readReq = await ctx.api.get(`${itemsUrl()}/${req.id}`).expect(200);
    expect(readReq.body).toEqual(req);
  });

  it("enforces case-insensitive sibling folder uniqueness only among siblings", async () => {
    const a = await createFolder("Shared");
    const conflict = await ctx.api.post(itemsUrl()).send({ type: "folder", name: "SHARED" }).expect(409);
    expect(conflict.body.error).toMatchObject({ code: "FOLDER_NAME_CONFLICT", details: { conflictingId: a.id } });

    await createFolder("shared", a.id);
    await createRequest("Shared");
    await createRequest("Shared");

    const b = await createFolder("Other");
    await ctx.api.put(`${itemsUrl()}/${b.id}`).send({ type: "folder", name: "sHaReD" }).expect(409);
    await ctx.api.put(`${itemsUrl()}/${a.id}`).send({ type: "folder", name: "SHARED" }).expect(200);
  });

  it("rejects invalid parents", async () => {
    const req = await createRequest("R");
    const other = (await ctx.api.post("/api/v1/collections").send({ name: "Other" }).expect(201)).body;
    const otherFolder = (
      await ctx.api.post(`/api/v1/collections/${other.id}/items`).send({ type: "folder", name: "F" }).expect(201)
    ).body;

    for (const parentId of [req.id, otherFolder.id, "00000000-0000-4000-8000-000000000000"]) {
      const res = await ctx.api.post(itemsUrl()).send({ type: "folder", name: "X", parentId }).expect(400);
      expect(res.body.error.code).toBe("INVALID_PARENT");
    }
    await ctx.api.post(itemsUrl()).send({ type: "folder", name: "X", parentId: "not-a-uuid" }).expect(400);
  });

  it("saves a request's own fields without touching siblings, parent, or collection", async () => {
    const folder = await createFolder("F");
    const a = await createRequest("A", folder.id, { headers: [{ key: "X-A", value: "1" }] });
    const b = await createRequest("B", folder.id, { headers: [{ key: "X-B", value: "2" }] });
    const before = (await ctx.api.get(`/api/v1/collections/${collectionId}`)).body;

    const saved = await ctx.api
      .put(`${itemsUrl()}/${a.id}`)
      .send({
        type: "request",
        name: "A renamed",
        method: "DELETE",
        url: "https://example.test/a",
        queryParams: [{ key: "q", value: "1" }],
        headers: [
          { key: "Z", value: "last" },
          { key: "Y", value: "first", enabled: false },
        ],
        body: { type: "json", content: "{}" },
        auth: { type: "none" },
      })
      .expect(200);
    expect(saved.body).toMatchObject({ id: a.id, name: "A renamed", method: "DELETE", parentId: folder.id });
    expect(saved.body.headers.map((h: { key: string }) => h.key)).toEqual(["Z", "Y"]);
    expect(saved.body.createdAt).toBe(a.createdAt);

    const after = (await ctx.api.get(`/api/v1/collections/${collectionId}`)).body;
    const { items: _i1, ...metaBefore } = before;
    const { items: _i2, ...metaAfter } = after;
    expect(metaAfter).toEqual(metaBefore);
    const folderAfter = after.items[0];
    expect(folderAfter.updatedAt).toBe(folder.updatedAt);
    expect(folderAfter.items.find((i: { id: string }) => i.id === b.id)).toEqual(b);
  });

  it("saving a folder does not rewrite its children", async () => {
    const folder = await createFolder("F");
    const child = await createRequest("Child", folder.id);
    const saved = await ctx.api
      .put(`${itemsUrl()}/${folder.id}`)
      .send({ type: "folder", name: "F2", description: "desc" })
      .expect(200);
    expect(saved.body).toMatchObject({ name: "F2", description: "desc" });
    expect(saved.body.items).toEqual([child]);
  });

  it("rejects type changes, unknown fields, and moves via save", async () => {
    const req = await createRequest("R");
    const mismatch = await ctx.api.put(`${itemsUrl()}/${req.id}`).send({ type: "folder", name: "R" }).expect(400);
    expect(mismatch.body.error.code).toBe("ITEM_TYPE_MISMATCH");
    await ctx.api
      .put(`${itemsUrl()}/${req.id}`)
      .send({ type: "request", name: "R", ...requestFields, parentId: null })
      .expect(400);
    await ctx.api.put(`${itemsUrl()}/${req.id}`).send({ type: "request", name: "R", ...requestFields, method: "HEAD" }).expect(400);
    const unchanged = await ctx.api.get(`${itemsUrl()}/${req.id}`).expect(200);
    expect(unchanged.body).toEqual(req);
  });

  it("moves a folder subtree to Trash and hides it", async () => {
    const folder = await createFolder("F");
    const sub = await createFolder("Sub", folder.id);
    const req = await createRequest("R", sub.id);
    const keep = await createRequest("Keep");

    await ctx.api.delete(`${itemsUrl()}/${folder.id}`).expect(204);
    for (const id of [folder.id, sub.id, req.id]) {
      await ctx.api.get(`${itemsUrl()}/${id}`).expect(404);
      await ctx.api.put(`${itemsUrl()}/${id}`).send({ type: "folder", name: "x" }).expect(404);
    }
    await ctx.api.delete(`${itemsUrl()}/${folder.id}`).expect(404);
    const tree = (await ctx.api.get(`/api/v1/collections/${collectionId}`)).body.items;
    expect(tree.map((i: { id: string }) => i.id)).toEqual([keep.id]);

    await ctx.api.post(itemsUrl()).send({ type: "folder", name: "X", parentId: folder.id }).expect(400);
    await createFolder("f");
  });

  it("isolates items by collection", async () => {
    const req = await createRequest("R");
    const other = (await ctx.api.post("/api/v1/collections").send({ name: "Other" }).expect(201)).body;
    await ctx.api.get(`/api/v1/collections/${other.id}/items/${req.id}`).expect(404);
    await ctx.api.put(`/api/v1/collections/${other.id}/items/${req.id}`).send({ type: "request", name: "x", ...requestFields }).expect(404);
    await ctx.api.delete(`/api/v1/collections/${other.id}/items/${req.id}`).expect(404);
  });

  it("returns 404 when the collection is in Trash", async () => {
    const req = await createRequest("R");
    await ctx.api.delete(`/api/v1/collections/${collectionId}`).expect(204);
    await ctx.api.get(`${itemsUrl()}/${req.id}`).expect(404);
    await ctx.api.post(itemsUrl()).send({ type: "folder", name: "X" }).expect(404);
  });
});
