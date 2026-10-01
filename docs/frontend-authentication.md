# Authentication: frontend integration

Saved requests support no authentication, inherited authentication, Basic, Bearer, and API Key.
The API stores authentication settings and resolves inheritance; the frontend converts the resolved
settings into outbound headers or query parameters before calling the proxy.

## Request authentication shape

The `auth` field on a request accepts:

```ts
type RequestAuth =
  | { type: "inherit" }
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  | { type: "api-key"; in: "header" | "query"; key: string; value: string };
```

New requests default to `{ "type": "inherit" }`. `none` explicitly disables authentication,
including any configured on the collection or parent folder. Credentials are strings and may
contain frontend variable placeholders such as `{{token}}`.

Authentication can be set on:

- A collection, using `auth` on `POST /api/v1/collections` or `PUT /api/v1/collections/:id`.
- A folder, using `auth` on folder create/update and on folder nodes in collection creation/import.
- A request, using the `auth` union above.

Collection and folder auth accepts `null` or one of `none`, `basic`, `bearer`, or `api-key`.
`null` means “inherit from the parent” (or no auth when there is no configured parent). An explicit
`none` on a collection/folder stops inheritance below it. For example:

```json
{
  "name": "Production API",
  "description": "",
  "auth": { "type": "bearer", "token": "{{productionToken}}" }
}
```

Folder create and update use the same setting shape:

```json
{
  "type": "folder",
  "name": "Public endpoints",
  "description": "",
  "auth": { "type": "none" }
}
```

Omit `auth` on a folder update to leave its current setting unchanged; send `null` to clear it and
resume inheritance. Collection update behaves the same way. A new collection or folder without
`auth` starts with `null`.

## Inheritance and read responses

The nearest non-null collection/folder setting applies to requests whose own `auth.type` is
`inherit`. A request setting other than `inherit` always overrides its ancestors.

Collection reads return the collection's configured `auth` value and recursively include `auth` on
folders and both `auth` and `effectiveAuth` on requests. `auth` is the saved request setting;
`effectiveAuth` is the resolved configuration to use for execution. Individual item reads return
the same request fields, including `effectiveAuth`. `effectiveAuth` is always one of `none`,
`basic`, `bearer`, or `api-key`—never `inherit`.

Example request in a collection with a Bearer token:

```json
{
  "type": "request",
  "name": "List records",
  "parentId": null,
  "method": "GET",
  "url": "https://api.example.test/records",
  "queryParams": [],
  "headers": [],
  "body": null,
  "auth": { "type": "inherit" },
  "effectiveAuth": { "type": "bearer", "token": "{{productionToken}}" }
}
```

`effectiveAuth` is response-only; do not send it in create/update payloads. When collection auth is
changed, the `PUT` response is a collection summary; fetch `GET /api/v1/collections/:id` to refresh
the auth settings and effective request values.

## Preparing a proxy request

`POST /api/v1/proxy` still accepts explicit `headers` and a URL; it does not accept a saved request
ID and does not automatically apply `effectiveAuth`. The frontend should resolve variables in
`effectiveAuth`, then:

| `effectiveAuth.type` | Outbound behavior |
| --- | --- |
| `none` | Add no authentication data. |
| `basic` | Set `Authorization: Basic <base64(UTF-8(username + ":" + password))>`. |
| `bearer` | Set `Authorization: Bearer <token>`. |
| `api-key` with `in: "header"` | Set the header named by `key` to `value`. |
| `api-key` with `in: "query"` | Add or replace the URL parameter named by `key` with `value`. |

Do not send credentials in both the saved `auth` configuration and a duplicate manually-authored
header/query parameter. Prefer API keys in headers where the target supports them, since query
parameters are more likely to be captured by upstream logs. Keep the existing proxy host allow-list
requirements in mind; authentication does not expand the hosts the server may reach.

## Persistence, history, and compatibility

Authentication settings are preserved by collection/item reads, tree creation, import, cloning,
cross-collection moves, and version history. Version snapshots include saved auth settings, and
restoring a version restores the corresponding auth configuration. Import responses include a
`SENSITIVE_AUTH` warning with the item path and auth type when an imported auth setting contains a
literal credential; placeholders such as `{{token}}` do not trigger the warning, and credential
values are never included in the warning.

Credentials are currently stored in the database and returned to the signed-in frontend in the
same manner as request header values. They are not encrypted or redacted by this API; avoid logging
request/auth payloads and treat version-history responses as sensitive.

Deploy migration `0008_auth_methods_inheritance` before deploying API code that uses these fields.
It adds collection/folder auth storage, expands the request `auth_type` enum, and converts existing
`none` request settings to `inherit`. Since legacy collections and folders had no auth setting, that
conversion does not introduce authentication for existing requests. Explicit `{ "type": "none" }`
remains supported to disable inherited settings.

## Suggested frontend coverage

- Round-trip each request auth mode through create, update, read, clone, import, and version restore.
- Resolve collection → folder → nested folder → request inheritance; verify a nearer setting
  overrides its parent and `none` stops inheritance.
- Verify request `effectiveAuth` updates after collection or folder auth changes.
- Resolve variables in credential values and confirm each mode produces the expected proxy URL and
  headers without exposing credentials in logs or error messages.
