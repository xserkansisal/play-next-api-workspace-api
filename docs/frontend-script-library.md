# Frontend integration: reusable team scripts

The script library lets team members define reusable JavaScript hooks once, then attach them to
requests in a collection. Scripts run through the collection runner's existing QuickJS sandbox.
This document describes the API and frontend behavior for browsing, editing, attaching, and
running shared scripts.

## Request context and permissions

All routes require an authenticated session and the selected team:

```http
X-Team-Id: <active-team-id>
```

Use the same API client and cookie credentials as other team-scoped routes. A `viewer` can list
scripts, but only `member` and `owner` roles can create, edit, or delete them. Script records and
references are team-scoped; the API does not reveal a script from a different team.

## API

| Method | Route | Success |
| --- | --- | --- |
| `GET` | `/api/v1/scripts` | `200 { "scripts": Script[] }` |
| `POST` | `/api/v1/scripts` | `201 Script` |
| `PUT` | `/api/v1/scripts/:scriptId` | `200 Script` |
| `DELETE` | `/api/v1/scripts/:scriptId` | `204` with no response body |

`Script` is returned in camel case:

```ts
type ScriptStage = "pre-request" | "post-response";

type Script = {
  id: string;
  teamId: string;
  name: string;
  description: string;
  stage: ScriptStage;
  source: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
};
```

Create and update use the same body. `description` may be omitted and defaults to an empty string.
`name`, `stage`, and `source` are required.

```json
{
  "name": "Add session header",
  "description": "Adds the shared session token to a request",
  "stage": "pre-request",
  "source": "pm.request.headers.push({ key: \"X-Session\", value: pm.environment.get(\"sessionToken\") });"
}
```

Names are unique case-insensitively within a team and stage; the same name may be used once in
each stage. Names are trimmed, limited to 200 characters, and source is limited to 32,768
characters. Updating a script's source immediately affects all requests linked to it. A script
referenced by a current request or saved item/tree history cannot be deleted or moved to the other
stage until those references are removed.

## Attach scripts to requests

Request payloads use two ordered arrays of script IDs:

```ts
type RequestScriptReferences = {
  preRequestScriptIds: string[];
  postResponseScriptIds: string[];
};
```

For example, create or update a request with:

```json
{
  "type": "request",
  "name": "List orders",
  "method": "GET",
  "url": "{{baseUrl}}/orders",
  "preRequestScriptIds": ["<pre-request-script-id>"],
  "postResponseScriptIds": ["<post-response-script-id>"]
}
```

Each array accepts at most 50 unique UUIDs. The API verifies that every ID exists in the selected
team and its stage matches the array. An invalid, missing, cross-team, or wrong-stage reference
returns `400 INVALID_SCRIPT_REFERENCE`.

The reference arrays are supported wherever request items are written: collection create/tree
payloads, item create/update, and collection import. Item and collection reads return both arrays.
Omitted arrays default to `[]`. In particular, item `PUT` replaces the request's saved fields, so
the frontend must send both arrays when saving the rest of a request; omitting one clears that
stage's references.

Request clones and collection clones keep the linked IDs. Item-version and collection-tree
snapshot restore retain the IDs as well. OpenAPI documents do not carry team-local script IDs, so
an OpenAPI import/export is not a mechanism for transferring script links between teams.

## Execution order and script API

For each request in a collection run, hooks execute in this order:

1. `preRequestScriptIds` in array order
2. The request's existing inline `preRequestScript`, if non-empty
3. Send the request
4. `postResponseScriptIds` in array order
5. The request's existing inline `postResponseScript`, if non-empty

Request mutations and run-local variable updates from each hook are visible to subsequent hooks.
Post-response test assertions from shared and inline scripts are included in the request's normal
run result. Existing inline-script behavior is preserved.

Scripts use the same API and sandbox documented in [the collection runner guide](frontend-collection-runner.md#request-scripts).
In brief, pre-request hooks can edit `pm.request` and read/write `pm.environment`; post-response
hooks can also inspect `pm.response`, define `pm.test` assertions, and use `pm.expect`. Script
execution is synchronous with a 1-second CPU deadline, a 16 MiB memory limit, and no Node APIs,
filesystem, process environment, network APIs, timers, promises, or module loading. Variables
captured by scripts apply only to the current run and do not update saved environments or variables.

The runner loads referenced shared scripts for the run from the selected team. If a script is
missing at run time, the request fails with the normal `SCRIPT_FAILED` result. Script source is
executable code shared with the team: keep credentials in environment variables and do not embed
secrets in source.

## Error handling

API errors use the standard envelope:

```json
{
  "error": {
    "code": "SCRIPT_IN_USE",
    "message": "A script linked to a request or saved history cannot be deleted",
    "details": {
      "referenceCount": 1,
      "historicalReferenceCount": 0
    }
  }
}
```

| Code | Status | Frontend behavior |
| --- | --- | --- |
| `VALIDATION_ERROR` | `400` | Show invalid fields; source length is capped at 32,768 characters. |
| `INVALID_SCRIPT_REFERENCE` | `400` | Refresh the script list and correct the request's stage assignments. |
| `SCRIPT_NAME_CONFLICT` | `409` | Ask for a different name within the same stage. |
| `SCRIPT_IN_USE` | `409` | Keep the script and its stage; remove current and historical request references before retrying. |
| `NOT_FOUND` | `404` | Refresh the list; the script may have been removed or belong to another team. |
| `TEAM_ROLE_REQUIRED` | `403` | Keep the list read-only for viewers. |

## Suggested frontend flow

- Load `GET /api/v1/scripts` when the selected team changes; use `stage` to group scripts into
  pre-request and post-response lists.
- On a request form, let the user select multiple scripts per stage and preserve their order. Save
  their IDs with the request, not copies of their source.
- Include both reference arrays whenever saving a request. On collection/tree/import operations,
  retain IDs and display validation errors without silently dropping references.
- After editing a script, update the list from the returned record; linked requests use the saved
  source on subsequent runs without having to be rewritten.
- On a failed delete or stage change (`SCRIPT_IN_USE`), show that current or saved history still
  refers to the script. Do not silently detach references.
- Keep script source out of analytics and logs. Treat shared source as team-readable content, and
  store credentials in environment variables.
