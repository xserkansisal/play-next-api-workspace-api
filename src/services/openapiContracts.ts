import { createHash } from "node:crypto";
import { Ajv2020, type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { ProxyResult } from "./proxy.js";

export interface OpenApiContractResponse {
  content: Record<string, { schema?: unknown }>;
}

export interface OpenApiOperationContract {
  operationId: string | null;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  responses: Record<string, OpenApiContractResponse>;
}

export interface OpenApiContractDocument {
  openapiVersion: string;
  componentsSchemas: Record<string, unknown>;
  operations: OpenApiOperationContract[];
}

export interface ContractAssertion {
  name: string;
  passed: false;
  errorCode:
    | "CONTRACT_STATUS_UNEXPECTED"
    | "CONTRACT_CONTENT_TYPE_UNEXPECTED"
    | "CONTRACT_INVALID_JSON"
    | "CONTRACT_RESPONSE_TRUNCATED"
    | "CONTRACT_SCHEMA_MISMATCH"
    | "CONTRACT_SCHEMA_INVALID";
  path?: string;
  expected?: string;
  actual?: string;
}

type ResponseContract = OpenApiOperationContract["responses"][string];

const NON_VALIDATING_SCHEMA_ANNOTATIONS = new Set([
  "$comment",
  "default",
  "deprecated",
  "description",
  "discriminator",
  "example",
  "examples",
  "externalDocs",
  "readOnly",
  "title",
  "writeOnly",
  "xml",
]);

export function sanitizeOpenApiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeOpenApiSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => !NON_VALIDATING_SCHEMA_ANNOTATIONS.has(key))
    .map(([key, value]) => [key, sanitizeOpenApiSchema(value)]));
}

function diagnosticText(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function summarize(values: string[]): string {
  return diagnosticText(values.sort().join(", "));
}

function normalizeSchema(schema: unknown, isOpenApi30: boolean, seen = new WeakMap<object, unknown>()): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeSchema(entry, isOpenApi30, seen));
  }
  if (typeof schema !== "object" || schema === null) return schema;
  const prior = seen.get(schema);
  if (prior !== undefined) return prior;
  const output: Record<string, unknown> = {};
  seen.set(schema, output);
  const schemaObject = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries(schemaObject)) {
    if (isOpenApi30 && key === "nullable") continue;
    if (isOpenApi30 && (key === "exclusiveMinimum" || key === "exclusiveMaximum") && typeof value === "number") {
      output[key === "exclusiveMinimum" ? "minimum" : "maximum"] = value;
      output[key] = true;
      continue;
    }
    output[key] = normalizeSchema(value, isOpenApi30, seen);
  }
  if (isOpenApi30 && schemaObject.nullable === true && typeof schemaObject.type === "string") {
    output.type = [...new Set([schemaObject.type, "null"])];
  }
  return output;
}

function rewriteLocalRefs(schema: unknown, schemaDocumentId: string): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => rewriteLocalRefs(entry, schemaDocumentId));
  if (typeof schema !== "object" || schema === null) return schema;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    output[key] = key === "$ref" && typeof value === "string" && value.startsWith("#/")
      ? `${schemaDocumentId}${value}`
      : rewriteLocalRefs(value, schemaDocumentId);
  }
  return output;
}

function mediaTypeMatches(expected: string, actual: string): boolean {
  const [expectedType, expectedSubtype] = expected.toLowerCase().split("/", 2);
  const [actualType, actualSubtype] = actual.toLowerCase().split("/", 2);
  return (expectedType === "*" || expectedType === actualType)
    && (expectedSubtype === "*" || expectedSubtype === actualSubtype);
}

function selectResponse(
  responses: OpenApiOperationContract["responses"],
  status: number,
): ResponseContract | undefined {
  return responses[String(status)]
    ?? responses[`${Math.floor(status / 100)}XX`]
    ?? responses.default;
}

function jsonPath(instancePath: string, error: ErrorObject): string {
  const segments = instancePath.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    segments.push(error.params.missingProperty);
  } else if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    segments.push(error.params.additionalProperty);
  }
  return segments.reduce((path, part) => {
    if (/^(0|[1-9]\d*)$/.test(part)) return `${path}[${part}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(part)) return `${path}.${part}`;
    return `${path}[${JSON.stringify(part)}]`;
  }, "$");
}

function valueAtPath(value: unknown, path: string): unknown {
  const segments = path === "$" ? [] : [...path.matchAll(/\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g)]
    .map((match) => match[1] ?? match[2] ?? JSON.parse(`"${match[3]}"`) as string);
  let current = value;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Array.isArray(current)
      ? /^\d+$/.test(segment) ? current[Number(segment)] : undefined
      : (current as Record<string, unknown>)[segment];
  }
  return current;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value) && typeof value === "number") return "integer";
  return typeof value;
}

export function createOpenApiContractValidator(document: OpenApiContractDocument): (
  operation: OpenApiOperationContract,
  response: ProxyResult,
) => ContractAssertion[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false, messages: false });
  const isOpenApi30 = document.openapiVersion.startsWith("3.0.");
  const componentSchemas = normalizeSchema(document.componentsSchemas, isOpenApi30) as Record<string, unknown>;
  const schemaDocumentId = `https://play-next.invalid/openapi/${createHash("sha256")
    .update(JSON.stringify(componentSchemas))
    .digest("hex")}`;
  try {
    ajv.addSchema({
      $id: schemaDocumentId,
      components: { schemas: componentSchemas },
    });
  } catch {
    return () => [{
      name: "OpenAPI response schema",
      passed: false,
      errorCode: "CONTRACT_SCHEMA_INVALID",
    }];
  }
  const validators = new Map<string, ValidateFunction>();
  const checkSchema = (schema: unknown): ValidateFunction => {
    const normalized = normalizeSchema(schema, isOpenApi30);
    const rewritten = rewriteLocalRefs(normalized, schemaDocumentId);
    const key = JSON.stringify(rewritten);
    const cached = validators.get(key);
    if (cached) return cached;
    const compiled = ajv.compile(rewritten as AnySchema);
    validators.set(key, compiled);
    return compiled;
  };

  return (operation, response) => {
    const assertions: ContractAssertion[] = [];
    const selected = selectResponse(operation.responses, response.status);
    if (!selected) {
      assertions.push({
        name: "OpenAPI response status",
        passed: false,
        errorCode: "CONTRACT_STATUS_UNEXPECTED",
        expected: summarize(Object.keys(operation.responses)) || "no documented status",
        actual: String(response.status),
      });
      return assertions;
    }

    const content = selected.content;
    if (!content || Object.keys(content).length === 0) return assertions;
    const actualContentType = diagnosticText(
      response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "",
      200,
    );
    const matchingMediaType = Object.keys(content)
      .sort((left, right) => Number(right.toLowerCase() === actualContentType) - Number(left.toLowerCase() === actualContentType))
      .find((mediaType) => mediaTypeMatches(mediaType, actualContentType));
    if (!matchingMediaType) {
      assertions.push({
        name: "OpenAPI response content type",
        passed: false,
        errorCode: "CONTRACT_CONTENT_TYPE_UNEXPECTED",
        expected: summarize(Object.keys(content)),
        actual: actualContentType || "missing",
      });
      return assertions;
    }

    const schema = content[matchingMediaType]?.schema;
    if (schema === undefined) return assertions;
    if (response.truncated) {
      assertions.push({
        name: "OpenAPI response body",
        passed: false,
        errorCode: "CONTRACT_RESPONSE_TRUNCATED",
        path: "$",
      });
      return assertions;
    }

    let body: unknown = response.bodyText;
    if (actualContentType === "application/json" || actualContentType.endsWith("+json")) {
      try {
        body = JSON.parse(response.bodyText) as unknown;
      } catch {
        assertions.push({
          name: "OpenAPI response JSON",
          passed: false,
          errorCode: "CONTRACT_INVALID_JSON",
          path: "$",
        });
        return assertions;
      }
    }

    try {
      const validate = checkSchema(schema);
      if (!validate(body)) {
        for (const error of (validate.errors ?? []).slice(0, 25)) {
          const path = jsonPath(error.instancePath, error);
          const actual = valueAtPath(body, path);
          assertions.push({
            name: "OpenAPI response body schema",
            passed: false,
            errorCode: "CONTRACT_SCHEMA_MISMATCH",
            path: diagnosticText(path, 1_000),
            ...(error.keyword === "type" ? { expected: diagnosticText(String(error.params.type)) } : {}),
            ...(["type", "required"].includes(error.keyword) ? { actual: valueType(actual) } : {}),
          });
        }
      }
    } catch {
      assertions.push({
        name: "OpenAPI response schema",
        passed: false,
        errorCode: "CONTRACT_SCHEMA_INVALID",
      });
    }
    return assertions;
  };
}
