# Frontend integration: OpenAPI import, export, and sync

This guide describes the frontend flows supported by the API. The server-side format, conversion
rules, and OpenAPI limitations are documented in [frontend-openapi.md](frontend-openapi.md).

All routes below use the normal signed-in API client and selected team context. They are available
to collection editors; read-only team members cannot apply imports or sync changes. OpenAPI request
bodies may be up to 10 MiB. Pass either a parsed JSON object or the original JSON/YAML text as
`spec`; the API does not fetch a spec URL or remote `$ref`.

## User-facing entry points

Provide three distinct actions:

| Action | API | Result |
| --- | --- | --- |
| Create collection from a spec | `POST /api/v1/collections/openapi` | Creates a collection immediately |
| Import once into a collection | `POST /api/v1/collections/:collectionId/import/openapi` | Uses bulk-import dry-run/apply behavior; does not link a sync source |
| Export a collection | `GET /api/v1/collections/:collectionId/export/openapi` | Downloads an OpenAPI document |
| Compare or synchronize | Preview and apply routes below | Preview is read-only; apply establishes/updates source tracking |

Do not imply that a one-time import is linked to its source. Only a successful sync apply creates
source tracking, and each collection has at most one tracked OpenAPI source.

## Reading a spec file

Read `.json`, `.yaml`, or `.yml` file contents as text and send that text in `spec`. This avoids
frontend parser differences and lets the backend return consistent validation errors and warnings.
Show the selected filename and allow the user to replace it before submitting. Do not send a
filesystem path or URL in place of the document.

## Create a collection

```http
POST /api/v1/collections/openapi
Content-Type: application/json
```

```json
{
  "spec": "openapi: 3.1.0\ninfo:\n  title: Example API\npaths:\n  /health:\n    get: {}\n",
  "name": "Optional collection name override",
  "description": "Optional description override"
}
```

`name` and `description` are optional. If omitted, the API uses the spec's `info.title` and
`info.description`. A successful response is HTTP `201`:

```json
{
  "collection": { "id": "...", "name": "Example API", "items": [] },
  "warnings": []
}
```

The frontend should show conversion warnings and then navigate to or refresh the created collection.
This action is immediate; there is no preview endpoint for collection creation.

## One-time import into an existing collection

```http
POST /api/v1/collections/:collectionId/import/openapi
Content-Type: application/json
```

```json
{
  "spec": "<JSON/YAML text or parsed OpenAPI object>",
  "parentId": null,
  "onConflict": "rename",
  "dryRun": true
}
```

Use `dryRun: true` first when the user needs to inspect the number of folders/requests and folder
renames. Show the dry-run result and warnings before resubmitting the same import with
`dryRun: false`. `parentId` may be a destination folder ID or `null` for the collection root.
`onConflict` accepts `rename` or `fail`.

The dry-run response is HTTP `200`; a committed import is HTTP `201`. Both include the bulk import
result (`created`, `renames`, `roots`, and related fields) plus OpenAPI `warnings`. Refresh the
collection after a committed import. Import remains independent of future source changes.

## Export and download

```http
GET /api/v1/collections/:collectionId/export/openapi?version=3.1&format=json
```

- `version`: `3.1` (default) or `3.0`.
- `format`: `json` (default) or `yaml`.

Treat the response as a file download, not as a normal JSON API envelope. Preserve the response
filename from `Content-Disposition` when available; it ends in `-openapi.json` or `-openapi.yaml`.
The response body is the document itself. The API uses
`application/vnd.oai.openapi+json` for JSON and `application/yaml` for YAML.

Credentials and sensitive values are replaced with placeholders before export. Export supports
Play Next `x-play-next-*` extensions to preserve collection behavior on a later import.

## Sync: preview, decisions, and apply

Sync is a two-request flow. Keep the exact spec text/object in frontend state between preview and
apply. Do not silently edit, normalize, or reserialize it after preview: the preview token is bound
to the submitted spec and the current collection state.

### 1. Preview

```http
POST /api/v1/collections/:collectionId/sync/openapi/preview
Content-Type: application/json
```

```json
{
  "spec": "<the selected JSON/YAML text or parsed document>"
}
```

The response shape is:

```ts
interface OpenApiSyncPreview {
  collectionId: string;
  linked: boolean;
  source: { title: string; version: string };
  previewToken: string;
  warnings: OpenApiWarning[];
  changes: OpenApiSyncChange[];
}

interface OpenApiSyncChange {
  key: string;
  kind:
    | "add"
    | "adopt"
    | "update"
    | "move"
    | "unchanged"
    | "local-edit"
    | "conflict"
    | "delete"
    | "delete-conflict"
    | "missing";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  operationId?: string;
  itemId?: string;
  candidateItemIds?: string[];
  changedFields?: string[];
  before?: Partial<RequestItem>;
  after?: Partial<RequestItem>;
  recreatable?: boolean;
  beforeFolderPath?: string[];
  afterFolderPath?: string[];
}
```

`key` is `operationId:<operationId>` when a spec operation has an `operationId`; otherwise it is
`route:<METHOD>:<path>`. Use this key in `adopt`, `conflicts`, and `recreate` maps/lists. A preview
token is opaque to the frontend.

Change meanings and required UI handling:

| Kind | Meaning | Apply behavior / frontend decision |
| --- | --- | --- |
| `add` | New operation with no matching untracked request | Created and tracked on apply |
| `adopt` | Same-method/path untracked requests may already represent this operation | Let the user choose one `candidateItemIds` entry to adopt, or omit a choice to create a separate request. Adoption replaces that candidate's request fields with the spec fields |
| `update` | Source fields changed; tracked request has no local field edits | Updated from the spec |
| `move` | Request fields are unchanged but its source folder path changed | Moved to the source path automatically |
| `unchanged` | No request-field or folder-path change | No request field write needed |
| `local-edit` | The request differs from the last synced snapshot, but the spec has not changed those request fields | Local request edits are retained |
| `conflict` | The spec and local request both changed since the last sync | Require the user to choose `keep` or `spec` for every conflict |
| `delete` | Tracked source operation was removed; active request has no local edits | Leave active unless its `itemId` is explicitly selected for Trash |
| `delete-conflict` | Tracked source operation was removed; active request has local edits | Same explicit delete selection; otherwise leave active |
| `missing` | A previously tracked request is not active in the collection | If its operation still exists in the submitted spec, optionally recreate it. Otherwise it can only be unlinked by selecting its `itemId` for removal when present |

Sensitive values in `before` and `after` are redacted by the API. Display those previews as safe
diffs; do not expect them to be byte-for-byte the stored request data. `changedFields` contains
request field names and may contain `folderPath`.

### 2. Collect decisions and apply

Only send choices the user actually made. The apply request is:

```http
POST /api/v1/collections/:collectionId/sync/openapi/apply
Content-Type: application/json
```

```json
{
  "spec": "<exactly the spec submitted to preview>",
  "previewToken": "<preview.previewToken>",
  "adopt": {
    "operationId:getHealth": "<selected candidate item ID>"
  },
  "conflicts": {
    "operationId:updateUser": "keep"
  },
  "deleteItemIds": ["<item ID explicitly selected for Trash>"],
  "recreate": ["operationId:getHealth"]
}
```

All choice fields are optional and default to empty. The frontend must:

- Include a `conflicts` entry for every preview change of kind `conflict`. `keep` retains local
  request fields; `spec` replaces them with the spec version.
- Include `deleteItemIds` only for requests the user explicitly confirmed should move to Trash.
  Omitting an ID retains the request. This is the confirmation boundary for source deletions.
- Include `recreate` only for missing requests whose operation still exists in the submitted spec
  and which the user wants recreated.
- Include an `adopt` mapping only when the user selected a specific candidate. If no candidate is
  selected, apply creates a new request rather than adopting implicitly.

The API validates each decision against the preview, applies all changes in one transaction, and
returns:

```ts
interface OpenApiSyncApplyResult {
  collectionId: string;
  changedAt: string;
  applied: {
    added: number;
    adopted: number;
    updated: number;
    moved: number;
    deleted: number;
    recreated: number;
  };
  pending: OpenApiSyncChange[];
  deletedItemIds: string[];
}
```

`pending` contains unresolved deletion/missing cases left after this apply. A selected deletion
that succeeded is not pending. `deletedItemIds` is useful for local selection cleanup. On success,
refresh the collection tree and show the applied counts, any remaining pending changes, and
warnings. Sync leaves the collection's own name, description, and auth unchanged.

## State and error handling

- Disable duplicate submission while preview/apply is in flight. A successful apply changes the
  preview token, so a repeated apply using it must not be attempted.
- HTTP `409` with `OPENAPI_SYNC_PREVIEW_STALE` means the collection or sync source changed after
  preview. Keep the selected spec, discard prior decisions, fetch a fresh preview, and ask the user
  to confirm the new change list.
- HTTP `400` with `OPENAPI_SYNC_RESOLUTION_REQUIRED` means at least one conflict has no resolution.
  Keep the preview visible and collect the missing `keep`/`spec` choice.
- HTTP `400` with `OPENAPI_SYNC_INVALID_CHOICE` means a submitted choice does not match the
  preview. Do not retry unchanged; refresh the preview and rebuild the decisions.
- Other validation errors use the normal API error envelope
  (`{ error: { code, message, details? } }`). Surface the message and retain the selected file so
  the user can correct or replace it.
- Preview and apply use the same per-user rate limit as import (10 requests per minute by default).
  Handle HTTP `429` with the normal rate-limit UX.

## Folder and authentication behavior

Operations are initially grouped by their first OpenAPI tag, or by static path segments when
untagged. During sync, tracked requests follow that source folder path; a tag/path-derived folder
change is applied automatically, even when the request has a local field conflict. Empty old
folders are not deleted. Existing destination folders keep their current auth settings; newly
created folders receive supported `x-play-next` folder auth settings. The collection's auth is not
changed by sync.

The API imports only supported request methods (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`). Other
methods, unsupported media types, unsupported auth schemes, and unsupported parameter locations
appear as warnings rather than being silently treated as equivalent operations. Show warnings from
the create, import, and sync preview responses.
