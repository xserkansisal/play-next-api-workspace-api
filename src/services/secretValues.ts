import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const CIPHER = "aes-256-gcm";
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

function keyBytes(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) {
    throw new Error("Environment encryption key is invalid");
  }
  return key;
}

function keyId(encodedKey: string): string {
  return createHash("sha256").update(keyBytes(encodedKey)).digest("hex").slice(0, 16);
}

export function encryptEnvironmentValue(value: string, encodedKey: string): string {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(CIPHER, keyBytes(encodedKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${keyId(encodedKey)}:${nonce.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export interface DecryptedEnvironmentValue {
  value: string;
  needsReEncryption: boolean;
}

export function decryptEnvironmentValue(
  value: string,
  encryptionVersion: number | null,
  currentKey: string,
  previousKey?: string,
): DecryptedEnvironmentValue {
  if (encryptionVersion !== 1) {
    throw new Error("Environment value is not encrypted with a supported format");
  }

  const [format, storedKeyId, nonceText, tagText, ciphertextText, ...extra] = value.split(":");
  if (format !== "v1" || !storedKeyId || !nonceText || !tagText || ciphertextText === undefined || extra.length > 0) {
    throw new Error("Environment value ciphertext is invalid");
  }

  const encodedKey = [currentKey, previousKey].find((candidate) => candidate && keyId(candidate) === storedKeyId);
  if (!encodedKey) throw new Error("Environment value encryption key is unavailable");

  try {
    const nonce = Buffer.from(nonceText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const ciphertext = Buffer.from(ciphertextText, "base64url");
    if (nonce.length !== NONCE_LENGTH || tag.length !== TAG_LENGTH) {
      throw new Error("Invalid ciphertext components");
    }
    const decipher = createDecipheriv(CIPHER, keyBytes(encodedKey), nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return { value: plaintext, needsReEncryption: encodedKey !== currentKey };
  } catch {
    throw new Error("Environment value ciphertext could not be authenticated");
  }
}

export function encryptionKeyId(encodedKey: string): string {
  return keyId(encodedKey);
}

export function isSensitiveVariableKey(key: string): boolean {
  return /(?:token|secret|password|api[-_]?key|authorization|credential|cookie)/i.test(key);
}

export function maskSecretValues(value: string, secrets: Iterable<string>): string;
export function maskSecretValues(value: null, secrets: Iterable<string>): null;
export function maskSecretValues(value: string | null, secrets: Iterable<string>): string | null {
  if (value === null) return null;
  const orderedSecrets = [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length);
  return orderedSecrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
}
