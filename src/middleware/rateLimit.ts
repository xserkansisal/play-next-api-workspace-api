import type { RequestHandler } from "express";
import { authenticatedUserId } from "./authenticate.js";

export interface UserRateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

/**
 * Fixed-window limit per signed-in user, kept in memory.
 *
 * The API runs as a single writable process (see the change hub), so there is no other instance
 * whose counts would need to be shared. Must be mounted after authentication.
 */
export function createUserRateLimit({ limit, windowMs, now = Date.now }: UserRateLimitOptions): RequestHandler {
  const windows = new Map<string, { startedAt: number; count: number }>();

  return (req, res, next) => {
    const userId = authenticatedUserId(req);
    const at = now();
    for (const [key, entry] of windows) {
      if (at - entry.startedAt >= windowMs) windows.delete(key);
    }
    const entry = windows.get(userId) ?? { startedAt: at, count: 0 };
    if (entry.count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((entry.startedAt + windowMs - at) / 1000));
      res
        .status(429)
        .set("Retry-After", String(retryAfter))
        .json({ error: { code: "RATE_LIMITED", message: "Too many requests, try again later", details: { retryAfterSeconds: retryAfter } } });
      return;
    }
    entry.count += 1;
    windows.set(userId, entry);
    next();
  };
}
