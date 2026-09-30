import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ENV_KEYS, loadEnv } from "../../src/config/env.js";

const require = createRequire(import.meta.url);
const configPath = join(dirname(fileURLToPath(import.meta.url)), "../../ecosystem.config.cjs");

// The ecosystem file reads process.env when PM2 evaluates it, so the config has to be re-required
// after the environment changes.
function loadConfig(overrides: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, overrides);
  try {
    delete require.cache[require.resolve(configPath)];
    return require(configPath).apps[0] as { env: Record<string, string> };
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const REQUIRED = {
  PORT: "3000",
  DATABASE_PATH: "/tmp/does-not-need-to-exist.sqlite",
  AUTH_CODE_PEPPER: "a-pepper-long-enough-for-the-schema-00000",
};

// The config pins NODE_ENV=production, and production also insists on a configured mail sender.
const PRODUCTION_MINIMUM = {
  ...REQUIRED,
  SMTP_HOST: "smtp.example",
  SMTP_FROM: "no-reply@sisal.com",
};

afterEach(() => {
  delete require.cache[require.resolve(configPath)];
});

describe("PM2 ecosystem configuration", () => {
  // A setting the operator exports but this file forgets to forward is invisible: nothing fails at
  // startup, the API just runs on the default. That is how the server-side proxy came to be
  // silently disabled in production while PROXY_ALLOWED_HOSTS was exported. Deriving the list from
  // the schema means a newly added variable fails here instead of on the server.
  it("forwards every variable the API reads", () => {
    const exported: Record<string, string> = {
      ...REQUIRED,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      CORS_ORIGIN: "https://workspace.example",
      SSE_HEARTBEAT_MS: "15000",
      SSE_RETRY_MS: "3000",
      AUTH_CODE_TTL_SECONDS: "900",
      AUTH_CODE_MAX_ATTEMPTS: "5",
      AUTH_CODE_REQUEST_LIMIT: "3",
      AUTH_CODE_REQUEST_WINDOW_SECONDS: "900",
      AUTH_CODE_VERIFY_LIMIT: "10",
      AUTH_CODE_VERIFY_WINDOW_SECONDS: "900",
      AUTH_SESSION_TTL_SECONDS: "2592000",
      AUTH_COOKIE_NAME: "play_next_session",
      AUTH_COOKIE_SECURE: "false",
      AUTH_DEV_INBOX_TOKEN: "a-token-long-enough-to-pass-validation-00",
      SMTP_HOST: "smtp.example",
      SMTP_PORT: "587",
      SMTP_SECURE: "false",
      SMTP_USER: "mailer",
      SMTP_PASSWORD: "secret",
      SMTP_FROM: "no-reply@sisal.com",
      PROXY_ALLOWED_HOSTS: "10.0.0.1:7799",
      PROXY_TIMEOUT_MS: "30000",
      PROXY_MAX_RESPONSE_BYTES: "10485760",
    };

    const { env } = loadConfig(exported);
    const dropped = ENV_KEYS.filter((key) => !(key in env));
    expect(dropped, "exported by the operator but not forwarded to the API").toEqual([]);
  });

  it("carries the exported proxy allow-list through to a usable configuration", () => {
    const { env } = loadConfig({ ...PRODUCTION_MINIMUM, PROXY_ALLOWED_HOSTS: "10.29.125.148:7799" });
    expect(loadEnv(env).PROXY_ALLOWED_HOSTS).toBe("10.29.125.148:7799");
  });

  it("leaves the proxy disabled when no allow-list is exported", () => {
    const { env } = loadConfig(PRODUCTION_MINIMUM);
    expect(env.PROXY_ALLOWED_HOSTS).toBeUndefined();
    expect(loadEnv(env).PROXY_ALLOWED_HOSTS).toBeUndefined();
  });

  it("refuses to start without the settings that have no safe default", () => {
    for (const missing of Object.keys(REQUIRED)) {
      const partial = { ...REQUIRED, [missing]: "" };
      expect(() => loadConfig(partial), `${missing} should be required`).toThrow(missing);
    }
  });
});
