import { describe, expect, it, vi } from "vitest";

import { HttpError } from "../../src/errors.js";
import { allowsAnyHost, executeProxyRequest, isHostAllowed, parseAllowedHosts } from "../../src/services/proxy.js";

const baseOptions = {
  allowedHosts: ["localhost:7799"],
  timeoutMs: 5_000,
  maxResponseBytes: 1_000_000,
};

const request = {
  method: "POST" as const,
  url: "http://localhost:7799/game-math/startup-data",
  headers: [["Content-Type", "application/json"]] as [string, string][],
  body: "{}",
};

function ok(body = "{}", init: ResponseInit = {}) {
  return vi.fn().mockResolvedValue(new Response(body, { status: 200, ...init }));
}

async function expectHttpError(promise: Promise<unknown>, status: number, code: string) {
  await expect(promise).rejects.toMatchObject({ status, code });
  await expect(promise).rejects.toBeInstanceOf(HttpError);
}

describe("parseAllowedHosts", () => {
  it("reads a comma separated list, trimming and lowercasing", () => {
    expect(parseAllowedHosts(" Localhost:7799 , API.Example.com ")).toEqual(["localhost:7799", "api.example.com"]);
  });

  it("treats absent or empty configuration as no hosts at all", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts(" , , ")).toEqual([]);
  });
});

describe("isHostAllowed", () => {
  it("matches an explicit host and port", () => {
    expect(isHostAllowed(new URL("http://localhost:7799/x"), ["localhost:7799"])).toBe(true);
    expect(isHostAllowed(new URL("http://localhost:7800/x"), ["localhost:7799"])).toBe(false);
  });

  it("lets a bare host entry cover any port", () => {
    expect(isHostAllowed(new URL("http://localhost:1234/x"), ["localhost"])).toBe(true);
  });

  it("applies the default port when the URL omits it", () => {
    expect(isHostAllowed(new URL("https://example.com/x"), ["example.com:443"])).toBe(true);
    expect(isHostAllowed(new URL("http://example.com/x"), ["example.com:80"])).toBe(true);
    expect(isHostAllowed(new URL("http://example.com/x"), ["example.com:443"])).toBe(false);
  });

  it("does not admit a lookalike host by suffix", () => {
    // "evil-example.com" and "example.com.attacker.net" must not pass an entry for "example.com".
    expect(isHostAllowed(new URL("http://evil-example.com/x"), ["example.com"])).toBe(false);
    expect(isHostAllowed(new URL("http://example.com.attacker.net/x"), ["example.com"])).toBe(false);
    expect(isHostAllowed(new URL("http://sub.example.com/x"), ["example.com"])).toBe(false);
  });

  it("allows nothing when the list is empty", () => {
    expect(isHostAllowed(new URL("http://localhost:7799/x"), [])).toBe(false);
  });

  it("admits every host when the list contains the wildcard", () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "https://example.com/x", "http://10.0.0.5:9000/x"]) {
      expect(isHostAllowed(new URL(url), ["*"])).toBe(true);
    }
    // Still true when the wildcard sits alongside named hosts.
    expect(isHostAllowed(new URL("http://anything.invalid/x"), ["localhost:7799", "*"])).toBe(true);
  });

  it("treats only a bare asterisk as a wildcard, not a pattern containing one", () => {
    // Partial patterns are not supported, and must not be read as permissive: "*.example.com"
    // would otherwise look like it works while admitting nothing, or worse, everything.
    expect(isHostAllowed(new URL("http://sub.example.com/x"), ["*.example.com"])).toBe(false);
    expect(isHostAllowed(new URL("http://192.168.1.5/x"), ["192.168.*"])).toBe(false);
  });
});

describe("allowsAnyHost", () => {
  it("is true only for a bare asterisk entry", () => {
    expect(allowsAnyHost(["*"])).toBe(true);
    expect(allowsAnyHost(["localhost:7799", "*"])).toBe(true);
    expect(allowsAnyHost([])).toBe(false);
    expect(allowsAnyHost(["localhost:7799"])).toBe(false);
    expect(allowsAnyHost(["*.example.com"])).toBe(false);
  });
});

describe("executeProxyRequest", () => {
  it("refuses to proxy at all until an operator configures an allow-list", async () => {
    const fetchImpl = ok();
    await expectHttpError(
      executeProxyRequest(request, { ...baseOptions, allowedHosts: [], fetchImpl }),
      403,
      "PROXY_DISABLED",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a host that is not allow-listed, without contacting it", async () => {
    const fetchImpl = ok();
    await expectHttpError(
      executeProxyRequest({ ...request, url: "http://169.254.169.254/latest/meta-data/" }, { ...baseOptions, fetchImpl }),
      403,
      "PROXY_HOST_NOT_ALLOWED",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects schemes other than http and https", async () => {
    const fetchImpl = ok();
    for (const url of ["file:///etc/passwd", "gopher://localhost:7799/x", "data:text/plain,hi"]) {
      await expectHttpError(
        executeProxyRequest({ ...request, url }, { ...baseOptions, allowedHosts: ["localhost"], fetchImpl }),
        400,
        "PROXY_UNSUPPORTED_SCHEME",
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still refuses a non-http scheme under the wildcard, since that defence is not the allow-list", async () => {
    const fetchImpl = ok();
    await expectHttpError(
      executeProxyRequest(
        { ...request, url: "file:///etc/passwd" },
        { ...baseOptions, allowedHosts: ["*"], fetchImpl },
      ),
      400,
      "PROXY_UNSUPPORTED_SCHEME",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a URL that is not absolute", async () => {
    await expectHttpError(
      executeProxyRequest({ ...request, url: "/relative/path" }, { ...baseOptions, fetchImpl: ok() }),
      400,
      "PROXY_INVALID_URL",
    );
  });

  it("never follows redirects, so an allow-listed host cannot bounce it to an internal one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    );
    const result = await executeProxyRequest(request, { ...baseOptions, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
    // The redirect is reported rather than followed.
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("http://169.254.169.254/latest/meta-data/");
  });

  it("strips hop-by-hop headers that would corrupt the upstream connection", async () => {
    const fetchImpl = ok();
    await executeProxyRequest(
      {
        ...request,
        headers: [
          ["Content-Type", "application/json"],
          ["Host", "spoofed.example.com"],
          ["Connection", "close"],
          ["Content-Length", "9999"],
          ["Transfer-Encoding", "chunked"],
        ],
      },
      { ...baseOptions, fetchImpl },
    );

    const sent = fetchImpl.mock.calls[0]![1]!.headers as Headers;
    expect(sent.get("content-type")).toBe("application/json");
    for (const stripped of ["host", "connection", "content-length", "transfer-encoding"]) {
      expect(sent.get(stripped)).toBeNull();
    }
  });

  it("forwards only the submitted headers, so the caller's API session cannot leak upstream", async () => {
    const fetchImpl = ok();
    await executeProxyRequest({ ...request, headers: [["Accept", "application/json"]] }, { ...baseOptions, fetchImpl });

    const sent = fetchImpl.mock.calls[0]![1]!.headers as Headers;
    expect(sent.get("cookie")).toBeNull();
    expect([...sent.keys()]).toEqual(["accept"]);
  });

  it("returns the upstream status, headers and body of a successful call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', { status: 201, statusText: "Created", headers: { "content-type": "application/json" } }),
    );
    const result = await executeProxyRequest(request, { ...baseOptions, fetchImpl });

    expect(result.status).toBe(201);
    expect(result.bodyText).toBe('{"ok":true}');
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.truncated).toBe(false);
    expect(result.sizeBytes).toBe(11);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports an upstream error status as a completed request, not a proxy failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("nope", { status: 500, statusText: "Internal Server Error" }));
    const result = await executeProxyRequest(request, { ...baseOptions, fetchImpl });
    expect(result.status).toBe(500);
  });

  it("does not attach a body to GET or HEAD, which fetch would reject", async () => {
    for (const method of ["GET", "HEAD"] as const) {
      const fetchImpl = ok();
      await executeProxyRequest({ ...request, method, body: "ignored" }, { ...baseOptions, fetchImpl });
      expect(fetchImpl.mock.calls[0]![1]!.body).toBeUndefined();
    }
  });

  it("truncates an oversized response and says so rather than buffering it all", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x".repeat(5_000)));
    const result = await executeProxyRequest(request, { ...baseOptions, maxResponseBytes: 100, fetchImpl });

    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(100);
    expect(result.bodyText).toHaveLength(100);
  });

  it("reports an unreachable host as a bad gateway", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expectHttpError(executeProxyRequest(request, { ...baseOptions, fetchImpl }), 502, "PROXY_REQUEST_FAILED");
  });

  it("reports an aborted request as a gateway timeout", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    await expectHttpError(
      executeProxyRequest(request, { ...baseOptions, timeoutMs: 1_000, fetchImpl }),
      504,
      "PROXY_TIMEOUT",
    );
  });
});
