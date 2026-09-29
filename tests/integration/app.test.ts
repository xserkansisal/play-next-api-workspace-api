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
