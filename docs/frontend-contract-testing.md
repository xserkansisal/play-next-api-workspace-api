# Frontend integration: OpenAPI contract testing

This guide describes how the frontend enables OpenAPI response contracts, starts collection runs,
and renders contract failures. The runner is synchronous: the run endpoint returns the finished run
and results. Calls use the normal signed-in API client, session cookie, and selected team context.

## What is validated

Response validation is enabled for operations tracked by an **applied OpenAPI sync source**:

- The response HTTP status must match an exact response code, a status range such as `2XX`, or
  `default`.
- When the selected response declares `content`, the response `Content-Type` must match one of its
  media types. Exact media types take precedence over wildcards such as `application/*`.
- When the matched media type declares a schema, the response body is checked against it. JSON and
  `+json` content types are parsed as JSON; other content types are validated as text.
- A truncated body cannot be validated and is reported as a contract failure.

Undocumented status codes, content types, invalid JSON, truncated bodies, and schema mismatches fail
the request. When the matching response has no `content`, or its media type has no `schema`, the
corresponding body check is skipped. A normal upstream `4xx`/`5xx` is not itself a failure when it
is documented by the contract.

One-time OpenAPI create/import operations do not link a contract. Only a successful OpenAPI sync
apply tracks operations and enables their response validation. Requests not tracked to an operation
in that source are unaffected.

## Sync flow

Use the existing two-step sync flow:

1. `POST /api/v1/collections/:collectionId/sync/openapi/preview` with
   `{ "spec": "<JSON/YAML text or parsed OpenAPI document>" }`.
2. Show `contractChanged: true` (and `"responses"` in `changedFields`) when present on a tracked
   operation. This indicates that its response definitions or shared component schemas changed.
   It is informational; it does not require an extra choice.
3. `POST /api/v1/collections/:collectionId/sync/openapi/apply` with the **same spec** and returned
   `previewToken`, plus any normal `adopt`, `conflicts`, `deleteItemIds`, and `recreate` choices.
4. Refresh the collection tree after successful apply.

The API stores only the response contracts needed by the runner: OpenAPI version, component
schemas, operation identity/method/path, response status definitions, media types, and response
schemas. It does not need to retain or refetch the original spec. Applying a sync refreshes the
stored contracts in the same operation as updating sync tracking.

Collections with an existing sync link created before contract storage was introduced have no
stored response contract yet. Preview and apply the current source spec once to enable validation.

## Run requests

Run a collection or folder using the existing runner API:

```http
POST /api/v1/collections/:collectionId/run
POST /api/v1/collections/:collectionId/items/:folderId/run
Content-Type: application/json
```

```json
{ "environmentId": "optional-environment-uuid" }
```

Send `{}` when no environment is selected. Both routes return `201` after completion. The body
contains the final run status and per-request results; there is no polling endpoint for an active
run. A collection or folder run continues after contract failures so the user can see all outcomes.
See [frontend-collection-runner.md](frontend-collection-runner.md) for limits, scripts, privacy, and
history behavior.

## Result types and rendering

The result keeps the existing runner shape. Contract failures are entries in `assertions`; they do
not populate the request-level `errorCode`, which is reserved for execution errors such as proxy or
script failures.

```ts
type ContractErrorCode =
  | "CONTRACT_STATUS_UNEXPECTED"
  | "CONTRACT_CONTENT_TYPE_UNEXPECTED"
  | "CONTRACT_INVALID_JSON"
  | "CONTRACT_RESPONSE_TRUNCATED"
  | "CONTRACT_SCHEMA_MISMATCH"
  | "CONTRACT_SCHEMA_INVALID";

interface RunAssertion {
  name: string;
  passed: boolean;
  errorCode?: string;
  path?: string;
  expected?: string;
  actual?: string;
}

interface RunRequestResult {
  id: string;
  position: number;
  itemId: string;
  itemName: string;
  status: "passed" | "failed" | "error" | "skipped";
  httpStatus: number | null;
  durationMs: number;
  responseSizeBytes: number | null;
  assertions: RunAssertion[];
  errorCode: string | null;
  responsePreview: string | null;
  responseTruncated: boolean;
}
```

Render passing assertions normally. For failed contract assertions, show a readable label derived
from `name` and map `errorCode` to localized copy. When available, show `path`, `expected`, and
`actual` as diagnostic details:

```json
{
  "name": "OpenAPI response body schema",
  "passed": false,
  "errorCode": "CONTRACT_SCHEMA_MISMATCH",
  "path": "$.user.id",
  "expected": "string",
  "actual": "integer"
}
```

Use `path` as a JSONPath-like location, not as a request field path. `expected` and `actual` are
short type/constraint descriptions; they never contain the response value. `CONTRACT_STATUS_UNEXPECTED`
includes the documented status keys in `expected` and the received HTTP code in `actual`.
`CONTRACT_CONTENT_TYPE_UNEXPECTED` includes declared media types in `expected` and the received
media type (or `missing`) in `actual`. Invalid JSON and truncated-body assertions point to `$`.
Schema diagnostics are capped by the API; do not assume every schema violation is returned.

The request result is `failed` if any script or contract assertion fails. The overall run is
`failed` if any request failed, errored, or was skipped; `failedCount` counts all non-passed
requests. Contract failures do not stop subsequent requests. An execution failure may have a
request-level `errorCode` and no contract assertion if no upstream response was received.

Never display, log, or send assertion diagnostics or `responsePreview` to analytics. The API omits
response values from diagnostics, but response previews are separate sensitive data and can contain
secrets.

## Run history

Use the existing history routes to restore a run view:

```http
GET /api/v1/collections/:collectionId/runs?limit=25&offset=0
GET /api/v1/collections/:collectionId/runs/:runId
```

The run detail returns the same stored assertion fields, including contract diagnostics, as the
original run. History is private to the user who started the run.

## Supported schema behavior and limitations

- OpenAPI 3.0 and 3.1 response schemas and local `#/components/schemas/...` references are
  supported. Remote references are rejected by OpenAPI parsing; the runner never fetches them.
- OpenAPI 3.0 `nullable` and numeric `exclusiveMinimum`/`exclusiveMaximum` are normalized for
  validation.
- Common JSON Schema constraints are evaluated by Ajv. Schema `format` keywords are not validated.
- Only response status, content type, and response body are checked. Response headers, links,
  cookies, and request bodies are not validated by this feature.
- An operation must be tracked by sync apply. One-time imports and manually created requests do
  not acquire response contracts automatically.

The API deployment must apply the generated database migration that adds `source_spec` to
`openapi_syncs` before sync apply can persist contracts. The frontend does not need a separate
endpoint or request flag to turn validation on.
