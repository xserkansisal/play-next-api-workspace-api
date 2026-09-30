import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults when variables are missing", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 3000,
      PROXY_TIMEOUT_MS: 30_000,
      PROXY_MAX_RESPONSE_BYTES: 10_485_760,
      DATABASE_PATH: "./data/api.sqlite",
      SSE_HEARTBEAT_MS: 15000,
      SSE_RETRY_MS: 3000,
      AUTH_CODE_PEPPER: "local-development-only-pepper-not-for-production",
      AUTH_CODE_TTL_SECONDS: 900,
      AUTH_CODE_MAX_ATTEMPTS: 5,
      AUTH_CODE_REQUEST_LIMIT: 3,
      AUTH_CODE_REQUEST_WINDOW_SECONDS: 900,
      AUTH_CODE_VERIFY_LIMIT: 10,
      AUTH_CODE_VERIFY_WINDOW_SECONDS: 900,
      AUTH_SESSION_TTL_SECONDS: 2592000,
      AUTH_COOKIE_NAME: "play_next_session",
      AUTH_COOKIE_SECURE: false,
      SMTP_PORT: 587,
      SMTP_SECURE: false,
    });
  });

  it("parses provided values and coerces PORT", () => {
    expect(loadEnv({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "8080",
      AUTH_CODE_PEPPER: "this-is-a-test-secret-pepper-123456",
      SMTP_HOST: "smtp.test.local",
      SMTP_FROM: "sender@sisal.com",
    })).toMatchObject({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: 8080,
      DATABASE_PATH: "./data/api.sqlite",
      SSE_HEARTBEAT_MS: 15000,
      SSE_RETRY_MS: 3000,
      AUTH_CODE_TTL_SECONDS: 900,
      AUTH_SESSION_TTL_SECONDS: 2592000,
    });
  });

  it("accepts a CORS origin but rejects values that are not origins", () => {
    expect(loadEnv({ CORS_ORIGIN: "http://localhost:5173" }).CORS_ORIGIN).toBe("http://localhost:5173");
    expect(() => loadEnv({ CORS_ORIGIN: "http://localhost:5173/path" })).toThrow(EnvValidationError);
  });

  it("treats blank optional SMTP/development settings as unset", () => {
    expect(loadEnv({
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      SMTP_FROM: "",
      AUTH_DEV_INBOX_TOKEN: "",
    })).toMatchObject({ SMTP_PORT: 587, SMTP_SECURE: false });
  });

  it("throws a descriptive error for invalid values", () => {
    expect(() => loadEnv({ NODE_ENV: "staging", PORT: "not-a-port" })).toThrow(EnvValidationError);
    expect(() => loadEnv({
      NODE_ENV: "production",
      AUTH_CODE_PEPPER: "replace-with-a-random-secret-at-least-32-characters",
      SMTP_HOST: "smtp.test.local",
      SMTP_FROM: "sender@sisal.com",
    })).toThrow(EnvValidationError);
    try {
      loadEnv({ PORT: "70000" });
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.some((i) => i.startsWith("PORT"))).toBe(true);
    }
  });
});
