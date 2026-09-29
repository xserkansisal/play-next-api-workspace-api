import { describe, expect, it } from "vitest";
import { generateCode, generateSessionToken, hashCode, hashSessionToken, verifyCodeHash } from "../../src/auth/crypto.js";

describe("authentication cryptography", () => {
  it("generates six-digit codes and stores only peppered, challenge-bound hashes", () => {
    const code = generateCode();
    expect(code).toMatch(/^\d{6}$/);
    const digest = hashCode("test-pepper", "challenge-a", code);
    expect(digest).not.toEqual(Buffer.from(code));
    expect(verifyCodeHash(digest.toString("hex"), hashCode("test-pepper", "challenge-a", code))).toBe(true);
    expect(verifyCodeHash(digest.toString("hex"), hashCode("other-pepper", "challenge-a", code))).toBe(false);
    expect(verifyCodeHash(digest.toString("hex"), hashCode("test-pepper", "challenge-b", code))).toBe(false);
  });

  it("generates unguessable-format session tokens and stores only their digest", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(hashSessionToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});
