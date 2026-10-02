import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";
import type { SequencedChangeEvent } from "../../src/events/hub.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => ctx.close());

const names = (list: { name: string }[]) => list.map((entry) => entry.name);

async function createCollection(body: Record<string, unknown>) {
  return (await ctx.api.post("/api/v1/collections").send(body).expect(201)).body;
}

function readCollection(id: string) {
  return ctx.api.get(`/api/v1/collections/${id}`).expect(200).then((res) => res.body);
}

function move(collectionId: string, itemId: string, body: Record<string, unknown>) {
  return ctx.api.post(`/api/v1/collections/${collectionId}/items/${itemId}/move`).send(body);
}

interface Node {
  id: string;
  name: string;
  type: "folder" | "request";
  parentId: string | null;
  collectionId: string;
  updatedAt: string;
  items?: Node[];
}

function flatten(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...flatten(node.items ?? [])]);
}

function find(tree: Node[], name: string): Node {
  const node = flatten(tree).find((entry) => entry.name === name);
  if (!node) throw new Error(`No item named ${name} in the tree`);
  return node;
}

const sampleTree = [
  {
    type: "folder",
    name: "Orders",
    items: [
      { type: "folder", name: "Archive", items: [{ type: "request", name: "Old", ...requestFields }] },
      { type: "request", name: "List", ...requestFields },
    ],
  },
  { type: "folder", name: "Users", items: [] },
  { type: "request", name: "Health", ...requestFields },
];

describe("moving an item within one collection", () => {
  it("reparents a folder with its whole subtree", async () => {
    const collection = await createCollection({ name: "Commerce", items: sampleTree });
    const orders = find(collection.items, "Orders");
    const users = find(collection.items, "Users");
    const archive = find(collection.items, "Archive");
    const old = find(collection.items, "Old");

    const moved = (await move(collection.id, orders.id, { targetCollectionId: collection.id, parentId: users.id }).expect(200)).body;

    expect(moved).toMatchObject({ id: orders.id, parentId: users.id, collectionId: collection.id });
    expect(names(moved.items)).toEqual(["Archive", "List"]);

    const after = await readCollection(collection.id);
    expect(names(after.items)).toEqual(["Health", "Users"]);
    expect(find(after.items, "Orders").parentId).toBe(users.id);
    // The subtree travelled with it rather than being rewritten or detached.
    expect(find(after.items, "Old")).toMatchObject({ id: old.id, parentId: archive.id, collectionId: collection.id });
  });

  it("moves a request to the collection root", async () => {
    const collection = await createCollection({ name: "Commerce", items: sampleTree });
    const list = find(collection.items, "List");

    const moved = (await move(collection.id, list.id, { targetCollectionId: collection.id, parentId: null }).expect(200)).body;

    expect(moved).toMatchObject({ id: list.id, parentId: null, type: "request" });
    const after = await readCollection(collection.id);
    expect(names(after.items)).toEqual(["Health", "List", "Orders", "Users"]);
    expect(names(find(after.items, "Orders").items!)).toEqual(["Archive"]);
  });

  it("records who moved the item", async () => {
    const collection = await createCollection({ name: "Commerce", items: sampleTree });
    const health = find(collection.items, "Health");
    const users = find(collection.items, "Users");

    const moved = (await move(collection.id, health.id, { targetCollectionId: collection.id, parentId: users.id }).expect(200)).body;

    expect(moved.updatedBy).toBe((await ctx.api.get("/api/v1/auth/me").expect(200)).body.user.email);
    expect(moved.updatedAt >= health.updatedAt).toBe(true);
  });
});

describe("moving an item across collections", () => {
  it("rewrites the collection of every descendant", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [{ type: "folder", name: "Inbox", items: [] }] });
    const orders = find(source.items, "Orders");
    const inbox = find(target.items, "Inbox");

    const moved = (await move(source.id, orders.id, { targetCollectionId: target.id, parentId: inbox.id }).expect(200)).body;

    expect(moved).toMatchObject({ id: orders.id, parentId: inbox.id, collectionId: target.id });
    for (const node of flatten(moved.items)) expect(node.collectionId).toBe(target.id);

    const afterSource = await readCollection(source.id);
    expect(names(afterSource.items)).toEqual(["Health", "Users"]);
    expect(flatten(afterSource.items).some((node) => node.id === orders.id)).toBe(false);

    const afterTarget = await readCollection(target.id);
    expect(names(find(afterTarget.items, "Inbox").items!)).toEqual(["Orders"]);
    expect(find(afterTarget.items, "Old").collectionId).toBe(target.id);

    // The item is reachable at its new address and gone from the old one.
    await ctx.api.get(`/api/v1/collections/${target.id}/items/${orders.id}`).expect(200);
    await ctx.api.get(`/api/v1/collections/${source.id}/items/${orders.id}`).expect(404);
  });

  it("carries trashed descendants along, so they still restore after the move", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [] });
    const orders = find(source.items, "Orders");
    const archive = find(source.items, "Archive");

    await ctx.api.delete(`/api/v1/collections/${source.id}/items/${archive.id}`).expect(204);
    await move(source.id, orders.id, { targetCollectionId: target.id, parentId: null }).expect(200);

    const restored = (await ctx.api.post(`/api/v1/trash/${archive.id}/restore`).expect(200)).body;
    expect(restored.item).toMatchObject({ id: archive.id, parentId: orders.id, collectionId: target.id });
    expect(find((await readCollection(target.id)).items, "Old").collectionId).toBe(target.id);
  });

  it("moves a request's details, headers and params with it", async () => {
    const source = await createCollection({
      name: "Commerce",
      auth: { type: "bearer", token: "source-token" },
      items: [
        {
          type: "request",
          name: "Charge",
          ...requestFields,
          method: "POST",
          url: "https://example.test/charge",
          headers: [{ key: "X-A", value: "1", description: "", enabled: true }],
          queryParams: [{ key: "q", value: "2", description: "", enabled: false }],
          body: { type: "json", content: "{\"a\":1}" },
        },
      ],
    });
    const target = await createCollection({ name: "Billing", auth: { type: "api-key", in: "header", key: "X-API-Key", value: "target-key" }, items: [] });
    const charge = find(source.items, "Charge");

    const moved = (await move(source.id, charge.id, { targetCollectionId: target.id, parentId: null }).expect(200)).body;

    expect(moved).toMatchObject({
      method: "POST",
      url: "https://example.test/charge",
      headers: [{ key: "X-A", value: "1", enabled: true }],
      queryParams: [{ key: "q", value: "2", enabled: false }],
      body: { type: "json", content: "{\"a\":1}" },
      auth: { type: "inherit" },
      effectiveAuth: { type: "api-key", in: "header", key: "X-API-Key", value: "target-key" },
    });
  });
});

describe("rejected moves", () => {
  it("reports an unknown item, target collection or parent", async () => {
    const collection = await createCollection({ name: "Commerce", items: sampleTree });
    const missing = "11111111-1111-4111-8111-111111111111";
    const orders = find(collection.items, "Orders");

    const unknownItem = await move(collection.id, missing, { targetCollectionId: collection.id, parentId: null }).expect(404);
    expect(unknownItem.body.error.code).toBe("ITEM_NOT_FOUND");

    // The team guard answers for the collection before the item is looked up.
    const unknownCollection = await move(missing, orders.id, { targetCollectionId: collection.id, parentId: null }).expect(404);
    expect(unknownCollection.body.error.code).toBe("NOT_FOUND");

    const unknownTarget = await move(collection.id, orders.id, { targetCollectionId: missing, parentId: null }).expect(404);
    expect(unknownTarget.body.error.code).toBe("TARGET_NOT_FOUND");

    const unknownParent = await move(collection.id, orders.id, { targetCollectionId: collection.id, parentId: missing }).expect(404);
    expect(unknownParent.body.error.code).toBe("TARGET_NOT_FOUND");
  });

  it("refuses a parent that is in another collection than the target", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [] });
    const orders = find(source.items, "Orders");
    const users = find(source.items, "Users");

    const response = await move(source.id, orders.id, { targetCollectionId: target.id, parentId: users.id }).expect(404);
    expect(response.body.error.code).toBe("TARGET_NOT_FOUND");
  });

  it("refuses a move into itself, into its own subtree, or onto a request", async () => {
    const collection = await createCollection({ name: "Commerce", items: sampleTree });
    const orders = find(collection.items, "Orders");
    const archive = find(collection.items, "Archive");
    const old = find(collection.items, "Old");
    const health = find(collection.items, "Health");

    for (const parentId of [orders.id, archive.id, old.id, health.id]) {
      const response = await move(collection.id, orders.id, { targetCollectionId: collection.id, parentId }).expect(409);
      expect(response.body.error.code).toBe("INVALID_MOVE");
    }

    // Nothing was written by any of the four attempts.
    const after = await readCollection(collection.id);
    expect(find(after.items, "Orders").parentId).toBeNull();
    expect(find(after.items, "Old").parentId).toBe(archive.id);
  });

  it("refuses a folder whose name is already taken by a sibling folder", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [{ type: "folder", name: "orders", items: [] }] });
    const orders = find(source.items, "Orders");

    const response = await move(source.id, orders.id, { targetCollectionId: target.id, parentId: null }).expect(409);
    expect(response.body.error).toMatchObject({ code: "NAME_CONFLICT" });
    expect(response.body.error.message).toContain("Orders");

    expect(names((await readCollection(source.id)).items)).toEqual(["Health", "Orders", "Users"]);
    expect(names((await readCollection(target.id)).items)).toEqual(["orders"]);
  });

  it("allows a request to share a name with a sibling request", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [{ type: "request", name: "health", ...requestFields }] });
    const health = find(source.items, "Health");

    await move(source.id, health.id, { targetCollectionId: target.id, parentId: null }).expect(200);
    expect(names((await readCollection(target.id)).items)).toEqual(["Health", "health"]);
  });

  it("refuses a move into a trashed collection and a trashed item", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [] });
    const orders = find(source.items, "Orders");
    const users = find(source.items, "Users");
    await ctx.api.delete(`/api/v1/collections/${target.id}`).expect(204);
    await ctx.api.delete(`/api/v1/collections/${source.id}/items/${users.id}`).expect(204);

    expect((await move(source.id, orders.id, { targetCollectionId: target.id, parentId: null }).expect(404)).body.error.code)
      .toBe("TARGET_NOT_FOUND");
    expect((await move(source.id, users.id, { targetCollectionId: source.id, parentId: null }).expect(404)).body.error.code)
      .toBe("ITEM_NOT_FOUND");
  });

  it("rejects a malformed body", async () => {
    const collection = await createCollection({ name: "Commerce", items: sampleTree });
    const orders = find(collection.items, "Orders");

    await move(collection.id, orders.id, {}).expect(400);
    await move(collection.id, orders.id, { targetCollectionId: collection.id }).expect(400);
    await move(collection.id, orders.id, { targetCollectionId: "nope", parentId: null }).expect(400);
    await move(collection.id, orders.id, { targetCollectionId: collection.id, parentId: null, name: "x" }).expect(400);
  });

  it("leaves the session usable after a rejected cross-collection move", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [{ type: "folder", name: "Orders", items: [] }] });
    const orders = find(source.items, "Orders");

    await move(source.id, orders.id, { targetCollectionId: target.id, parentId: null }).expect(409);

    // The foreign key must still be enforced on the pooled connection the rejection used.
    const users = find(source.items, "Users");
    await move(source.id, orders.id, { targetCollectionId: source.id, parentId: users.id }).expect(200);
    expect(find((await readCollection(source.id)).items, "Orders").parentId).toBe(users.id);
  });
});

describe("move change events", () => {
  it("announces the move once within a collection and twice across collections", async () => {
    const source = await createCollection({ name: "Commerce", items: sampleTree });
    const target = await createCollection({ name: "Billing", items: [] });
    const orders = find(source.items, "Orders");
    const users = find(source.items, "Users");

    const seen: SequencedChangeEvent[] = [];
    const unsubscribe = ctx.subscribe((event) => seen.push(event));

    await move(source.id, orders.id, { targetCollectionId: source.id, parentId: users.id }).expect(200);
    expect(seen).toEqual([
      expect.objectContaining({ kind: "folder", id: orders.id, collectionId: source.id, operation: "move" }),
    ]);

    seen.length = 0;
    await move(source.id, orders.id, { targetCollectionId: target.id, parentId: null }).expect(200);
    expect(seen.map((event) => event.collectionId)).toEqual([target.id, source.id]);
    for (const event of seen) expect(event).toMatchObject({ kind: "folder", id: orders.id, operation: "move" });

    unsubscribe();
  });
});
