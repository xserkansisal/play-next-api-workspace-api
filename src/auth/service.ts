import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Env } from "../config/env.js";
import { parseEmailList } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
import { authCodes, authRateLimits, authSessions, userAvatars, users } from "../db/schema.js";
import type { DbExecutor } from "../services/tree.js";
import { generateCode, generateSessionToken, hashCode, hashSessionToken, normalizeEmail, verifyCodeHash } from "./crypto.js";
import { HttpError } from "../errors.js";
import { deriveUserProfileName } from "./profile.js";
import type { AvatarColor } from "./avatar.js";

export const ALLOWED_EMAIL_DOMAINS = ["fluttersea.com", "sisal.com", "sisal.it"] as const;

export type SystemRole = "user" | "admin";

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarColor: string;
  /** Id of the stored avatar image, or null when the user has none. Clients see it as `avatarUrl`. */
  avatarId: string | null;
  systemRole: SystemRole;
}

const authUserColumns = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  avatarColor: users.avatarColor,
  avatarId: userAvatars.id,
  systemRole: users.systemRole,
};

export class AuthError extends HttpError {
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
    this.name = "AuthError";
  }
}

function isoAfter(seconds: number, now = Date.now()): string {
  return new Date(now + seconds * 1000).toISOString();
}

export function validateAllowedEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain as (typeof ALLOWED_EMAIL_DOMAINS)[number])) {
    throw new AuthError(400, "EMAIL_DOMAIN_NOT_ALLOWED", "Email domain is not allowed");
  }
  return normalized;
}

async function consumeRateLimit(
  tx: DbExecutor,
  email: string,
  purpose: "request_code" | "verify_code",
  limit: number,
  windowSeconds: number,
  now: string,
): Promise<boolean> {
  await tx
    .insert(authRateLimits)
    .values({ email, purpose, windowStartedAt: now, attempts: 0 })
    .onDuplicateKeyUpdate({ set: { attempts: sql`${authRateLimits.attempts}` } });
  const current = await first(
    tx
      .select()
      .from(authRateLimits)
      .where(and(eq(authRateLimits.email, email), eq(authRateLimits.purpose, purpose)))
      .for("update")
      .limit(1),
  );
  if (!current) throw new Error("Rate-limit row disappeared while its transaction was active");

  const expired = Date.parse(now) - Date.parse(current.windowStartedAt) >= windowSeconds * 1000;
  if (expired) {
    await tx
      .update(authRateLimits)
      .set({ windowStartedAt: now, attempts: 1 })
      .where(and(eq(authRateLimits.email, email), eq(authRateLimits.purpose, purpose)));
    return false;
  }
  if (current.attempts >= limit) return true;
  await tx
    .update(authRateLimits)
    .set({ attempts: current.attempts + 1 })
    .where(and(eq(authRateLimits.email, email), eq(authRateLimits.purpose, purpose)));
  return false;
}

export interface AuthServiceConfig extends Pick<
  Env,
  | "AUTH_CODE_PEPPER"
  | "AUTH_CODE_TTL_SECONDS"
  | "AUTH_CODE_MAX_ATTEMPTS"
  | "AUTH_CODE_REQUEST_LIMIT"
  | "AUTH_CODE_REQUEST_WINDOW_SECONDS"
  | "AUTH_CODE_VERIFY_LIMIT"
  | "AUTH_CODE_VERIFY_WINDOW_SECONDS"
  | "AUTH_SESSION_TTL_SECONDS"
  | "ADMIN_EMAILS"
> {}

export interface RequestedCode {
  challengeId: string;
  email: string;
  code: string;
  expiresAt: string;
}

export async function requestCode(db: AppDatabase, config: AuthServiceConfig, inputEmail: string): Promise<RequestedCode> {
  const email = validateAllowedEmail(inputEmail);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const challengeId = randomUUID();
  const code = generateCode();
  const expiresAt = isoAfter(config.AUTH_CODE_TTL_SECONDS, nowDate.getTime());

  const outcome = await db.transaction(async (tx) => {
    const limited = await consumeRateLimit(
      tx,
      email,
      "request_code",
      config.AUTH_CODE_REQUEST_LIMIT,
      config.AUTH_CODE_REQUEST_WINDOW_SECONDS,
      now,
    );
    if (limited) return false;
    await tx
      .update(authCodes)
      .set({ consumedAt: now })
      .where(and(eq(authCodes.email, email), isNull(authCodes.consumedAt)));
    await tx.insert(authCodes).values({
      id: challengeId,
      email,
      codeHash: hashCode(config.AUTH_CODE_PEPPER, challengeId, code).toString("hex"),
      createdAt: now,
      expiresAt,
    });
    return true;
  });

  if (!outcome) throw new AuthError(429, "AUTH_RATE_LIMITED", "Please wait before requesting another code");
  return { challengeId, email, code, expiresAt };
}

export interface VerifiedSession {
  user: AuthUser;
  sessionToken: string;
  expiresAt: string;
}

export type VerifyOutcome =
  | { ok: true; session: VerifiedSession }
  | { ok: false; rateLimited: boolean };

async function openSession(
  tx: DbExecutor,
  email: string,
  sessionToken: string,
  sessionExpiresAt: string,
  now: string,
  adminEmails: string | undefined,
): Promise<VerifiedSession> {
  const profileName = deriveUserProfileName(email);
  await tx
    .insert(users)
    .values({ id: randomUUID(), email, ...profileName, createdAt: now })
    .onDuplicateKeyUpdate({ set: { email } });
  let user = await first(tx.select().from(users).where(eq(users.email, email)).limit(1));
  if (!user) throw new Error("User row disappeared while a verified session was being created");
  // Bootstrap only: promotes listed addresses, never demotes, so the admin API stays authoritative.
  if (user.systemRole !== "admin" && parseEmailList(adminEmails).includes(email)) {
    await tx.update(users).set({ systemRole: "admin" }).where(eq(users.id, user.id));
    user = { ...user, systemRole: "admin" };
  }
  const avatar = await first(tx.select({ id: userAvatars.id }).from(userAvatars).where(eq(userAvatars.userId, user.id)).limit(1));
  const firstName = user.firstName || profileName.firstName;
  const lastName = user.lastName || profileName.lastName;
  if (firstName !== user.firstName || lastName !== user.lastName) {
    await tx.update(users).set({ firstName, lastName }).where(eq(users.id, user.id));
  }

  await tx.insert(authSessions).values({
    id: randomUUID(),
    userId: user.id,
    tokenHash: hashSessionToken(sessionToken),
    createdAt: now,
    expiresAt: sessionExpiresAt,
  });
  return {
    user: {
      id: user.id,
      email: user.email,
      firstName,
      lastName,
      avatarColor: user.avatarColor,
      avatarId: avatar?.id ?? null,
      systemRole: user.systemRole,
    },
    sessionToken,
    expiresAt: sessionExpiresAt,
  };
}

/**
 * Opens a session without a sign-in code. Only the development-only route may call this; the
 * domain allow-list still applies.
 */
export async function createSessionForEmail(
  db: AppDatabase,
  config: Pick<AuthServiceConfig, "AUTH_SESSION_TTL_SECONDS" | "ADMIN_EMAILS">,
  inputEmail: string,
): Promise<VerifiedSession> {
  const email = validateAllowedEmail(inputEmail);
  const nowDate = new Date();
  const sessionExpiresAt = isoAfter(config.AUTH_SESSION_TTL_SECONDS, nowDate.getTime());
  return db.transaction((tx) =>
    openSession(tx, email, generateSessionToken(), sessionExpiresAt, nowDate.toISOString(), config.ADMIN_EMAILS),
  );
}

export async function verifyCode(
  db: AppDatabase,
  config: AuthServiceConfig,
  inputEmail: string,
  code: string,
): Promise<VerifyOutcome> {
  const email = validateAllowedEmail(inputEmail);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const generatedSessionToken = generateSessionToken();
  const sessionExpiresAt = isoAfter(config.AUTH_SESSION_TTL_SECONDS, nowDate.getTime());

  return db.transaction(async (tx): Promise<VerifyOutcome> => {
    const limited = await consumeRateLimit(
      tx,
      email,
      "verify_code",
      config.AUTH_CODE_VERIFY_LIMIT,
      config.AUTH_CODE_VERIFY_WINDOW_SECONDS,
      now,
    );
    if (limited) return { ok: false, rateLimited: true };

    const challenge = await first(
      tx
        .select()
        .from(authCodes)
        .where(and(eq(authCodes.email, email), isNull(authCodes.consumedAt)))
        .orderBy(desc(authCodes.createdAt))
        .for("update")
        .limit(1),
    );
    if (!challenge) return { ok: false, rateLimited: false };
    if (challenge.expiresAt <= now || challenge.attempts >= config.AUTH_CODE_MAX_ATTEMPTS) {
      await tx.update(authCodes).set({ consumedAt: now }).where(eq(authCodes.id, challenge.id));
      return { ok: false, rateLimited: false };
    }

    const matches = verifyCodeHash(
      challenge.codeHash,
      hashCode(config.AUTH_CODE_PEPPER, challenge.id, code),
    );
    const nextAttempts = challenge.attempts + 1;
    if (!matches) {
      await tx
        .update(authCodes)
        .set({
          attempts: nextAttempts,
          ...(nextAttempts >= config.AUTH_CODE_MAX_ATTEMPTS ? { consumedAt: now } : {}),
        })
        .where(eq(authCodes.id, challenge.id));
      return { ok: false, rateLimited: false };
    }

    await tx.update(authCodes).set({ attempts: nextAttempts, consumedAt: now }).where(eq(authCodes.id, challenge.id));

    return { ok: true, session: await openSession(tx, email, generatedSessionToken, sessionExpiresAt, now, config.ADMIN_EMAILS) };
  });
}

export async function findSessionUser(
  db: AppDatabase,
  token: string,
  now = new Date().toISOString(),
): Promise<AuthUser | undefined> {
  return first(
    db
      .select(authUserColumns)
      .from(authSessions)
      .innerJoin(users, eq(authSessions.userId, users.id))
      .leftJoin(userAvatars, eq(userAvatars.userId, users.id))
      .where(
        and(
          eq(authSessions.tokenHash, hashSessionToken(token)),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, now),
        ),
      )
      .limit(1),
  );
}

export async function revokeSession(db: AppDatabase, token: string, now = new Date().toISOString()): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.tokenHash, hashSessionToken(token)), isNull(authSessions.revokedAt)));
}

export async function invalidateCode(db: AppDatabase, challengeId: string, now = new Date().toISOString()): Promise<void> {
  await db
    .update(authCodes)
    .set({ consumedAt: now })
    .where(and(eq(authCodes.id, challengeId), isNull(authCodes.consumedAt)));
}

export async function userForId(db: AppDatabase, id: string): Promise<AuthUser | undefined> {
  return first(
    db
      .select(authUserColumns)
      .from(users)
      .leftJoin(userAvatars, eq(userAvatars.userId, users.id))
      .where(eq(users.id, id))
      .limit(1),
  );
}

async function requireUser(db: AppDatabase, id: string): Promise<AuthUser> {
  const user = await userForId(db, id);
  if (!user) throw new AuthError(401, "AUTHENTICATION_REQUIRED", "Sign-in required");
  return user;
}

export async function updateUserAvatarColor(db: AppDatabase, id: string, avatarColor: AvatarColor): Promise<AuthUser> {
  await db.update(users).set({ avatarColor }).where(eq(users.id, id));
  return requireUser(db, id);
}

/** Stores the processed image, replacing (not orphaning) any previous one for the same user. */
export async function replaceUserAvatar(
  db: AppDatabase,
  userId: string,
  image: { contentType: string; data: Buffer },
  now = new Date().toISOString(),
): Promise<AuthUser> {
  const avatarId = randomUUID();
  await db
    .insert(userAvatars)
    .values({ userId, id: avatarId, contentType: image.contentType, data: image.data, updatedAt: now })
    .onDuplicateKeyUpdate({ set: { id: avatarId, contentType: image.contentType, data: image.data, updatedAt: now } });
  return requireUser(db, userId);
}

export async function deleteUserAvatar(db: AppDatabase, userId: string): Promise<AuthUser> {
  await db.delete(userAvatars).where(eq(userAvatars.userId, userId));
  return requireUser(db, userId);
}

export async function findAvatarImage(
  db: AppDatabase,
  avatarId: string,
): Promise<{ contentType: string; data: Buffer } | undefined> {
  return first(
    db
      .select({ contentType: userAvatars.contentType, data: userAvatars.data })
      .from(userAvatars)
      .where(eq(userAvatars.id, avatarId))
      .limit(1),
  );
}
