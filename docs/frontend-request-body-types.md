# Request body types: frontend integration

This document describes the request-body contract available in API v1 and the frontend behavior
needed to use it. The backend stores body content; it does not build or convert a body based on
its selected type. The frontend owns the type-specific editors, serialization, and request headers.

## Request model

A request item has either no body or a body object:

```json
{
  "type": "request",
  "name": "Create item",
  "description": "",
  "method": "POST",
  "url": "https://api.example.test/items",
  "queryParams": [],
  "headers": [
    {
      "key": "Content-Type",
      "value": "application/json",
      "description": "",
      "enabled": true
    }
  ],
  "body": {
    "type": "json",
    "content": "{\"name\":\"Example\"}"
  },
  "auth": { "type": "inherit" }
}
```

`body` is `null` when the request has no body. Otherwise its shape is always:

```ts
type RequestBody = {
  type: "json" | "form-urlencoded" | "multipart" | "raw" | "graphql";
  content: string;
};
```

Use this shape for request creation (`POST /api/v1/collections/:id/items`), request updates
(`PUT /api/v1/collections/:id/items/:itemId`), and request nodes in collection creation and bulk
import. Read endpoints return the same shape. Omit `body` to use its `null` default, or send
`null` explicitly to clear a saved body. An empty string in `content` is different from `null`: it
means a body type is selected with empty content.

The body content limit is 1,000,000 characters. The body type and content are stored and returned
verbatim. Collection import, request cloning, and tree reads preserve both.

## Body type behavior

| Type | Frontend editor / content convention | Suggested `Content-Type` |
| --- | --- | --- |
| `json` | JSON text. Validate JSON in the frontend if desired; variable placeholders may make the saved text invalid JSON until execution. | `application/json` |
| `form-urlencoded` | Key/value editor. Persist the encoded content string, e.g. `name=Sam+Lee&active=true`; decode it into rows when editing. `URLSearchParams` provides the encoding convention and supports duplicate keys and row order. | `application/x-www-form-urlencoded` |
| `multipart` | Key/value editor for text fields only. Persist the field list as a JSON string in `content`; generate boundary-delimited text at execution time. File/blob fields are not supported. | Generate a boundary for each execution and set `multipart/form-data; boundary=<generated-boundary>`. |
| `raw` | Uninterpreted text, such as plain text, XML, or another caller-selected format. | Default to `text/plain`; allow the user to edit the media type. |
| `graphql` | The GraphQL HTTP JSON envelope as text, e.g. `{"query":"query { status }","variables":{}}`. | `application/json` |

When body type changes, the frontend should automatically set/update the request's `Content-Type`:
`application/json` for JSON and GraphQL, `application/x-www-form-urlencoded` for URL-encoded,
`text/plain` for raw, and a freshly generated boundary parameter for multipart at execution time.
The frontend should treat this as a type-managed header: update it on a type switch, while allowing
manual adjustment for raw content. For multipart, the boundary in the header must exactly match
the boundary in the generated body.

The API does not perform any of these transformations or automatically add a `Content-Type`
header. It sends the proxy payload's body string as supplied.

### Multipart content convention and limitations

The frontend should store multipart text fields in `body.content` as a JSON string:

```json
[
  { "key": "description", "value": "A sample", "enabled": true },
  { "key": "optional", "value": "not sent", "enabled": false }
]
```

This JSON is an opaque string to the API; the frontend parses it for editing. At execution, omit
disabled rows, build a boundary-delimited string body from the enabled text fields, and use that
same generated boundary in `Content-Type`. Do not pass browser `FormData` to the proxy endpoint:
it accepts JSON containing a string body, not multipart form data. Files, blobs, per-part binary
data, and browser `FormData` uploads are outside the current scope.

## Executing a saved request

Execution uses `POST /api/v1/proxy` with a separate proxy payload:

```json
{
  "method": "POST",
  "url": "https://api.example.test/items",
  "headers": [["Content-Type", "application/json"]],
  "body": "{\"name\":\"Example\"}"
}
```

Before calling the proxy, the frontend should:

1. Resolve any frontend-managed variables in the URL, headers, and body content.
2. Include only enabled headers, preserving duplicate header names where the target protocol allows them.
3. Serialize URL-encoded key/value rows, or turn the stored multipart JSON field list into a
   boundary-delimited string and matching boundary header.
4. Send the resolved body as a string, or `null` when there is no body. Send `null` for `GET`;
   saved request methods do not include `HEAD`.

The proxy has no `bodyType` field: it sends the supplied string as-is and uses only the supplied
headers to describe it. The proxy endpoint itself supports `HEAD`, but saved request items only
support `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`; adding `HEAD` to saved requests is outside this
feature. Upstream status and response data are returned in the proxy JSON response; an upstream
`4xx`/`5xx` is still a successfully executed proxy call.

Execution also depends on server configuration. `GET /api/v1/proxy` reports whether proxying is
enabled and which hosts are permitted. A disabled proxy or a target outside its allow-list will
reject execution.

## Scope

This feature covers saved-request body editing and proxy execution only. Postman import/conversion
rules for these body types are not included; do not assume a Postman body will be recognized or
converted into one of these editor formats.

Authentication modes and collection/folder inheritance are documented separately in
[frontend-authentication.md](frontend-authentication.md).

## Validation and compatibility

- Supported body type values are exactly `json`, `form-urlencoded`, `multipart`, `raw`, and
  `graphql`. The previous `json` value remains valid.
- The request body object accepts only `type` and `content`; unknown fields are rejected.
- A body must be either `null` or an object with a supported `type` and string `content`.
- The server persists the body type and content in `request_details`; the database constraint
  requires both values to be null or both to be non-null.
- Deploy the migration `0006_amazing_white_tiger` before deploying API code that reads or writes
  the added enum values.

## Suggested frontend coverage

- Create, update, read, clone, and import requests using each body type; assert type and content
  round-trip unchanged.
- Verify `null` clears a body and `{ type, content: "" }` keeps an explicitly selected empty body.
- Verify URL-encoded duplicate keys, row order, and round-trip encoding.
- Verify disabled multipart fields are omitted from the generated body and boundary matches the
  generated `Content-Type`.
- Keep file upload controls out of multipart until the proxy accepts a suitable structured/binary
  body contract.
