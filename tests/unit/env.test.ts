import { describe, expect, it } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("applies defaults when variables are missing", () => {
    expect(loadEnv({})).toEqual({
      NODE_ENV: "development",
      HOST: "0.0.0.0",
      PORT: 3000,
      DATABASE_PATH: "./data/api.sqlite",
    });
  });

  it("parses provided values and coerces PORT", () => {
    expect(loadEnv({ NODE_ENV: "production", HOST: "127.0.0.1", PORT: "8080" })).toEqual({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: 8080,
      DATABASE_PATH: "./data/api.sqlite",
    });
  });

  it("throws a descriptive error for invalid values", () => {
    expect(() => loadEnv({ NODE_ENV: "staging", PORT: "not-a-port" })).toThrow(EnvValidationError);
    try {
      loadEnv({ PORT: "70000" });
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).issues.some((i) => i.startsWith("PORT"))).toBe(true);
    }
  });
});
