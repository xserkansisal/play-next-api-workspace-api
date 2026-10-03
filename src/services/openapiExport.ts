import type { RequestAuth, ScopedAuth } from "../validation/schemas.js";
import { BadRequestError } from "../errors.js";
import { redactRequestAuth, redactScopedAuth, redactSensitiveJsonText } from "./openapiValues.js";
import type { CollectionAggregate } from "./collections.js";
import type { FolderNode, ItemNode, RequestNode } from "./tree.js";

type OpenApiDocument = Record<string, unknown>;
type OpenApiParameter = Record<string, unknown>;

interface RequestAddress {
  server: string;
  path: string;
  query: Array<{ key: string; value: string }>;
}

function safeAuth(auth: RequestAuth | ScopedAuth | null): RequestAuth | ScopedAuth | null {
  if (auth === null) return null;
  if (auth.type === "inherit") return redactRequestAuth(auth);
  return redactScopedAuth(auth);
}

function requestAddress(url: string): RequestAddress {
  const absolute = url.match(/^([a-z][a-z\d+.-]*:\/\/[^/?#]+)([^?#]*)(\?[^#]*)?(?:#.*)?$/i);
  const usesBaseUrl = url.startsWith("{{baseUrl}}");
  let server = absolute?.[1] ?? "{{baseUrl}}";
  if (absolute) {
    try {
      const parsed = new URL(server);
      if (parsed.username || parsed.password) server = parsed.origin;
    } catch {
      server = "{{baseUrl}}";
    }
  }
  const rawPath = absolute ? absolute[2] : usesBaseUrl ? url.slice("{{baseUrl}}".length).split(/[?#]/, 1)[0] : url.split(/[?#]/, 1)[0];
  const rawQuery = absolute?.[3] ?? (url.includes("?") ? `?${url.split("?", 2)[1]!.split("#", 1)[0]}` : "");
  const query = [...new URLSearchParams(rawQuery)].map(([key, value]) => ({ key, value }));
  const path = (rawPath || "/").replace(/\{\{([^{}]+)\}\}/g, "{$1}");
  return { server, path: path.startsWith("/") ? path : `/${path}`, query };
}

function authSecurity(auth: ScopedAuth, schemes: Record<string, unknown>): [] | [{ [name: string]: string[] }] {
  if (auth.type === "none") return [];
  let name: string;
  let scheme: Record<string, unknown>;
  switch (auth.type) {
    case "basic":
      name = "playNextBasic";
      scheme = { type: "http", scheme: "basic" };
      break;
    case "bearer":
      name = "playNextBearer";
      scheme = { type: "http", scheme: "bearer" };
      break;
    case "api-key":
      name = `playNextApiKey${Object.keys(schemes).length + 1}`;
      scheme = { type: "apiKey", in: auth.in, name: auth.key };
      break;
  }
  schemes[name] = scheme;
  return [{ [name]: [] }];
}

function parameterRows(
  location: "query" | "header",
  values: Array<{ key: string; value: string; description?: string; enabled?: boolean }>,
): OpenApiParameter[] {
  return values.map((row) => {
    const sensitive = /(?:token|secret|password|api[-_]?key|authorization|credential|cookie)/i.test(row.key);
    return {
      name: row.key,
      in: location,
      description: row.description || undefined,
      required: row.enabled ?? true,
      schema: { type: "string" },
      ...(row.value !== "" ? { example: sensitive ? `{{${row.key}}}` : row.value } : {}),
      "x-play-next-enabled": row.enabled ?? true,
    };
  });
}

function bodyMediaType(type: NonNullable<RequestNode["body"]>["type"]): string {
  switch (type) {
    case "json":
      return "application/json";
    case "form-urlencoded":
      return "application/x-www-form-urlencoded";
    case "multipart":
      return "multipart/form-data";
    case "graphql":
      return "application/graphql";
    case "raw":
      return "text/plain";
  }
}

function bodyExample(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

function pathParameters(path: string): OpenApiParameter[] {
  const names = [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]!);
  return [...new Set(names)].map((name) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

function openApiServer(serverUrl: string): Record<string, unknown> {
  if (serverUrl === "{{baseUrl}}") {
    return { url: "https://example.com", "x-play-next-url": serverUrl };
  }
  const variables: Record<string, { default: string }> = {};
  const url = serverUrl.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => {
    variables[name] = { default: "example" };
    return `{${name}}`;
  });
  return { url, ...(Object.keys(variables).length > 0 ? { variables } : {}), "x-play-next-url": serverUrl };
}

function folderAuthPath(folders: FolderNode[]): Array<ScopedAuth | null> {
  return folders.map((folder) => safeAuth(folder.auth) as ScopedAuth | null);
}

function addRequest(
  request: RequestNode,
  folders: FolderNode[],
  paths: Record<string, Record<string, unknown>>,
  schemes: Record<string, unknown>,
): void {
  const address = requestAddress(request.url);
  const pathItem = paths[address.path] ?? {};
  const method = request.method.toLowerCase();
  if (Object.hasOwn(pathItem, method)) {
    throw new BadRequestError(
      `Multiple requests map to the same OpenAPI operation ${request.method} ${address.path}`,
      "OPENAPI_EXPORT_DUPLICATE_OPERATION",
      { method: request.method, path: address.path },
    );
  }

  const effectiveAuth = safeAuth(request.effectiveAuth) as ScopedAuth;
  const parameters = [
    ...pathParameters(address.path),
    ...parameterRows("query", [...address.query, ...request.queryParams]),
    ...parameterRows("header", request.headers),
  ];
  const body = request.body
    ? {
        [bodyMediaType(request.body.type)]: {
          example: bodyExample(
            request.body.type === "json"
              ? redactSensitiveJsonText(request.body.content).value
              : request.body.content,
          ),
        },
      }
    : undefined;
  const exportedBody = request.body
    ? {
        ...request.body,
        ...(request.body.type === "json"
          ? { content: redactSensitiveJsonText(request.body.content).value }
          : {}),
      }
    : null;
  const tags = folders.length > 0 ? [folders[0]!.name] : undefined;
  pathItem[method] = {
    operationId: `playNext_${request.id.replaceAll("-", "")}`,
    summary: request.name,
    description: request.description || undefined,
    tags,
    servers: [openApiServer(address.server)],
    parameters,
    requestBody: body ? { content: body } : undefined,
    responses: { default: { description: "Response" } },
    security: authSecurity(effectiveAuth, schemes),
    "x-play-next-name": request.name,
    "x-play-next-folder-path": folders.map((folder) => folder.name),
    "x-play-next-folder-auth": folderAuthPath(folders),
    "x-play-next-folder-descriptions": folders.map((folder) => folder.description),
    "x-play-next-auth": safeAuth(request.auth),
    "x-play-next-body": exportedBody,
    "x-play-next-pre-request-script": request.preRequestScript,
    "x-play-next-post-response-script": request.postResponseScript,
  };
  paths[address.path] = pathItem;
}

function walk(
  nodes: ItemNode[],
  folders: FolderNode[],
  paths: Record<string, Record<string, unknown>>,
  schemes: Record<string, unknown>,
): void {
  for (const node of nodes) {
    if (node.type === "folder") walk(node.items, [...folders, node], paths, schemes);
    else addRequest(node, folders, paths, schemes);
  }
}

export function exportCollectionAsOpenApi(
  collection: CollectionAggregate,
  version: "3.0" | "3.1" = "3.1",
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  const schemes: Record<string, unknown> = {};
  walk(collection.items, [], paths, schemes);
  const root: OpenApiDocument = {
    openapi: version === "3.0" ? "3.0.3" : "3.1.0",
    info: { title: collection.name, version: "1.0.0", description: collection.description || undefined },
    paths,
    "x-play-next-collection-auth": safeAuth(collection.auth),
  };
  if (Object.keys(schemes).length > 0) {
    root.components = { securitySchemes: schemes };
  }
  return root;
}
