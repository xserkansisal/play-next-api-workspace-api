import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTeamMembership, createTeamRow, createTestContext, queryRows, requestFields, type TestContext } from "../helpers.js";
import { connectSse, startServer, waitUntil, type RunningServer, type SseClient } from "../sse.js";

let ctx: TestContext;
let otherTeamId: string;

async function signInAs(email: string) {
  const agent = request.agent(ctx.app);
  await agent.post("/api/v1/auth/request-code").send({ email }).expect(202);
  const message = ctx.emailSender.getMessage(email);
  if (!message) throw new Error(`No code was sent to ${email}`);
  await agent.post("/api/v1/auth/verify-code").send({ email, code: message.code }).expect(200);
  return agent;
}

/** Requests as the default test user, who is now in two teams and must name one. */
const inTeam = (teamId: string) => ({
  get: (url: string) => ctx.api.get(url).set("X-Team-Id", teamId),
  post: (url: string) => ctx.api.post(url).set("X-Team-Id", teamId),
  put: (url: string) => ctx.api.put(url).set("X-Team-Id", teamId),
  delete: (url: string) => ctx.api.delete(url).set("X-Team-Id", teamId),
});

beforeEach(async () => {
  ctx = await createTestContext(":memory:", { env: { ADMIN_EMAILS: "test@sisal.com" } });
  otherTeamId = await createTeamRow(ctx.db, "Payments");
  await addTeamMembership(ctx.db, "test@sisal.com", otherTeamId, "member");
});

afterEach(async () => ctx.close());

describe("choosing a team", () => {
  it("requires a team when the user belongs to several and selects the only one automatically", async () => {
    const missing = await ctx.api.get("/api/v1/collections").expect(400);
    expect(missing.body.error.code).toBe("TEAM_CONTEXT_REQUIRED");
    await inTeam(ctx.teamId).get("/api/v1/collections").expect(200);
    await ctx.api.get(`/api/v1/collections?teamId=${otherTeamId}`).expect(200);

    const single = await signInAs("single@sisal.com");
    await addTeamMembership(ctx.db, "single@sisal.com", otherTeamId);
    await single.get("/api/v1/collections").expect(200);
  });

  it("refuses users without a team and teams the user is not in", async () => {
    const lonely = await signInAs("lonely@sisal.com");
    expect((await lonely.get("/api/v1/environments").expect(403)).body.error.code).toBe("TEAM_MEMBERSHIP_REQUIRED");
    expect((await lonely.get("/api/v1/variables").set("X-Team-Id", ctx.teamId).expect(404)).body.error.code)
      .toBe("TEAM_NOT_FOUND");
    expect((await inTeam("not-a-team").get("/api/v1/collections").expect(404)).body.error.code).toBe("TEAM_NOT_FOUND");
    expect((await inTeam("x".repeat(100)).get("/api/v1/collections").expect(404)).body.error.code).toBe("TEAM_NOT_FOUND");
    // Teams and preferences are not team-scoped and stay reachable for everyone.
    await lonely.get("/api/v1/teams").expect(200);
  });

  it("does not grant system admins access to teams they are not in", async () => {
    const foreign = await createTeamRow(ctx.db, "Bingo");
    await inTeam(foreign).get("/api/v1/collections").expect(404);
  });

  it("stops serving a team as soon as it is archived", async () => {
    await ctx.api.post(`/api/v1/admin/teams/${otherTeamId}/archive`).expect(200);
    expect((await inTeam(otherTeamId).get("/api/v1/collections").expect(404)).body.error.code).toBe("TEAM_NOT_FOUND");
    // Only one active team is left, so it is selected without a header.
    await ctx.api.get("/api/v1/collections").expect(200);
  });
});

describe("team isolation", () => {
  it("keeps collections, their items and runs inside their team", async () => {
    const a = inTeam(ctx.teamId);
    const b = inTeam(otherTeamId);
    const collection = (await a.post("/api/v1/collections").send({
      name: "Shared name",
      items: [{ type: "request", name: "Ping", ...requestFields }],
    }).expect(201)).body;
    const itemId = collection.items[0].id;

    // The same name is free in another team.
    await b.post("/api/v1/collections").send({ name: "Shared name" }).expect(201);
    await a.post("/api/v1/collections").send({ name: "Shared name" }).expect(409);

    expect((await a.get("/api/v1/collections").expect(200)).body.collections).toHaveLength(1);
    expect((await b.get("/api/v1/collections").expect(200)).body.collections).toHaveLength(1);
    expect((await b.get("/api/v1/collections").expect(200)).body.collections[0].id).not.toBe(collection.id);

    await b.get(`/api/v1/collections/${collection.id}`).expect(404);
    await b.put(`/api/v1/collections/${collection.id}`).send({ name: "Stolen", description: "" }).expect(404);
    await b.delete(`/api/v1/collections/${collection.id}`).expect(404);
    await b.get(`/api/v1/collections/${collection.id}/items/${itemId}`).expect(404);
    await b.get(`/api/v1/collections/${collection.id}/versions`).expect(404);
    await b.post(`/api/v1/collections/${collection.id}/clone`).send({}).expect(404);
    await b.get(`/api/v1/collections/${collection.id}/runs`).expect(404);
    await b.post(`/api/v1/collections/${collection.id}/run`).send({}).expect(404);
    await a.get(`/api/v1/collections/${collection.id}`).expect(200);
  });

  it("refuses to move an item into another team's collection", async () => {
    const source = (await inTeam(ctx.teamId).post("/api/v1/collections").send({
      name: "Source",
      items: [{ type: "folder", name: "Folder" }],
    }).expect(201)).body;
    const target = (await inTeam(otherTeamId).post("/api/v1/collections").send({ name: "Target" }).expect(201)).body;

    const moved = await inTeam(ctx.teamId)
      .post(`/api/v1/collections/${source.id}/items/${source.items[0].id}/move`)
      .send({ targetCollectionId: target.id, parentId: null })
      .expect(404);
    expect(moved.body.error.code).toBe("TARGET_NOT_FOUND");
  });

  it("keeps environments inside their team, also when running a collection", async () => {
    const environment = (await inTeam(otherTeamId).post("/api/v1/environments").send({
      name: "Staging",
      variables: [{ key: "baseUrl", value: "https://other.test" }],
    }).expect(201)).body;
    await inTeam(ctx.teamId).post("/api/v1/environments").send({ name: "Staging" }).expect(201);

    await inTeam(ctx.teamId).get(`/api/v1/environments/${environment.id}`).expect(404);
    expect((await inTeam(ctx.teamId).get("/api/v1/environments").expect(200)).body.environments)
      .not.toContainEqual(expect.objectContaining({ id: environment.id }));

    const collection = (await inTeam(ctx.teamId).post("/api/v1/collections").send({
      name: "Runner",
      items: [{ type: "request", name: "Ping", ...requestFields, url: "{{baseUrl}}/ping" }],
    }).expect(201)).body;
    await inTeam(ctx.teamId)
      .post(`/api/v1/collections/${collection.id}/run`)
      .send({ environmentId: environment.id })
      .expect(404);
  });

  it("shares global variables within a team only, while personal ones follow the user", async () => {
    await inTeam(ctx.teamId).put("/api/v1/variables/global/host").send({ value: "default-host" }).expect(200);
    await inTeam(otherTeamId).put("/api/v1/variables/global/host").send({ value: "payments-host" }).expect(200);
    await inTeam(ctx.teamId).put("/api/v1/variables/user/token").send({ value: "mine" }).expect(200);

    const variablesIn = async (teamId: string) =>
      (await inTeam(teamId).get("/api/v1/variables").expect(200)).body.variables
        .map((variable: { scope: string; key: string; value: string }) => `${variable.scope}:${variable.key}=${variable.value}`)
        .sort();
    expect(await variablesIn(ctx.teamId)).toEqual(["global:host=default-host", "user:token=mine"]);
    expect(await variablesIn(otherTeamId)).toEqual(["global:host=payments-host", "user:token=mine"]);

    await inTeam(otherTeamId).delete("/api/v1/variables/global/host").expect(204);
    expect(await variablesIn(ctx.teamId)).toEqual(["global:host=default-host", "user:token=mine"]);
  });

  it("lists and restores Trash per team", async () => {
    const collection = (await inTeam(otherTeamId).post("/api/v1/collections").send({ name: "Gone" }).expect(201)).body;
    await inTeam(otherTeamId).delete(`/api/v1/collections/${collection.id}`).expect(204);

    expect((await inTeam(ctx.teamId).get("/api/v1/trash").expect(200)).body.entries).toEqual([]);
    expect((await inTeam(otherTeamId).get("/api/v1/trash").expect(200)).body.entries).toHaveLength(1);
    await inTeam(ctx.teamId).post(`/api/v1/trash/${collection.id}/restore`).send({}).expect(404);
    await inTeam(otherTeamId).post(`/api/v1/trash/${collection.id}/restore`).send({}).expect(200);
  });

  it("will not delete a team that still owns resources", async () => {
    const collection = (await inTeam(otherTeamId).post("/api/v1/collections").send({ name: "Keep" }).expect(201)).body;
    await inTeam(otherTeamId).delete(`/api/v1/collections/${collection.id}`).expect(204);
    await ctx.api.post(`/api/v1/admin/teams/${otherTeamId}/archive`).expect(200);
    // Even a trashed collection still belongs to the team.
    expect((await ctx.api.delete(`/api/v1/admin/teams/${otherTeamId}`).expect(409)).body.error.code).toBe("TEAM_NOT_EMPTY");
  });
});

describe("team event streams", () => {
  let server: RunningServer;
  const clients: SseClient[] = [];

  beforeEach(async () => {
    server = await startServer(ctx.app);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
  });

  async function connectReady(teamId: string) {
    const client = await connectSse(server.url, { Cookie: ctx.sessionCookie, "X-Team-Id": teamId });
    clients.push(client);
    await client.waitFor((frames) => frames.some((frame) => frame.event === "ready"));
    return client;
  }

  it("delivers a team's changes only to streams watching that team", async () => {
    const defaultStream = await connectReady(ctx.teamId);
    const otherStream = await connectReady(otherTeamId);

    const created = (await inTeam(otherTeamId).post("/api/v1/collections").send({ name: "Live" }).expect(201)).body;
    await otherStream.waitFor(() => otherStream.changes().some((change) => change.id === created.id));
    await inTeam(ctx.teamId).post("/api/v1/collections").send({ name: "Marker" }).expect(201);
    await defaultStream.waitFor(() => defaultStream.changes().length === 1);
    expect(defaultStream.changes().map((change) => change.id)).not.toContain(created.id);
  });

  it("closes the stream of a member removed from the team", async () => {
    const stream = await connectReady(ctx.teamId);
    const otherTeamStream = await connectReady(otherTeamId);
    const [self] = await queryRows(ctx.db, "SELECT id FROM users WHERE email = 'test@sisal.com'");
    // The test user is the team's only owner; hand ownership over before leaving.
    await ctx.api.post(`/api/v1/admin/teams/${ctx.teamId}/members`).send({ email: "keeper@sisal.com", role: "owner" }).expect(201);
    await ctx.api.delete(`/api/v1/admin/teams/${ctx.teamId}/members/${self!.id}`).expect(204);
    let ended = false;
    void stream.ended.then(() => {
      ended = true;
    });
    await waitUntil(() => ended);
    expect(otherTeamStream.response.destroyed).toBe(false);
    expect((await inTeam(ctx.teamId).get("/api/v1/collections").expect(404)).body.error.code).toBe("TEAM_NOT_FOUND");
  });
});

describe("migration of existing data", () => {
  it("adds team columns and removes the transitional Default team", async () => {
    expect(await queryRows(ctx.db, "SELECT id FROM teams WHERE id = '00000000-0000-4000-8000-000000000001'")).toEqual([]);
    const columns = await queryRows(
      ctx.db,
      `SELECT table_name AS t, is_nullable AS n FROM information_schema.columns
       WHERE table_schema = DATABASE() AND column_name = 'team_id' AND table_name IN ('collections', 'environments', 'variables')
       ORDER BY table_name`,
    );
    expect(columns.map((column) => [column.t, column.n])).toEqual([
      ["collections", "NO"],
      ["environments", "NO"],
      ["variables", "YES"],
    ]);
  });

  it("seeds the initial teams, each with its admin, without signing anyone in", async () => {
    const rows = await queryRows(
      ctx.db,
      `SELECT t.name, u.email, u.first_name, u.last_name, m.role,
              EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id = u.id) AS signed_in
       FROM teams t
       INNER JOIN team_members m ON m.team_id = t.id
       INNER JOIN users u ON u.id = m.user_id
       WHERE t.id LIKE '00000000-0000-4000-8000-0000000001%' AND m.role = 'admin'
       ORDER BY t.id`,
    );
    expect(rows.map((row) => [row.name, row.email, row.role, Number(row.signed_in)])).toEqual([
      ["Game Studio", "umit.cakir@fluttersea.com", "admin", 0],
      ["Mobile Gaming", "arman.kara@fluttersea.com", "admin", 0],
      ["PAM", "mertkan.yener@fluttersea.com", "admin", 0],
      ["Cross Module", "oguz.avci@fluttersea.com", "admin", 0],
      ["Lottery", "berk.yavuz@fluttersea.com", "admin", 0],
      ["Hybrid App", "burak.akyol@fluttersea.com", "admin", 0],
      ["Native App", "kubilay.aydin@fluttersea.com", "admin", 0],
    ]);
    expect(rows[0]).toMatchObject({ first_name: "Umit", last_name: "Cakir" });

    const gameStudio = await queryRows(
      ctx.db,
      `SELECT u.email, m.role FROM team_members m INNER JOIN users u ON u.id = m.user_id
       WHERE m.team_id = '00000000-0000-4000-8000-000000000101' AND u.email <> 'test@sisal.com' ORDER BY u.email`,
    );
    expect(gameStudio.map((row) => [row.email, row.role])).toEqual([
      ["ali.ghadiri@fluttersea.com", "member"],
      ["batuhan.munger@fluttersea.com", "member"],
      ["hakan.toker@fluttersea.com", "member"],
      ["onur.ozuyguz@fluttersea.com", "member"],
      ["serkan.taghan@fluttersea.com", "member"],
      ["umit.cakir@fluttersea.com", "admin"],
    ]);

    // Signing in later picks up the seeded account and its team.
    const admin = await signInAs("umit.cakir@fluttersea.com");
    expect((await admin.get("/api/v1/teams").expect(200)).body.teams).toEqual([
      { id: "00000000-0000-4000-8000-000000000101", name: "Game Studio", description: "", role: "admin" },
    ]);
    await admin.get("/api/v1/collections").expect(200);
  });

  it("makes the seeded system admin an admin on first sign-in", async () => {
    const [seeded] = await queryRows(ctx.db, "SELECT system_role FROM users WHERE email = 'serkan.taghan@fluttersea.com'");
    expect(seeded).toMatchObject({ system_role: "admin" });
    const admin = await signInAs("serkan.taghan@fluttersea.com");
    expect((await admin.get("/api/v1/auth/me").expect(200)).body.user.systemRole).toBe("admin");
    await admin.get("/api/v1/admin/teams").expect(200);
  });
});
