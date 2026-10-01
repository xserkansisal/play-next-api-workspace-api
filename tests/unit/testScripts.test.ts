import { describe, expect, it } from "vitest";
import { executeTestScript, scriptResponseForResult, type ScriptRequest } from "../../src/services/testScripts.js";
import { truncateUtf8 } from "../../src/services/common.js";

const request: ScriptRequest = {
  method: "GET",
  url: "https://example.test/items",
  queryParams: [],
  headers: [],
  body: null,
};

describe("isolated collection test scripts", () => {
  it("runs assertions, captures variables, and returns request edits", async () => {
    const result = await executeTestScript(
      `
pm.request.url += "/" + pm.environment.get("itemId");
pm.environment.set("nextToken", pm.response.json().token);
pm.test("response is successful", () => pm.expect(pm.response.code).to.eql(201));
pm.test("captured the next token", () => pm.expect(pm.environment.get("nextToken")).to.equal("next"));
`,
      {
        request,
        variables: { itemId: "42" },
        response: {
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json" },
          bodyText: '{"token":"next"}',
          sizeBytes: 16,
          truncated: false,
        },
      },
    );

    expect(result.request.url).toBe("https://example.test/items/42");
    expect(result.variables.nextToken).toBe("next");
    expect(result.tests).toEqual([
      { name: "response is successful", passed: true },
      { name: "captured the next token", passed: true },
    ]);
  });

  it("records assertion failures without leaking thrown messages", async () => {
    const result = await executeTestScript(
      `pm.test("status check", () => { throw new Error(pm.environment.get("secret")); });`,
      {
        request,
        variables: { secret: "never-store-this" },
        response: {
          status: 500,
          statusText: "Server Error",
          headers: {},
          bodyText: "",
          sizeBytes: 0,
          truncated: false,
        },
      },
    );

    expect(result.tests).toEqual([{ name: "status check", passed: false, errorCode: "ASSERTION_FAILED" }]);
    expect(JSON.stringify(result.tests)).not.toContain("never-store-this");
  });

  it("returns bounded request edits and captures stringified values", async () => {
    const result = await executeTestScript(
      `
pm.request.method = "POST";
pm.request.queryParams.push({ key: "page", value: "2" });
pm.request.headers.push({ key: "X-Run", value: "yes" });
pm.request.body = JSON.stringify({ item: pm.environment.get("itemId") });
pm.environment.set("captured", { id: "42" });
`,
      { request, variables: { itemId: "42" } },
    );

    expect(result.request).toMatchObject({
      method: "POST",
      queryParams: [{ key: "page", value: "2" }],
      headers: [{ key: "X-Run", value: "yes" }],
      body: '{"item":"42"}',
    });
    expect(result.variables.captured).toBe('{"id":"42"}');
  });

  it("rejects oversized inputs and invalid captured variable keys", async () => {
    await expect(
      executeTestScript("void 0", { request, variables: { oversized: "x".repeat(2_600_000) } }),
    ).rejects.toMatchObject({ code: "SCRIPT_INPUT_TOO_LARGE" });
    await expect(
      executeTestScript(
        `pm.environment.set("invalid key", "value");`,
        { request, variables: {} },
      ),
    ).rejects.toMatchObject({ code: "SCRIPT_FAILED" });
  });

  it("truncates UTF-8 payloads on character boundaries", () => {
    expect(truncateUtf8("🙂🙂", 5)).toEqual({ text: "🙂", truncated: true });
    const response = scriptResponseForResult({
      status: 200,
      statusText: "OK",
      headers: {},
      bodyText: "🙂".repeat(70_000),
      durationMs: 1,
      sizeBytes: 280_000,
      truncated: false,
    });
    expect(Buffer.byteLength(response.bodyText)).toBeLessThanOrEqual(256 * 1024);
    expect(response.truncated).toBe(true);
    expect(response.bodyText).not.toContain("\uFFFD");
  });

  it("cannot access Node globals and enforces execution timeouts", async () => {
    const denied = await executeTestScript(
      `if (typeof process !== "undefined" || typeof require !== "undefined" || typeof fetch !== "undefined" || typeof setTimeout !== "undefined") throw new Error("host access");`,
      { request, variables: {} },
    );
    expect(denied.tests).toEqual([]);

    await expect(
      executeTestScript(`while (true) {}`, { request, variables: {} }, { timeoutMs: 25 }),
    ).rejects.toMatchObject({ code: "SCRIPT_TIMEOUT" });
  });
});
