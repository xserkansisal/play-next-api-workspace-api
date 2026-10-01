# Collection test runner: frontend integration

The API can run every saved request in a collection, or every request under one folder, in the
collection tree's displayed order. A run is synchronous: the response contains the completed run
and its per-request results. All runner and history routes require the signed-in session.

## Routes

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/v1/collections/:collectionId/run` | Run every active request in a collection |
| `POST` | `/api/v1/collections/:collectionId/items/:folderId/run` | Run active requests under a folder and its nested folders |
| `GET` | `/api/v1/collections/:collectionId/runs?limit=25&offset=0` | List the caller's runs for the collection |
| `GET` | `/api/v1/collections/:collectionId/runs/:runId` | Read one run and its saved request results |

Run POST bodies are optional in practice; send `{}` to use no environment, or select an environment:

```json
{ "environmentId": "f7e3383e-378c-4e72-9b99-6a58f8b429c2" }
```

The selected folder ID must identify an active folder in that collection. A request item is not a
valid folder-run target. A run is capped at 100 requests; an oversized run returns `413
RUN_TOO_LARGE` without creating a history entry. The run endpoint is rate-limited to three runs per
signed-in user per minute. Empty collections/folders complete successfully with zero results.

## Request scripts

Request create, update, collection-tree, and import payloads accept two optional string fields.
Reads return both fields; omitted values default to the empty string.

```ts
type RequestScripts = {
  preRequestScript: string;   // Runs before this request is sent
  postResponseScript: string; // Runs after a proxy response is received
};
```

Scripts are plain JavaScript executed in a fresh QuickJS WebAssembly runtime for each hook. Each
hook has a 1-second CPU deadline, a 16 MiB memory limit, and a bounded stack. Node APIs, the
filesystem, process environment, network APIs, timers, promises, and module loading are not
available. Scripts run synchronously.

`pm.request` is a mutable copy of the outgoing request:

```js
pm.request.method;      // GET, POST, PUT, PATCH, or DELETE
pm.request.url;         // URL string, including any saved query string
pm.request.queryParams; // [{ key, value }, ...] from enabled saved rows
pm.request.headers;     // [{ key, value }, ...] from enabled saved rows
pm.request.body;        // string or null
```

For example, a pre-request hook can add a header using a value captured earlier in the run:

```js
pm.request.headers.push({
  key: "X-Session",
  value: pm.environment.get("sessionToken")
});
```

In a post-response hook, `pm.response.code` (also `status`), `statusText`, `headers`, `bodyText`,
`sizeBytes`, `truncated`, `text()`, and `json()` describe the upstream response. The script API
includes `pm.test(name, callback)` and `pm.expect(value)` with `equal`, `eql`, `include`, `.not`,
`.to.be.true`, `.to.be.false`, and `.to.be.ok` assertions:

```js
pm.test("created", () => pm.expect(pm.response.code).to.eql(201));
pm.test("received an id", () => pm.expect(pm.response.json().id).to.be.ok);
pm.environment.set("createdId", pm.response.json().id);
```

`pm.environment`, `pm.variables`, and `pm.collectionVariables` share the same run-local variable
map. `get(key)` reads a string; `set(key, value)` stores a string (non-string JSON values are
serialized). Captures are available to later requests in that run only. They do not update a saved
environment or the user's variables.

## Order and variable resolution

Requests execute sequentially in the same sibling name-sorted order as the collection tree.
The selected environment is optional. Variables are loaded for the calling user only and resolve
in this order, from lowest to highest priority:

1. Shared `global` variables
2. The caller's `user` variables
3. Enabled variables in the selected environment
4. Values set by scripts during this run

After the pre-request hook, `{{key}}` placeholders are substituted in the URL, enabled query
parameters and headers, body, and effective inherited authentication. Undefined variables fail
that request with `RUN_VARIABLE_NOT_FOUND`; their values are never included in the error. API-key
query authentication is appended to the URL. Saved body content is sent as-is, as with the
single-request proxy route.

The server enforces the same `PROXY_ALLOWED_HOSTS`, timeout, redirect, and bounded-response
policies as `POST /api/v1/proxy`. Authentication settings use the saved request's resolved
`effectiveAuth`; the frontend does not need to construct authorization headers for runner calls.

## Run result

Both run POST routes return `201` after the run is finished. A collection-level status is `passed`
or `failed`; any failed assertion, request error, or skipped request makes it `failed`. Each
request result has `passed`, `failed`, `error`, or `skipped` status. `failedCount` counts every
non-passed request, including errors and skips. Assertion failures do not stop later requests.
Script errors, unresolved variables, and proxy failures are recorded against that request, and the
runner continues with the next request. If the 10-minute run deadline is reached, remaining
requests are recorded as `skipped` with `RUN_TIMEOUT`.

```json
{
  "id": "run-uuid",
  "collectionId": "collection-uuid",
  "folderId": null,
  "environmentId": "environment-uuid",
  "status": "failed",
  "requestCount": 2,
  "passedCount": 1,
  "failedCount": 1,
  "startedAt": "2026-10-02T00:00:00.000Z",
  "finishedAt": "2026-10-02T00:00:01.000Z",
  "durationMs": 1000,
  "results": [
    {
      "id": "result-uuid",
      "position": 0,
      "itemId": "request-uuid",
      "itemName": "Create record",
      "status": "failed",
      "httpStatus": 201,
      "durationMs": 32,
      "responseSizeBytes": 26,
      "responsePreview": "{\"id\":\"record-1\"}",
      "responseTruncated": false,
      "assertions": [
        { "name": "id exists", "passed": false, "errorCode": "ASSERTION_FAILED" }
      ],
      "errorCode": null
    }
  ]
}
```

Assertion failures store a generic `ASSERTION_FAILED` code rather than exception text, because a
script's thrown message could contain a secret. Other request errors expose a stable `errorCode`
but not proxy exception details. Common codes include `SCRIPT_TIMEOUT`, `SCRIPT_FAILED`,
`SCRIPT_MEMORY_EXCEEDED`, `SCRIPT_INPUT_TOO_LARGE`, `SCRIPT_OUTPUT_INVALID`,
`RUN_VARIABLE_NOT_FOUND`, `PROXY_DISABLED`, `PROXY_HOST_NOT_ALLOWED`, `PROXY_TIMEOUT`, and
`PROXY_REQUEST_FAILED`. An upstream `4xx` or `5xx` alone does not fail a request; add a `pm.test`
status assertion when that is expected.

The result stores no resolved URL, request headers, request body, authentication values, or final
captured variables. It does store up to 16 KiB of each upstream response body as `responsePreview`
for debugging; this may contain tokens or other sensitive response data. Treat run history as
sensitive, and use the truncation flags before relying on a preview as complete. Scripts can inspect
up to 256 KiB of a response body; `pm.response.truncated` is true if that script-visible body is
incomplete. The effective input variable set is limited to 512 KiB and each script's serialized
input is limited to 2.5 MiB.

## Run history

History is private to the user who started each run, even though collections are shared. The list
response is:

```json
{
  "runs": [],
  "total": 0,
  "limit": 25,
  "offset": 0
}
```

`limit` defaults to 25 and is capped at 100; `offset` defaults to 0 and is capped at 100,000.
Results in a run are ordered by their request position. Deleted item names and IDs remain in
historical results. History has no automatic expiration or delete endpoint.

## Suggested frontend behavior

- Add pre-request and post-response script editors to saved request forms; preserve both strings on
  create, update, import, clone, and version restore.
- Start a run with the selected environment ID, disable duplicate submissions while it is active,
  and show its status, each request outcome, assertion names, response status, and preview.
- Refresh the relevant collection/folder after the run and use the history endpoints to restore a
  prior run view.
- Treat preview data as sensitive; do not put it in analytics, logs, or shared UI state.
- Show `RUN_VARIABLE_NOT_FOUND` and proxy configuration/allow-list errors without retrying
  automatically. Allow the user to retry a failed run explicitly.
