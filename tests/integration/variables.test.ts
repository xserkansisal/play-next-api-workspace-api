import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTeamMembership, createTestContext, type TestContext } from "../helpers.js";

async function signInAs(ctx: TestContext, email: string) {
  const agent = request.agent(ctx.app);
  await agent.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = ctx.emailSender.getMessage(email);
  if (!message) throw new Error(`No code was sent to ${email}`);
  await agent.post("/api/v1/auth/verify-code").send({ email, code: message.code }).expect(200);
  await addTeamMembership(ctx.db, email, ctx.teamId);
  return agent;
}

describe("scoped variables", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  it("requires a signed-in user", async () => {
    await ctx.unauthenticatedApi.get("/api/v1/variables").expect(401);
    await ctx.unauthenticatedApi.get("/api/v1/variables/order").expect(401);
    await ctx.unauthenticatedApi.put("/api/v1/variables/order").send({ order: [] }).expect(401);
    await ctx.unauthenticatedApi.post("/api/v1/variables/user").send({ key: "token", value: "x" }).expect(401);
  });

  it("persists a complete display order privately, including names with no API variable row", async () => {
    const other = await signInAs(ctx, "order-private@sisal.com");
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "unchanged" }).expect(200);

    expect((await ctx.api.get("/api/v1/variables/order").expect(200)).body).toEqual({ order: [] });
    const saved = await ctx.api
      .put("/api/v1/variables/order")
      .send({ order: ["environmentOnly", "token", "globalOnly"] })
      .expect(200);
    expect(saved.body).toEqual({ order: ["environmentOnly", "token", "globalOnly"] });
    expect((await ctx.api.get("/api/v1/variables/order").expect(200)).body).toEqual(saved.body);
    expect((await other.get("/api/v1/variables/order").expect(200)).body).toEqual({ order: [] });

    await ctx.api.put("/api/v1/variables/order").send({ order: [] }).expect(200);
    expect((await ctx.api.get("/api/v1/variables/order").expect(200)).body).toEqual({ order: [] });
    expect((await ctx.api.get("/api/v1/variables").expect(200)).body.variables).toEqual([
      expect.objectContaining({ scope: "user", key: "token", value: "unchanged" }),
    ]);
  });

  it("rejects duplicate names, invalid variable keys, and malformed order bodies", async () => {
    const invalidBodies = [
      { order: ["token", "token"] },
      { order: ["two words"] },
      { order: ["{braced}"] },
      { order: [""] },
      { order: "token" },
      { order: ["token"], extra: true },
      {},
    ];

    for (const body of invalidBodies) {
      const response = await ctx.api.put("/api/v1/variables/order").send(body).expect(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect((await ctx.api.get("/api/v1/variables/order").expect(200)).body).toEqual({ order: [] });
  });

  it("starts empty and returns what was written", async () => {
    expect((await ctx.api.get("/api/v1/variables").expect(200)).body).toEqual({ variables: [] });

    const written = await ctx.api.put("/api/v1/variables/user/token").send({ value: "abc" }).expect(200);
    expect(written.body).toMatchObject({ scope: "user", key: "token", value: "abc" });

    const listed = await ctx.api.get("/api/v1/variables").expect(200);
    expect(listed.body.variables).toEqual([expect.objectContaining({ scope: "user", key: "token", value: "abc" })]);
  });

  it("creates scoped variables without overwriting existing keys", async () => {
    const other = await signInAs(ctx, "global-create-other@sisal.com");
    const created = await ctx.api
      .post("/api/v1/variables/user")
      .send({ key: "token", value: "" })
      .expect(201);
    expect(created.body).toMatchObject({ scope: "user", key: "token", value: "" });

    await ctx.api.post("/api/v1/variables/user").send({ key: "token", value: "replacement" }).expect(409);
    await ctx.api.post("/api/v1/variables/global").send({ key: "shared", value: "first" }).expect(201);
    await other.post("/api/v1/variables/global").send({ key: "shared", value: "second" }).expect(409);
    expect((await other.get("/api/v1/variables").expect(200)).body.variables).toEqual([
      expect.objectContaining({ scope: "global", key: "shared", value: "first" }),
    ]);
  });

  it("validates scoped variable create keys and value limits", async () => {
    await ctx.api.post("/api/v1/variables/user").send({ key: "two words", value: "" }).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("VARIABLE_KEY_INVALID"));
    await ctx.api.post("/api/v1/variables/user").send({ key: "ok", value: 1 }).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("VARIABLE_VALUE_INVALID"));
    await ctx.api.post("/api/v1/variables/user").send({ key: "ok", value: "x".repeat(64 * 1024 + 1) }).expect(400)
      .expect(({ body }) => expect(body.error.code).toBe("VARIABLE_VALUE_INVALID"));
  });

  it("replaces a value rather than accumulating readings of the same key", async () => {
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "first" }).expect(200);
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "second" }).expect(200);

    const listed = await ctx.api.get("/api/v1/variables").expect(200);
    expect(listed.body.variables).toHaveLength(1);
    expect(listed.body.variables[0].value).toBe("second");
  });

  it("keeps one person's user-scope value entirely out of another's", async () => {
    const other = await signInAs(ctx, "someone-else@sisal.com");
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "mine" }).expect(200);
    await other.put("/api/v1/variables/user/token").send({ value: "theirs" }).expect(200);

    const mine = await ctx.api.get("/api/v1/variables").expect(200);
    const theirs = await other.get("/api/v1/variables").expect(200);
    expect(mine.body.variables).toEqual([expect.objectContaining({ value: "mine" })]);
    expect(theirs.body.variables).toEqual([expect.objectContaining({ value: "theirs" })]);
  });

  it("shares a global value with everyone and lets either person replace it", async () => {
    const other = await signInAs(ctx, "teammate@sisal.com");
    await ctx.api.put("/api/v1/variables/global/baseUrl").send({ value: "http://one" }).expect(200);

    const seenByOther = await other.get("/api/v1/variables").expect(200);
    expect(seenByOther.body.variables).toEqual([expect.objectContaining({ scope: "global", value: "http://one" })]);

    await other.put("/api/v1/variables/global/baseUrl").send({ value: "http://two" }).expect(200);
    const seenByMe = await ctx.api.get("/api/v1/variables").expect(200);
    expect(seenByMe.body.variables).toEqual([expect.objectContaining({ scope: "global", value: "http://two" })]);
  });

  it("holds the same key at both scopes at once, which is what shadowing needs", async () => {
    await ctx.api.put("/api/v1/variables/global/token").send({ value: "shared" }).expect(200);
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "mine" }).expect(200);

    const listed = await ctx.api.get("/api/v1/variables").expect(200);
    expect(listed.body.variables).toEqual([
      expect.objectContaining({ scope: "user", key: "token", value: "mine" }),
      expect.objectContaining({ scope: "global", key: "token", value: "shared" }),
    ]);
  });

  it("deletes one scope without touching the other", async () => {
    await ctx.api.put("/api/v1/variables/global/token").send({ value: "shared" }).expect(200);
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "mine" }).expect(200);

    await ctx.api.delete("/api/v1/variables/user/token").expect(204);

    const listed = await ctx.api.get("/api/v1/variables").expect(200);
    expect(listed.body.variables).toEqual([expect.objectContaining({ scope: "global", value: "shared" })]);
  });

  it("updates a variable value or atomically renames it", async () => {
    await ctx.api.put("/api/v1/variables/user/token").send({ value: "first" }).expect(200);

    const updated = await ctx.api.patch("/api/v1/variables/user/token").send({ value: "second" }).expect(200);
    expect(updated.body).toMatchObject({ scope: "user", key: "token", value: "second" });

    const renamed = await ctx.api.patch("/api/v1/variables/user/token").send({ key: "authToken" }).expect(200);
    expect(renamed.body).toMatchObject({ scope: "user", key: "authToken", value: "second" });
    expect((await ctx.api.get("/api/v1/variables").expect(200)).body.variables).toEqual([
      expect.objectContaining({ scope: "user", key: "authToken", value: "second" }),
    ]);
  });

  it("does not overwrite an existing variable when a rename conflicts", async () => {
    await ctx.api.put("/api/v1/variables/global/old").send({ value: "old value" }).expect(200);
    await ctx.api.put("/api/v1/variables/global/taken").send({ value: "keep me" }).expect(200);

    const conflict = await ctx.api.patch("/api/v1/variables/global/old").send({ key: "taken" }).expect(409);
    expect(conflict.body.error).toMatchObject({
      code: "VARIABLE_KEY_EXISTS",
      message: 'A global variable named "taken" already exists',
    });
    expect((await ctx.api.get("/api/v1/variables").expect(200)).body.variables).toEqual([
      expect.objectContaining({ scope: "global", key: "old", value: "old value" }),
      expect.objectContaining({ scope: "global", key: "taken", value: "keep me" }),
    ]);
  });

  it("rejects an empty patch and reports missing variables", async () => {
    await ctx.api.patch("/api/v1/variables/user/missing").send({}).expect(400);
    await ctx.api.patch("/api/v1/variables/user/missing").send({ value: "x" }).expect(404);
  });

  it("will not let one person delete another's user-scope value", async () => {
    const other = await signInAs(ctx, "victim@sisal.com");
    await other.put("/api/v1/variables/user/token").send({ value: "theirs" }).expect(200);

    await ctx.api.delete("/api/v1/variables/user/token").expect(404);
    await ctx.api.patch("/api/v1/variables/user/token").send({ key: "renamed" }).expect(404);

    const theirs = await other.get("/api/v1/variables").expect(200);
    expect(theirs.body.variables).toEqual([expect.objectContaining({ value: "theirs" })]);
  });

  it("rejects an unknown scope and a key that could never be referenced as {{key}}", async () => {
    await ctx.api.put("/api/v1/variables/team/token").send({ value: "x" }).expect(400);
    await ctx.api.put("/api/v1/variables/user/two%20words").send({ value: "x" }).expect(400);
    await ctx.api.put("/api/v1/variables/user/%7Bbraced%7D").send({ value: "x" }).expect(400);
  });

  it("announces a global write but never a personal one", async () => {
    const seen: string[] = [];
    const unsubscribe = ctx.subscribe((event) => {
      if (event.kind === "variable") seen.push(`${event.operation}:${event.id}`);
    });
    try {
      await ctx.api.put("/api/v1/variables/user/private").send({ value: "x" }).expect(200);
      await ctx.api.post("/api/v1/variables/user").send({ key: "private-add", value: "x" }).expect(201);
      await ctx.api.post("/api/v1/variables/global").send({ key: "global-add", value: "x" }).expect(201);
      await ctx.api.put("/api/v1/variables/global/shared").send({ value: "x" }).expect(200);
      await ctx.api.patch("/api/v1/variables/global/shared").send({ key: "renamed" }).expect(200);
      await ctx.api.delete("/api/v1/variables/global/renamed").expect(204);
      // A personal value concerns one person: broadcasting it would make every other client
      // refetch for nothing and would tell the team which keys that person holds.
      expect(seen).toEqual([
        "created:global-add",
        "updated:shared",
        "trashed:shared",
        "updated:renamed",
        "trashed:renamed",
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("stores a whole JSON object, which is what a captured game state actually is", async () => {
    const mathState = JSON.stringify({ phase: "base", spins: [1, 2, 3] });
    await ctx.api.put("/api/v1/variables/user/mathState").send({ value: mathState }).expect(200);

    const listed = await ctx.api.get("/api/v1/variables").expect(200);
    expect(listed.body.variables[0].value).toBe(mathState);
  });
});
