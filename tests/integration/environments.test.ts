import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { runMigrations } from "../../src/db/client.js";
import { environmentVariables } from "../../src/db/schema.js";
import { createTestContext, queryRows, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(async () => ctx.close());

describe("environments API", () => {
  it("creates, lists, reads, and saves environments with ordered variables", async () => {
    const created = await ctx.api
      .post("/api/v1/environments")
      .send({
        name: "Development",
        variables: [
          { key: "port", value: "8443" },
          { key: "baseUrl", value: "https://dev.example.internal", enabled: false },
        ],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      name: "Development",
      variables: [
        { key: "port", value: "8443", enabled: true, isSecret: false },
        { key: "baseUrl", value: "https://dev.example.internal", enabled: false, isSecret: false },
      ],
    });
    const staging = await ctx.api.post("/api/v1/environments").send({ name: "a-staging" }).expect(201);

    const list = await ctx.api.get("/api/v1/environments").expect(200);
    expect(list.body.environments.map((e: { name: string }) => e.name)).toEqual(["a-staging", "Development"]);

    const saved = await ctx.api
      .put(`/api/v1/environments/${created.body.id}`)
      .send({ name: "Dev", variables: [{ key: "baseUrl", value: "http://localhost" }] })
      .expect(200);
    expect(saved.body.variables).toEqual([{ key: "baseUrl", value: "http://localhost", enabled: true, isSecret: false }]);

    const read = await ctx.api.get(`/api/v1/environments/${created.body.id}`).expect(200);
    expect(read.body).toEqual(saved.body);
    const other = await ctx.api.get(`/api/v1/environments/${staging.body.id}`).expect(200);
    expect(other.body).toEqual(staging.body);
  });

  it("rejects duplicate variable keys and invalid keys without partial saves", async () => {
    const env = await ctx.api
      .post("/api/v1/environments")
      .send({ name: "E", variables: [{ key: "a", value: "1" }] })
      .expect(201);

    for (const variables of [
      [{ key: "a", value: "1" }, { key: "a", value: "2" }],
      [{ key: "", value: "1" }],
      [{ key: "has space", value: "1" }],
      [{ key: "{{x}}", value: "1" }],
      [{ key: "ok", value: 1 }],
    ]) {
      const res = await ctx.api.put(`/api/v1/environments/${env.body.id}`).send({ name: "Changed", variables }).expect(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    const read = await ctx.api.get(`/api/v1/environments/${env.body.id}`).expect(200);
    expect(read.body).toEqual(env.body);
  });

  it("requires active environment names to be unique case-insensitively", async () => {
    const first = await ctx.api.post("/api/v1/environments").send({ name: "Staging" }).expect(201);
    const dup = await ctx.api.post("/api/v1/environments").send({ name: "  STAGING " }).expect(409);
    expect(dup.body.error).toMatchObject({ code: "ENVIRONMENT_NAME_CONFLICT", details: { conflictingId: first.body.id } });

    const other = await ctx.api.post("/api/v1/environments").send({ name: "Prod" }).expect(201);
    await ctx.api.put(`/api/v1/environments/${other.body.id}`).send({ name: "staging" }).expect(409);
    expect((await ctx.api.get(`/api/v1/environments/${other.body.id}`)).body).toEqual(other.body);
    await ctx.api.put(`/api/v1/environments/${first.body.id}`).send({ name: "STAGING" }).expect(200);

    await ctx.api.delete(`/api/v1/environments/${first.body.id}`).expect(204);
    await ctx.api.post("/api/v1/environments").send({ name: "staging" }).expect(201);
  });

  it("trims variable keys and treats them case-sensitively", async () => {
    const res = await ctx.api
      .post("/api/v1/environments")
      .send({ name: "E", variables: [{ key: "  baseUrl  ", value: " keep " }, { key: "a", value: "1" }, { key: "A", value: "2" }] })
      .expect(201);
    expect(res.body.variables.map((v: { key: string; value: string }) => [v.key, v.value])).toEqual([
      ["baseUrl", " keep "],
      ["a", "1"],
      ["A", "2"],
    ]);
    const dup = await ctx.api
      .post("/api/v1/environments")
      .send({ name: "E2", variables: [{ key: "k", value: "1" }, { key: " k ", value: "2" }] })
      .expect(400);
    expect(dup.body.error.code).toBe("VALIDATION_ERROR");
    await ctx.api.post("/api/v1/environments").send({ name: "E3", variables: [{ key: "   ", value: "1" }] }).expect(400);
    await ctx.api.post("/api/v1/environments").send({ name: "E4", variables: [{ key: "a\tb", value: "1" }] }).expect(400);
    await ctx.api.post("/api/v1/environments").send({ name: "E5", variables: [{ key: "a}", value: "1" }] }).expect(400);
  });

  it("adds environment variables atomically, appending rows and allowing disabled duplicate keys", async () => {
    const env = await ctx.api.post("/api/v1/environments").send({
      name: "Append",
      variables: [{ key: "token", value: "old", enabled: false }],
    }).expect(201);

    const added = await ctx.api.post(`/api/v1/environments/${env.body.id}/variables`)
      .send({ key: "token", value: "new", isSecret: true })
      .expect(201);
    expect(added.body.variables).toEqual([
      { key: "token", value: "old", enabled: false, isSecret: false },
      { key: "token", value: "new", enabled: true, isSecret: true },
    ]);

    await ctx.api.post(`/api/v1/environments/${env.body.id}/variables`)
      .send({ key: "token", value: "duplicate" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("VARIABLE_KEY_EXISTS"));
    await ctx.api.post(`/api/v1/environments/${env.body.id}/variables`)
      .send({ key: "token", value: "disabled duplicate", enabled: false })
      .expect(201);

    await ctx.api.post(`/api/v1/environments/00000000-0000-4000-8000-000000000000/variables`)
      .send({ key: "missing", value: "x" })
      .expect(404);
  });

  it("encrypts values at rest, migrates legacy plaintext, and preserves the secret flag", async () => {
    const secret = "secret-environment-value";
    const environment = await ctx.api.post("/api/v1/environments").send({
      name: "Encrypted",
      variables: [{ key: "ACCESS_TOKEN", value: secret, isSecret: true }],
    }).expect(201);
    const row = await queryRows(
      ctx.db,
      "SELECT value, value_encryption_version, is_secret FROM environment_variables WHERE environment_id = ?",
      [environment.body.id],
    );
    expect(String(row[0]?.value)).not.toContain(secret);
    expect(row[0]).toMatchObject({ value_encryption_version: 1, is_secret: 1 });
    expect(environment.body.variables).toEqual([{
      key: "ACCESS_TOKEN",
      value: secret,
      enabled: true,
      isSecret: true,
    }]);

    await ctx.db.$client.query(
      "UPDATE environment_variables SET value = ?, value_encryption_version = NULL WHERE environment_id = ?",
      [secret, environment.body.id],
    );
    await runMigrations(ctx.db, loadEnv({ NODE_ENV: "test" }).ENCRYPTION_KEY);

    const migrated = await queryRows(
      ctx.db,
      "SELECT value, value_encryption_version FROM environment_variables WHERE environment_id = ?",
      [environment.body.id],
    );
    expect(String(migrated[0]?.value)).not.toContain(secret);
    expect(migrated[0]?.value_encryption_version).toBe(1);
    expect((await ctx.api.get(`/api/v1/environments/${environment.body.id}`).expect(200)).body.variables[0])
      .toMatchObject({ value: secret, isSecret: true });

    const copy = (await ctx.api.post(`/api/v1/environments/${environment.body.id}/clone`).expect(201)).body;
    expect(copy.variables).toEqual(environment.body.variables);
    await ctx.api.delete(`/api/v1/environments/${environment.body.id}`).expect(204);
    const restored = await ctx.api.post(`/api/v1/trash/${environment.body.id}/restore`).expect(200);
    expect(restored.body.environment.variables).toEqual(environment.body.variables);
  });

  it("moves an environment to Trash", async () => {
    const env = await ctx.api.post("/api/v1/environments").send({ name: "Gone" }).expect(201);
    await ctx.api.delete(`/api/v1/environments/${env.body.id}`).expect(204);
    await ctx.api.get(`/api/v1/environments/${env.body.id}`).expect(404);
    await ctx.api.put(`/api/v1/environments/${env.body.id}`).send({ name: "x" }).expect(404);
    await ctx.api.delete(`/api/v1/environments/${env.body.id}`).expect(404);
    expect((await ctx.api.get("/api/v1/environments")).body.environments).toEqual([]);
  });
});
