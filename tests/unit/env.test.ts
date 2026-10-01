import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults when variables are missing", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 3000,
      PROXY_TIMEOUT_MS: 30_000,
      PROXY_MAX_RESPONSE_BYTES: 10_485_760,
      MYSQL_HOST: "127.0.0.1",
      MYSQL_PORT: 3306,
      MYSQL_USER: "play_next_api",
      MYSQL_DATABASE: "play_next_api",
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
      MYSQL_PASSWORD: "test-password",
    })).toMatchObject({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: 8080,
      MYSQL_HOST: "127.0.0.1",
      MYSQL_PORT: 3306,
      MYSQL_USER: "play_next_api",
      MYSQL_DATABASE: "play_next_api",
      SSE_HEARTBEAT_MS: 15000,
      SSE_RETRY_MS: 3000,
      AUTH_CODE_TTL_SECONDS: 900,
      AUTH_SESSION_TTL_SECONDS: 2592000,
    });
  });

  it("accepts a CORS origin but rejects values that are not origins", () => {
    expect(loadEnv({ CORS_ORIGIN: "http://localhost:5173" }).CORS_ORIGIN).toBe("http://localhost:5173");
    expect(() => loadEnv({ CORS_ORIGIN: "http://localhost:5173/path" })).toThrow(EnvValidationError);
    expect(() => loadEnv({ CORS_ORIGIN: "localhost:5173" })).toThrow(EnvValidationError);
  });

  it('accepts "*" as the one value meaning every origin', () => {
    expect(loadEnv({ CORS_ORIGIN: "*" }).CORS_ORIGIN).toBe("*");
    // Only a bare "*" is the wildcard; a pattern is kept as the literal origin it looks like, so a
    // half-remembered guess cannot quietly open the API to every page on the web.
    expect(loadEnv({ CORS_ORIGIN: "https://*.example.com" }).CORS_ORIGIN).toBe("https://*.example.com");
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
      MYSQL_PASSWORD: "test-password",
    })).toThrow(EnvValidationError);
    try {
      loadEnv({ PORT: "70000" });
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.some((i) => i.startsWith("PORT"))).toBe(true);
    }
  });

  describe("AUTH_CODE_PEPPER in production", () => {
    const productionEnv = (pepper: string) => ({
      NODE_ENV: "production",
      SMTP_HOST: "smtp.test.local",
      SMTP_FROM: "sender@sisal.com",
      MYSQL_PASSWORD: "test-password",
      AUTH_CODE_PEPPER: pepper,
    });

    // Each of these has been printed in this repository as an example, so it is public knowledge.
    it.each([
      "local-development-only-pepper-not-for-production",
      "replace-with-a-random-secret-at-least-32-characters",
      "use-a-unique-random-secret-of-at-least-32-characters",
    ])("refuses a pepper published in this repository: %s", (pepper) => {
      expect(() => loadEnv(productionEnv(pepper))).toThrow(EnvValidationError);
    });

    it("refuses a long pepper typed by repeating one character", () => {
      expect(() => loadEnv(productionEnv("a".repeat(48)))).toThrow(EnvValidationError);
    });

    it("tells the reader how to generate a replacement", () => {
      try {
        loadEnv(productionEnv("a".repeat(48)));
        expect.unreachable("expected the weak pepper to be refused");
      } catch (err) {
        const issue = (err as EnvValidationError).issues.find((i) => i.startsWith("AUTH_CODE_PEPPER"));
        expect(issue).toContain("randomBytes(32)");
      }
    });

    it("accepts a randomly generated pepper", () => {
      const pepper = randomBytes(32).toString("base64url");
      expect(loadEnv(productionEnv(pepper))).toMatchObject({ AUTH_CODE_PEPPER: pepper });
    });
  });
});
