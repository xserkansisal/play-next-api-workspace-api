import { describe, expect, it } from "vitest";
import { convertOpenApiSpec } from "../../src/services/openapi.js";
import { exportCollectionAsOpenApi } from "../../src/services/openapiExport.js";
import { redactSensitiveUrl } from "../../src/services/openapiValues.js";
import type { CollectionAggregate } from "../../src/services/collections.js";

describe("convertOpenApiSpec", () => {
  it("converts OpenAPI 3.0 JSON using the first tag and resolves local parameter and body refs", () => {
    const converted = convertOpenApiSpec({
      openapi: "3.0.3",
      info: { title: "Orders API", description: "Order service" },
      tags: [{ name: "orders", description: "Order operations" }],
      paths: {
        "/orders/{orderId}": {
          parameters: [{ $ref: "#/components/parameters/orderId" }],
          get: {
            tags: ["orders"],
            operationId: "readOrder",
            summary: "Read order",
            description: "Fetch one order",
            parameters: [{ name: "verbose", in: "query", required: false, schema: { type: "boolean", default: true } }],
          },
          post: {
            tags: ["orders"],
            requestBody: { $ref: "#/components/requestBodies/order" },
            security: [{ bearerAuth: [] }],
          },
        },
      },
      components: {
        parameters: {
          orderId: { name: "orderId", in: "path", required: true, schema: { type: "string" } },
        },
        requestBodies: {
          order: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { id: { type: "integer" }, enabled: { type: "boolean" } },
                },
              },
            },
          },
        },
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
    });

    expect(converted).toMatchObject({ name: "Orders API", description: "Order service", auth: null, warnings: [] });
    expect(converted.items).toHaveLength(1);
    expect(converted.items[0]).toMatchObject({
      type: "folder",
      name: "Orders",
      description: "Order operations",
      items: [
        {
          type: "request",
          name: "Read order",
          description: "Fetch one order",
          method: "GET",
          url: "{{baseUrl}}/orders/{{orderId}}",
          queryParams: [{ key: "verbose", value: "true", enabled: false }],
          headers: [],
          body: null,
          auth: { type: "inherit" },
        },
        {
          type: "request",
          name: "POST /orders/{orderId}",
          method: "POST",
          body: { type: "json", content: '{\n  "id": 0,\n  "enabled": false\n}' },
          auth: { type: "bearer", token: "{{apiKey}}" },
        },
      ],
    });
  });

  describe("exportCollectionAsOpenApi", () => {
    it("exports valid 3.0/3.1 documents, redacts credentials, and round-trips Play Next fields", () => {
      const collection: CollectionAggregate = {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Workspace",
        description: "API collection",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        createdBy: null,
        updatedBy: null,
        auth: { type: "basic", username: "actual-user", password: "collection-secret" },
        items: [{
          id: "00000000-0000-4000-8000-000000000002",
          collectionId: "00000000-0000-4000-8000-000000000001",
          parentId: null,
          name: "Orders",
          description: "Folder description",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          createdBy: null,
          updatedBy: null,
          type: "folder",
          auth: { type: "bearer", token: "folder-secret" },
          items: [{
            id: "00000000-0000-4000-8000-000000000003",
            collectionId: "00000000-0000-4000-8000-000000000001",
            parentId: "00000000-0000-4000-8000-000000000002",
            name: "Create order",
            description: "Create one order",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            createdBy: null,
            updatedBy: null,
            type: "request",
            method: "POST",
            url: "https://url-user:url-secret@example.test/orders/{{orderId}}",
            queryParams: [{ key: "access_token", value: "query-secret", description: "credential", enabled: true }],
            headers: [{ key: "Authorization", value: "header-secret", description: "", enabled: true }],
            body: { type: "json", content: '{"password":"body-secret","orderId":3}' },
            auth: { type: "inherit" },
            effectiveAuth: { type: "bearer", token: "request-secret" },
            preRequestScript: "before()",
            postResponseScript: "after()",
            preRequestScriptIds: [],
            postResponseScriptIds: [],
          }],
        }],
      };
      const document = exportCollectionAsOpenApi(collection);
      const serialized = JSON.stringify(document);
      const operation = (document.paths as Record<string, Record<string, Record<string, unknown>>>)["/orders/{orderId}"]!.post!;

      expect(document.openapi).toBe("3.1.0");
      expect(serialized).not.toContain("actual-user");
      expect(serialized).not.toContain("collection-secret");
      expect(serialized).not.toContain("folder-secret");
      expect(serialized).not.toContain("request-secret");
      expect(serialized).not.toContain("query-secret");
      expect(serialized).not.toContain("header-secret");
      expect(serialized).not.toContain("url-user");
      expect(serialized).not.toContain("url-secret");
      expect(serialized).not.toContain("body-secret");
      expect(operation.security).toEqual([{ playNextBearer: [] }]);

      const roundTrip = convertOpenApiSpec(document);
      const folder = roundTrip.items[0]!;
      expect(folder).toMatchObject({
        type: "folder",
        name: "Orders",
        description: "Folder description",
        auth: { type: "bearer", token: "{{token}}" },
        items: [{
          type: "request",
          name: "Create order",
          body: { type: "json", content: '{\n  "password": "{{password}}",\n  "orderId": 3\n}' },
          auth: { type: "inherit" },
          preRequestScript: "before()",
          postResponseScript: "after()",
          queryParams: [{ key: "access_token", value: "{{access_token}}" }],
          headers: [{ key: "Authorization", value: "{{Authorization}}" }],
        }],
      });
      expect(roundTrip.auth).toEqual({ type: "basic", username: "{{username}}", password: "{{password}}" });
      expect(exportCollectionAsOpenApi(collection, "3.0").openapi).toBe("3.0.3");
    });
  });

  it("parses YAML and groups untagged operations by static path segments", () => {
    const converted = convertOpenApiSpec(`
openapi: 3.1.0
info:
  title: Example
paths:
  /users/{userId}/orders:
    get:
      operationId: listOrders
`);

    expect(converted.items).toMatchObject([
      {
        type: "folder",
        name: "Users",
        items: [{
          type: "folder",
          name: "Orders",
          items: [{ type: "request", name: "listOrders", url: "{{baseUrl}}/users/{{userId}}/orders" }],
        }],
      },
    ]);
  });

  it("warns for unsupported methods, extra tags, and unrepresentable body media types", () => {
    const converted = convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Example" },
      paths: {
        "/upload": {
          tags: [],
          options: { tags: ["Files", "Admin"] },
          post: {
            tags: ["Files", "Admin"],
            requestBody: { content: { "application/octet-stream": { schema: { type: "string" } } } },
          },
        },
      },
    });

    expect(converted.warnings).toEqual([
      { code: "UNSUPPORTED_METHOD", method: "OPTIONS", path: "/upload" },
      { code: "MULTIPLE_TAGS", path: "/upload", method: "POST", usedTag: "Files" },
      { code: "UNSUPPORTED_BODY", path: "/upload", method: "POST", mediaType: "application/octet-stream" },
    ]);
  });

  it("keeps sensitive parameter values as placeholders and honors an empty security override", () => {
    const converted = convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Example" },
      security: [{ bearerAuth: [] }],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
      paths: {
        "/profile": {
          get: {
            security: [],
            parameters: [
              { name: "access_token", in: "query", example: "must-not-be-stored" },
              { name: "session", in: "cookie" },
            ],
          },
        },
      },
    });
    const request = converted.items[0]!.type === "folder" ? converted.items[0]!.items[0]! : converted.items[0]!;

    expect(request).toMatchObject({
      type: "request",
      auth: { type: "none" },
      queryParams: [{ key: "access_token", value: "{{access_token}}" }],
    });
    expect(converted.warnings).toContainEqual({
      code: "SENSITIVE_PARAMETER_VALUE",
      path: "/profile",
      method: "GET",
      parameter: "access_token",
      location: "query",
    });
    expect(converted.warnings).toContainEqual({
      code: "UNSUPPORTED_PARAMETER",
      path: "/profile",
      method: "GET",
      parameter: "session",
      location: "cookie",
    });
    expect(JSON.stringify(converted)).not.toContain("must-not-be-stored");
  });

  it("redacts sensitive keys in OpenAPI request-body examples", () => {
    const converted = convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Example" },
      paths: {
        "/login": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  example: { username: "player", password: "must-not-be-stored" },
                },
              },
            },
          },
        },
      },
    });
    const folder = converted.items[0]!;
    const request = folder.type === "folder" ? folder.items[0]! : folder;

    expect(request).toMatchObject({
      type: "request",
      body: { type: "json", content: '{\n  "username": "player",\n  "password": "{{password}}"\n}' },
    });
    expect(converted.warnings).toContainEqual({ code: "SENSITIVE_BODY_VALUE", path: "/login", method: "POST" });
    expect(JSON.stringify(converted)).not.toContain("must-not-be-stored");
  });

  it("redacts URL credentials and vendor-extension auth values on import", () => {
    const converted = convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Example" },
      servers: [{ url: "https://server-user:server-secret@example.test" }],
      paths: {
        "/health": {
          get: {
            "x-play-next-auth": { type: "bearer", token: "request-secret" },
          },
        },
      },
    });
    const folder = converted.items[0]!;
    const request = folder.type === "folder" ? folder.items[0]! : folder;

    expect(request).toMatchObject({
      type: "request",
      url: "https://example.test/health",
      auth: { type: "bearer", token: "{{token}}" },
    });
    expect(converted.warnings).toContainEqual({ code: "SENSITIVE_SERVER_URL", path: "/health", method: "GET" });
    expect(JSON.stringify(converted)).not.toContain("server-user");
    expect(JSON.stringify(converted)).not.toContain("server-secret");
    expect(JSON.stringify(converted)).not.toContain("request-secret");
  });

  it("preserves sensitive query placeholders and appends paths before server queries", () => {
    const redacted = redactSensitiveUrl("https://example.test/v1?token=first&token=second#section");
    expect(redacted).toEqual({
      value: "https://example.test/v1?token={{token}}&token={{token}}#section",
      redacted: true,
    });

    const converted = convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Query server" },
      servers: [{ url: "https://example.test/v1?access_token=secret" }],
      paths: { "/health": { get: {} } },
    });
    const item = converted.items[0]!;
    const request = item.type === "folder" ? item.items[0]! : item;
    expect(request).toMatchObject({
      url: "https://example.test/v1/health?access_token={{access_token}}",
    });
    expect(request.type === "request" ? request.url : "").not.toContain("secret");
  });

  it("rejects unsupported versions, malformed YAML, missing local refs, and all remote refs", () => {
    expect(() => convertOpenApiSpec({ openapi: "2.0", paths: {} })).toThrowError(/Only OpenAPI 3.0 and 3.1/);
    expect(() => convertOpenApiSpec("openapi: [")).toThrowError(/could not be parsed/);
    expect(() => convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Broken ref" },
      paths: { "/": { get: { parameters: [{ $ref: "#/components/parameters/missing" }] } } },
    })).toThrowError(/was not found/);
    expect(() => convertOpenApiSpec({
      openapi: "3.1.0",
      info: { title: "Remote ref" },
      paths: { "/": { get: { parameters: [{ $ref: "https://example.test/parameters.yaml" }] } } },
    })).toThrowError(/Only local OpenAPI/);
  });
});
