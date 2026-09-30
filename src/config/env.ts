import { z } from "zod";

const booleanEnv = (defaultValue: boolean) =>
  z.preprocess(
    (value) => (value === undefined ? (defaultValue ? "true" : "false") : value),
    z.enum(["true", "false"]).transform((value) => value === "true"),
  );

const optionalStringEnv = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

// Every pepper this repository has ever printed as an example. A secret that appears in a public
// git history is known to everyone who can read the repository, which defeats the entire point of
// peppering: the value is what stops a stolen database from being brute-forced. Copying the
// deployment guide's export block verbatim used to produce exactly that, and passed validation.
// Anything added here must stay here even after the docs stop printing it, because an operator who
// copied it once is still running it.
const PUBLISHED_PEPPERS = new Set([
  "local-development-only-pepper-not-for-production",
  "replace-with-a-random-secret-at-least-32-characters",
  "use-a-unique-random-secret-of-at-least-32-characters",
]);

// A typed-out placeholder reaches 32 characters by repetition; a generated secret does not. This
// only rejects the obviously hand-written case - real random output of this length has roughly
// twenty distinct characters, so the threshold is nowhere near it and does not guess at entropy.
const MIN_PEPPER_DISTINCT_CHARACTERS = 5;

const distinctCharacters = (value: string) => new Set(value).size;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/api.sqlite"),
  // A bare "*" means every origin; anything else must be a single origin. The two are validated
  // together so a mistyped wildcard is rejected rather than silently treated as one.
  CORS_ORIGIN: z
    .string()
    .refine(
      (value) => value === "*" || (URL.canParse(value) && new URL(value).origin === value),
      'must be an origin without a path, or "*" for every origin',
    )
    .optional(),
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(1000).max(300_000).default(15_000),
  SSE_RETRY_MS: z.coerce.number().int().min(100).max(300_000).default(3_000),
  AUTH_CODE_PEPPER: z.string().min(32).default("local-development-only-pepper-not-for-production"),
  AUTH_CODE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  AUTH_CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  AUTH_CODE_REQUEST_LIMIT: z.coerce.number().int().min(1).max(100).default(3),
  AUTH_CODE_REQUEST_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  AUTH_CODE_VERIFY_LIMIT: z.coerce.number().int().min(1).max(100).default(10),
  AUTH_CODE_VERIFY_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(3600).max(7_776_000).default(2_592_000),
  AUTH_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default("play_next_session"),
  AUTH_COOKIE_SECURE: booleanEnv(false),
  SMTP_HOST: optionalStringEnv(z.string().min(1)),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanEnv(false),
  SMTP_USER: optionalStringEnv(z.string().min(1)),
  SMTP_PASSWORD: optionalStringEnv(z.string().min(1)),
  SMTP_FROM: optionalStringEnv(z.email()),
  AUTH_DEV_INBOX_TOKEN: optionalStringEnv(z.string().min(32)),
  // Server-side request execution is off until an operator names the hosts it may reach. Empty is
  // the safe default: an open proxy inside a private network is worth more to an attacker than one
  // on the public internet, because this process can reach hosts they cannot. "*" admits every
  // host and is announced at startup.
  PROXY_ALLOWED_HOSTS: optionalStringEnv(z.string().min(1)),
  PROXY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
  PROXY_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).max(104_857_600).default(10_485_760),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === "production") {
    if (PUBLISHED_PEPPERS.has(env.AUTH_CODE_PEPPER)) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_CODE_PEPPER"],
        message:
          "is a value published in this repository, so it is not a secret. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
      });
    } else if (distinctCharacters(env.AUTH_CODE_PEPPER) < MIN_PEPPER_DISTINCT_CHARACTERS) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_CODE_PEPPER"],
        message:
          "repeats too few distinct characters to be randomly generated; length alone is not secrecy. " +
          "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
      });
    }
    if (!env.SMTP_HOST) {
      ctx.addIssue({ code: "custom", path: ["SMTP_HOST"], message: "is required in production" });
    }
    if (!env.SMTP_FROM) {
      ctx.addIssue({ code: "custom", path: ["SMTP_FROM"], message: "is required in production" });
    }
  }
  if ((env.SMTP_USER === undefined) !== (env.SMTP_PASSWORD === undefined)) {
    ctx.addIssue({ code: "custom", path: ["SMTP_USER"], message: "SMTP_USER and SMTP_PASSWORD must be configured together" });
  }
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvValidationError";
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}
