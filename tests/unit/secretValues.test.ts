import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  maskSecretValues,
} from "../../src/services/secretValues.js";

const CURRENT_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const PREVIOUS_KEY = randomBytes(32).toString("base64url");

describe("environment secret values", () => {
  it("encrypts with authenticated encryption and decrypts only with the matching key", () => {
    const first = encryptEnvironmentValue("sensitive value", CURRENT_KEY);
    const second = encryptEnvironmentValue("sensitive value", CURRENT_KEY);
    expect(first).not.toBe(second);
    expect(first).not.toContain("sensitive value");
    expect(decryptEnvironmentValue(first, 1, CURRENT_KEY)).toEqual({
      value: "sensitive value",
      needsReEncryption: false,
    });
    expect(() => decryptEnvironmentValue(first, 1, PREVIOUS_KEY)).toThrow("encryption key is unavailable");
  });

  it("decrypts previous-key values for re-encryption during rotation", () => {
    const ciphertext = encryptEnvironmentValue("rotate me", PREVIOUS_KEY);
    expect(decryptEnvironmentValue(ciphertext, 1, CURRENT_KEY, PREVIOUS_KEY)).toEqual({
      value: "rotate me",
      needsReEncryption: true,
    });
  });

  it("rejects plaintext and malformed ciphertext instead of returning it", () => {
    expect(() => decryptEnvironmentValue("plaintext", null, CURRENT_KEY)).toThrow("not encrypted");
    expect(() => decryptEnvironmentValue("v1:key:bad:tag:body", 1, CURRENT_KEY)).toThrow("key is unavailable");
  });

  it("masks secret strings longest-first while leaving ordinary text unchanged", () => {
    expect(maskSecretValues("token and token-plus", ["token", "token-plus"]))
      .toBe("[REDACTED] and [REDACTED]");
    expect(maskSecretValues(null, ["token"])).toBeNull();
  });
});
