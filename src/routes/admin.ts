import { Router, type Request } from "express";
import { withAvatarUrl } from "../auth/avatarUrl.js";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import type { PresenceHub } from "../events/presence.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  deleteUser,
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
  type TeamDetail,
  type TeamMember,
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
  /** Same value as the CORS middleware, so avatar URLs follow the auth routes' convention. */
  corsOrigin?: string;
}

/** System administration. Mount behind authentication and `requireSystemAdmin`. */
export function createAdminRouter(db: AppDatabase, options: AdminRouterOptions = {}): Router {
  const router = Router();
  const member = (req: Request, value: TeamMember) => withAvatarUrl(req, options.corsOrigin, value);
  const team = (req: Request, value: TeamDetail) => ({ ...value, members: value.members.map((m) => member(req, m)) });

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
    res.status(201).json(team(req, await createTeam(db, createTeamSchema.parse(req.body), authenticatedUserId(req))));
  });

  router.get("/teams/:teamId", async (req, res) => {
    res.json(team(req, await readTeam(db, req.params.teamId)));
  });

  router.patch("/teams/:teamId", async (req, res) => {
    res.json(team(req, await updateTeam(db, req.params.teamId, updateTeamSchema.parse(req.body), authenticatedUserId(req))));
  });

  router.post("/teams/:teamId/archive", async (req, res) => {
    const archived = await setTeamArchived(db, req.params.teamId, true, authenticatedUserId(req));
    revokeAccess(archived.id);
    res.json(team(req, archived));
  });

  router.post("/teams/:teamId/unarchive", async (req, res) => {
    res.json(team(req, await setTeamArchived(db, req.params.teamId, false, authenticatedUserId(req))));
  });

  router.delete("/teams/:teamId", async (req, res) => {
    await deleteTeam(db, req.params.teamId, authenticatedUserId(req));
    res.status(204).end();
  });

  router.get("/teams/:teamId/members", async (req, res) => {
    res.json({ members: (await listTeamMembers(db, req.params.teamId)).map((m) => member(req, m)) });
  });

  router.post("/teams/:teamId/members", async (req, res) => {
    const added = await addTeamMember(db, req.params.teamId, addTeamMemberSchema.parse(req.body), authenticatedUserId(req));
    res.status(201).json(member(req, added));
  });

  router.patch("/teams/:teamId/members/:userId", async (req, res) => {
    const { role } = updateTeamMemberSchema.parse(req.body);
    res.json(member(req, await updateTeamMemberRole(db, req.params.teamId, req.params.userId, role, authenticatedUserId(req))));
  });

  router.delete("/teams/:teamId/members/:userId", async (req, res) => {
    await removeTeamMember(db, req.params.teamId, req.params.userId, authenticatedUserId(req));
    revokeAccess(req.params.teamId, req.params.userId);
    res.status(204).end();
  });

  router.get("/users", async (req, res) => {
    const { users, total } = await listUsers(db, listUsersQuerySchema.parse(req.query));
    res.json({ users: users.map((user) => withAvatarUrl(req, options.corsOrigin, user)), total });
  });

  router.get("/users/:userId", async (req, res) => {
    res.json(withAvatarUrl(req, options.corsOrigin, await readUser(db, req.params.userId)));
  });

  router.patch("/users/:userId", async (req, res) => {
    const { systemRole } = updateUserSchema.parse(req.body);
    const user = await updateUserSystemRole(db, req.params.userId, systemRole, authenticatedUserId(req));
    res.json(withAvatarUrl(req, options.corsOrigin, user));
  });

  router.delete("/users/:userId", async (req, res) => {
    const { teamIds } = await deleteUser(db, req.params.userId, authenticatedUserId(req));
    for (const teamId of teamIds) revokeAccess(teamId, req.params.userId);
    res.status(204).end();
  });

  router.get("/audit-log", async (req, res) => {
    res.json(await listAuditLog(db, listAuditLogQuerySchema.parse(req.query)));
  });

  return router;
}
