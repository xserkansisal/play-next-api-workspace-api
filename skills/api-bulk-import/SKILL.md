---
name: api-bulk-import
description: Create and keep up to date a Play Next bulk import file (api-bulk-import.json) describing every HTTP endpoint of this project's API layer. Use when asked to create, generate, refresh or sync the bulk import / Play Next collection file, and ALWAYS when you add, change, rename or delete an API route, controller, handler or its request validation (path, method, params, headers or body schema) in this project.
---

# API bulk import file

Keep `api-bulk-import.json` at the repository root (unless the project already has one elsewhere -
search for it first and keep its location) as a faithful, deterministic description of this
project's HTTP API, in the Play Next native import format. The file is posted as-is to
`POST /api/v1/collections/:collectionId/import` of the Play Next workspace API.

## When to run

- **Create**: when asked, or when the file does not exist yet and you are changing the API layer.
- **Update, in the same task**: whenever you add, modify, rename or remove a route, controller,
  handler, router mount/prefix, or the validation/DTO that defines a request's params, headers or
  body. Do not finish a task that touched the API layer with this file stale.
- **On request** ("refresh / sync the bulk import file"): do a full rescan.

## Output format (must match exactly)

```jsonc
{
  "onConflict": "rename",
  "items": [ /* TreeNode[] */ ]
}
```

`TreeNode` is one of:

```jsonc
// folder
{ "type": "folder", "name": "Users", "description": "", "items": [ /* TreeNode[] */ ] }

// request
{
  "type": "request",
  "name": "GET /users/:id",
  "description": "",
  "method": "GET",                        // only GET | POST | PUT | PATCH | DELETE
  "url": "{{baseUrl}}/users/{{id}}",
  "queryParams": [ { "key": "page", "value": "", "description": "", "enabled": true } ],
  "headers":     [ { "key": "Content-Type", "value": "application/json", "description": "", "enabled": true } ],
  "body": { "type": "json", "content": "{\n  \"name\": \"\"\n}" },   // or null
  "auth": { "type": "none" }
}
```

Rules enforced by the server - violating any of them rejects the whole import:

- No other keys anywhere (no `id`, `parentId`, `createdAt`, ...). `parentId` and `dryRun` may be
  added at the top level only.
- `name`: 1-200 characters after trimming. Folder names must be unique (case-insensitive) among
  sibling folders. Request names may repeat.
- `url` <= 8192 chars; <= 500 `queryParams` and <= 500 `headers` per request; each key/value
  <= 8192 chars; `description` <= 10000 chars; `body.content` <= 1,000,000 chars, stored verbatim.
- `body` is `null` or `{ "type": "json", "content": string }`. `auth` is always `{ "type": "none" }`.
- At most 2000 nodes in total, nesting at most 32 levels (including the depth of the destination
  folder it is imported into), and the file must be under 10 MB.

## Discovering endpoints

1. Identify the framework(s) from dependencies and entry points (Express, Fastify, Koa, Hono,
   NestJS, Next.js route handlers / `pages/api`, ASP.NET, Spring, FastAPI, Flask, Go
   `net/http`/chi/gin, ...).
2. Resolve full paths: follow router mounts (`app.use("/api/v1/x", router)`), controller and global
   prefixes, versioning and file-system routing. Include every route reachable by a client; skip
   test-only and framework-internal routes.
3. For each route collect the method, full path, path params, query params, headers the handler
   reads, and the request body shape from its validation (zod/joi/yup/class-validator DTOs/
   pydantic/records). Read the validator, not just the handler.

## Mapping rules (deterministic, so updates give small diffs)

- **Folders** follow the resource path after the shared API prefix: `/api/v1/users/:id/orders` ->
  folder `Users` -> folder `Orders`. Folder name = the static segment, title-cased, `-`/`_`
  replaced by spaces. Endpoints on a folder's own path go directly inside it.
- **Request name** = `"<METHOD> <full path as declared>"`, e.g. `GET /api/v1/users/:id`. This is
  the identity key used for updates; never change it for an unchanged endpoint.
- **URL** = `{{baseUrl}}` + full path, each path param rewritten as `{{paramName}}`.
- **queryParams**: one row per documented query param, `value` empty (or the default the code
  defines), `enabled: true` when required, `false` when optional.
- **headers**: `Content-Type: application/json` when the route takes a JSON body, plus headers the
  route reads explicitly. Credentials are **always** placeholders: `Authorization: Bearer {{token}}`,
  `X-API-Key: {{apiKey}}`, `Cookie: {{cookie}}`.
- **body**: for JSON bodies, a pretty-printed (2 spaces) example built from the schema - required
  fields first, placeholder values by type (`""`, `0`, `false`, `[]`, `{}`, `null` for nullable,
  enum -> first value). Non-JSON bodies (form-data, multipart, raw text): `body: null`, and say so
  in `description`.
- **description**: one line from the handler's doc comment if there is one, else `""`. Mention
  anything that could not be represented (e.g. `"Multipart upload - body not represented"`).
- **Unsupported methods** (HEAD, OPTIONS, TRACE, ALL/any): skip them and list them in the report.
  For a route registered for all methods, emit only the methods it actually handles.
- **Ordering**: folders first, then requests, each sorted by name (case-insensitive). The server
  ignores order; a stable file keeps reviews readable.

## Updating an existing file

1. Parse the current file. Index requests by name (`METHOD path`) and folders by their path.
2. Rescan the API (or only the changed routes, when you are sure of the change's scope).
3. **Add** new endpoints into their folder. **Remove** endpoints that no longer exist, and folders
   left empty by that. **Update** changed endpoints: a method or path change is remove + add; a
   param, header or body-schema change updates those fields.
4. **Preserve user edits**: keep existing `description` text, values in `queryParams`, `headers`
   and `body` whose keys still exist, and extra headers a user added. Rewrite a body example only
   when the schema's fields changed, keeping the values of fields that remain.
5. Re-sort as above; write with 2-space indentation and a trailing newline.

## Security

- Never copy real secrets, tokens, passwords or internal hostnames from `.env`, config, fixtures
  or tests into the file. Do not read `.env` values at all; use `{{variables}}`.
- `{{baseUrl}}` stays a variable; never hard-code an environment.

## Validate before finishing

- The file is valid JSON and every node satisfies the rules above (types, allowed keys, methods,
  limits, unique sibling folder names, <= 2000 nodes, depth <= 32).
- Where the Play Next API source is available, parse the file with `importItemsSchema` from
  `src/validation/schemas.ts`.
- Optionally preview against a running Play Next API with a temporary copy that sets
  `"dryRun": true` (never commit that flag):
  `curl -X POST "$PLAY_NEXT_URL/api/v1/collections/<collectionId>/import" -H 'Content-Type: application/json' --cookie "<session cookie>" -d @api-bulk-import.preview.json`

## Report

Finish with a short summary: endpoints added / updated / removed, endpoints skipped and why
(unsupported method, non-JSON body), and credential headers turned into placeholders.

`example.json` next to this file is an excerpt generated with these rules from the Play Next
workspace API itself (collections, items, trash and health routes).
