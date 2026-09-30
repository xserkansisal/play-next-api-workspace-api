import { and, desc, eq, isNull, gt } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { authCodes, authRateLimits, authSessions, users } from "../db/schema.js";
import type { DbExecutor } from "../services/tree.js";
import { generateCode, generateSessionToken, hashCode, hashSessionToken, normalizeEmail, verifyCodeHash } from "./crypto.js";
import { HttpError } from "../errors.js";

export const ALLOWED_EMAIL_DOMAINS = ["fluttersea.com", "sisal.com", "sisal.it"] as const;

export interface AuthUser {
  id: string;
  email: string;
}

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

function consumeRateLimit(
  tx: DbExecutor,
  email: string,
  purpose: "request_code" | "verify_code",
  limit: number,
  windowSeconds: number,
  now: string,
): boolean {
  const current = tx
    .select()
    .from(authRateLimits)
    .where(and(eq(authRateLimits.email, email), eq(authRateLimits.purpose, purpose)))
    .get();
  const windowMillis = windowSeconds * 1000;
  const expired = !current || Date.parse(now) - Date.parse(current.windowStartedAt) >= windowMillis;
  if (expired) {
    tx.insert(authRateLimits)
      .values({ email, purpose, windowStartedAt: now, attempts: 1 })
      .onConflictDoUpdate({
        target: [authRateLimits.email, authRateLimits.purpose],
        set: { windowStartedAt: now, attempts: 1 },
      })
      .run();
    return false;
  }
  if (current.attempts >= limit) return true;
  tx.update(authRateLimits)
    .set({ attempts: current.attempts + 1 })
    .where(and(eq(authRateLimits.email, email), eq(authRateLimits.purpose, purpose)))
    .run();
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
> {}

export interface RequestedCode {
  challengeId: string;
  email: string;
  code: string;
  expiresAt: string;
}

export function requestCode(db: AppDatabase, config: AuthServiceConfig, inputEmail: string): RequestedCode {
  const email = validateAllowedEmail(inputEmail);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const challengeId = randomUUID();
  const code = generateCode();
  const expiresAt = isoAfter(config.AUTH_CODE_TTL_SECONDS, nowDate.getTime());

  const outcome = db.transaction((tx) => {
    const limited = consumeRateLimit(
      tx,
      email,
      "request_code",
      config.AUTH_CODE_REQUEST_LIMIT,
      config.AUTH_CODE_REQUEST_WINDOW_SECONDS,
      now,
    );
    if (limited) return false;
    tx.update(authCodes)
      .set({ consumedAt: now })
      .where(and(eq(authCodes.email, email), isNull(authCodes.consumedAt)))
      .run();
    tx.insert(authCodes)
      .values({
        id: challengeId,
        email,
        codeHash: hashCode(config.AUTH_CODE_PEPPER, challengeId, code).toString("hex"),
        createdAt: now,
        expiresAt,
      })
      .run();
    return true;
  }, { behavior: "immediate" });

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

export function verifyCode(db: AppDatabase, config: AuthServiceConfig, inputEmail: string, code: string): VerifyOutcome {
  const email = validateAllowedEmail(inputEmail);
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const generatedSessionToken = generateSessionToken();
  const sessionExpiresAt = isoAfter(config.AUTH_SESSION_TTL_SECONDS, nowDate.getTime());

  return db.transaction((tx): VerifyOutcome => {
    const limited = consumeRateLimit(
      tx,
      email,
      "verify_code",
      config.AUTH_CODE_VERIFY_LIMIT,
      config.AUTH_CODE_VERIFY_WINDOW_SECONDS,
      now,
    );
    if (limited) return { ok: false, rateLimited: true };

    const challenge = tx
      .select()
      .from(authCodes)
      .where(and(eq(authCodes.email, email), isNull(authCodes.consumedAt)))
      .orderBy(desc(authCodes.createdAt))
      .get();
    if (!challenge) return { ok: false, rateLimited: false };
    if (challenge.expiresAt <= now || challenge.attempts >= config.AUTH_CODE_MAX_ATTEMPTS) {
      tx.update(authCodes).set({ consumedAt: now }).where(eq(authCodes.id, challenge.id)).run();
      return { ok: false, rateLimited: false };
    }

    const matches = verifyCodeHash(
      challenge.codeHash,
      hashCode(config.AUTH_CODE_PEPPER, challenge.id, code),
    );
    const nextAttempts = challenge.attempts + 1;
    if (!matches) {
      tx.update(authCodes)
        .set({
          attempts: nextAttempts,
          ...(nextAttempts >= config.AUTH_CODE_MAX_ATTEMPTS ? { consumedAt: now } : {}),
        })
        .where(eq(authCodes.id, challenge.id))
        .run();
      return { ok: false, rateLimited: false };
    }

    tx.update(authCodes)
      .set({ attempts: nextAttempts, consumedAt: now })
      .where(eq(authCodes.id, challenge.id))
      .run();

    let user = tx.select().from(users).where(eq(users.email, email)).get();
    if (!user) {
      const id = randomUUID();
      tx.insert(users).values({ id, email, createdAt: now }).run();
      user = { id, email, createdAt: now };
    }
    tx.insert(authSessions)
      .values({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashSessionToken(generatedSessionToken),
        createdAt: now,
        expiresAt: sessionExpiresAt,
      })
      .run();
    return {
      ok: true,
      session: {
        user: { id: user.id, email: user.email },
        sessionToken: generatedSessionToken,
        expiresAt: sessionExpiresAt,
      },
    };
  }, { behavior: "immediate" });
}

export function findSessionUser(db: AppDatabase, token: string, now = new Date().toISOString()): AuthUser | undefined {
  const session = db
    .select({ id: users.id, email: users.email })
    .from(authSessions)
    .innerJoin(users, eq(authSessions.userId, users.id))
    .where(
      and(
        eq(authSessions.tokenHash, hashSessionToken(token)),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    )
    .get();
  return session;
}

export function revokeSession(db: AppDatabase, token: string, now = new Date().toISOString()): void {
  db.update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.tokenHash, hashSessionToken(token)), isNull(authSessions.revokedAt)))
    .run();
}

export function invalidateCode(db: AppDatabase, challengeId: string, now = new Date().toISOString()): void {
  const challenge = db
    .select()
    .from(authCodes)
    .where(and(eq(authCodes.id, challengeId), isNull(authCodes.consumedAt)))
    .get();
  if (challenge) db.update(authCodes).set({ consumedAt: now }).where(eq(authCodes.id, challenge.id)).run();
}

export function userForId(db: AppDatabase, id: string): AuthUser | undefined {
  const user = db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id)).get();
  return user;
}
