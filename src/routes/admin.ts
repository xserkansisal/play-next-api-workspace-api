import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import type { PresenceHub } from "../events/presence.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listAuditLog,
  listTeamMembers,
  listTeams,
  listUsers,
  readTeam,
  readUser,
  removeTeamMember,
  setTeamArchived,
  updateTeam,
  updateTeamMemberRole,
  updateUserSystemRole,
} from "../services/teams.js";
import {
  addTeamMemberSchema,
  createTeamSchema,
  listAuditLogQuerySchema,
  listTeamsQuerySchema,
  listUsersQuerySchema,
  updateTeamMemberSchema,
  updateTeamSchema,
  updateUserSchema,
} from "../validation/adminSchemas.js";

export interface AdminRouterOptions {
  events?: ChangeEventHub;
  presence?: PresenceHub;
}

/** System administration. Mount behind authentication and `requireSystemAdmin`. */
export function createAdminRouter(db: AppDatabase, options: AdminRouterOptions = {}): Router {
  const router = Router();

  // REST calls re-check membership on every request; open event streams and presence entries do
  // not, so they are ended here the moment access is withdrawn.
  const revokeAccess = (teamId: string, userId?: string) => {
    options.events?.revoke(teamId, userId);
    options.presence?.removeTeamMember(teamId, userId);
  };

  router.get("/teams", async (req, res) => {
    const { includeArchived } = listTeamsQuerySchema.parse(req.query);
    res.json({ teams: await listTeams(db, { includeArchived }) });
  });

  router.post("/teams", async (req, res) => {
    res.status(201).json(await createTeam(db, createTeamSchema.parse(req.body), authenticatedUserId(req)));
  });

  router.get("/teams/:teamId", async (req, res) => {
    res.json(await readTeam(db, req.params.teamId));
  });

  router.patch("/teams/:teamId", async (req, res) => {
    res.json(await updateTeam(db, req.params.teamId, updateTeamSchema.parse(req.body), authenticatedUserId(req)));
  });

  router.post("/teams/:teamId/archive", async (req, res) => {
    const team = await setTeamArchived(db, req.params.teamId, true, authenticatedUserId(req));
    revokeAccess(team.id);
    res.json(team);
  });

  router.post("/teams/:teamId/unarchive", async (req, res) => {
    res.json(await setTeamArchived(db, req.params.teamId, false, authenticatedUserId(req)));
  });

  router.delete("/teams/:teamId", async (req, res) => {
    await deleteTeam(db, req.params.teamId, authenticatedUserId(req));
    res.status(204).end();
  });

  router.get("/teams/:teamId/members", async (req, res) => {
    res.json({ members: await listTeamMembers(db, req.params.teamId) });
  });

  router.post("/teams/:teamId/members", async (req, res) => {
    const member = await addTeamMember(db, req.params.teamId, addTeamMemberSchema.parse(req.body), authenticatedUserId(req));
    res.status(201).json(member);
  });

  router.patch("/teams/:teamId/members/:userId", async (req, res) => {
    const { role } = updateTeamMemberSchema.parse(req.body);
    res.json(await updateTeamMemberRole(db, req.params.teamId, req.params.userId, role, authenticatedUserId(req)));
  });

  router.delete("/teams/:teamId/members/:userId", async (req, res) => {
    await removeTeamMember(db, req.params.teamId, req.params.userId, authenticatedUserId(req));
    revokeAccess(req.params.teamId, req.params.userId);
    res.status(204).end();
  });

  router.get("/users", async (req, res) => {
    res.json(await listUsers(db, listUsersQuerySchema.parse(req.query)));
  });

  router.get("/users/:userId", async (req, res) => {
    res.json(await readUser(db, req.params.userId));
  });

  router.patch("/users/:userId", async (req, res) => {
    const { systemRole } = updateUserSchema.parse(req.body);
    res.json(await updateUserSystemRole(db, req.params.userId, systemRole, authenticatedUserId(req)));
  });

  router.get("/audit-log", async (req, res) => {
    res.json(await listAuditLog(db, listAuditLogQuerySchema.parse(req.query)));
  });

  return router;
}
