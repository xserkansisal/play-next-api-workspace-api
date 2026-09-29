import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../helpers.js";

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(() => ctx.close());

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
        { key: "port", value: "8443", enabled: true },
        { key: "baseUrl", value: "https://dev.example.internal", enabled: false },
      ],
    });
    const staging = await ctx.api.post("/api/v1/environments").send({ name: "a-staging" }).expect(201);

    const list = await ctx.api.get("/api/v1/environments").expect(200);
    expect(list.body.environments.map((e: { name: string }) => e.name)).toEqual(["a-staging", "Development"]);

    const saved = await ctx.api
      .put(`/api/v1/environments/${created.body.id}`)
      .send({ name: "Dev", variables: [{ key: "baseUrl", value: "http://localhost" }] })
      .expect(200);
    expect(saved.body.variables).toEqual([{ key: "baseUrl", value: "http://localhost", enabled: true }]);

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

  it("moves an environment to Trash", async () => {
    const env = await ctx.api.post("/api/v1/environments").send({ name: "Gone" }).expect(201);
    await ctx.api.delete(`/api/v1/environments/${env.body.id}`).expect(204);
    await ctx.api.get(`/api/v1/environments/${env.body.id}`).expect(404);
    await ctx.api.put(`/api/v1/environments/${env.body.id}`).send({ name: "x" }).expect(404);
    await ctx.api.delete(`/api/v1/environments/${env.body.id}`).expect(404);
    expect((await ctx.api.get("/api/v1/environments")).body.environments).toEqual([]);
  });
});
