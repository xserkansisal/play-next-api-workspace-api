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
      createdBy: "test@sisal.com",
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
});
