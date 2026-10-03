import { Router, type Request } from "express";
import { withAvatarUrl } from "../auth/avatarUrl.js";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import type { PresenceHub } from "../events/presence.js";
import { NotFoundError } from "../errors.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import { requireTeamRole } from "../middleware/teamPermissions.js";
import {
  addTeamMember,
  findTeamAccess,
  listMyTeams,
  listTeamMembers,
  removeTeamMember,
  updateTeamMemberRole,
  type TeamMember,
} from "../services/teams.js";
import { addTeamMemberSchema, updateTeamMemberSchema } from "../validation/adminSchemas.js";

export interface TeamsRouterOptions {
  events?: ChangeEventHub;
  presence?: PresenceHub;
  /** Same value as the CORS middleware, so avatar URLs follow the auth routes' convention. */
  corsOrigin?: string;
}

/**
 * Team information for the signed-in user. Drives the team switcher, and lets a team's owners
 * (and system admins) manage that team's members. Mount behind authentication.
 */
export function createTeamsRouter(db: AppDatabase, options: TeamsRouterOptions = {}): Router {
  const router = Router();
  const member = (req: Request, value: TeamMember) => withAvatarUrl(req, options.corsOrigin, value);

  router.get("/", async (req, res) => {
    res.json({ teams: await listMyTeams(db, req.authUser!) });
  });

  // The caller's role in the team named by the path; a team they cannot enter answers like a
  // missing one. Members can read the roster, only owners can change it.
  router.use("/:teamId", async (req, _res, next) => {
    try {
      const teamId = String(req.params.teamId);
      const access = teamId.length <= 36 ? await findTeamAccess(db, req.authUser!, teamId) : undefined;
      if (!access) throw new NotFoundError(`Team ${teamId} not found`, "TEAM_NOT_FOUND");
      req.team = access;
      next();
    } catch (error) {
      next(error);
    }
  });

  router.get("/:teamId/members", async (req, res) => {
    res.json({ members: (await listTeamMembers(db, req.team!.id)).map((m) => member(req, m)) });
  });

  router.post("/:teamId/members", requireTeamRole("owner"), async (req, res) => {
    const added = await addTeamMember(db, req.team!.id, addTeamMemberSchema.parse(req.body), authenticatedUserId(req));
    res.status(201).json(member(req, added));
  });

  router.patch("/:teamId/members/:userId", requireTeamRole("owner"), async (req, res) => {
    const { role } = updateTeamMemberSchema.parse(req.body);
    res.json(member(req, await updateTeamMemberRole(db, req.team!.id, String(req.params.userId), role, authenticatedUserId(req))));
  });

  router.delete("/:teamId/members/:userId", requireTeamRole("owner"), async (req, res) => {
    const userId = String(req.params.userId);
    await removeTeamMember(db, req.team!.id, userId, authenticatedUserId(req));
    // Open event streams and presence entries do not re-check membership on their own.
    options.events?.revoke(req.team!.id, userId);
    options.presence?.removeTeamMember(req.team!.id, userId);
    res.status(204).end();
  });

  return router;
}
