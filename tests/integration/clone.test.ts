import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => ctx.close());

const names = (list: { name: string }[]) => list.map((entry) => entry.name);

async function createCollection(body: Record<string, unknown>) {
  return (await ctx.api.post("/api/v1/collections").send(body).expect(201)).body;
}

describe("cloning a collection", () => {
  it("copies the whole tree under a free name without touching the original", async () => {
    const source = await createCollection({
      name: "Commerce",
      description: "Storefront",
      items: [
        {
          type: "folder",
          name: "Orders",
          items: [
            { type: "folder", name: "Archive", items: [{ type: "request", name: "Old", ...requestFields }] },
            { type: "request", name: "List", ...requestFields },
          ],
        },
        { type: "request", name: "Health", ...requestFields, method: "POST" },
      ],
    });

    const clone = (await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(201)).body;

    expect(clone.id).not.toBe(source.id);
    expect(clone).toMatchObject({ name: "Commerce (copy)", description: "Storefront" });
    expect(names(clone.items)).toEqual(["Health", "Orders"]);

    const orders = clone.items[1];
    expect(orders.parentId).toBeNull();
    expect(orders.collectionId).toBe(clone.id);
    expect(names(orders.items)).toEqual(["Archive", "List"]);
    expect(orders.items[0].items[0]).toMatchObject({ name: "Old", parentId: orders.items[0].id });

    const original = (await ctx.api.get(`/api/v1/collections/${source.id}`).expect(200)).body;
    expect(original.name).toBe("Commerce");
    expect(names(original.items)).toEqual(["Health", "Orders"]);
  });

  it("carries a request's method, url, body and ordered headers and params over exactly", async () => {
    const source = await createCollection({
      name: "Payments",
      items: [
        {
          type: "request",
          name: "Charge",
          ...requestFields,
          method: "POST",
          url: "{{baseUrl}}:{{port}}/charge",
          queryParams: [
            { key: "b", value: "2", description: "second", enabled: false },
            { key: "a", value: "1", description: "", enabled: true },
          ],
          headers: [
            { key: "Accept", value: "application/json", description: "", enabled: true },
            { key: "X-Trace", value: "{{traceId}}", description: "", enabled: false },
          ],
          body: { type: "json", content: '{"id": {{id}}}' },
        },
      ],
    });

    const clone = (await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(201)).body;
    const [copied] = clone.items;
    const [original] = source.items;

    expect(copied.id).not.toBe(original.id);
    // Positions are carried over rather than re-derived, so the user's ordering survives.
    expect(copied.queryParams).toEqual(original.queryParams);
    expect(copied.headers).toEqual(original.headers);
    expect(copied).toMatchObject({ method: "POST", url: original.url, body: original.body, auth: original.auth });
  });

  it("counts up on repeated cloning instead of nesting markers", async () => {
    const source = await createCollection({ name: "Commerce" });
    const first = (await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(201)).body;
    const second = (await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(201)).body;
    const ofACopy = (await ctx.api.post(`/api/v1/collections/${first.id}/clone`).expect(201)).body;

    expect([first.name, second.name, ofACopy.name]).toEqual([
      "Commerce (copy)",
      "Commerce (copy 2)",
      "Commerce (copy 3)",
    ]);
  });

  it("leaves trashed items behind", async () => {
    const source = await createCollection({
      name: "Commerce",
      items: [
        { type: "folder", name: "Keep" },
        { type: "folder", name: "Drop" },
      ],
    });
    const drop = source.items.find((item: { name: string }) => item.name === "Drop");
    await ctx.api.delete(`/api/v1/collections/${source.id}/items/${drop.id}`).expect(204);

    const clone = (await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(201)).body;
    expect(names(clone.items)).toEqual(["Keep"]);
  });

  it("refuses to clone a collection that is not there", async () => {
    const source = await createCollection({ name: "Gone" });
    await ctx.api.delete(`/api/v1/collections/${source.id}`).expect(204);
    await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(404);
    await ctx.api.post("/api/v1/collections/11111111-1111-4111-8111-111111111111/clone").expect(404);
  });

  it("needs a signed-in caller", async () => {
    const source = await createCollection({ name: "Commerce" });
    await ctx.unauthenticatedApi.post(`/api/v1/collections/${source.id}/clone`).expect(401);
  });

  it("announces the copy as a created collection", async () => {
    const source = await createCollection({ name: "Commerce" });
    const seen: unknown[] = [];
    const unsubscribe = ctx.events.subscribe((event) => seen.push(event));
    const clone = (await ctx.api.post(`/api/v1/collections/${source.id}/clone`).expect(201)).body;
    unsubscribe();
    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "collection", id: clone.id, operation: "created" }),
    );
  });
});

describe("cloning a folder or a request", () => {
  let collectionId: string;
  const itemsUrl = () => `/api/v1/collections/${collectionId}/items`;

  const createFolder = async (name: string, parentId: string | null = null) =>
    (await ctx.api.post(itemsUrl()).send({ type: "folder", name, parentId }).expect(201)).body;

  const createRequest = async (name: string, parentId: string | null = null, extra: Record<string, unknown> = {}) =>
    (await ctx.api.post(itemsUrl()).send({ type: "request", name, parentId, ...requestFields, ...extra }).expect(201))
      .body;

  const clone = async (itemId: string) =>
    (await ctx.api.post(`${itemsUrl()}/${itemId}/clone`).expect(201)).body;

  beforeEach(async () => {
    collectionId = (await ctx.api.post("/api/v1/collections").send({ name: "Main" }).expect(201)).body.id;
  });

  it("copies a folder with everything inside it, beside the original", async () => {
    const orders = await createFolder("Orders");
    const archive = await createFolder("Archive", orders.id);
    await createRequest("Old", archive.id);
    await createRequest("List", orders.id);

    const copy = await clone(orders.id);

    expect(copy).toMatchObject({ type: "folder", name: "Orders (copy)", parentId: null, collectionId });
    expect(copy.id).not.toBe(orders.id);
    expect(names(copy.items)).toEqual(["Archive", "List"]);
    // Only the root is renamed: descendants land under a new parent where nothing can collide.
    expect(copy.items[0].name).toBe("Archive");
    expect(copy.items[0].items[0]).toMatchObject({ name: "Old", parentId: copy.items[0].id });

    const tree = (await ctx.api.get(`/api/v1/collections/${collectionId}`).expect(200)).body;
    expect(names(tree.items)).toEqual(["Orders", "Orders (copy)"]);
  });

  it("keeps a nested copy next to what it was copied from", async () => {
    const orders = await createFolder("Orders");
    const archive = await createFolder("Archive", orders.id);

    const copy = await clone(archive.id);

    expect(copy).toMatchObject({ name: "Archive (copy)", parentId: orders.id });
  });

  it("copies a single request with its payload", async () => {
    const source = await createRequest("Charge", null, {
      method: "POST",
      url: "{{baseUrl}}/charge",
      headers: [{ key: "Accept", value: "application/json", description: "", enabled: true }],
      queryParams: [{ key: "dry", value: "1", description: "", enabled: false }],
      body: { type: "json", content: "{}" },
    });

    const copy = await clone(source.id);

    expect(copy).toMatchObject({
      type: "request",
      name: "Charge (copy)",
      method: "POST",
      url: "{{baseUrl}}/charge",
      body: { type: "json", content: "{}" },
    });
    expect(copy.headers).toEqual(source.headers);
    expect(copy.queryParams).toEqual(source.queryParams);
  });

  it("numbers requests too, even though nothing forces it to", async () => {
    const source = await createRequest("Charge");
    const first = await clone(source.id);
    const second = await clone(source.id);
    expect([first.name, second.name]).toEqual(["Charge (copy)", "Charge (copy 2)"]);
  });

  it("does not copy trashed descendants", async () => {
    const orders = await createFolder("Orders");
    const keep = await createRequest("Keep", orders.id);
    const drop = await createRequest("Drop", orders.id);
    await ctx.api.delete(`${itemsUrl()}/${drop.id}`).expect(204);

    const copy = await clone(orders.id);
    expect(names(copy.items)).toEqual(["Keep"]);
    expect(copy.items[0].id).not.toBe(keep.id);
  });

  it("credits the caller with the copy rather than the original author", async () => {
    const source = await createFolder("Orders");
    const copy = await clone(source.id);
    expect(copy.createdBy).toEqual(source.createdBy);
    expect(copy.createdAt >= source.createdAt).toBe(true);
    expect(copy.createdAt).toBe(copy.updatedAt);
  });

  it("refuses an item that is not there, or one from another collection", async () => {
    const other = (await ctx.api.post("/api/v1/collections").send({ name: "Other" }).expect(201)).body;
    const source = await createFolder("Orders");
    await ctx.api.post(`/api/v1/collections/${other.id}/items/${source.id}/clone`).expect(404);

    await ctx.api.delete(`${itemsUrl()}/${source.id}`).expect(204);
    await ctx.api.post(`${itemsUrl()}/${source.id}/clone`).expect(404);
  });

  it("announces the copy under its own kind", async () => {
    const folder = await createFolder("Orders");
    const request = await createRequest("Charge");
    const seen: { kind?: string; id?: string }[] = [];
    const unsubscribe = ctx.events.subscribe((event) => seen.push(event as { kind?: string; id?: string }));
    const folderCopy = await clone(folder.id);
    const requestCopy = await clone(request.id);
    unsubscribe();

    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "folder", id: folderCopy.id, collectionId, operation: "created" }),
    );
    expect(seen).toContainEqual(
      expect.objectContaining({ kind: "request", id: requestCopy.id, collectionId, operation: "created" }),
    );
  });
});

describe("cloning an environment", () => {
  it("copies the variables in order under a free name", async () => {
    const source = (
      await ctx.api
        .post("/api/v1/environments")
        .send({
          name: "Development",
          variables: [
            { key: "port", value: "8443" },
            { key: "baseUrl", value: "https://dev.example.internal", enabled: false },
          ],
        })
        .expect(201)
    ).body;

    const copy = (await ctx.api.post(`/api/v1/environments/${source.id}/clone`).expect(201)).body;

    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe("Development (copy)");
    expect(copy.variables).toEqual(source.variables);

    const list = (await ctx.api.get("/api/v1/environments").expect(200)).body;
    expect(names(list.environments)).toEqual(["Development", "Development (copy)"]);
  });

  it("counts up on repeated cloning", async () => {
    const source = (await ctx.api.post("/api/v1/environments").send({ name: "Dev" }).expect(201)).body;
    const first = (await ctx.api.post(`/api/v1/environments/${source.id}/clone`).expect(201)).body;
    const second = (await ctx.api.post(`/api/v1/environments/${source.id}/clone`).expect(201)).body;
    expect([first.name, second.name]).toEqual(["Dev (copy)", "Dev (copy 2)"]);
  });

  it("refuses an environment that is not there, and an unsigned caller", async () => {
    const source = (await ctx.api.post("/api/v1/environments").send({ name: "Dev" }).expect(201)).body;
    await ctx.unauthenticatedApi.post(`/api/v1/environments/${source.id}/clone`).expect(401);
    await ctx.api.delete(`/api/v1/environments/${source.id}`).expect(204);
    await ctx.api.post(`/api/v1/environments/${source.id}/clone`).expect(404);
  });

  it("announces the copy as a created environment", async () => {
    const source = (await ctx.api.post("/api/v1/environments").send({ name: "Dev" }).expect(201)).body;
    const seen: unknown[] = [];
    const unsubscribe = ctx.events.subscribe((event) => seen.push(event));
    const copy = (await ctx.api.post(`/api/v1/environments/${source.id}/clone`).expect(201)).body;
    unsubscribe();
    expect(seen).toContainEqual(expect.objectContaining({ kind: "environment", id: copy.id, operation: "created" }));
  });
});
