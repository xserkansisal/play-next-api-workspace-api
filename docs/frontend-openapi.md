# OpenAPI import and export

OpenAPI 3.0 and 3.1 documents can be imported as JSON objects or JSON/YAML text. The API does not
fetch remote specifications or remote `$ref` values; only references inside the submitted document
are supported. Requests require the usual signed-in team context and the `member` role.

## Create a collection

`POST /api/v1/collections/openapi`

```json
{
  "spec": "openapi: 3.1.0\ninfo:\n  title: Example API\npaths:\n  /health:\n    get: {}\n",
  "name": "Optional collection name override",
  "description": "Optional collection description override"
}
```

`spec` may instead be the parsed OpenAPI object. The title and description in `info` are used unless
overridden. The response is `{ "collection": Collection, "warnings": OpenApiWarning[] }`.

## Import into an existing collection

`POST /api/v1/collections/:collectionId/import/openapi`

```json
{
  "spec": { "openapi": "3.1.0", "info": { "title": "Example" }, "paths": { "/health": { "get": {} } } },
  "parentId": null,
  "onConflict": "rename",
  "dryRun": true
}
```

`parentId`, `onConflict`, and `dryRun` have the same behavior as the bulk tree import endpoint. A
dry run returns the created counts, folder renames, and warnings without writing or publishing
events. Both endpoints have the same per-user rate limit and 10 MiB body limit as bulk import.

## Mapping and limitations

- Operations are grouped under the first operation tag. Untagged operations use their static URL
  path segments; path parameters remain in the request URL as `{{parameterName}}`.
- The first applicable server is used, with server variables replaced by their declared defaults
  or `{{variableName}}`.
- Query and header parameters become ordered rows. Request bodies support JSON, form URL encoded,
  multipart, raw text, and GraphQL media types.
- HTTP Basic, Bearer, and API-key security schemes are represented with placeholders, never copied
  as live credentials. More complex or multiple security alternatives are reported as warnings.
- `HEAD`, `OPTIONS`, and `TRACE` operations are skipped with warnings. Unsupported media types are
  also reported instead of silently represented as an empty body.
- `x-play-next-auth`, `x-play-next-body`, `x-play-next-pre-request-script`, and
  `x-play-next-post-response-script` are imported when present.
- Local `$ref` values are resolved. Remote references are rejected without network access.

Imports use the existing atomic bulk-import behavior and its 2,000-item / 32-level tree limits.

## Export a collection

`GET /api/v1/collections/:collectionId/export/openapi?version=3.1&format=json`

The response is a downloadable OpenAPI document. `version` accepts `3.1` (default) or `3.0`;
`format` accepts `json` (default) or `yaml`. Authentication secrets are never exported: auth values
and sensitive query/header values are replaced with variable placeholders. The export includes
standard OpenAPI operations and Play Next `x-play-next-*` extensions for request scripts, body
types, folder paths and auth settings. These extensions allow a document exported here to preserve
Play Next behavior when imported again.

When a request uses the Play Next `{{baseUrl}}` placeholder, the standard OpenAPI server uses
`https://example.com` as a safe editable example and `x-play-next-url` retains the placeholder for
round-trip imports. Duplicate requests that would map to the same OpenAPI path and method return
`400 OPENAPI_EXPORT_DUPLICATE_OPERATION`.

## Preview and synchronize a collection

`POST /api/v1/collections/:collectionId/sync/openapi/preview`

```json
{
  "spec": { "openapi": "3.1.0", "info": { "title": "Example" }, "paths": { "/health": { "get": { "operationId": "getHealth" } } } }
}
```

The preview links nothing by itself. It reports `add`, `adopt`, `update`, `move`, `local-edit`,
`conflict`, `delete`, `delete-conflict`, and `missing` changes with a `previewToken`. Adoption
candidates are untracked requests with the same method and path. Sensitive values are redacted in
the preview. Tracked operations also include `contractChanged: true` and `"responses"` in
`changedFields` when their response definitions or shared component schemas change.

`POST /api/v1/collections/:collectionId/sync/openapi/apply`

Send the same spec and preview token, plus optional explicit choices:

```json
{
  "spec": { "openapi": "3.1.0", "info": { "title": "Example" }, "paths": { "/health": { "get": { "operationId": "getHealth" } } } },
  "previewToken": "<token>",
  "adopt": { "operationId:getHealth": "<candidate-item-id>" },
  "conflicts": { "operationId:getHealth": "spec" },
  "deleteItemIds": ["<item-id>"],
  "recreate": ["operationId:getHealth"]
}
```

`adopt` maps an operation key to one of its previewed candidates; without a choice, a new request
is created instead. `conflicts` is required for every `conflict` (`keep` or `spec`). Requests no
longer in the source are moved to Trash only when their IDs are explicitly supplied in
`deleteItemIds`. `recreate` recreates missing tracked operations by key. Unselected deletes and
missing operations are returned as `pending`; chosen deletions are removed from source tracking.

Sync is available to signed-in collection members and stores one source per collection. Only sync
apply establishes tracking; normal imports remain independent one-time imports. A preview token
becomes stale if the collection or source changes before apply, in which case the caller must fetch
a new preview. Sync updates request operations and tracked placement, but leaves the collection's
own name, description and auth unchanged. Tracked requests follow the source folder path (first
tag, or static path segments for untagged operations); empty old folders are retained. Existing
folder auth settings are preserved, while newly created folders use the source extension auth
settings. Local request-field edits are preserved as `local-edit`; overlapping source and local
edits require an explicit conflict choice. Once applied, the runner validates tracked responses
against the source's documented status codes, media types, and schemas. Collections linked before
response-contract storage was added gain response validation the next time the source is applied.
