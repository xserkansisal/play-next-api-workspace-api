import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestContext, type TestContext } from "../helpers.js";

/**
 * A stand-in for the kind of server this feature exists for: it answers normally but sends no CORS
 * headers, so a browser could never read it.
 */
let upstream: http.Server;
let upstreamPort: number;
let lastRequest: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string } | null = null;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      lastRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      };
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      if (req.url === "/teapot") {
        res.writeHead(418, { "content-type": "text/plain" });
        res.end("no coffee");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: req.method, echo: Buffer.concat(chunks).toString() }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

let context: TestContext | null = null;
afterEach(async () => {
  await context?.close();
  context = null;
  lastRequest = null;
});

async function withAllowedHost(): Promise<TestContext> {
  context = await createTestContext(":memory:", {
    env: { PROXY_ALLOWED_HOSTS: `127.0.0.1:${upstreamPort}` },
  });
  return context;
}

const target = (path = "/") => `http://127.0.0.1:${upstreamPort}${path}`;

describe("POST /api/v1/proxy", () => {
  it("rejects an unauthenticated caller before doing anything else", async () => {
    context = await createTestContext(":memory:", { env: { PROXY_ALLOWED_HOSTS: `127.0.0.1:${upstreamPort}` } });
    const response = await context.unauthenticatedApi
      .post("/api/v1/proxy")
      .send({ method: "GET", url: target("/") });

    expect(response.status).toBe(401);
    expect(lastRequest).toBeNull();
  });

  it("executes a request the browser could not, and returns the upstream response", async () => {
    const ctx = await withAllowedHost();
    const response = await ctx.api
      .post("/api/v1/proxy")
      .send({ method: "POST", url: target("/game-math"), headers: [["Content-Type", "application/json"]], body: '{"a":1}' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe(200);
    expect(response.body.truncated).toBe(false);
    expect(JSON.parse(response.body.bodyText)).toEqual({ received: "POST", echo: '{"a":1}' });
    expect(lastRequest?.method).toBe("POST");
    expect(lastRequest?.headers["content-type"]).toBe("application/json");
  });

  it("does not forward the caller's session cookie to the target", async () => {
    const ctx = await withAllowedHost();
    await ctx.api.post("/api/v1/proxy").send({ method: "GET", url: target("/") });

    expect(lastRequest?.headers.cookie).toBeUndefined();
  });

  it("passes an upstream error status through as a completed request", async () => {
    const ctx = await withAllowedHost();
    const response = await ctx.api.post("/api/v1/proxy").send({ method: "GET", url: target("/teapot") });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe(418);
    expect(response.body.bodyText).toBe("no coffee");
  });

  it("returns a redirect instead of following it to an internal address", async () => {
    const ctx = await withAllowedHost();
    const response = await ctx.api.post("/api/v1/proxy").send({ method: "GET", url: target("/redirect") });

    expect(response.body.status).toBe(302);
    expect(response.body.headers.location).toBe("http://169.254.169.254/latest/meta-data/");
    expect(response.body.bodyText).toBe("");
  });

  it("is disabled, and says so, when no allow-list is configured", async () => {
    context = await createTestContext();
    const response = await context.api.post("/api/v1/proxy").send({ method: "GET", url: target("/") });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PROXY_DISABLED");
    expect(lastRequest).toBeNull();
  });

  it("refuses a host outside the allow-list without contacting it", async () => {
    const ctx = await withAllowedHost();
    const response = await ctx.api
      .post("/api/v1/proxy")
      .send({ method: "GET", url: "http://169.254.169.254/latest/meta-data/" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PROXY_HOST_NOT_ALLOWED");
  });

  it("rejects a malformed request body", async () => {
    const ctx = await withAllowedHost();
    const response = await ctx.api.post("/api/v1/proxy").send({ method: "TRACE", url: target("/") });

    expect(response.status).toBe(400);
    expect(lastRequest).toBeNull();
  });

  it("reports an unreachable target as a bad gateway rather than a crash", async () => {
    context = await createTestContext(":memory:", { env: { PROXY_ALLOWED_HOSTS: "127.0.0.1" } });
    // Port 1 is reserved and nothing listens on it.
    const response = await context.api.post("/api/v1/proxy").send({ method: "GET", url: "http://127.0.0.1:1/" });

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("PROXY_REQUEST_FAILED");
  });
});

describe("GET /api/v1/proxy", () => {
  it("reports that it is disabled when nothing is allow-listed", async () => {
    context = await createTestContext();
    const response = await context.api.get("/api/v1/proxy");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ enabled: false, allowedHosts: [] });
  });

  it("reports the configured hosts so the client can explain what is reachable", async () => {
    const ctx = await withAllowedHost();
    const response = await ctx.api.get("/api/v1/proxy");

    expect(response.body.enabled).toBe(true);
    expect(response.body.allowedHosts).toEqual([`127.0.0.1:${upstreamPort}`]);
  });

  it("requires authentication", async () => {
    context = await createTestContext();
    expect((await context.unauthenticatedApi.get("/api/v1/proxy")).status).toBe(401);
  });
});
