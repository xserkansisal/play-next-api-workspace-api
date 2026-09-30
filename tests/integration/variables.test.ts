import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../helpers.js";

async function signInAs(ctx: TestContext, email: string) {
  const agent = request.agent(ctx.app);
  await agent.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = ctx.emailSender.getMessage(email);
  if (!message) throw new Error(`No code was sent to ${email}`);
  await agent.post("/api/v1/auth/verify-code").send({ email, code: message.code }).expect(200);
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
  });

  it("starts empty and returns what was written", async () => {
    expect((await ctx.api.get("/api/v1/variables").expect(200)).body).toEqual({ variables: [] });

    const written = await ctx.api.put("/api/v1/variables/user/token").send({ value: "abc" }).expect(200);
    expect(written.body).toMatchObject({ scope: "user", key: "token", value: "abc" });

    const listed = await ctx.api.get("/api/v1/variables").expect(200);
    expect(listed.body.variables).toEqual([expect.objectContaining({ scope: "user", key: "token", value: "abc" })]);
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

  it("will not let one person delete another's user-scope value", async () => {
    const other = await signInAs(ctx, "victim@sisal.com");
    await other.put("/api/v1/variables/user/token").send({ value: "theirs" }).expect(200);

    await ctx.api.delete("/api/v1/variables/user/token").expect(404);

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
    const unsubscribe = ctx.events.subscribe((event) => {
      if (event.kind === "variable") seen.push(`${event.operation}:${event.id}`);
    });
    try {
      await ctx.api.put("/api/v1/variables/user/private").send({ value: "x" }).expect(200);
      await ctx.api.put("/api/v1/variables/global/shared").send({ value: "x" }).expect(200);
      await ctx.api.delete("/api/v1/variables/global/shared").expect(204);
      // A personal value concerns one person: broadcasting it would make every other client
      // refetch for nothing and would tell the team which keys that person holds.
      expect(seen).toEqual(["updated:shared", "trashed:shared"]);
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
