import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTeamMembership, createTeamRow, createTestContext, requestFields, type TestContext } from "../helpers.js";

let upstream: http.Server;
let upstreamPort: number;
let ctx: TestContext;

beforeEach(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ receivedHeader: req.headers["x-chain"] ?? null }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
  ctx = await createTestContext(":memory:", {
    env: { PROXY_ALLOWED_HOSTS: `127.0.0.1:${upstreamPort}` },
  });
});
afterEach(async () => {
  if (ctx) await ctx.close();
  if (upstream?.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("team script library API", () => {
  it("shares ordered hook scripts with requests and uses their latest saved source", async () => {
    const preRequest = (await ctx.api.post("/api/v1/scripts").send({
      name: "Add shared header",
      description: "Shared auth helper",
      stage: "pre-request",
      source: 'pm.request.headers.push({ key: "X-Chain", value: "shared-token" });',
    }).expect(201)).body;
    const postResponse = (await ctx.api.post("/api/v1/scripts").send({
      name: "Check shared header",
      stage: "post-response",
      source: `
pm.test("shared pre-request hook ran", () =>
  pm.expect(pm.response.json().receivedHeader).to.equal("shared-token"));
`,
    }).expect(201)).body;
    const collection = (await ctx.api.post("/api/v1/collections").send({
      name: "Shared script run",
      items: [{
        type: "request",
        name: "Echo",
        method: "GET",
        url: `http://127.0.0.1:${upstreamPort}/echo`,
        preRequestScriptIds: [preRequest.id],
        postResponseScriptIds: [postResponse.id],
      }],
    }).expect(201)).body;

    expect(collection.items[0]).toMatchObject({
      preRequestScriptIds: [preRequest.id],
      postResponseScriptIds: [postResponse.id],
    });
    const listed = await ctx.api.get("/api/v1/scripts").expect(200);
    expect(listed.body.scripts.map((script: { id: string }) => script.id)).toEqual([
      preRequest.id,
      postResponse.id,
    ]);

    const wrongStage = await ctx.api.post(`/api/v1/collections/${collection.id}/items`).send({
      type: "request",
      name: "Invalid hook",
      ...requestFields,
      preRequestScriptIds: [postResponse.id],
    }).expect(400);
    expect(wrongStage.body.error.code).toBe("INVALID_SCRIPT_REFERENCE");

    const deleteInUse = await ctx.api.delete(`/api/v1/scripts/${preRequest.id}`).expect(409);
    expect(deleteInUse.body.error.code).toBe("SCRIPT_IN_USE");
    const stageChange = await ctx.api.put(`/api/v1/scripts/${preRequest.id}`).send({
      name: preRequest.name,
      description: preRequest.description,
      stage: "post-response",
      source: preRequest.source,
    }).expect(409);
    expect(stageChange.body.error.code).toBe("SCRIPT_IN_USE");

    const updated = await ctx.api.put(`/api/v1/scripts/${preRequest.id}`).send({
      name: preRequest.name,
      description: preRequest.description,
      stage: preRequest.stage,
      source: 'pm.request.headers.push({ key: "X-Chain", value: "updated-token" });',
    }).expect(200);
    expect(updated.body.source).toContain("updated-token");
    await ctx.api.put(`/api/v1/scripts/${postResponse.id}`).send({
      name: postResponse.name,
      description: postResponse.description,
      stage: postResponse.stage,
      source: `
pm.test("updated shared pre-request hook ran", () =>
  pm.expect(pm.response.json().receivedHeader).to.equal("updated-token"));
`,
    }).expect(200);

    const listedAfterUpdate = await ctx.api.get("/api/v1/scripts").expect(200);
    expect(listedAfterUpdate.body.scripts.find((script: { id: string }) => script.id === preRequest.id).source)
      .toContain("updated-token");
    const run = await ctx.api.post(`/api/v1/collections/${collection.id}/run`).send({}).expect(201);
    expect(run.body.status).toBe("passed");
    expect(run.body.results[0].assertions[0].name).toBe("updated shared pre-request hook ran");
  });

  it("isolates library records by team and enforces uniqueness by hook stage", async () => {
    const created = await ctx.api.post("/api/v1/scripts").send({
      name: "Common",
      stage: "pre-request",
      source: "",
    }).expect(201);
    const duplicate = await ctx.api.post("/api/v1/scripts").send({
      name: "common",
      stage: "pre-request",
      source: "",
    }).expect(409);
    expect(duplicate.body.error.code).toBe("SCRIPT_NAME_CONFLICT");
    await ctx.api.post("/api/v1/scripts").send({
      name: "Common",
      stage: "post-response",
      source: "",
    }).expect(201);

    const otherTeam = await createTeamRow(ctx.db, "Other scripts team");
    await addTeamMembership(ctx.db, "test@fluttersea.com", otherTeam, "owner");
    const otherList = await ctx.api.get("/api/v1/scripts").set("X-Team-Id", otherTeam).expect(200);
    expect(otherList.body.scripts).toEqual([]);
    await ctx.api.delete(`/api/v1/scripts/${created.body.id}`).set("X-Team-Id", otherTeam).expect(404);
  });
});
