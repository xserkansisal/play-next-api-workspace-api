import type { Request, RequestHandler } from "express";
import { HttpError } from "../errors.js";
import type { TeamRole } from "../validation/adminSchemas.js";

const RANK: Record<TeamRole, number> = { viewer: 0, member: 1, owner: 2 };
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function hasTeamRole(actual: TeamRole, required: TeamRole): boolean {
  return RANK[actual] >= RANK[required];
}

function teamRole(req: Request): TeamRole {
  if (!req.team) throw new HttpError(400, "Choose a team with the X-Team-Id header", "TEAM_CONTEXT_REQUIRED");
  return req.team.role;
}

function roleRequired(required: TeamRole): HttpError {
  return new HttpError(403, `The ${required} role is required in this team`, "TEAM_ROLE_REQUIRED");
}

/** Must run after the team context middleware. */
export function requireTeamRole(required: TeamRole): RequestHandler {
  return (req, _res, next) => {
    next(hasTeamRole(teamRole(req), required) ? undefined : roleRequired(required));
  };
}

/**
 * Lets a viewer read but not change anything: every method other than GET/HEAD/OPTIONS needs the
 * member role. `allowedForViewer` names the few writes that are not edits of the team's content,
 * such as running a collection or saving one's own personal variables. Must run after the team
 * context middleware.
 */
export function requireTeamEditor(allowedForViewer: (req: Request) => boolean = () => false): RequestHandler {
  return (req, _res, next) => {
    if (READ_ONLY_METHODS.has(req.method) || hasTeamRole(teamRole(req), "member") || allowedForViewer(req)) {
      next();
      return;
    }
    next(roleRequired("member"));
  };
}
