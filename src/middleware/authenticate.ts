import type { Request, RequestHandler } from "express";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { findSessionUser, type AuthUser } from "../auth/service.js";
import { HttpError } from "../errors.js";
import { findActiveMemberships, findTeamAccess, type TeamContext } from "../services/teams.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
      team?: TeamContext;
    }
  }
}

export const TEAM_HEADER = "X-Team-Id";

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0 || pair.slice(0, index).trim() !== name) continue;
    const value = pair.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createAuthenticationMiddleware(db: AppDatabase, cookieName: Env["AUTH_COOKIE_NAME"]): RequestHandler {
  return async (req, res, next) => {
    const token = readCookie(req, cookieName);
    const user = token ? await findSessionUser(db, token) : undefined;
    if (!user) {
      res.status(401).json({ error: { code: "AUTHENTICATION_REQUIRED", message: "Sign-in required" } });
      return;
    }

    req.authUser = user;
    next();
  };
}

export function authenticatedUserId(req: Request): string {
  if (!req.authUser) throw new HttpError(401, "Sign-in required", "AUTHENTICATION_REQUIRED");
  return req.authUser.id;
}

// Must run after the authentication middleware. The role is read from the session lookup made for
// this request, so a demotion takes effect on the very next call.
export const requireSystemAdmin: RequestHandler = (req, res, next) => {
  if (req.authUser?.systemRole !== "admin") {
    res.status(403).json({ error: { code: "ADMIN_REQUIRED", message: "System administrator access is required" } });
    return;
  }
  next();
};

/**
 * Resolves which team this request works in. Must run after the authentication middleware.
 *
 * The team comes from the `X-Team-Id` header, or the `teamId` query parameter for clients that
 * cannot set headers (EventSource). Without either, a user who belongs to exactly one team works
 * in it; anyone with several must choose. A team the caller does not belong to - or that is
 * archived - answers exactly like one that does not exist, so ids of other teams are never
 * confirmed. Membership is read per request, so a removal takes effect on the very next call.
 * A system admin may name any non-archived team and acts as an owner in it; without a header the
 * fallback below only considers real memberships.
 */
export function createTeamContextMiddleware(db: AppDatabase): RequestHandler {
  return async (req, res, next) => {
    const userId = authenticatedUserId(req);
    const user = req.authUser!;
    const fromQuery = typeof req.query.teamId === "string" ? req.query.teamId : undefined;
    const requested = req.get(TEAM_HEADER)?.trim() || fromQuery?.trim() || undefined;

    if (requested !== undefined) {
      const team = requested.length <= 36 ? await findTeamAccess(db, user, requested) : undefined;
      if (!team) {
        res.status(404).json({ error: { code: "TEAM_NOT_FOUND", message: `Team ${requested} not found` } });
        return;
      }
      req.team = team;
      next();
      return;
    }

    const memberships = await findActiveMemberships(db, userId);
    if (memberships.length === 0) {
      res.status(403).json({
        error: { code: "TEAM_MEMBERSHIP_REQUIRED", message: "You are not a member of any team yet" },
      });
      return;
    }
    if (memberships.length > 1) {
      res.status(400).json({
        error: {
          code: "TEAM_CONTEXT_REQUIRED",
          message: `Choose a team with the ${TEAM_HEADER} header`,
        },
      });
      return;
    }
    req.team = memberships[0];
    next();
  };
}

export function requestTeamId(req: Request): string {
  if (!req.team) throw new HttpError(400, `Choose a team with the ${TEAM_HEADER} header`, "TEAM_CONTEXT_REQUIRED");
  return req.team.id;
}
