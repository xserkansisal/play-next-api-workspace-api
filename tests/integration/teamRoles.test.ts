import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTeamMembership, createTeamRow, createTestContext, queryRows, requestFields, type TestContext } from "../helpers.js";

let ctx: TestContext;
let teamId: string;
let viewer: ReturnType<typeof request.agent>;
let member: ReturnType<typeof request.agent>;
let owner: ReturnType<typeof request.agent>;

async function signInAs(email: string) {
  const agent = request.agent(ctx.app);
  await agent.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = ctx.emailSender.getMessage(email);
  if (!message) throw new Error(`No code was sent to ${email}`);
  await agent.post("/api/v1/auth/verify-code").send({ email, code: message.code }).expect(200);
  return agent;
}

async function userId(email: string): Promise<string> {
  const [row] = await queryRows(ctx.db, "SELECT id FROM users WHERE email = ?", [email]);
  return row!.id as string;
}

beforeEach(async () => {
  ctx = await createTestContext(":memory:", { env: { ADMIN_EMAILS: "test@fluttersea.com" } });
  teamId = await createTeamRow(ctx.db, "Payments");
  viewer = await signInAs("viewer@fluttersea.com");
  member = await signInAs("member@fluttersea.com");
  owner = await signInAs("owner@fluttersea.com");
  await addTeamMembership(ctx.db, "viewer@fluttersea.com", teamId, "viewer");
  await addTeamMembership(ctx.db, "member@fluttersea.com", teamId, "member");
  await addTeamMembership(ctx.db, "owner@fluttersea.com", teamId, "owner");
});

afterEach(async () => ctx.close());

describe("team viewer", () => {
  it("reads the team's content but cannot change it", async () => {
    const collection = (await member.post("/api/v1/collections").send({
      name: "Orders",
      items: [{ type: "request", name: "Ping", ...requestFields }],
    }).expect(201)).body;
    const itemId = collection.items[0].id;
    const env = (await member.post("/api/v1/environments").send({ name: "Staging", variables: [] }).expect(201)).body;

    await viewer.get("/api/v1/collections").expect(200);
    await viewer.get(`/api/v1/collections/${collection.id}`).expect(200);
    await viewer.get(`/api/v1/collections/${collection.id}/items/${itemId}`).expect(200);
    await viewer.get("/api/v1/environments").expect(200);
    await viewer.get("/api/v1/trash").expect(200);
    await viewer.get("/api/v1/variables").expect(200);

    const denied = async (call: request.Test) => expect((await call.expect(403)).body.error.code).toBe("TEAM_ROLE_REQUIRED");
    await denied(viewer.post("/api/v1/collections").send({ name: "Nope" }));
    await denied(viewer.put(`/api/v1/collections/${collection.id}`).send({ name: "Renamed" }));
    await denied(viewer.delete(`/api/v1/collections/${collection.id}`));
    await denied(viewer.post(`/api/v1/collections/${collection.id}/items`).send({ type: "folder", name: "F" }));
    await denied(viewer.delete(`/api/v1/collections/${collection.id}/items/${itemId}`));
    await denied(viewer.post("/api/v1/environments").send({ name: "Nope", variables: [] }));
    await denied(viewer.delete(`/api/v1/environments/${env.id}`));
    await denied(viewer.put("/api/v1/variables/global/key").send({ value: "x" }));
    await denied(viewer.post("/api/v1/trash/00000000-0000-4000-8000-0000000000aa/restore").send({}));
  });

  it("may still run collections, use the proxy and keep personal variables", async () => {
    const collection = (await member.post("/api/v1/collections").send({ name: "Orders" }).expect(201)).body;
    await viewer.post(`/api/v1/collections/${collection.id}/run`).send({}).expect(201);
    await viewer.put("/api/v1/variables/user/mine").send({ value: "1" }).expect(200);
    await viewer.put("/api/v1/variables/order").send({ order: ["mine"] }).expect(200);
    await viewer.delete("/api/v1/variables/user/mine").expect(204);
    await viewer.put("/api/v1/presence").send({ clientId: "tab", location: null }).expect(204);
  });
});

describe("team member", () => {
  it("edits content, including shared variables, but cannot manage members", async () => {
    await member.post("/api/v1/collections").send({ name: "Orders" }).expect(201);
    await member.put("/api/v1/variables/global/key").send({ value: "x" }).expect(200);
    const denied = await member.post(`/api/v1/teams/${teamId}/members`).send({ email: "x@fluttersea.com" }).expect(403);
    expect(denied.body.error.code).toBe("TEAM_ROLE_REQUIRED");
    await member.get(`/api/v1/teams/${teamId}/members`).expect(200);
  });
});

describe("team owner", () => {
  it("manages the members of their own team", async () => {
    const added = (await owner.post(`/api/v1/teams/${teamId}/members`).send({ email: "new@fluttersea.com", role: "viewer" }).expect(201)).body;
    expect(added).toMatchObject({ email: "new@fluttersea.com", role: "viewer" });
    await owner.patch(`/api/v1/teams/${teamId}/members/${added.userId}`).send({ role: "member" }).expect(200);
    await owner.patch(`/api/v1/teams/${teamId}/members/${added.userId}`).send({ role: "admin" }).expect(400);
    await owner.delete(`/api/v1/teams/${teamId}/members/${added.userId}`).expect(204);

    const roster = (await owner.get(`/api/v1/teams/${teamId}/members`).expect(200)).body.members;
    expect(roster.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ["owner@fluttersea.com", "owner"],
      ["member@fluttersea.com", "member"],
      ["viewer@fluttersea.com", "viewer"],
    ]);
    const log = (await ctx.api.get(`/api/v1/admin/audit-log?teamId=${teamId}`).expect(200)).body;
    expect(log.entries.map((e: { actor: string }) => e.actor)).toContain("owner@fluttersea.com");
  });

  it("keeps the last owner and cannot touch other teams or the admin panel", async () => {
    const ownerId = await userId("owner@fluttersea.com");
    expect((await owner.delete(`/api/v1/teams/${teamId}/members/${ownerId}`).expect(409)).body.error.code).toBe("TEAM_LAST_OWNER");

    const foreign = await createTeamRow(ctx.db, "Elsewhere");
    await owner.get(`/api/v1/teams/${foreign}/members`).expect(404);
    await owner.post(`/api/v1/teams/${foreign}/members`).send({ email: "x@fluttersea.com" }).expect(404);
    expect((await owner.get("/api/v1/admin/teams").expect(403)).body.error.code).toBe("ADMIN_REQUIRED");
  });

  it("ends the live access of a member they remove", async () => {
    const memberId = await userId("member@fluttersea.com");
    await owner.delete(`/api/v1/teams/${teamId}/members/${memberId}`).expect(204);
    expect((await member.get("/api/v1/collections").set("X-Team-Id", teamId).expect(404)).body.error.code).toBe("TEAM_NOT_FOUND");
  });
});

describe("roles differ per team", () => {
  it("lets a user own one team and only view another", async () => {
    const other = await createTeamRow(ctx.db, "Casino");
    await addTeamMembership(ctx.db, "owner@fluttersea.com", other, "viewer");
    await owner.post("/api/v1/collections").set("X-Team-Id", teamId).send({ name: "Mine" }).expect(201);
    await owner.post("/api/v1/collections").set("X-Team-Id", other).send({ name: "Theirs" }).expect(403);
    const teams = (await owner.get("/api/v1/teams").expect(200)).body.teams;
    expect(teams.map((t: { name: string; role: string }) => [t.name, t.role])).toEqual([["Casino", "viewer"], ["Payments", "owner"]]);
  });
});

describe("system admin", () => {
  it("edits any team's content and manages its members without being a member", async () => {
    await ctx.api.post("/api/v1/collections").set("X-Team-Id", teamId).send({ name: "Admin made" }).expect(201);
    await ctx.api.post(`/api/v1/teams/${teamId}/members`).send({ email: "late@fluttersea.com" }).expect(201);
  });
});
