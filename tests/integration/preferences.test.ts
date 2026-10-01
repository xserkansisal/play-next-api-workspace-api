import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../helpers.js";

let ctx: TestContext;

async function signInAs(context: TestContext, email: string) {
  const agent = request.agent(context.app);
  await agent.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = context.emailSender.getMessage(email);
  if (!message) throw new Error(`No code was sent to ${email}`);
  await agent.post("/api/v1/auth/verify-code").send({ email, code: message.code }).expect(200);
  return agent;
}

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => ctx.close());

describe("variable-order preferences API", () => {
  it("requires sign-in and returns null rather than 404 when no preference is saved", async () => {
    await ctx.unauthenticatedApi.get("/api/v1/preferences/variable-order").expect(401);
    await ctx.unauthenticatedApi
      .put("/api/v1/preferences/variable-order")
      .send({ preferences: {} })
      .expect(401);

    expect((await ctx.api.get("/api/v1/preferences/variable-order").expect(200)).body).toEqual({
      preferences: null,
    });
  });

  it("stores the complete document unchanged and only for the signed-in user", async () => {
    const other = await signInAs(ctx, "preference-other@sisal.com");
    const preferences = {
      version: 1,
      sort: { field: "value", direction: "desc" },
      manual: {
        user: ["token", "baseUrl"],
        global: ["tenant"],
        environments: { "missing-environment-id": ["host", "port"] },
      },
      updatedAt: "2026-10-01T11:20:00.000Z",
      futureField: { preserved: true },
    };

    expect(
      (await ctx.api.put("/api/v1/preferences/variable-order").send({ preferences }).expect(200)).body,
    ).toEqual({ preferences });
    expect((await ctx.api.get("/api/v1/preferences/variable-order").expect(200)).body).toEqual({
      preferences,
    });
    expect((await other.get("/api/v1/preferences/variable-order").expect(200)).body).toEqual({
      preferences: null,
    });

    const updated = { ...preferences, updatedAt: "2026-10-01T11:21:00.000Z" };
    expect(
      (await ctx.api.put("/api/v1/preferences/variable-order").send({ preferences: updated }).expect(200)).body,
    ).toEqual({ preferences: updated });
  });

  it("rejects invalid documents with the preference-specific error", async () => {
    const invalidDocuments = [
      {},
      { version: 2, sort: null, manual: { user: [], global: [], environments: {} }, updatedAt: "now" },
      { version: 1, sort: { field: "name", direction: "asc" }, manual: { user: [], global: [], environments: {} }, updatedAt: "now" },
      { version: 1, sort: null, manual: { user: ["x".repeat(257)], global: [], environments: {} }, updatedAt: "now" },
    ];

    for (const preferences of invalidDocuments) {
      const response = await ctx.api
        .put("/api/v1/preferences/variable-order")
        .send({ preferences })
        .expect(400);
      expect(response.body.error.code).toBe("PREFERENCES_INVALID");
      expect(response.body.error.message).toBe("Variable order preferences are invalid");
    }
    expect((await ctx.api.get("/api/v1/preferences/variable-order").expect(200)).body).toEqual({
      preferences: null,
    });
  });

  it("returns 413 when the request body exceeds 256 KB", async () => {
    const response = await ctx.api
      .put("/api/v1/preferences/variable-order")
      .send({
        preferences: {
          version: 1,
          sort: null,
          manual: { user: [], global: [], environments: {} },
          updatedAt: "now",
          extra: "x".repeat(256 * 1024),
        },
      })
      .expect(413);
    expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});
