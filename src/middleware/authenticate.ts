import type { Request, RequestHandler } from "express";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { findSessionUser, type AuthUser } from "../auth/service.js";
import { HttpError } from "../errors.js";

declare global {
  namespace Express {
    interface Request {
      authUser?: AuthUser;
    }
  }
}

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
