import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
let collectionId: string;

beforeEach(async () => {
  ctx = await createTestContext();
  collectionId = (await ctx.api.post("/api/v1/collections").send({ name: "Main", description: "Initial" }).expect(201)).body.id;
});

afterEach(async () => ctx?.close());

describe("version history API", () => {
  it("lists previous collection content and restores it while preserving the replaced state", async () => {
    await ctx.api
      .put(`/api/v1/collections/${collectionId}`)
      .send({ name: "Renamed", description: "Changed", auth: { type: "bearer", token: "new-token" } })
      .expect(200);

    const history = await ctx.api.get(`/api/v1/collections/${collectionId}/versions`).expect(200);
    expect(history.body.versions).toHaveLength(1);
    expect(history.body.versions[0]).toMatchObject({
      snapshot: { name: "Main", description: "Initial" },
      createdBy: "test@fluttersea.com",
    });

    const restored = await ctx.api
      .post(`/api/v1/collections/${collectionId}/versions/${history.body.versions[0].id}/restore`)
      .expect(200);
    expect(restored.body).toMatchObject({ name: "Main", description: "Initial" });
    expect((await ctx.api.get(`/api/v1/collections/${collectionId}`).expect(200)).body.auth).toBeNull();

    const afterRestore = await ctx.api.get(`/api/v1/collections/${collectionId}/versions`).expect(200);
    expect(afterRestore.body.versions).toHaveLength(2);
    expect(afterRestore.body.versions.map((version: { snapshot: unknown }) => version.snapshot)).toContainEqual({
      name: "Renamed",
      description: "Changed",
      auth: { type: "bearer", token: "new-token" },
    });
  });

  it("versions complete request content and restores it without changing the tree", async () => {
    const folder = (
      await ctx.api
        .post(`/api/v1/collections/${collectionId}/items`)
        .send({ type: "folder", name: "Folder" })
        .expect(201)
    ).body;
    const request = (
      await ctx.api
        .post(`/api/v1/collections/${collectionId}/items`)
        .send({
          type: "request",
          name: "Request",
          parentId: folder.id,
          ...requestFields,
          method: "POST",
          url: "/before",
          auth: { type: "bearer", token: "before-token" },
          headers: [{ key: "X-Test", value: "old", enabled: false }],
          body: { type: "json", content: '{"version":1}' },
          preRequestScript: `pm.request.url += "/before";`,
          postResponseScript: `pm.test("old assertion", () => pm.expect(pm.response.code).to.eql(200));`,
        })
        .expect(201)
    ).body;

    await ctx.api
      .put(`/api/v1/collections/${collectionId}/items/${request.id}`)
      .send({
        type: "request",
        name: "Changed request",
        ...requestFields,
        method: "PATCH",
        url: "/after",
        queryParams: [{ key: "q", value: "new" }],
      })
      .expect(200);

    const history = await ctx.api.get(`/api/v1/collections/${collectionId}/items/${request.id}/versions`).expect(200);
    expect(history.body.versions).toHaveLength(1);
    expect(history.body.versions[0].snapshot).toMatchObject({
      type: "request",
      name: "Request",
      method: "POST",
      url: "/before",
      headers: [{ key: "X-Test", value: "old", description: "", enabled: false }],
      body: { type: "json", content: '{"version":1}' },
      auth: { type: "bearer", token: "before-token" },
      preRequestScript: `pm.request.url += "/before";`,
      postResponseScript: `pm.test("old assertion", () => pm.expect(pm.response.code).to.eql(200));`,
    });

    const restored = await ctx.api
      .post(`/api/v1/collections/${collectionId}/items/${request.id}/versions/${history.body.versions[0].id}/restore`)
      .expect(200);
    expect(restored.body).toMatchObject({
      id: request.id,
      collectionId,
      parentId: folder.id,
      name: "Request",
      method: "POST",
      url: "/before",
      headers: [{ key: "X-Test", value: "old", description: "", enabled: false }],
      body: { type: "json", content: '{"version":1}' },
      auth: { type: "bearer", token: "before-token" },
      preRequestScript: `pm.request.url += "/before";`,
      postResponseScript: `pm.test("old assertion", () => pm.expect(pm.response.code).to.eql(200));`,
    });

    const afterRestore = await ctx.api.get(`/api/v1/collections/${collectionId}/items/${request.id}/versions`).expect(200);
    expect(afterRestore.body.versions).toHaveLength(2);
    expect(afterRestore.body.versions.map((version: { snapshot: { name: string } }) => version.snapshot.name)).toContain(
      "Changed request",
    );
  });

  it("versions folder auth settings and restores the prior inheritance policy", async () => {
    const folder = (
      await ctx.api
        .post(`/api/v1/collections/${collectionId}/items`)
        .send({ type: "folder", name: "Secure", auth: { type: "basic", username: "team", password: "secret" } })
        .expect(201)
    ).body;

    await ctx.api
      .put(`/api/v1/collections/${collectionId}/items/${folder.id}`)
      .send({ type: "folder", name: "Secure", auth: null })
      .expect(200);

    const history = await ctx.api.get(`/api/v1/collections/${collectionId}/items/${folder.id}/versions`).expect(200);
    expect(history.body.versions[0].snapshot.auth).toEqual({
      type: "basic",
      username: "team",
      password: "secret",
    });

    const restored = await ctx.api
      .post(`/api/v1/collections/${collectionId}/items/${folder.id}/versions/${history.body.versions[0].id}/restore`)
      .expect(200);
    expect(restored.body.auth).toEqual({ type: "basic", username: "team", password: "secret" });
  });

  it("does not expose versions through a different collection or item", async () => {
    const other = (await ctx.api.post("/api/v1/collections").send({ name: "Other" }).expect(201)).body;
    const item = (
      await ctx.api
        .post(`/api/v1/collections/${collectionId}/items`)
        .send({ type: "folder", name: "Folder" })
        .expect(201)
    ).body;
    await ctx.api.put(`/api/v1/collections/${collectionId}/items/${item.id}`).send({ type: "folder", name: "Renamed" }).expect(200);

    const versionId = (await ctx.api.get(`/api/v1/collections/${collectionId}/items/${item.id}/versions`).expect(200)).body
      .versions[0].id;
    await ctx.api.post(`/api/v1/collections/${other.id}/versions/${versionId}/restore`).expect(404);
    await ctx.api.get(`/api/v1/collections/${collectionId}/items/not-an-item/versions`).expect(404);
  });

  it("snapshots, diffs, and restores the complete collection tree", async () => {
    const request = (
      await ctx.api.post(`/api/v1/collections/${collectionId}/items`)
        .send({ type: "request", name: "Before", ...requestFields, url: "/before" })
        .expect(201)
    ).body;
    await ctx.api.put(`/api/v1/collections/${collectionId}/items/${request.id}`)
      .send({ type: "request", name: "After", ...requestFields, url: "/after" })
      .expect(200);
    const laterFolder = (await ctx.api.post(`/api/v1/collections/${collectionId}/items`)
      .send({ type: "folder", name: "Added later" })
      .expect(201)).body;

    const listing = await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots`).expect(200);
    expect(listing.body.snapshots).toHaveLength(3);
    const firstPage = await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots?limit=2`).expect(200);
    expect(firstPage.body.snapshots).toHaveLength(2);
    expect(firstPage.body.nextOffset).toBe(2);
    const lastPage = await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots?limit=2&offset=2`).expect(200);
    expect(lastPage.body.snapshots).toHaveLength(1);
    expect(lastPage.body.nextOffset).toBeNull();
    const snapshots = await Promise.all(listing.body.snapshots.map(async (entry: { id: string }) =>
      (await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots/${entry.id}`).expect(200)).body,
    ));
    const oldState = snapshots.find((entry: { snapshot: { items: Array<{ name: string }> } }) =>
      entry.snapshot.items[0]?.name === "Before",
    );
    expect(oldState).toBeDefined();

    const diff = await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots/diff`)
      .query({ from: oldState.id, to: "current" })
      .expect(200);
    expect(diff.body.items.added.map((item: { path: string[] }) => item.path)).toContainEqual(["Added later"]);
    expect(diff.body.items.changed).toContainEqual(expect.objectContaining({
      id: request.id,
      fields: expect.arrayContaining(["name", "url"]),
    }));
    expect(diff.body.collectionFields).toEqual([]);

    const restored = await ctx.api.post(`/api/v1/collections/${collectionId}/snapshots/${oldState.id}/restore`).expect(200);
    expect(restored.body.items).toHaveLength(1);
    expect(restored.body.items[0]).toMatchObject({ id: request.id, name: "Before", url: "/before" });
    expect((await ctx.api.get(`/api/v1/collections/${collectionId}/items/${request.id}`).expect(200)).body.name).toBe("Before");
    expect((await ctx.api.get("/api/v1/trash").expect(200)).body.entries).toContainEqual(
      expect.objectContaining({ id: laterFolder.id, name: "Added later", collectionId }),
    );

    const afterRestore = await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots`).expect(200);
    expect(afterRestore.body.snapshots).toHaveLength(4);
    expect(afterRestore.body.snapshots[0].createdBy).toBe("test@fluttersea.com");
  });

  it("rejects restoring a collection snapshot when one of its items has moved elsewhere", async () => {
    const target = (await ctx.api.post("/api/v1/collections").send({ name: "Target" }).expect(201)).body;
    const item = (
      await ctx.api.post(`/api/v1/collections/${collectionId}/items`)
        .send({ type: "request", name: "Moved", ...requestFields })
        .expect(201)
    ).body;
    await ctx.api.post(`/api/v1/collections/${collectionId}/items/${item.id}/move`)
      .send({ targetCollectionId: target.id, parentId: null })
      .expect(200);

    const snapshots = (await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots`).expect(200)).body.snapshots;
    const details = await Promise.all(snapshots.map(async (entry: { id: string }) =>
      (await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots/${entry.id}`).expect(200)).body,
    ));
    const beforeMove = details.find((entry: { snapshot: { items: Array<{ id: string }> } }) =>
      entry.snapshot.items.some((node) => node.id === item.id),
    );
    expect(beforeMove).toBeDefined();
    const snapshotId = beforeMove.id;
    const response = await ctx.api.post(`/api/v1/collections/${collectionId}/snapshots/${snapshotId}/restore`).expect(409);
    expect(response.body.error).toMatchObject({
      code: "SNAPSHOT_ITEM_MOVED",
      details: { itemIds: [item.id] },
    });
    expect((await ctx.api.get(`/api/v1/collections/${target.id}/items/${item.id}`).expect(200)).body.id).toBe(item.id);
  });

  it("reactivates matching items that were moved to Trash after a snapshot", async () => {
    const item = (
      await ctx.api.post(`/api/v1/collections/${collectionId}/items`)
        .send({ type: "request", name: "Recoverable", ...requestFields, url: "/recoverable" })
        .expect(201)
    ).body;
    await ctx.api.delete(`/api/v1/collections/${collectionId}/items/${item.id}`).expect(204);

    const listed = (await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots`).expect(200)).body.snapshots;
    const details = await Promise.all(listed.map(async (entry: { id: string }) =>
      (await ctx.api.get(`/api/v1/collections/${collectionId}/snapshots/${entry.id}`).expect(200)).body,
    ));
    const beforeTrash = details.find((entry: { snapshot: { items: Array<{ id: string }> } }) =>
      entry.snapshot.items.some((node) => node.id === item.id),
    );
    expect(beforeTrash).toBeDefined();

    const restored = await ctx.api.post(`/api/v1/collections/${collectionId}/snapshots/${beforeTrash.id}/restore`).expect(200);
    expect(restored.body.items).toHaveLength(1);
    expect(restored.body.items[0]).toMatchObject({ id: item.id, name: "Recoverable", url: "/recoverable" });
    await ctx.api.get(`/api/v1/collections/${collectionId}/items/${item.id}`).expect(200);
  });
});
