import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { addTeamMembership, createTestContext, type TestContext } from "../helpers.js";

let upstream: http.Server;
let upstreamPort: number;
let lastEchoHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === "/login") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "chain-token" }));
      return;
    }
    lastEchoHeaders = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ receivedHeader: req.headers["x-chain"] ?? null, path: req.url }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

let ctx: TestContext | null = null;
afterEach(async () => {
  await ctx?.close();
  ctx = null;
  lastEchoHeaders = {};
});

const target = (path: string) => `http://127.0.0.1:${upstreamPort}${path}`;

describe("collection test runner API", () => {
  it("runs requests sequentially, chains captured variables, and records per-user history", async () => {
    ctx = await createTestContext(":memory:", {
      env: { PROXY_ALLOWED_HOSTS: `127.0.0.1:${upstreamPort}` },
    });
    const collection = (
      await ctx.api.post("/api/v1/collections").send({
        name: "Runner",
        items: [
          {
            type: "request",
            name: "01 Login",
            method: "GET",
            url: target("/login"),
            postResponseScript: `
pm.environment.set("token", pm.response.json().token);
pm.test("login succeeded", () => pm.expect(pm.response.code).to.eql(200));
`,
          },
          {
            type: "request",
            name: "02 Echo",
            method: "GET",
            url: target("/echo/{{token}}"),
            headers: [{ key: "X-Chain", value: "{{token}}" }],
            postResponseScript: `
pm.test("uses the captured token", () => pm.expect(pm.response.json().receivedHeader).to.equal("chain-token"));
`,
          },
        ],
      }).expect(201)
    ).body;

    const runResponse = await ctx.api.post(`/api/v1/collections/${collection.id}/run`).send({}).expect(201);
    const run = runResponse.body;
    expect(run).toMatchObject({
      collectionId: collection.id,
      status: "passed",
      requestCount: 2,
      passedCount: 2,
      failedCount: 0,
    });
    expect(run.results.map((result: { itemName: string }) => result.itemName)).toEqual(["01 Login", "02 Echo"]);
    expect(run.results[0].assertions).toEqual([{ name: "login succeeded", passed: true }]);
    expect(run.results[1].assertions).toEqual([{ name: "uses the captured token", passed: true }]);
    expect(run.results[1].responsePreview).toContain("chain-token");
    expect(lastEchoHeaders["x-chain"]).toBe("chain-token");

    const history = await ctx.api.get(`/api/v1/collections/${collection.id}/runs?limit=1`).expect(200);
    expect(history.body).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(history.body.runs[0].id).toBe(run.id);
    expect((await ctx.api.get(`/api/v1/collections/${collection.id}/runs/${run.id}`).expect(200)).body.results)
      .toHaveLength(2);

    const anotherUser = request.agent(ctx.app);
    await anotherUser.post("/api/v1/auth/request-code").send({ email: "runner-viewer@fluttersea.com" }).expect(202);
    const message = ctx.emailSender.getMessage("runner-viewer@fluttersea.com");
    if (!message) throw new Error("Test email sender did not retain the second user's code");
    await anotherUser.post("/api/v1/auth/verify-code").send({ email: message.to, code: message.code }).expect(200);
    await addTeamMembership(ctx.db, "runner-viewer@fluttersea.com", ctx.teamId);
    expect((await anotherUser.get(`/api/v1/collections/${collection.id}/runs`).expect(200)).body.total).toBe(0);
    await anotherUser.get(`/api/v1/collections/${collection.id}/runs/${run.id}`).expect(404);
  });

  it("runs only the selected folder and returns proxy failures as stored request results", async () => {
    ctx = await createTestContext(":memory:", {
      env: { PROXY_ALLOWED_HOSTS: `127.0.0.1:${upstreamPort}` },
    });
    const collection = (
      await ctx.api.post("/api/v1/collections").send({ name: "Folders" }).expect(201)
    ).body;
    const itemsUrl = `/api/v1/collections/${collection.id}/items`;
    const folder = (await ctx.api.post(itemsUrl).send({ type: "folder", name: "Selected" }).expect(201)).body;
    const requestInFolder = (
      await ctx.api.post(itemsUrl).send({
        type: "request",
        name: "Inside",
        parentId: folder.id,
        method: "GET",
        url: target("/inside"),
      }).expect(201)
    ).body;
    await ctx.api.post(itemsUrl).send({
      type: "request",
      name: "Outside",
      method: "GET",
      url: "http://example.invalid/not-allowed",
    }).expect(201);

    const run = (
      await ctx.api.post(`/api/v1/collections/${collection.id}/items/${folder.id}/run`).send({}).expect(201)
    ).body;
    expect(run.folderId).toBe(folder.id);
    expect(run.results.map((result: { itemId: string }) => result.itemId)).toEqual([requestInFolder.id]);

    const fullRun = (
      await ctx.api.post(`/api/v1/collections/${collection.id}/run`).send({}).expect(201)
    ).body;
    expect(fullRun.status).toBe("failed");
    expect(fullRun.results.find((result: { itemName: string }) => result.itemName === "Outside"))
      .toMatchObject({ status: "error", errorCode: "PROXY_HOST_NOT_ALLOWED" });
  });
});
