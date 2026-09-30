import { describe, expect, it } from "vitest";
import { defaultEmailCodeSender } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { MemoryEmailCodeSender, SmtpEmailCodeSender } from "../../src/auth/email.js";

const smtp = { SMTP_HOST: "smtp.test.local", SMTP_FROM: "noreply@sisal.com" };

describe("choosing an email sender", () => {
  // Selecting on NODE_ENV meant SMTP settings could not be exercised anywhere except the one
  // deployment where getting them wrong is most expensive.
  it("uses SMTP in development once it is configured, so settings can be checked before production", () => {
    const env = loadEnv({ NODE_ENV: "development", ...smtp });
    expect(defaultEmailCodeSender(env)).toBeInstanceOf(SmtpEmailCodeSender);
  });

  it("falls back to the in-memory sender when SMTP is not configured", () => {
    expect(defaultEmailCodeSender(loadEnv({ NODE_ENV: "development" }))).toBeInstanceOf(MemoryEmailCodeSender);
  });

  // A half-configured transport would throw at construction, taking the whole API down at startup
  // rather than at the first sign-in.
  it("does not treat a host without a sender as configured", () => {
    const env = loadEnv({ NODE_ENV: "development", SMTP_HOST: "smtp.test.local" });
    expect(defaultEmailCodeSender(env)).toBeInstanceOf(MemoryEmailCodeSender);
  });

  it("still uses SMTP in production", () => {
    const env = loadEnv({
      NODE_ENV: "production",
      AUTH_CODE_PEPPER: "a-production-pepper-that-is-long-enough-to-pass",
      ...smtp,
    });
    expect(defaultEmailCodeSender(env)).toBeInstanceOf(SmtpEmailCodeSender);
  });
});
