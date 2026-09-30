// Server-side execution of a user's request.
//
// A browser-based REST client can never reach a server that does not send CORS headers, which is a
// restriction on the *page*, not on the request. Executing the request from here removes that
// limit - but it also turns this API into a machine that makes arbitrary outbound HTTP requests on
// behalf of whoever is signed in. That is server-side request forgery, and inside a private network
// it is worth more to an attacker than it would be on the public internet, because this process can
// reach hosts the attacker cannot.
//
// The defences, in order of how much they carry:
//
//  1. An allow-list, and no proxying at all until an operator sets one. Nothing is implicitly
//     reachable. This is the whole security boundary; everything below is depth.
//  2. Redirects are never followed. An allow-listed host could otherwise redirect to a cloud
//     metadata endpoint or another internal service and smuggle the response back out. The redirect
//     is returned to the caller as an ordinary response instead, which an API client wants anyway.
//  3. Only http and https. No file:, no gopher:, no data:.
//  4. Nothing about the caller's session is forwarded: headers come only from the submitted request,
//     so the session cookie for this API cannot leak to a third-party host.
//  5. Hop-by-hop headers are dropped, and a bounded response size and timeout keep one request from
//     exhausting the process.
//
// Residual risk, stated rather than hidden: an allow-listed name is trusted, so if an operator
// allow-lists a host whose DNS an attacker controls, that attacker chooses the address this process
// connects to. The allow-list is operator-controlled configuration, so this is a deliberate trade;
// it is not defended against here.

import { z } from "zod";

import { HttpError } from "../errors.js";

export const PROXYABLE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/**
 * Headers that describe a single network hop. Forwarding them corrupts the upstream connection,
 * and `content-length` in particular would contradict the body we actually send.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const proxyRequestSchema = z.strictObject({
  method: z.enum(PROXYABLE_METHODS),
  url: z.string().min(1).max(8_192),
  headers: z.array(z.tuple([z.string().max(8_192), z.string().max(8_192)])).max(500).default([]),
  body: z.string().max(10_000_000).nullable().default(null),
});

export type ProxyRequest = z.infer<typeof proxyRequestSchema>;

export interface ProxyResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText: string;
  durationMs: number;
  sizeBytes: number;
  /** True when the response was cut off at the size limit, so the body must not be trusted as complete. */
  truncated: boolean;
}

export interface ProxyOptions {
  allowedHosts: readonly string[];
  timeoutMs: number;
  maxResponseBytes: number;
  fetchImpl?: typeof fetch;
}

/**
 * Parses `PROXY_ALLOWED_HOSTS`. Entries are `host` (any port) or `host:port`, compared
 * case-insensitively. An empty value leaves the proxy disabled.
 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * A target is allowed when the allow-list names its `host:port`, or names the host with no port at
 * all. Matching is exact: no wildcards, and no suffix matching, because `evil-example.com` must not
 * be admitted by an entry for `example.com`.
 */
export function isHostAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return false;
  const hostname = url.hostname.toLowerCase();
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const port = url.port || defaultPort;
  return allowedHosts.includes(`${hostname}:${port}`) || allowedHosts.includes(hostname);
}

function parseTargetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `"${raw}" is not a valid absolute URL.`, "PROXY_INVALID_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, `Only http and https can be proxied, not "${url.protocol}".`, "PROXY_UNSUPPORTED_SCHEME");
  }
  return url;
}

function buildOutboundHeaders(headers: readonly (readonly [string, string])[]): Headers {
  const outbound = new Headers();
  for (const [key, value] of headers) {
    const name = key.trim();
    if (name === "" || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    try {
      outbound.append(name, value);
    } catch {
      throw new HttpError(400, `"${name}" is not a valid header name or value.`, "PROXY_INVALID_HEADER");
    }
  }
  return outbound;
}

/**
 * Reads the body, stopping once `maxBytes` is exceeded so a huge or endless response cannot exhaust
 * memory. Returns what was read plus whether it was cut short, rather than failing: a truncated
 * response is still informative, as long as the caller is told.
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; sizeBytes: number; truncated: boolean }> {
  if (!response.body) return { text: "", sizeBytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (sizeBytes + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - sizeBytes)));
        sizeBytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      sizeBytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), sizeBytes, truncated };
}

export async function executeProxyRequest(request: ProxyRequest, options: ProxyOptions): Promise<ProxyResult> {
  if (options.allowedHosts.length === 0) {
    throw new HttpError(
      403,
      "Server-side request execution is disabled. An operator must set PROXY_ALLOWED_HOSTS to the hosts that may be reached.",
      "PROXY_DISABLED",
    );
  }

  const url = parseTargetUrl(request.url);
  if (!isHostAllowed(url, options.allowedHosts)) {
    throw new HttpError(
      403,
      `"${url.host}" is not in PROXY_ALLOWED_HOSTS, so this server will not send the request there. ` +
        "Add it to that setting and restart the API if it should be reachable.",
      "PROXY_HOST_NOT_ALLOWED",
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await doFetch(url, {
      method: request.method,
      headers: buildOutboundHeaders(request.headers),
      // A GET or HEAD carrying a body is rejected by fetch, so send none regardless of what was submitted.
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpError(504, `The request to ${url.host} timed out after ${options.timeoutMs}ms.`, "PROXY_TIMEOUT");
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `This server could not reach ${url.host}: ${detail}`, "PROXY_REQUEST_FAILED");
  } finally {
    clearTimeout(timeout);
  }

  try {
    const { text, sizeBytes, truncated } = await readBoundedBody(response, options.maxResponseBytes);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      bodyText: text,
      durationMs: Date.now() - startedAt,
      sizeBytes,
      truncated,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new HttpError(504, `The response from ${url.host} timed out after ${options.timeoutMs}ms.`, "PROXY_TIMEOUT");
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `The response from ${url.host} could not be read: ${detail}`, "PROXY_REQUEST_FAILED");
  }
}
