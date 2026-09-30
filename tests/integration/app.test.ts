import { afterAll, describe, expect, it } from "vitest";
import { createTestContext } from "../helpers.js";

const ctx = await createTestContext();
afterAll(async () => ctx.close());

describe("API app", () => {
  it("GET /health returns ok", async () => {
    const res = await ctx.api.get("/health").expect("Content-Type", /json/).expect(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });

  it("does not expose the x-powered-by header", async () => {
    const res = await ctx.api.get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows only the configured Vite origin, including SSE preflight headers", async () => {
    const cors = await createTestContext(":memory:", { corsOrigin: "http://localhost:5173" });
    try {
      const api = await cors.api
        .get("/api/v1/collections")
        .set("Origin", "http://localhost:5173")
        .expect(200);
      expect(api.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

      const preflight = await cors.api
        .options("/api/v1/events")
        .set("Origin", "http://localhost:5173")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "last-event-id")
        .expect(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(preflight.headers["access-control-allow-headers"]).toContain("Last-Event-ID");
      expect(preflight.headers["access-control-allow-methods"]).toContain("GET");

      const rejected = await cors.api
        .get("/api/v1/collections")
        .set("Origin", "http://localhost:5174")
        .expect(200);
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it('answers every origin when CORS_ORIGIN is "*", echoing the caller so cookies still work', async () => {
    const cors = await createTestContext(":memory:", { corsOrigin: "*" });
    try {
      for (const origin of ["http://localhost:5173", "http://10.29.125.148:5173", "https://anything.example"]) {
        const api = await cors.api.get("/api/v1/collections").set("Origin", origin).expect(200);
        // The caller's own origin, never a literal "*": a browser refuses to send credentials to a
        // wildcard, and this API authenticates with a session cookie.
        expect(api.headers["access-control-allow-origin"]).toBe(origin);
        expect(api.headers["access-control-allow-credentials"]).toBe("true");
        // Without this a cache could hand one origin's allowance to another.
        expect(api.headers.vary).toContain("Origin");
      }

      const preflight = await cors.api
        .options("/api/v1/events")
        .set("Origin", "https://anything.example")
        .set("Access-Control-Request-Method", "GET")
        .expect(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("https://anything.example");
    } finally {
      await cors.close();
    }
  });

  it("treats a wildcard pattern as a literal origin, so a mistyped guess fails closed", async () => {
    const cors = await createTestContext(":memory:", { corsOrigin: "https://*.example.com" });
    try {
      const res = await cors.api.get("/api/v1/collections").set("Origin", "https://app.example.com").expect(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await cors.close();
    }
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await ctx.api.get("/does-not-exist").expect(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Route GET /does-not-exist not found" } });
  });

  it("returns a JSON 400 for malformed JSON bodies", async () => {
    const res = await ctx.api
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });
});
