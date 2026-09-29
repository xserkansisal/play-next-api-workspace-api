import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { createTestContext } from "../helpers.js";

const ctx = createTestContext();
const app = ctx.app;
afterAll(() => ctx.close());

describe("API app", () => {
  it("GET /health returns ok", async () => {
    const res = await request(app).get("/health").expect("Content-Type", /json/).expect(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.uptime).toBe("number");
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
  });

  it("does not expose the x-powered-by header", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows only the configured Vite origin, including SSE preflight headers", async () => {
    const cors = createTestContext(":memory:", { corsOrigin: "http://localhost:5173" });
    try {
      const api = await request(cors.app)
        .get("/api/v1/collections")
        .set("Origin", "http://localhost:5173")
        .expect(200);
      expect(api.headers["access-control-allow-origin"]).toBe("http://localhost:5173");

      const preflight = await request(cors.app)
        .options("/api/v1/events")
        .set("Origin", "http://localhost:5173")
        .set("Access-Control-Request-Method", "GET")
        .set("Access-Control-Request-Headers", "last-event-id")
        .expect(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(preflight.headers["access-control-allow-headers"]).toContain("Last-Event-ID");
      expect(preflight.headers["access-control-allow-methods"]).toContain("GET");

      const rejected = await request(cors.app)
        .get("/api/v1/collections")
        .set("Origin", "http://localhost:5174")
        .expect(200);
      expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      cors.close();
    }
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/does-not-exist").expect(404);
    expect(res.body).toEqual({ error: { code: "NOT_FOUND", message: "Route GET /does-not-exist not found" } });
  });

  it("returns a JSON 400 for malformed JSON bodies", async () => {
    const res = await request(app)
      .post("/health")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
  });
});
