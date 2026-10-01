import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDir, createTestContext, dropTestDatabase, queryRows, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => ctx.close());

async function failOn(table: string, event: "INSERT" | "UPDATE" | "DELETE") {
  await ctx.db.$client.query(
    `CREATE TRIGGER fail_${table}_${event.toLowerCase()} BEFORE ${event} ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected failure'`,
  );
}

async function snapshot() {
  const tables = ["collections", "items", "request_details", "request_query_params", "request_headers", "environments", "environment_variables"];
  const rows = await Promise.all(tables.map((table) => queryRows(ctx.db, `SELECT * FROM ${table} ORDER BY 1`)));
  return Object.fromEntries(tables.map((table, index) => [table, rows[index]!]));
}

describe("persistence across reopen", () => {
  it("keeps collections, items, environments, and Trash state in MySQL across pool reopen", async () => {
    const tmp = createTempDir();
    const path = join(tmp.dir, "nested", "api.sqlite");
    try {
      const first = await createTestContext(path);
      const col = (
        await first.api
          .post("/api/v1/collections")
          .send({ name: "Persisted", items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields, headers: [{ key: "a", value: "1" }] }] }] })
          .expect(201)
      ).body;
      const env = (await first.api.post("/api/v1/environments").send({ name: "E", variables: [{ key: "k", value: "v" }] }).expect(201)).body;
      const gone = (await first.api.post("/api/v1/environments").send({ name: "Gone" }).expect(201)).body;
      await first.api.delete(`/api/v1/environments/${gone.id}`).expect(204);
      await first.close();

      const second = await createTestContext(path);
      try {
        expect((await second.api.get(`/api/v1/collections/${col.id}`).expect(200)).body).toEqual(col);
        expect((await second.api.get(`/api/v1/environments/${env.id}`).expect(200)).body).toEqual(env);
        expect((await second.api.get("/api/v1/trash").expect(200)).body.entries.map((e: { id: string }) => e.id)).toEqual([gone.id]);
      } finally {
        await second.close();
      }
    } finally {
      await dropTestDatabase(path);
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
    const before = await snapshot();
    await failOn("request_headers", "INSERT");

    await ctx.api
      .put(`/api/v1/collections/${col.id}/items/${req.id}`)
      .send({ type: "request", name: "Renamed", ...requestFields, headers: [{ key: "new", value: "2" }] })
      .expect(500);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back a nested collection create when a deep insert fails", async () => {
    await failOn("request_query_params", "INSERT");
    await ctx.api
      .post("/api/v1/collections")
      .send({ name: "C", items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields, queryParams: [{ key: "q", value: "1" }] }] }] })
      .expect(500);
    expect(Object.values(await snapshot()).every((rows) => rows.length === 0)).toBe(true);
  });

  it("rolls back a subtree Trash move and a subtree restore when a step fails", async () => {
    const col = (
      await ctx.api
        .post("/api/v1/collections")
        .send({ name: "C", items: [{ type: "folder", name: "F", items: [{ type: "request", name: "R", ...requestFields }] }] })
        .expect(201)
    ).body;
    let before = await snapshot();
    await failOn("collections", "UPDATE");
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(500);
    expect(await snapshot()).toEqual(before);

    await ctx.db.$client.query("DROP TRIGGER fail_collections_update");
    await ctx.api.delete(`/api/v1/collections/${col.id}`).expect(204);
    before = await snapshot();
    await ctx.db.$client.query(
      "CREATE TRIGGER fail_restore BEFORE UPDATE ON items FOR EACH ROW BEGIN IF NEW.deleted_at IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'injected failure'; END IF; END",
    );
    await ctx.api.post(`/api/v1/trash/${col.id}/restore`).send({ collectionName: "Renamed" }).expect(500);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back an environment save when variable insertion fails", async () => {
    const env = (await ctx.api.post("/api/v1/environments").send({ name: "E", variables: [{ key: "a", value: "1" }] }).expect(201)).body;
    const before = await snapshot();
    await failOn("environment_variables", "INSERT");
    await ctx.api.put(`/api/v1/environments/${env.id}`).send({ name: "E2", variables: [{ key: "b", value: "2" }] }).expect(500);
    expect(await snapshot()).toEqual(before);
  });
});
