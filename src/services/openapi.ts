import { parseDocument, YAMLParseError } from "yaml";
import { BadRequestError } from "../errors.js";
import {
  redactRequestAuth,
  redactScopedAuth,
  redactSensitiveJson,
  redactSensitiveJsonText,
  redactSensitiveUrl,
} from "./openapiValues.js";
import {
  HTTP_METHODS,
  MAX_IMPORT_NODES,
  MAX_TREE_DEPTH,
  importItemsSchema,
  measureImportShape,
  requestAuthSchema,
  requestBodySchema,
  scopedAuthSchema,
  type RequestAuth,
  type RequestItemFields,
  type ScopedAuth,
  type TreeNodeInput,
} from "../validation/schemas.js";
import type { CreateOpenApiCollectionInput } from "../validation/openapiSchemas.js";

type JsonObject = Record<string, unknown>;
type SupportedMethod = (typeof HTTP_METHODS)[number];
export type OpenApiWarning =
  | { code: "UNSUPPORTED_METHOD"; method: string; path: string }
  | { code: "MULTIPLE_TAGS"; path: string; method: string; usedTag: string }
  | { code: "UNSUPPORTED_SECURITY"; path: string; method: string }
  | { code: "UNSUPPORTED_PARAMETER"; path: string; method: string; parameter: string; location: string }
  | { code: "SENSITIVE_PARAMETER_VALUE"; path: string; method: string; parameter: string; location: "query" | "header" }
  | { code: "SENSITIVE_BODY_VALUE"; path: string; method: string }
  | { code: "SENSITIVE_SERVER_URL"; path: string; method: string }
  | { code: "UNSUPPORTED_BODY"; path: string; method: string; mediaType: string };

export interface OpenApiConversion {
  name: string;
  description: string;
  sourceVersion: string;
  auth: ScopedAuth | null;
  items: TreeNodeInput[];
  operations: OpenApiOperation[];
  warnings: OpenApiWarning[];
}

export interface OpenApiOperation {
  operationId: string | null;
  method: RequestItemFields["method"];
  path: string;
  requestPath: string;
  fields: RequestItemFields;
  folderPath: string[];
  folderAuth: Array<ScopedAuth | null>;
  folderDescriptions: string[];
}

const OPENAPI_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const METHOD_MAP: Record<string, SupportedMethod | undefined> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};
const SENSITIVE_PLACEHOLDER = "{{apiKey}}";

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseSpec(spec: unknown): JsonObject {
  if (typeof spec !== "string") {
    if (!isObject(spec)) throw new BadRequestError("OpenAPI spec must be an object or JSON/YAML text", "INVALID_OPENAPI");
    return spec;
  }
  if (Buffer.byteLength(spec, "utf8") > 10 * 1024 * 1024) {
    throw new BadRequestError("OpenAPI spec must be at most 10 MiB", "OPENAPI_TOO_LARGE");
  }
  try {
    const document = parseDocument(spec, { strict: true, uniqueKeys: true });
    if (document.errors.length > 0) {
      const firstError = document.errors[0];
      throw new BadRequestError(
        `OpenAPI JSON/YAML could not be parsed${firstError instanceof YAMLParseError ? `: ${firstError.message}` : ""}`,
        "INVALID_OPENAPI",
      );
    }
    const parsed = document.toJS({ maxAliasCount: 50 }) as unknown;
    if (!isObject(parsed)) throw new BadRequestError("OpenAPI spec must have an object at its root", "INVALID_OPENAPI");
    return parsed;
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError("OpenAPI JSON/YAML could not be parsed", "INVALID_OPENAPI");
  }
}

function rejectExternalRefs(root: JsonObject): void {
  const visited = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!isObject(current) && !Array.isArray(current)) continue;
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const ref = current.$ref;
    if (typeof ref === "string" && !ref.startsWith("#/")) {
      throw new BadRequestError("Only local OpenAPI $ref references are supported", "OPENAPI_EXTERNAL_REF_UNSUPPORTED", { ref });
    }
    stack.push(...Object.values(current));
  }
}

function resolveRef(root: JsonObject, value: unknown): unknown {
  if (!isObject(value) || typeof value.$ref !== "string") return value;
  const ref = value.$ref;
  if (!ref.startsWith("#/")) {
    throw new BadRequestError("Only local OpenAPI $ref references are supported", "OPENAPI_EXTERNAL_REF_UNSUPPORTED", { ref });
  }
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) || !Object.hasOwn(current, key)) {
      throw new BadRequestError(`OpenAPI reference "${ref}" was not found`, "OPENAPI_REF_NOT_FOUND", { ref });
    }
    current = current[key];
  }
  if (!isObject(current)) throw new BadRequestError(`OpenAPI reference "${ref}" must point to an object`, "INVALID_OPENAPI_REF", { ref });
  return current;
}

function exampleForSchema(root: JsonObject, schemaInput: unknown, depth = 0, seen = new Set<unknown>()): unknown {
  if (depth > 16 || !isObject(schemaInput)) return "";
  const schema = object(resolveRef(root, schemaInput));
  if (seen.has(schema)) return "";
  const nextSeen = new Set(seen).add(schema);
  if (Object.hasOwn(schema, "example")) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Object.hasOwn(schema, "default")) return schema.default;
  switch (schema.type) {
    case "object": {
      const properties = object(schema.properties);
      const output: JsonObject = {};
      for (const [key, property] of Object.entries(properties)) {
        output[key] = exampleForSchema(root, property, depth + 1, nextSeen);
      }
      return output;
    }
    case "array":
      return [exampleForSchema(root, schema.items, depth + 1, nextSeen)];
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "";
  }
}

function contentExample(
  root: JsonObject,
  mediaType: string,
  media: JsonObject,
  warnings: OpenApiWarning[],
  path: string,
  method: string,
): string {
  const examples = object(media.examples);
  for (const example of Object.values(examples)) {
    const value = object(resolveRef(root, example)).value;
    if (value !== undefined) {
      const redacted = redactSensitiveJson(value);
      if (redacted.redacted) warnings.push({ code: "SENSITIVE_BODY_VALUE", path, method });
      return typeof redacted.value === "string" ? redacted.value : JSON.stringify(redacted.value, null, 2);
    }
  }
  if (Object.hasOwn(media, "example")) {
    const redacted = redactSensitiveJson(media.example);
    if (redacted.redacted) warnings.push({ code: "SENSITIVE_BODY_VALUE", path, method });
    return typeof redacted.value === "string" ? redacted.value : JSON.stringify(redacted.value, null, 2);
  }
  const schema = resolveRef(root, media.schema);
  const example = exampleForSchema(root, schema);
  return typeof example === "string" ? example : JSON.stringify(example, null, 2);
}

function bodyForOperation(root: JsonObject, operation: JsonObject, pathItem: JsonObject, warnings: OpenApiWarning[], path: string, method: string) {
  const requestBody = resolveRef(root, operation.requestBody ?? pathItem.requestBody);
  if (!isObject(requestBody)) return null;
  const content = object(requestBody.content);
  for (const [mediaType, mediaValue] of Object.entries(content)) {
    const media = object(mediaValue);
    const normalized = mediaType.toLowerCase();
    let type: "json" | "form-urlencoded" | "multipart" | "raw" | "graphql";
    if (normalized === "application/json" || normalized.endsWith("+json")) type = "json";
    else if (normalized === "application/x-www-form-urlencoded") type = "form-urlencoded";
    else if (normalized === "multipart/form-data") type = "multipart";
    else if (normalized === "application/graphql") type = "graphql";
    else if (normalized.startsWith("text/")) type = "raw";
    else {
      warnings.push({ code: "UNSUPPORTED_BODY", path, method, mediaType });
      return null;
    }
    return { type, content: contentExample(root, mediaType, media, warnings, path, method) };
  }
  return null;
}

function pathParameters(root: JsonObject, pathItem: JsonObject, operation: JsonObject): unknown[] {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ].map((parameter) => resolveRef(root, parameter));
  const unique = new Map<string, unknown>();
  for (const parameter of parameters) {
    const resolved = object(parameter);
    if (typeof resolved.name === "string" && typeof resolved.in === "string") {
      unique.set(`${resolved.in}:${resolved.name}`, resolved);
    }
  }
  return [...unique.values()];
}

function parameterRows(
  parameters: unknown[],
  location: "query" | "header",
  warnings: OpenApiWarning[],
  path: string,
  method: string,
) {
  return parameters.flatMap((input) => {
    const parameter = object(input);
    if (typeof parameter.name !== "string" || typeof parameter.in !== "string") return [];
    if (parameter.in === "cookie") {
      warnings.push({ code: "UNSUPPORTED_PARAMETER", path, method, parameter: parameter.name, location: "cookie" });
      return [];
    }
    if (parameter.in !== location) return [];
    const schema = object(parameter.schema);
    const value = parameter.example ?? schema.example ?? schema.default ?? "";
    const sensitive = /(?:token|secret|password|api[-_]?key|authorization|credential|cookie)/i.test(parameter.name);
    if (sensitive) {
      warnings.push({ code: "SENSITIVE_PARAMETER_VALUE", path, method, parameter: parameter.name, location });
    }
    return [{
      key: parameter.name,
      value: sensitive ? `{{${parameter.name}}}` : typeof value === "string" ? value : JSON.stringify(value),
      description: text(parameter.description) ?? "",
      enabled: typeof parameter["x-play-next-enabled"] === "boolean"
        ? parameter["x-play-next-enabled"]
        : parameter.required === true,
    }];
  });
}

function securityForOperation(root: JsonObject, operation: JsonObject, warnings: OpenApiWarning[], path: string, method: string): RequestAuth {
  const operationOverridesSecurity = Object.hasOwn(operation, "security");
  const security = operationOverridesSecurity ? operation.security : root.security;
  if (!Array.isArray(security)) return { type: "inherit" };
  if (security.length === 0) return operationOverridesSecurity || Array.isArray(root.security) ? { type: "none" } : { type: "inherit" };
  const firstRequirement = object(security[0]);
  const schemes = object(object(root.components).securitySchemes);
  const entries = Object.entries(firstRequirement);
  if (entries.length !== 1 || security.length > 1) {
    warnings.push({ code: "UNSUPPORTED_SECURITY", path, method });
  }
  const [schemeName, scopes] = entries[0] ?? [];
  if (!schemeName || !Array.isArray(scopes)) return { type: "inherit" };
  const scheme = object(resolveRef(root, schemes[schemeName]));
  switch (scheme.type) {
    case "http":
      if (scheme.scheme === "bearer") return { type: "bearer", token: SENSITIVE_PLACEHOLDER };
      if (scheme.scheme === "basic") return { type: "basic", username: "{{username}}", password: "{{password}}" };
      break;
    case "apiKey":
      if ((scheme.in === "header" || scheme.in === "query") && typeof scheme.name === "string") {
        return { type: "api-key", in: scheme.in, key: scheme.name, value: SENSITIVE_PLACEHOLDER };
      }
      break;
  }
  warnings.push({ code: "UNSUPPORTED_SECURITY", path, method });
  return { type: "inherit" };
}

function titleCase(segment: string): string {
  return segment
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment && !/^\{[^{}]+\}$/.test(segment)).map(titleCase);
}

function getOrAddFolder(items: TreeNodeInput[], name: string, description = ""): Extract<TreeNodeInput, { type: "folder" }> {
  const existing = items.find((node) => node.type === "folder" && node.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (existing?.type === "folder") return existing;
  const folder: Extract<TreeNodeInput, { type: "folder" }> = { type: "folder", name, description, items: [] };
  items.push(folder);
  return folder;
}

function operationPath(path: string): string {
  return path.replace(/\{([^{}]+)\}/g, "{{$1}}");
}

function operationUrl(
  root: JsonObject,
  pathItem: JsonObject,
  operation: JsonObject,
  path: string,
  method: string,
  warnings: OpenApiWarning[],
): string {
  const servers = operation.servers ?? pathItem.servers ?? root.servers;
  const server = Array.isArray(servers) ? object(servers[0]) : {};
  const variables = object(server.variables);
  const rawServerUrl = text(server["x-play-next-url"]) ?? text(server.url);
  const templateUrl = rawServerUrl?.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const variable = object(variables[name]);
    return typeof variable.default === "string" ? variable.default : `{{${name}}}`;
  }) ?? "{{baseUrl}}";
  const redactedUrl = redactSensitiveUrl(templateUrl);
  if (redactedUrl.redacted) warnings.push({ code: "SENSITIVE_SERVER_URL", path, method });
  const serverUrl = redactedUrl.value;
  const [serverPath, suffix] = serverUrl.match(/^([^?#]*)(.*)$/)!.slice(1);
  return `${serverPath!.replace(/\/+$/, "")}/${operationPath(path).replace(/^\/+/, "")}${suffix ?? ""}`;
}

function requestPath(url: string): string {
  const absolute = url.match(/^[a-z][a-z\d+.-]*:\/\/[^/?#]+([^?#]*)/i);
  const withoutQuery = absolute
    ? absolute[1] || "/"
    : url.startsWith("{{baseUrl}}")
      ? url.slice("{{baseUrl}}".length).split(/[?#]/, 1)[0] || "/"
      : url.split(/[?#]/, 1)[0] || "/";
  return withoutQuery.replace(/\{\{([^{}]+)\}\}/g, "{$1}");
}

function operationName(operation: JsonObject, method: string, path: string): string {
  return text(operation.summary)?.trim() || text(operation.operationId)?.trim() || `${method.toUpperCase()} ${path}`;
}

export function convertOpenApiSpec(input: CreateOpenApiCollectionInput["spec"]): OpenApiConversion {
  const root = parseSpec(input);
  const version = text(root.openapi);
  if (!version || !/^3\.(0|1)\.\d+(?:[-+].*)?$/.test(version)) {
    throw new BadRequestError("Only OpenAPI 3.0 and 3.1 documents are supported", "OPENAPI_VERSION_UNSUPPORTED", {
      received: version ?? null,
    });
  }
  rejectExternalRefs(root);
  const paths = object(root.paths);
  const tagDescriptions = new Map(
    (Array.isArray(root.tags) ? root.tags : []).flatMap((tag) => {
      const entry = object(tag);
      return typeof entry.name === "string" ? [[entry.name, text(entry.description) ?? ""] as const] : [];
    }),
  );
  const items: TreeNodeInput[] = [];
  const operations: OpenApiOperation[] = [];
  const warnings: OpenApiWarning[] = [];
  const folderAuthByNode = new WeakMap<object, string>();
  let operationCount = 0;

  for (const [path, rawPathItem] of Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))) {
    const pathItem = object(resolveRef(root, rawPathItem));
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!OPENAPI_METHODS.has(method.toLowerCase())) continue;
      const operation = object(resolveRef(root, rawOperation));
      const operationId = text(operation.operationId)?.trim() || null;
      if (operationId && operationId.length > 500) {
        throw new BadRequestError("OpenAPI operationId must be at most 500 characters", "OPENAPI_OPERATION_ID_TOO_LONG", {
          path,
          method: method.toUpperCase(),
        });
      }
      const supportedMethod = METHOD_MAP[method.toLowerCase()];
      if (!supportedMethod) {
        warnings.push({ code: "UNSUPPORTED_METHOD", method: method.toUpperCase(), path });
        continue;
      }

      const importedFolderPath = operation["x-play-next-folder-path"];
      const tags = Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [];
      if (tags.length > 1) warnings.push({ code: "MULTIPLE_TAGS", path, method: method.toUpperCase(), usedTag: tags[0]! });
      const folderNames = Array.isArray(importedFolderPath) && importedFolderPath.every((part) => typeof part === "string")
        ? importedFolderPath as string[]
        : tags.length > 0 ? [titleCase(tags[0]!)] : pathSegments(path);
      if (folderNames.length > MAX_TREE_DEPTH) {
        throw new BadRequestError(`Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`, "OPENAPI_TOO_DEEP", {
          maxDepth: MAX_TREE_DEPTH,
        });
      }
      const importedFolderAuth = Array.isArray(operation["x-play-next-folder-auth"])
        ? operation["x-play-next-folder-auth"]
        : [];
      const importedFolderDescriptions = Array.isArray(operation["x-play-next-folder-descriptions"])
        ? operation["x-play-next-folder-descriptions"]
        : [];
      let siblings = items;
      for (const [index, name] of folderNames.entries()) {
        const folder = getOrAddFolder(
          siblings,
          name,
          typeof importedFolderDescriptions[index] === "string"
            ? importedFolderDescriptions[index]
            : tags.length === 1 ? tagDescriptions.get(tags[0]!) ?? "" : "",
        );
        if (index < importedFolderAuth.length) {
          const auth = redactScopedAuth(scopedAuthSchema.nullable().parse(importedFolderAuth[index]));
          const serializedAuth = JSON.stringify(auth);
          const priorAuth = folderAuthByNode.get(folder);
          if (priorAuth !== undefined && priorAuth !== serializedAuth) {
            throw new BadRequestError(`OpenAPI folders named "${name}" have conflicting auth settings`, "OPENAPI_FOLDER_AUTH_CONFLICT");
          }
          folderAuthByNode.set(folder, serializedAuth);
          folder.auth = auth;
        }
        siblings = folder.items;
      }

      const parameters = pathParameters(root, pathItem, operation);
      const customAuth = operation["x-play-next-auth"];
      const auth = customAuth === undefined
        ? securityForOperation(root, operation, warnings, path, method.toUpperCase())
        : redactRequestAuth(requestAuthSchema.parse(customAuth));
      const body = bodyForOperation(root, operation, pathItem, warnings, path, method.toUpperCase());
      const customBody = operation["x-play-next-body"];
      let bodyFields = customBody === undefined ? body : requestBodySchema.parse(customBody);
      if (bodyFields?.type === "json") {
        const redacted = redactSensitiveJsonText(bodyFields.content);
        if (redacted.redacted) warnings.push({ code: "SENSITIVE_BODY_VALUE", path, method: method.toUpperCase() });
        bodyFields = { ...bodyFields, content: redacted.value };
      }
      const request: RequestItemFields = {
        type: "request" as const,
        name: operationName(operation, method, path),
        description: text(operation.description) ?? "",
        method: supportedMethod,
        url: operationUrl(root, pathItem, operation, path, method.toUpperCase(), warnings),
        queryParams: parameterRows(parameters, "query", warnings, path, method.toUpperCase()),
        headers: parameterRows(parameters, "header", warnings, path, method.toUpperCase()),
        body: bodyFields,
        auth,
        preRequestScript: text(operation["x-play-next-pre-request-script"]) ?? "",
        postResponseScript: text(operation["x-play-next-post-response-script"]) ?? "",
      };
      siblings.push(request);
      operations.push({
        operationId,
        method: supportedMethod,
        path,
        requestPath: requestPath(request.url),
        fields: request,
        folderPath: [...folderNames],
        folderAuth: folderNames.map((_, index) => scopedAuthSchema.nullable().parse(importedFolderAuth[index] ?? null)),
        folderDescriptions: folderNames.map((_, index) => typeof importedFolderDescriptions[index] === "string"
          ? importedFolderDescriptions[index] as string
          : tags.length === 1 ? tagDescriptions.get(tags[0]!) ?? "" : ""),
      });
      operationCount += 1;
    }
  }
  if (operationCount === 0) throw new BadRequestError("OpenAPI spec contains no supported operations", "OPENAPI_NO_OPERATIONS");
  const shape = measureImportShape({ items });
  if (shape.nodes > MAX_IMPORT_NODES) {
    throw new BadRequestError(`An OpenAPI import may contain at most ${MAX_IMPORT_NODES} items`, "OPENAPI_TOO_LARGE", {
      maxItems: MAX_IMPORT_NODES,
    });
  }
  if (shape.depth > MAX_TREE_DEPTH) {
    throw new BadRequestError(`Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`, "OPENAPI_TOO_DEEP", {
      maxDepth: MAX_TREE_DEPTH,
    });
  }
  importItemsSchema.parse({ items });

  const info = object(root.info);
  const collectionAuth = root["x-play-next-collection-auth"] === undefined
    ? null
    : redactScopedAuth(scopedAuthSchema.nullable().parse(root["x-play-next-collection-auth"]));
  return {
    name: text(info.title)?.trim() || "Imported OpenAPI",
    description: text(info.description) ?? "",
    sourceVersion: version,
    auth: collectionAuth,
    items,
    operations,
    warnings,
  };
}
