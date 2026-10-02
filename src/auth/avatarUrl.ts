import type { Request } from "express";
import { allowsAnyOrigin } from "../middleware/cors.js";

const AVATAR_PATH = "/api/v1/auth/avatars";

/**
 * Same-origin clients (the nginx deployment) get a root-relative URL. A browser on another
 * allowed origin - the Vite dev server - would resolve that against its own origin, so it gets
 * this API's absolute URL instead.
 */
export function avatarUrl(req: Request, corsOrigin: string | undefined, avatarId: string | null): string | null {
  if (!avatarId) return null;
  const path = `${AVATAR_PATH}/${avatarId}`;
  const origin = req.get("Origin");
  const crossOrigin = !!origin && !!corsOrigin && (allowsAnyOrigin(corsOrigin) || origin === corsOrigin);
  return crossOrigin ? `${req.protocol}://${req.get("host")}${path}` : path;
}

/** Replaces the internal `avatarId` with the client-facing `avatarUrl`. */
export function withAvatarUrl<T extends { avatarId: string | null }>(
  req: Request,
  corsOrigin: string | undefined,
  user: T,
): Omit<T, "avatarId"> & { avatarUrl: string | null } {
  const { avatarId, ...rest } = user;
  return { ...rest, avatarUrl: avatarUrl(req, corsOrigin, avatarId) };
}
