import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTeamMembership, createTeamRow, createTestContext, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;

async function signInAs(email: string) {
  const agent = request.agent(ctx.app);
  await agent.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = ctx.emailSender.getMessage(email);
  if (!message) throw new Error(`No code was sent to ${email}`);
  await agent.post("/api/v1/auth/verify-code").send({ email, code: message.code }).expect(200);
  return agent;
}

beforeEach(async () => {
  ctx = await createTestContext(":memory:", { env: { ADMIN_EMAILS: "test@fluttersea.com" } });
});

afterEach(async () => {
  if (ctx) await ctx.close();
});

describe("team activity history", () => {
  it("records safe collection, request, environment, and shared variable events", async () => {
    const secret = "never-store-this-secret";
    const collection = (await ctx.api.post("/api/v1/collections").send({
      name: "Orders",
      items: [{
        type: "request",
        name: "Create order",
        ...requestFields,
        url: `https://example.com/${secret}`,
        headers: [{ key: "Authorization", value: secret }],
        body: { type: "raw", content: secret },
        auth: { type: "bearer", token: secret },
      }],
    }).expect(201)).body;
    await ctx.api.put(`/api/v1/collections/${collection.id}`).send({ name: "Orders API", description: "" }).expect(200);
    const environment = (await ctx.api.post("/api/v1/environments").send({
      name: "Staging",
      variables: [{ key: "ACCESS_TOKEN", value: secret, enabled: true }],
    }).expect(201)).body;
    await ctx.api.put("/api/v1/variables/global/SHARED_KEY").send({ value: secret }).expect(200);
    await ctx.api.patch("/api/v1/variables/global/SHARED_KEY").send({ key: "RENAMED_KEY", value: secret }).expect(200);

    const viewer = await signInAs("activity-viewer@fluttersea.com");
    await addTeamMembership(ctx.db, "activity-viewer@fluttersea.com", ctx.teamId, "viewer");
    const response = await viewer.get("/api/v1/activity?limit=20").set("X-Team-Id", ctx.teamId).expect(200);
    const entries = response.body.entries as Array<{ actor: string; action: string; resourceName: string; details: unknown }>;

    expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "collection.created",
      "collection.updated",
      "environment.created",
      "variable.created",
      "variable.renamed",
    ]));
    expect(entries.every((entry) => entry.actor === "test@fluttersea.com")).toBe(true);
    expect(entries.find((entry) => entry.action === "variable.renamed")?.resourceName).toBe("RENAMED_KEY");
    expect(JSON.stringify(response.body)).not.toContain(secret);
    expect(environment.name).toBe("Staging");
  });

  it("paginates newest-first without repeats and never exposes another team's events", async () => {
    await ctx.api.post("/api/v1/collections").send({ name: "First" }).expect(201);
    await ctx.api.post("/api/v1/environments").send({ name: "Second", variables: [] }).expect(201);

    const first = await ctx.api.get("/api/v1/activity?limit=1").expect(200);
    expect(first.body.entries).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await ctx.api.get(`/api/v1/activity?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`).expect(200);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.entries[0].id).not.toBe(first.body.entries[0].id);
    expect(second.body.nextCursor).toBeNull();

    const foreignTeamId = await createTeamRow(ctx.db, "Private Activity");
    const foreignUser = await signInAs("activity-outsider@fluttersea.com");
    await addTeamMembership(ctx.db, "activity-outsider@fluttersea.com", foreignTeamId, "member");
    const outsiderEvents = await foreignUser.get("/api/v1/activity").set("X-Team-Id", foreignTeamId).expect(200);
    expect(outsiderEvents.body.entries).toEqual([]);
    await foreignUser.get("/api/v1/activity").set("X-Team-Id", ctx.teamId).expect(404);
  });

  it("does not write activity when a content transaction fails", async () => {
    await ctx.api.post("/api/v1/collections").send({ name: "Existing" }).expect(201);
    await ctx.api.post("/api/v1/collections").send({ name: "Other" }).expect(201);
    const before = (await ctx.api.get("/api/v1/activity?limit=100").expect(200)).body.entries.length;
    const otherId = (await ctx.api.get("/api/v1/collections").expect(200)).body.collections
      .find((collection: { name: string }) => collection.name === "Other").id;

    await ctx.api.put(`/api/v1/collections/${otherId}`).send({ name: "Existing", description: "" }).expect(409);
    const after = (await ctx.api.get("/api/v1/activity?limit=100").expect(200)).body.entries.length;
    expect(after).toBe(before);
  });

  it("rejects malformed cursors and anonymous access", async () => {
    const invalid = await ctx.api.get("/api/v1/activity?cursor=not-a-cursor").expect(400);
    expect(invalid.body.error.code).toBe("ACTIVITY_CURSOR_INVALID");
    await ctx.unauthenticatedApi.get("/api/v1/activity").expect(401);
  });
});
