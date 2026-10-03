import { Router, type Request, type RequestHandler } from "express";
import multer from "multer";
import type { Env } from "../config/env.js";
import type { AppDatabase } from "../db/client.js";
import { MemoryEmailCodeSender, type EmailCodeSender } from "../auth/email.js";
import {
  createSessionForEmail,
  invalidateCode,
  requestCode,
  revokeSession,
  validateAllowedEmail,
  deleteUserAvatar,
  findAvatarImage,
  replaceUserAvatar,
  updateUserAvatarColor,
  verifyCode,
  type AuthServiceConfig,
  type AuthUser,
} from "../auth/service.js";
import { constantTimeStringEqual } from "../auth/crypto.js";
import { AVATAR_CONTENT_TYPE, AVATAR_MAX_BYTES, processAvatarImage } from "../auth/avatarImage.js";
import { withAvatarUrl } from "../auth/avatarUrl.js";
import { HttpError } from "../errors.js";
import { authenticatedUserId, createAuthenticationMiddleware, readCookie } from "../middleware/authenticate.js";
import { emailInputSchema, updateProfileInputSchema, verifyCodeInputSchema } from "../validation/authSchemas.js";

type AuthEnv = Pick<
  Env,
  | "NODE_ENV"
  | "AUTH_CODE_PEPPER"
  | "AUTH_CODE_TTL_SECONDS"
  | "AUTH_CODE_MAX_ATTEMPTS"
  | "AUTH_CODE_REQUEST_LIMIT"
  | "AUTH_CODE_REQUEST_WINDOW_SECONDS"
  | "AUTH_CODE_VERIFY_LIMIT"
  | "AUTH_CODE_VERIFY_WINDOW_SECONDS"
  | "AUTH_SESSION_TTL_SECONDS"
  | "AUTH_COOKIE_NAME"
  | "AUTH_COOKIE_SECURE"
  | "AUTH_DEV_INBOX_TOKEN"
  | "AUTH_DEV_BYPASS"
  | "CORS_ORIGIN"
  | "ADMIN_EMAILS"
>;

function publicUser(req: Request, env: AuthEnv, user: AuthUser) {
  return withAvatarUrl(req, env.CORS_ORIGIN, user);
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 },
}).single("avatar");

const parseAvatarUpload: RequestHandler = (req, res, next) => {
  avatarUpload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      next(new HttpError(413, "Avatar images must be 5 MB or smaller", "AVATAR_TOO_LARGE"));
      return;
    }
    next(new HttpError(400, "Send one image file in the multipart field \"avatar\"", "AVATAR_UPLOAD_INVALID"));
  });
};

function appendCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ["Secure"] : []),
  ].join("; ");
}

function cookieOptions(env: AuthEnv, maxAgeSeconds: number) {
  return { maxAgeSeconds, secure: env.AUTH_COOKIE_SECURE };
}

function isLoopback(address: string | undefined): boolean {
  return address === "::1" || address === "127.0.0.1" || address?.startsWith("::ffff:127.") === true;
}

// A reverse proxy on the same machine makes every client look like a loopback client, because the
// address the API sees is the proxy's. The dev inbox hands out sign-in codes, so "this request came
// from this machine" has to mean it, and behind a proxy it cannot: a forwarding header is proof the
// request was relayed for somebody else. These headers are attacker-controllable, but only in the
// direction that closes the route, so trusting them here is safe.
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", "forwarded"] as const;

function wasForwarded(req: Request): boolean {
  return FORWARDING_HEADERS.some((header) => req.get(header) !== undefined);
}

export function createAuthRouter(
  db: AppDatabase,
  env: AuthEnv,
  sender: EmailCodeSender,
  logger: (err: unknown) => void = (err) => console.error(err),
): Router {
  const router = Router();
  const authConfig: AuthServiceConfig = env;
  const requireAuth = createAuthenticationMiddleware(db, env.AUTH_COOKIE_NAME);

  router.post("/request-code", async (req, res, next) => {
    try {
      const { email: rawEmail } = emailInputSchema.parse(req.body);
      const issued = await requestCode(db, authConfig, rawEmail);
      try {
        await sender.sendCode({ to: issued.email, code: issued.code, expiresAt: issued.expiresAt });
      } catch (err) {
        // The caller is told only that delivery failed, because naming the reason would confirm the
        // address is eligible. The operator needs the opposite: a misconfigured SMTP host is
        // otherwise a 503 with no explanation anywhere, and the reason is a property of this
        // server's configuration, not of the address that was asked for.
        logger(new Error(`Failed to deliver a sign-in code via SMTP: ${err instanceof Error ? err.message : String(err)}`));
        await invalidateCode(db, issued.challengeId);
        res.status(503).json({ error: { code: "AUTH_DELIVERY_FAILED", message: "Unable to send sign-in code" } });
        return;
      }
      res.status(202).json({ message: "If the address is eligible, a sign-in code has been sent.", email: issued.email });
    } catch (err) {
      next(err);
    }
  });

  router.post("/verify-code", async (req, res, next) => {
    try {
      const { email, code } = verifyCodeInputSchema.parse(req.body);
      const outcome = await verifyCode(db, authConfig, email, code);
      if (!outcome.ok) {
        if (outcome.rateLimited) {
          res.status(429).json({ error: { code: "AUTH_RATE_LIMITED", message: "Please wait before trying again" } });
          return;
        }
        res.status(401).json({ error: { code: "INVALID_OR_EXPIRED_CODE", message: "Invalid or expired sign-in code" } });
        return;
      }
      res.setHeader(
        "Set-Cookie",
        appendCookie(env.AUTH_COOKIE_NAME, outcome.session.sessionToken, cookieOptions(env, env.AUTH_SESSION_TTL_SECONDS)),
      );
      res.status(200).json({ user: publicUser(req, env, outcome.session.user), expiresAt: outcome.session.expiresAt });
    } catch (err) {
      next(err);
    }
  });

  // Development only: signs in with just an email, skipping the code. Gated by NODE_ENV and an
  // explicit flag; env validation also refuses the flag outside development.
  if (env.NODE_ENV === "development" && env.AUTH_DEV_BYPASS) {
    router.post("/dev-login", async (req, res, next) => {
      try {
        const { email } = emailInputSchema.parse(req.body);
        const session = await createSessionForEmail(db, authConfig, email);
        res.setHeader(
          "Set-Cookie",
          appendCookie(env.AUTH_COOKIE_NAME, session.sessionToken, cookieOptions(env, env.AUTH_SESSION_TTL_SECONDS)),
        );
        res.status(200).json({ user: publicUser(req, env, session.user), expiresAt: session.expiresAt });
      } catch (err) {
        next(err);
      }
    });
  }

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req, env, req.authUser!) });
  });

  // Only the avatar colour is editable; names and email are derived server-side and the strict
  // schema rejects any attempt to send them.
  router.patch("/me/profile", requireAuth, async (req, res, next) => {
    try {
      const { avatarColor } = updateProfileInputSchema.parse(req.body);
      const user = await updateUserAvatarColor(db, authenticatedUserId(req), avatarColor);
      res.json({ user: publicUser(req, env, user) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/me/avatar", requireAuth, parseAvatarUpload, async (req, res, next) => {
    try {
      if (!req.file) {
        throw new HttpError(400, "Send one image file in the multipart field \"avatar\"", "AVATAR_UPLOAD_INVALID");
      }
      const data = await processAvatarImage(req.file.buffer);
      const user = await replaceUserAvatar(db, authenticatedUserId(req), { contentType: AVATAR_CONTENT_TYPE, data });
      res.json({ user: publicUser(req, env, user) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/me/avatar", requireAuth, async (req, res, next) => {
    try {
      const user = await deleteUserAvatar(db, authenticatedUserId(req));
      res.json({ user: publicUser(req, env, user) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/avatars/:avatarId", requireAuth, async (req, res, next) => {
    try {
      const image = await findAvatarImage(db, String(req.params.avatarId));
      if (!image) {
        res.status(404).json({ error: { code: "AVATAR_NOT_FOUND", message: "Avatar not found" } });
        return;
      }
      // Every upload gets a new id, so a URL's bytes never change and may be cached indefinitely.
      res.setHeader("Content-Type", image.contentType);
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.send(image.data);
    } catch (err) {
      next(err);
    }
  });

  router.post("/sign-out", async (req, res) => {
    const token = readCookie(req, env.AUTH_COOKIE_NAME);
    if (token) await revokeSession(db, token);
    res.setHeader("Set-Cookie", appendCookie(env.AUTH_COOKIE_NAME, "", cookieOptions(env, 0)) + "; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    res.status(204).end();
  });

  if (env.NODE_ENV === "development" && env.AUTH_DEV_INBOX_TOKEN && sender instanceof MemoryEmailCodeSender) {
    router.get("/dev-inbox", (req, res) => {
      const supplied = req.get("X-Dev-Inbox-Token") ?? "";
      if (
        !isLoopback(req.socket.remoteAddress) ||
        wasForwarded(req) ||
        !constantTimeStringEqual(env.AUTH_DEV_INBOX_TOKEN!, supplied)
      ) {
        res.status(404).end();
        return;
      }
      const email = req.query.email;
      if (typeof email !== "string") {
        res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Email query parameter is required" } });
        return;
      }
      const normalized = validateAllowedEmail(email);
      const message = sender.getMessage(normalized);
      if (!message || Date.parse(message.expiresAt) <= Date.now()) {
        res.status(404).json({ error: { code: "DEV_MESSAGE_NOT_FOUND", message: "No current message" } });
        return;
      }
      res.json({ email: message.to, code: message.code, expiresAt: message.expiresAt });
    });
  }

  return router;
}
