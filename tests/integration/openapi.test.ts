import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { createTestContext, type TestContext } from "../helpers.js";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  if (ctx) await ctx.close();
});

const spec = {
  openapi: "3.1.0",
  info: { title: "Orders API", description: "Orders service" },
  servers: [{ url: "https://api.example.test/v1" }],
  tags: [{ name: "Orders", description: "Order operations" }],
  paths: {
    "/orders/{orderId}": {
      get: {
        tags: ["Orders"],
        operationId: "readOrder",
        parameters: [{ name: "orderId", in: "path", required: true, schema: { type: "string" } }],
      },
      options: {},
    },
  },
};

describe("OpenAPI import", () => {
  it("creates a collection from a JSON spec and publishes a collection event", async () => {
    const events: string[] = [];
    ctx.subscribe((event) => events.push(event.kind));

    const response = await ctx.api.post("/api/v1/collections/openapi").send({ spec }).expect(201);

    expect(response.body).toMatchObject({
      collection: {
        name: "Orders API",
        description: "Orders service",
        items: [{
          type: "folder",
          name: "Orders",
          description: "Order operations",
          items: [{ type: "request", name: "readOrder", url: "https://api.example.test/v1/orders/{{orderId}}" }],
        }],
      },
      warnings: [{ code: "UNSUPPORTED_METHOD", method: "OPTIONS", path: "/orders/{orderId}" }],
    });
    expect(events).toContain("collection");
  });

  it("imports a YAML spec into an existing collection with dry-run and apply semantics", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({ name: "Existing" }).expect(201)).body;
    const yaml = `
openapi: 3.0.3
info:
  title: Imported
paths:
  /health:
    get:
      operationId: health
`;

    const preview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/import/openapi`)
      .send({ spec: yaml, dryRun: true })
      .expect(200);
    expect(preview.body).toMatchObject({
      dryRun: true,
      created: { folders: 1, requests: 1 },
      roots: [],
    });
    expect(preview.body.warnings).toEqual([]);

    const applied = await ctx.api
      .post(`/api/v1/collections/${collection.id}/import/openapi`)
      .send({ spec: yaml })
      .expect(201);
    expect(applied.body).toMatchObject({ dryRun: false, created: { folders: 1, requests: 1 } });
    expect(applied.body.roots).toHaveLength(1);
    const tree = (await ctx.api.get(`/api/v1/collections/${collection.id}`).expect(200)).body;
    expect(tree.items[0].items[0]).toMatchObject({ name: "health", method: "GET", url: "{{baseUrl}}/health" });
  });

  it("does not fetch external references and requires authentication", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({ name: "Existing" }).expect(201)).body;
    await ctx.api
      .post(`/api/v1/collections/${collection.id}/import/openapi`)
      .send({
        spec: {
          openapi: "3.1.0",
          info: { title: "External ref" },
          paths: { "/": { get: { parameters: [{ $ref: "https://example.test/parameter.yaml" }] } } },
        },
      })
      .expect(400);
    await ctx.unauthenticatedApi.post("/api/v1/collections/openapi").send({ spec }).expect(401);
  });

  it("downloads collection exports as OpenAPI JSON or YAML", async () => {
    const collection = (
      await ctx.api.post("/api/v1/collections").send({
        name: "Export me",
        items: [{ type: "request", name: "Health", method: "GET", url: "{{baseUrl}}/health" }],
      }).expect(201)
    ).body;

    const json = await ctx.api
      .get(`/api/v1/collections/${collection.id}/export/openapi`)
      .expect(200)
      .expect("Content-Disposition", /export-me-openapi\.json/);
    expect(json.body.openapi).toBe("3.1.0");
    expect(json.body.paths["/health"].get.summary).toBe("Health");

    const yaml = await ctx.api
      .get(`/api/v1/collections/${collection.id}/export/openapi?version=3.0&format=yaml`)
      .expect(200)
      .expect("Content-Disposition", /export-me-openapi\.yaml/);
    expect(parseDocument(yaml.text).toJS()).toMatchObject({
      openapi: "3.0.3",
      paths: { "/health": { get: { summary: "Health" } } },
    });
  });

  it("previews and applies source tracking, then reports unchanged operations", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({ name: "Sync target" }).expect(201)).body;
    const syncSpec = {
      openapi: "3.1.0",
      info: { title: "Health API" },
      paths: { "/health": { get: { operationId: "getHealth", summary: "Health" } } },
    };
    const preview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: syncSpec })
      .expect(200);
    expect(preview.body).toMatchObject({
      linked: false,
      changes: [{ key: "operationId:getHealth", kind: "add", method: "GET", path: "/health" }],
    });

    await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({ spec: syncSpec, previewToken: preview.body.previewToken })
      .expect(200)
      .then((response) => expect(response.body.applied).toMatchObject({ added: 1 }));

    const unchanged = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: syncSpec })
      .expect(200);
    expect(unchanged.body.linked).toBe(true);
    expect(unchanged.body.changes).toMatchObject([{ key: "operationId:getHealth", kind: "unchanged" }]);
  });

  it("requires a fresh preview when the collection changes before apply", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({ name: "Stale plan" }).expect(201)).body;
    const syncSpec = {
      openapi: "3.1.0",
      info: { title: "Health API" },
      paths: { "/health": { get: { operationId: "getHealth" } } },
    };
    const preview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: syncSpec })
      .expect(200);
    await ctx.api
      .post(`/api/v1/collections/${collection.id}/items`)
      .send({ type: "request", name: "Concurrent request", method: "GET", url: "/another" })
      .expect(201);

    const stale = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({ spec: syncSpec, previewToken: preview.body.previewToken })
      .expect(409);
    expect(stale.body.error.code).toBe("OPENAPI_SYNC_PREVIEW_STALE");
  });

  it("moves a tracked request when its source tag changes", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({ name: "Move target" }).expect(201)).body;
    const makeSpec = (tag: string) => ({
      openapi: "3.1.0",
      info: { title: "Move API" },
      tags: [{ name: tag }],
      paths: { "/health": { get: { operationId: "getHealth", tags: [tag] } } },
    });
    const initial = makeSpec("Health");
    const initialPreview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: initial })
      .expect(200);
    await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({ spec: initial, previewToken: initialPreview.body.previewToken })
      .expect(200);

    const updated = makeSpec("Status");
    const preview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: updated })
      .expect(200);
    expect(preview.body.changes).toMatchObject([{
      key: "operationId:getHealth",
      kind: "move",
      beforeFolderPath: ["Health"],
      afterFolderPath: ["Status"],
      changedFields: ["folderPath"],
    }]);

    const applied = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({ spec: updated, previewToken: preview.body.previewToken })
      .expect(200);
    expect(applied.body.applied.moved).toBe(1);
    const tree = (await ctx.api.get(`/api/v1/collections/${collection.id}`).expect(200)).body;
    expect(tree.items.find((folder: { name: string }) => folder.name === "Status").items)
      .toMatchObject([{ name: "getHealth" }]);
  });

  it("preserves auth on an existing destination folder", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({
      name: "Folder auth target",
      items: [{
        type: "folder",
        name: "health",
        auth: { type: "bearer", token: "local-token" },
        items: [],
      }],
    }).expect(201)).body;
    const syncSpec = {
      openapi: "3.1.0",
      info: { title: "Folder auth API" },
      paths: {
        "/health": {
          get: {
            operationId: "getHealth",
            tags: ["Health"],
            "x-play-next-folder-auth": [{ type: "bearer", token: "source-token" }],
          },
        },
      },
    };
    const preview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: syncSpec })
      .expect(200);
    await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({ spec: syncSpec, previewToken: preview.body.previewToken })
      .expect(200);

    const tree = (await ctx.api.get(`/api/v1/collections/${collection.id}`).expect(200)).body;
    expect(tree.items.find((folder: { name: string }) => folder.name === "health").auth)
      .toEqual({ type: "bearer", token: "local-token" });
    const unchanged = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: syncSpec })
      .expect(200);
    expect(unchanged.body.changes).toMatchObject([{ kind: "unchanged" }]);
  });

  it("reports only unselected deletions as pending after apply", async () => {
    const collection = (await ctx.api.post("/api/v1/collections").send({ name: "Delete target" }).expect(201)).body;
    const initial = {
      openapi: "3.1.0",
      info: { title: "Delete API" },
      paths: {
        "/health": { get: { operationId: "getHealth" } },
        "/ready": { get: { operationId: "getReady" } },
      },
    };
    const firstPreview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: initial })
      .expect(200);
    await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({ spec: initial, previewToken: firstPreview.body.previewToken })
      .expect(200);

    const revised = {
      openapi: "3.1.0",
      info: { title: "Delete API" },
      paths: { "/ready": { get: { operationId: "getReady" } } },
    };
    const preview = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/preview`)
      .send({ spec: revised })
      .expect(200);
    const deletion = preview.body.changes.find((change: { kind: string }) => change.kind === "delete");
    expect(deletion).toBeDefined();

    const applied = await ctx.api
      .post(`/api/v1/collections/${collection.id}/sync/openapi/apply`)
      .send({
        spec: revised,
        previewToken: preview.body.previewToken,
        deleteItemIds: [deletion.itemId],
      })
      .expect(200);
    expect(applied.body.applied.deleted).toBe(1);
    expect(applied.body.pending).toEqual([]);
  });
});
