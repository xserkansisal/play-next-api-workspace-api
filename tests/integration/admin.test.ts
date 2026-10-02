import request from "supertest";
import sharp from "sharp";
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
  ctx = await createTestContext(":memory:", { env: { ADMIN_EMAILS: "Test@sisal.com, second-admin@sisal.com" } });
});

afterEach(async () => ctx.close());

describe("system admin access", () => {
  it("promotes ADMIN_EMAILS on sign-in and exposes the role on /me", async () => {
    expect((await ctx.api.get("/api/v1/auth/me").expect(200)).body.user.systemRole).toBe("admin");
    const regular = await signInAs(ctx, "regular@sisal.com");
    expect((await regular.get("/api/v1/auth/me").expect(200)).body.user.systemRole).toBe("user");
  });

  it("rejects anonymous and non-admin callers", async () => {
    await ctx.unauthenticatedApi.get("/api/v1/admin/teams").expect(401);
    const regular = await signInAs(ctx, "regular@sisal.com");
    const response = await regular.get("/api/v1/admin/teams").expect(403);
    expect(response.body.error.code).toBe("ADMIN_REQUIRED");
    await regular.post("/api/v1/admin/teams").send({ name: "Sneaky" }).expect(403);
  });

  it("applies a demotion on the very next request and keeps at least one admin", async () => {
    const me = (await ctx.api.get("/api/v1/auth/me").expect(200)).body.user;
    // Migration 0016 seeds a system admin; demote it so the test user is the only admin left.
    const seeded = (await ctx.api.get("/api/v1/admin/users?query=serkan.taghan").expect(200)).body.users[0];
    await ctx.api.patch(`/api/v1/admin/users/${seeded.id}`).send({ systemRole: "user" }).expect(200);
    const lastAdmin = await ctx.api.patch(`/api/v1/admin/users/${me.id}`).send({ systemRole: "user" }).expect(409);
    expect(lastAdmin.body.error.code).toBe("LAST_SYSTEM_ADMIN");

    const other = await signInAs(ctx, "other@sisal.com");
    const otherUser = (await other.get("/api/v1/auth/me").expect(200)).body.user;
    const promoted = await ctx.api.patch(`/api/v1/admin/users/${otherUser.id}`).send({ systemRole: "admin" }).expect(200);
    expect(promoted.body.systemRole).toBe("admin");
    await other.get("/api/v1/admin/teams").expect(200);

    await other.patch(`/api/v1/admin/users/${me.id}`).send({ systemRole: "user" }).expect(200);
    await ctx.api.get("/api/v1/admin/teams").expect(403);
  });
});

describe("user avatars", () => {
  async function uploadAvatar(agent: ReturnType<typeof request.agent>) {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#3366cc" } }).png().toBuffer();
    return (await agent.post("/api/v1/auth/me/avatar").attach("avatar", png, "a.png").expect(200)).body.user.avatarUrl as string;
  }

  it("exposes avatarUrl on user list, detail and role update responses", async () => {
    const person = await signInAs(ctx, "photo.person@sisal.com");
    const personId = (await person.get("/api/v1/auth/me").expect(200)).body.user.id;

    const before = (await ctx.api.get("/api/v1/admin/users?query=photo.person").expect(200)).body.users[0];
    expect(before.avatarUrl).toBeNull();
    expect(before).not.toHaveProperty("avatarId");

    const url = await uploadAvatar(person);
    expect(url).toMatch(/^\/api\/v1\/auth\/avatars\/[0-9a-f-]{36}$/);

    const listed = (await ctx.api.get("/api/v1/admin/users?query=photo.person").expect(200)).body;
    expect(listed.total).toBe(1);
    expect(listed.users[0]).toMatchObject({ id: personId, avatarUrl: url });
    expect(listed.users[0]).not.toHaveProperty("avatarId");
    const detail = (await ctx.api.get(`/api/v1/admin/users/${personId}`).expect(200)).body;
    expect(detail).toMatchObject({ id: personId, avatarUrl: url, teams: [] });
    expect(detail).not.toHaveProperty("avatarId");
    const promoted = (await ctx.api.patch(`/api/v1/admin/users/${personId}`).send({ systemRole: "admin" }).expect(200)).body;
    expect(promoted).toMatchObject({ systemRole: "admin", avatarUrl: url });

    // The admin can load the returned URL with their own session.
    await ctx.api.get(url).expect(200).expect("Content-Type", "image/webp");
  });

  it("exposes avatarUrl on team members", async () => {
    const person = await signInAs(ctx, "photo.person@sisal.com");
    const url = await uploadAvatar(person);
    const team = (await ctx.api.post("/api/v1/admin/teams").send({ name: "Photos" }).expect(201)).body;

    const added = (await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "photo.person@sisal.com" }).expect(201)).body;
    expect(added).toMatchObject({ email: "photo.person@sisal.com", avatarUrl: url });
    expect(added).not.toHaveProperty("avatarId");
    const noPhoto = (await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "no.photo@sisal.com" }).expect(201)).body;
    expect(noPhoto.avatarUrl).toBeNull();

    const members = (await ctx.api.get(`/api/v1/admin/teams/${team.id}/members`).expect(200)).body.members;
    expect(members.find((m: { userId: string }) => m.userId === added.userId)).toMatchObject({ avatarUrl: url });
    const detail = (await ctx.api.get(`/api/v1/admin/teams/${team.id}`).expect(200)).body;
    expect(detail.members.find((m: { userId: string }) => m.userId === added.userId)).toMatchObject({ avatarUrl: url });
    const changed = (await ctx.api.patch(`/api/v1/admin/teams/${team.id}/members/${added.userId}`).send({ role: "owner" }).expect(200)).body;
    expect(changed).toMatchObject({ role: "owner", avatarUrl: url });
  });

  it("returns absolute avatar URLs to the allowed cross-origin client", async () => {
    const crossOrigin = await createTestContext(":memory:", {
      env: { ADMIN_EMAILS: "Test@sisal.com", CORS_ORIGIN: "http://localhost:5173" },
    });
    try {
      const person = await signInAs(crossOrigin, "photo.person@sisal.com");
      const personId = (await person.get("/api/v1/auth/me").expect(200)).body.user.id;
      const path = await uploadAvatar(person);

      const listed = (await crossOrigin.api.get("/api/v1/admin/users?query=photo.person").set("Origin", "http://localhost:5173").expect(200))
        .body.users[0];
      expect(listed.avatarUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${path}$`));
      const detail = (await crossOrigin.api.get(`/api/v1/admin/users/${personId}`).set("Origin", "http://localhost:5173").expect(200)).body;
      expect(detail.avatarUrl).toBe(listed.avatarUrl);

      const team = (await crossOrigin.api.post("/api/v1/admin/teams").send({ name: "Photos" }).expect(201)).body;
      const added = await crossOrigin.api
        .post(`/api/v1/admin/teams/${team.id}/members`)
        .set("Origin", "http://localhost:5173")
        .send({ email: "photo.person@sisal.com" })
        .expect(201);
      expect(added.body.avatarUrl).toBe(listed.avatarUrl);
    } finally {
      await crossOrigin.close();
    }
  });
});

describe("team management", () => {
  it("creates, renames, archives and deletes teams", async () => {
    const created = await ctx.api.post("/api/v1/admin/teams").send({ name: "Payments", description: "Payment APIs" }).expect(201);
    expect(created.body).toMatchObject({ name: "Payments", description: "Payment APIs", memberCount: 0, archivedAt: null, members: [] });
    const id = created.body.id;

    const conflict = await ctx.api.post("/api/v1/admin/teams").send({ name: "payments" }).expect(409);
    expect(conflict.body.error.code).toBe("TEAM_NAME_CONFLICT");

    const renamed = await ctx.api.patch(`/api/v1/admin/teams/${id}`).send({ name: "Payments Core" }).expect(200);
    expect(renamed.body).toMatchObject({ name: "Payments Core", description: "Payment APIs" });
    await ctx.api.patch(`/api/v1/admin/teams/${id}`).send({}).expect(400);

    const notArchived = await ctx.api.delete(`/api/v1/admin/teams/${id}`).expect(409);
    expect(notArchived.body.error.code).toBe("TEAM_NOT_ARCHIVED");

    await ctx.api.post(`/api/v1/admin/teams/${id}/archive`).expect(200);
    const active = (await ctx.api.get("/api/v1/admin/teams").expect(200)).body.teams;
    expect(active.map((team: { id: string }) => team.id)).not.toContain(id);
    const all = (await ctx.api.get("/api/v1/admin/teams?includeArchived=true").expect(200)).body.teams;
    const archived = all.find((team: { id: string }) => team.id === id);
    expect(archived.archivedAt).not.toBeNull();

    await ctx.api.post(`/api/v1/admin/teams/${id}/unarchive`).expect(200);
    await ctx.api.post(`/api/v1/admin/teams/${id}/archive`).expect(200);
    await ctx.api.delete(`/api/v1/admin/teams/${id}`).expect(204);
    const missing = await ctx.api.get(`/api/v1/admin/teams/${id}`).expect(404);
    expect(missing.body.error.code).toBe("TEAM_NOT_FOUND");
  });

  it("adds members by email, including people who have never signed in", async () => {
    const team = (await ctx.api.post("/api/v1/admin/teams").send({ name: "Games" }).expect(201)).body;

    const added = await ctx.api
      .post(`/api/v1/admin/teams/${team.id}/members`)
      .send({ email: " New.Person@Sisal.com ", role: "owner" })
      .expect(201);
    expect(added.body).toMatchObject({ email: "new.person@sisal.com", role: "owner" });

    const duplicate = await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "new.person@sisal.com" }).expect(409);
    expect(duplicate.body.error.code).toBe("TEAM_MEMBER_EXISTS");
    const foreign = await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "someone@example.com" }).expect(400);
    expect(foreign.body.error.code).toBe("EMAIL_DOMAIN_NOT_ALLOWED");

    const users = (await ctx.api.get("/api/v1/admin/users?query=new.person").expect(200)).body;
    expect(users.total).toBe(1);
    expect(users.users[0]).toMatchObject({ email: "new.person@sisal.com", hasSignedIn: false, systemRole: "user" });

    // Signing in later picks up the pre-created account and its membership.
    const person = await signInAs(ctx, "new.person@sisal.com");
    const me = (await person.get("/api/v1/auth/me").expect(200)).body.user;
    expect(me.id).toBe(added.body.userId);
    expect((await person.get("/api/v1/teams").expect(200)).body.teams).toEqual([
      { id: team.id, name: "Games", description: "", role: "owner" },
    ]);
    const detail = (await ctx.api.get(`/api/v1/admin/users/${me.id}`).expect(200)).body;
    expect(detail).toMatchObject({ hasSignedIn: true, teams: [{ id: team.id, name: "Games", role: "owner", archivedAt: null }] });
  });

  it("protects the last owner and changes roles", async () => {
    const team = (await ctx.api.post("/api/v1/admin/teams").send({ name: "Sports" }).expect(201)).body;
    const owner = (await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "owner@sisal.com", role: "owner" }).expect(201)).body;
    const member = (await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "member@sisal.com" }).expect(201)).body;
    expect(member.role).toBe("member");

    expect((await ctx.api.patch(`/api/v1/admin/teams/${team.id}/members/${owner.userId}`).send({ role: "member" }).expect(409)).body.error.code)
      .toBe("TEAM_LAST_OWNER");
    expect((await ctx.api.delete(`/api/v1/admin/teams/${team.id}/members/${owner.userId}`).expect(409)).body.error.code)
      .toBe("TEAM_LAST_OWNER");

    await ctx.api.patch(`/api/v1/admin/teams/${team.id}/members/${member.userId}`).send({ role: "owner" }).expect(200);
    await ctx.api.delete(`/api/v1/admin/teams/${team.id}/members/${owner.userId}`).expect(204);
    await ctx.api.patch(`/api/v1/admin/teams/${team.id}/members/${member.userId}`).send({ role: "superuser" }).expect(400);
    expect((await ctx.api.delete(`/api/v1/admin/teams/${team.id}/members/${owner.userId}`).expect(404)).body.error.code)
      .toBe("TEAM_MEMBER_NOT_FOUND");

    const members = (await ctx.api.get(`/api/v1/admin/teams/${team.id}/members`).expect(200)).body.members;
    expect(members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([["member@sisal.com", "owner"]]);
  });

  it("freezes membership of archived teams and hides them from the team switcher", async () => {
    const team = (await ctx.api.post("/api/v1/admin/teams").send({ name: "Bingo" }).expect(201)).body;
    await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "player@sisal.com" }).expect(201);
    const player = await signInAs(ctx, "player@sisal.com");
    expect((await player.get("/api/v1/teams").expect(200)).body.teams).toHaveLength(1);

    await ctx.api.post(`/api/v1/admin/teams/${team.id}/archive`).expect(200);
    expect((await player.get("/api/v1/teams").expect(200)).body.teams).toEqual([]);
    const frozen = await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "late@sisal.com" }).expect(409);
    expect(frozen.body.error.code).toBe("TEAM_ARCHIVED");
  });

  it("records every administrative change in the audit log", async () => {
    const team = (await ctx.api.post("/api/v1/admin/teams").send({ name: "Audit" }).expect(201)).body;
    const member = (await ctx.api.post(`/api/v1/admin/teams/${team.id}/members`).send({ email: "audited@sisal.com" }).expect(201)).body;
    await ctx.api.patch(`/api/v1/admin/teams/${team.id}/members/${member.userId}`).send({ role: "admin" }).expect(200);
    await ctx.api.delete(`/api/v1/admin/teams/${team.id}/members/${member.userId}`).expect(204);
    await ctx.api.post("/api/v1/admin/teams").send({ name: "Other" }).expect(201);

    const log = (await ctx.api.get(`/api/v1/admin/audit-log?teamId=${team.id}`).expect(200)).body;
    expect(log.total).toBe(4);
    expect(log.entries.map((e: { action: string }) => e.action).sort()).toEqual([
      "team.created",
      "team.member_added",
      "team.member_removed",
      "team.member_role_changed",
    ]);
    expect(log.entries.every((e: { actor: string }) => e.actor === "test@sisal.com")).toBe(true);
    expect((await ctx.api.get("/api/v1/admin/audit-log").expect(200)).body.total).toBe(5);
  });
});
