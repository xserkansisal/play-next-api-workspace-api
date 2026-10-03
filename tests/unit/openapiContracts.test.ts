import { describe, expect, it } from "vitest";
import {
  createOpenApiContractValidator,
  type OpenApiContractDocument,
  type OpenApiOperationContract,
} from "../../src/services/openapiContracts.js";
import type { ProxyResult } from "../../src/services/proxy.js";

const operation: OpenApiOperationContract = {
  operationId: "readUser",
  method: "GET",
  path: "/users/{userId}",
  responses: {
    "2XX": {
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/User" },
        },
      },
    },
  },
};

const document: OpenApiContractDocument = {
  openapiVersion: "3.1.0",
  componentsSchemas: {
    User: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  operations: [operation],
};

function response(status: number, body: string, contentType = "application/json"): ProxyResult {
  return {
    status,
    statusText: "OK",
    headers: { "content-type": contentType },
    bodyText: body,
    durationMs: 1,
    sizeBytes: Buffer.byteLength(body),
    truncated: false,
  };
}

describe("OpenAPI response contract validation", () => {
  it("matches status ranges and validates referenced response schemas", () => {
    const validate = createOpenApiContractValidator(document);

    expect(validate(operation, response(200, '{"id":"user-1"}'))).toEqual([]);
    expect(validate(operation, response(204, '{"id":3}'))).toMatchObject([{
      errorCode: "CONTRACT_SCHEMA_MISMATCH",
      path: "$.id",
      expected: "string",
      actual: "integer",
    }]);
  });

  it("reports undocumented status codes and missing required fields", () => {
    const validate = createOpenApiContractValidator(document);

    expect(validate(operation, response(404, "{}"))).toMatchObject([{
      errorCode: "CONTRACT_STATUS_UNEXPECTED",
      expected: "2XX",
      actual: "404",
    }]);
    expect(validate(operation, response(200, "{}"))).toMatchObject([{
      errorCode: "CONTRACT_SCHEMA_MISMATCH",
      path: "$.id",
      actual: "undefined",
    }]);
  });

  it("reports content type and invalid JSON without including body values", () => {
    const validate = createOpenApiContractValidator(document);

    expect(validate(operation, response(200, "secret response", "text/plain"))).toMatchObject([{
      errorCode: "CONTRACT_CONTENT_TYPE_UNEXPECTED",
      expected: "application/json",
      actual: "text/plain",
    }]);
    expect(validate(operation, response(200, "secret response"))).toMatchObject([{
      errorCode: "CONTRACT_INVALID_JSON",
      path: "$",
    }]);
  });

  it("supports nullable types in OpenAPI 3.0 schemas", () => {
    const contract: OpenApiOperationContract = {
      ...operation,
      responses: {
        "200": {
          content: {
            "application/json": {
              schema: { type: "object", properties: { nickname: { type: "string", nullable: true } } },
            },
          },
        },
      },
    };
    const validate = createOpenApiContractValidator({
      openapiVersion: "3.0.3",
      componentsSchemas: {},
      operations: [contract],
    });

    expect(validate(contract, response(200, '{"nickname":null}'))).toEqual([]);
  });
});
