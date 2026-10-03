import type { RequestAuth, ScopedAuth } from "../validation/schemas.js";
import { isSensitiveVariableKey } from "./secretValues.js";

export interface SensitiveRedaction<T> {
  value: T;
  redacted: boolean;
}

export function redactSensitiveUrl(value: string): SensitiveRedaction<string> {
  let url = value.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]+@/i, "$1");
  let redacted = url !== value;
  const match = url.match(/^([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (match) {
    const query = match[2]?.slice(1);
    let changed = false;
    const safeQuery = query?.split("&").map((parameter) => {
      const separator = parameter.indexOf("=");
      const rawKey = separator < 0 ? parameter : parameter.slice(0, separator);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replaceAll("+", " "));
      } catch {
        // Preserve malformed query keys verbatim; they cannot be reliably classified.
      }
      if (!isSensitiveVariableKey(key)) return parameter;
      changed = true;
      return `${rawKey}={{${key}}}`;
    }).join("&");
    if (changed && safeQuery !== undefined) {
      url = `${match[1]}?${safeQuery}${match[3] ?? ""}`;
      redacted = true;
    }
  }
  return { value: url, redacted };
}

export function redactRequestAuth(auth: RequestAuth): RequestAuth {
  switch (auth.type) {
    case "basic":
      return { type: "basic", username: "{{username}}", password: "{{password}}" };
    case "bearer":
      return { type: "bearer", token: "{{token}}" };
    case "api-key":
      return { type: "api-key", in: auth.in, key: auth.key, value: "{{apiKey}}" };
    default:
      return auth;
  }
}

export function redactScopedAuth(auth: ScopedAuth | null): ScopedAuth | null {
  if (auth === null) return null;
  switch (auth.type) {
    case "basic":
      return { type: "basic", username: "{{username}}", password: "{{password}}" };
    case "bearer":
      return { type: "bearer", token: "{{token}}" };
    case "api-key":
      return { type: "api-key", in: auth.in, key: auth.key, value: "{{apiKey}}" };
    default:
      return auth;
  }
}

export function redactSensitiveJson(value: unknown): SensitiveRedaction<unknown> {
  if (Array.isArray(value)) {
    const values = value.map(redactSensitiveJson);
    return { value: values.map((entry) => entry.value), redacted: values.some((entry) => entry.redacted) };
  }
  if (typeof value !== "object" || value === null) return { value, redacted: false };

  let redacted = false;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveVariableKey(key)) {
      output[key] = `{{${key}}}`;
      redacted = true;
    } else {
      const sanitized = redactSensitiveJson(entry);
      output[key] = sanitized.value;
      redacted ||= sanitized.redacted;
    }
  }
  return { value: output, redacted };
}

export function redactSensitiveJsonText(content: string): SensitiveRedaction<string> {
  try {
    const parsed: unknown = JSON.parse(content);
    const sanitized = redactSensitiveJson(parsed);
    return {
      value: sanitized.redacted ? JSON.stringify(sanitized.value, null, 2) : content,
      redacted: sanitized.redacted,
    };
  } catch {
    return { value: content, redacted: false };
  }
}
