import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.close());

function failOn(table: string, event: "INSERT" | "UPDATE" | "DELETE") {
  ctx.db.$client.exec(
    `CREATE TRIGGER fail_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`,
  );
}

function snapshot() {
  const tables = ["collections", "items", "request_details", "request_query_params", "request_headers", "environments", "environment_variables"];
  return Object.fromEntries(tables.map((t) => [t, ctx.db.$client.prepare(`SELECT * FROM ${t}`).all()]));
}

describe("persistence across reopen", () => {
  it("keeps collections, items, environments, and Trash state in the SQLite file", async () => {
    const tmp = createTempDir();
    const path = join(tmp.dir, "nested", "api.sqlite");
    try {
      const first = createTestContext(path);
      const col = (
        await first.api
          .post("/api/v1/collections")
          .send({ name: "Persisted", items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields, headers: [{ key: "a", value: "1" }] }] }] })
          .expect(201)
      ).body;
      const env = (await first.api.post("/api/v1/environments").send({ name: "E", variables: [{ key: "k", value: "v" }] }).expect(201)).body;
      const gone = (await first.api.post("/api/v1/environments").send({ name: "Gone" }).expect(201)).body;
      await first.api.delete(`/api/v1/environments/${gone.id}`).expect(204);
      first.close();

      const second = createTestContext(path);
      try {
        expect((await second.api.get(`/api/v1/collections/${col.id}`).expect(200)).body).toEqual(col);
        expect((await second.api.get(`/api/v1/environments/${env.id}`).expect(200)).body).toEqual(env);
        expect((await second.api.get("/api/v1/trash").expect(200)).body.entries.map((e: { id: string }) => e.id)).toEqual([gone.id]);
      } finally {
        second.close();
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe("transaction atomicity", () => {
  it("rolls back a request save when a later statement fails", async () => {
    const col = (await ctx.api.post("/api/v1/collections").send({ name: "C" }).expect(201)).body;
    const req = (
      await ctx.api
        .post(`/api/v1/collections/${col.id}/items`)
        .send({ type: "request", name: "R", ...requestFields, headers: [{ key: "old", value: "1" }] })
        .expect(201)
    ).body;
    const before = snapshot();
    failOn("request_headers", "INSERT");

    await ctx.api
      .put(`/api/v1/collections/${col.id}/items/${req.id}`)
      .send({ type: "request", name: "Renamed", ...requestFields, headers: [{ key: "new", value: "2" }] })
      .expect(500);
    expect(snapshot()).toEqual(before);
  });

  it("rolls back a nested collection create when a deep insert fails", async () => {
    failOn("request_query_params", "INSERT");
    await ctx.api
      .post("/api/v1/collections")
      .send({ name: "C", items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields, queryParams: [{ key: "q", value: "1" }] }] }] })
      .expect(500);
    expect(Object.values(snapshot()).every((rows) => rows.length === 0)).toBe(true);
  });

  it("rolls back a subtree Trash move and a subtree restore when a step fails", async () => {
    const col = (
      await ctx.api
        .post("/api/v1/collections")
        .send({ name: "C", items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields }] }] })
        .expect(201)
    ).body;
    let before = snapshot();
    failOn("collections", "UPDATE");
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(500);
    expect(snapshot()).toEqual(before);

    ctx.db.$client.exec("DROP TRIGGER fail_collections_update");
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(204);
    before = snapshot();
    ctx.db.$client.exec(
      "CREATE TRIGGER fail_restore BEFORE UPDATE ON items WHEN NEW.deleted_at IS NULL BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    );
    await ctx.api.post(`/api/v1/trash/${col.id}/restore`).send({ collectionName: "Renamed" }).expect(500);
    expect(snapshot()).toEqual(before);
  });

  it("rolls back an environment save when variable insertion fails", async () => {
    const env = (await ctx.api.post("/api/v1/environments").send({ name: "E", variables: [{ key: "a", value: "1" }] }).expect(201)).body;
    const before = snapshot();
    failOn("environment_variables", "INSERT");
    await ctx.api.put(`/api/v1/environments/${env.id}`).send({ name: "E2", variables: [{ key: "b", value: "2" }] }).expect(500);
    expect(snapshot()).toEqual(before);
  });
});
