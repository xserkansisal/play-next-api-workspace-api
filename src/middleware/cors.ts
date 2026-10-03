import type { RequestHandler } from "express";

/**
 * `CORS_ORIGIN=*` - answer every origin.
 *
 * Only a bare `*` is a wildcard. A pattern like `https://*.example.com` matches nothing, so a
 * half-remembered guess fails closed instead of quietly opening the API to every page on the web.
 */
export const ANY_ORIGIN = "*";

export function allowsAnyOrigin(allowedOrigin?: string): boolean {
  return allowedOrigin === ANY_ORIGIN;
}

export function createCorsMiddleware(allowedOrigin?: string): RequestHandler {
  const anyOrigin = allowsAnyOrigin(allowedOrigin);

  return (req, res, next) => {
    const origin = req.get("Origin");
    if (origin) res.vary("Origin");

    if (!allowedOrigin || !origin || (!anyOrigin && origin !== allowedOrigin)) {
      next();
      return;
    }

    // The caller's own origin is echoed rather than a literal `*`, because browsers refuse to
    // send or accept credentials against a wildcard - and this API authenticates with a session
    // cookie, so a literal `*` would answer every origin and sign in none of them. `Vary: Origin`
    // above is what keeps a cache from handing one origin's allowance to another.
    res.setHeader("Access-Control-Allow-Origin", anyOrigin ? origin : allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID, X-Dev-Inbox-Token, X-Team-Id");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}
