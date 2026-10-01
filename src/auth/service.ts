import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
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

    await tx
      .insert(users)
      .values({ id: randomUUID(), email, createdAt: now })
      .onDuplicateKeyUpdate({ set: { email } });
    const user = await first(tx.select().from(users).where(eq(users.email, email)).limit(1));
    if (!user) throw new Error("User row disappeared while a verified session was being created");

    await tx.insert(authSessions).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashSessionToken(generatedSessionToken),
      createdAt: now,
      expiresAt: sessionExpiresAt,
    });
    return {
      ok: true,
      session: {
        user: { id: user.id, email: user.email },
        sessionToken: generatedSessionToken,
        expiresAt: sessionExpiresAt,
      },
    };
  });
}

export async function findSessionUser(
  db: AppDatabase,
  token: string,
  now = new Date().toISOString(),
): Promise<AuthUser | undefined> {
  return first(
    db
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
  return first(db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, id)).limit(1));
}
