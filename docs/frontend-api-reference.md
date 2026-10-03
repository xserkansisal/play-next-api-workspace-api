# Play Next API — Frontend Reference (v1)

Complete reference of every endpoint the frontend can call: purpose, auth/role requirements, input,
output and error codes. Source of truth is the backend code; where a behaviour is a trap for the UI
it is called out with **Note**.

Related, more narrative docs: `frontend-authentication.md` (request auth + inheritance),
`frontend-request-body-types.md`, `frontend-collection-runner.md`, `frontend-version-history.md`,
`frontend-teams.md`, `frontend-roles-and-email.md`, `frontend-session-cookie.md`,
`frontend-dev-login.md`.

---

## Table of contents

1. [Conventions](#1-conventions)
2. [Authentication & team context](#2-authentication--team-context)
3. [Roles & permission matrix](#3-roles--permission-matrix)
4. [Endpoint index](#4-endpoint-index)
5. [Health](#5-health)
6. [Auth](#6-auth-apiv1auth)
7. [Teams (current user)](#7-teams-apiv1teams)
8. [Collections](#8-collections-apiv1collections)
9. [Items (folders & requests)](#9-items-folders--requests)
10. [Import](#10-import)
11. [Version history](#11-version-history)
12. [Collection runner & run history](#12-collection-runner--run-history)
13. [Environments](#13-environments-apiv1environments)
14. [Variables (user / global)](#14-variables-apiv1variables)
15. [Preferences](#15-preferences-apiv1preferences)
16. [Trash](#16-trash-apiv1trash)
17. [Proxy (server-side request execution)](#17-proxy-apiv1proxy)
18. [Realtime: SSE events](#18-realtime-events-apiv1events)
19. [Presence](#19-presence-apiv1presence)
20. [Admin](#20-admin-apiv1admin-system-admin-only)
21. [Data models](#21-data-models)
22. [Error reference](#22-error-reference)
23. [Limits & rate limits](#23-limits--rate-limits)

---

## 1. Conventions

- **Base path:** `/api/v1/...` (except `/health`). JSON in, JSON out (`Content-Type: application/json`),
  except avatar upload (multipart) and the SSE stream.
- **Credentials:** the session is an `HttpOnly` cookie. Every call must use `credentials: "include"`
  (fetch) / `withCredentials: true` (axios). The frontend never reads the cookie.
- **Timestamps:** ISO-8601 UTC strings (`2026-10-02T00:00:00.000Z`).
- **IDs:** UUID strings (users, teams, collections, items, environments, versions, runs…).
  Variable keys are the identifier for variables.
- **Authorship fields** (`createdBy`, `updatedBy`) on collections/items/environments/versions are the
  author's **email** or `null` (user deleted → show "Unknown user"). `updatedBy` on **variables** is
  the author's **user id** (or `null`).
- **Names:** trimmed, 1–200 chars. Uniqueness is case-insensitive (see each resource).
- **Unknown JSON fields are rejected** on almost every body (strict schemas) → `400 VALIDATION_ERROR`.
  Never send response-only fields (`id`, `effectiveAuth`, `createdAt`, …) back in a write.
- **Body size:** general JSON limit 50 MB; import 10 MB; preferences 256 KB.
- **CORS:** if the API is called cross-origin, the server must have `CORS_ORIGIN` set to the exact
  origin. Allowed request headers: `Content-Type, Last-Event-ID, X-Dev-Inbox-Token, X-Team-Id`.
  Methods: `GET, POST, PUT, PATCH, DELETE, OPTIONS`.
- **Error envelope** (all errors, except where noted):

```json
{ "error": { "code": "MACHINE_READABLE_CODE", "message": "Human readable", "details": {} } }
```

  `details` is optional. For `VALIDATION_ERROR` it is the array of Zod issues
  (`[{ code, path: ["field", 0, "sub"], message, ... }]`) — use `path` to highlight fields.
- **Generic errors any endpoint can return**

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Body/query/param failed schema validation |
| 400 | `BAD_REQUEST` | Malformed JSON body |
| 401 | `AUTHENTICATION_REQUIRED` | Missing/expired session cookie |
| 404 | `NOT_FOUND` | Unknown route (`Route GET /x not found`) |
| 409 | `CONFLICT` | Unexpected DB unique violation (race) — refetch and retry |
| 413 | `PAYLOAD_TOO_LARGE` | Body above the size limit |
| 500 | `INTERNAL_SERVER_ERROR` | Bug/outage; message is generic in production |

---

## 2. Authentication & team context

### Session
1. `POST /auth/request-code` (email) → code emailed.
2. `POST /auth/verify-code` (email + code) → `Set-Cookie` session (default 30 days). 
3. `GET /auth/me` on app start to learn if the user is signed in (`401` ⇒ show login).
4. `POST /auth/sign-out` to end it.

Cookie name depends on server env (`play_next_session` in prod, `_dev`, `_test` otherwise) — the
frontend does not need to know it.

### Team context (`X-Team-Id`)
All **team-scoped** endpoints (collections, environments, variables, trash, events, presence)
resolve which team to work in:

- Send header **`X-Team-Id: <teamId>`** on every team-scoped request. EventSource cannot set headers →
  use the query string **`?teamId=<teamId>`** instead.
- If omitted: a user in exactly **one** team uses it automatically; in several → `400 TEAM_CONTEXT_REQUIRED`;
  in none → `403 TEAM_MEMBERSHIP_REQUIRED`.
- A team the caller does not belong to, an archived team, or a non-existing team all return the same
  `404 TEAM_NOT_FOUND` (ids are never confirmed).
- System admins may use any non-archived team (acting as `owner`).
- Membership is checked per request: removal/demotion takes effect on the next call.
- Not team-scoped (no header needed): `/health`, `/auth/*`, `/preferences/*`, `/proxy`, `/teams`
  (list + the `:teamId` in path), `/admin/*`.

Team-context errors (apply to every team-scoped endpoint):

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `TEAM_CONTEXT_REQUIRED` | User has several teams and sent no `X-Team-Id` |
| 403 | `TEAM_MEMBERSHIP_REQUIRED` | User is in no team yet (empty state; wait for an owner/admin to add them) |
| 404 | `TEAM_NOT_FOUND` | Unknown / foreign / archived team |
| 403 | `TEAM_ROLE_REQUIRED` | Write attempted without sufficient role (see §3) |

---

## 3. Roles & permission matrix

Roles are **per team**: `owner` > `member` > `viewer`. `systemRole` (`user` | `admin`) is global; a
system admin acts as `owner` in every team (and gets the `/admin` panel).

| Capability | viewer | member | owner | system admin |
| --- | :-: | :-: | :-: | :-: |
| Read collections, items, environments, global variables, trash, versions | ✅ | ✅ | ✅ | ✅ |
| Send requests via proxy, SSE, presence | ✅ | ✅ | ✅ | ✅ |
| Run collections / folders / requests (own history) | ✅ | ✅ | ✅ | ✅ |
| Own (`user`-scope) variables, display order, preferences | ✅ | ✅ | ✅ | ✅ |
| Create/edit/delete/clone/move/import/restore collections & items | ❌ | ✅ | ✅ | ✅ |
| Create/edit/delete/clone environments, **global** variables | ❌ | ✅ | ✅ | ✅ |
| Trash restore | ❌ | ✅ | ✅ | ✅ |
| Add / change / remove team members | ❌ | ❌ | ✅ | ✅ |
| `/admin/*` | ❌ | ❌ | ❌ | ✅ |

Rule implemented server-side: on collections / environments / variables / trash, every method other
than `GET/HEAD/OPTIONS` requires `member`, with two exceptions open to viewers: collection/item
**run** endpoints and `user`-scope variable writes + `PUT /variables/order`.
Use `GET /teams` (`role`) to gate the UI; the API enforces regardless.

---

## 4. Endpoint index

| Method | Path | Purpose | Min. role |
| --- | --- | --- | --- |
| GET | `/health` | Liveness | public |
| POST | `/api/v1/auth/request-code` | Email a 6-digit sign-in code | public |
| POST | `/api/v1/auth/verify-code` | Exchange code for session | public |
| POST | `/api/v1/auth/dev-login` | Dev-only email sign-in | public (dev only) |
| GET | `/api/v1/auth/dev-inbox` | Dev-only: read last code | loopback+token (dev only) |
| GET | `/api/v1/auth/me` | Current user | signed in |
| PATCH | `/api/v1/auth/me/profile` | Change avatar colour | signed in |
| POST | `/api/v1/auth/me/avatar` | Upload avatar image | signed in |
| DELETE | `/api/v1/auth/me/avatar` | Remove avatar image | signed in |
| GET | `/api/v1/auth/avatars/:avatarId` | Avatar image bytes | signed in |
| POST | `/api/v1/auth/sign-out` | End session | any |
| GET | `/api/v1/teams` | Teams the user can switch between | signed in |
| GET | `/api/v1/teams/:teamId/members` | List members | any member |
| POST | `/api/v1/teams/:teamId/members` | Add member | owner |
| PATCH | `/api/v1/teams/:teamId/members/:userId` | Change member role | owner |
| DELETE | `/api/v1/teams/:teamId/members/:userId` | Remove member | owner |
| GET | `/api/v1/collections` | List collections | viewer |
| POST | `/api/v1/collections` | Create collection (optionally with tree) | member |
| GET | `/api/v1/collections/:collectionId` | Read collection + full tree | viewer |
| PUT | `/api/v1/collections/:collectionId` | Update metadata/auth | member |
| DELETE | `/api/v1/collections/:collectionId` | Move to trash | member |
| POST | `/api/v1/collections/:collectionId/clone` | Duplicate collection | member |
| POST | `/api/v1/collections/:collectionId/import` | Bulk import tree | member |
| GET | `/api/v1/collections/:collectionId/versions` | Collection history | viewer |
| POST | `/api/v1/collections/:collectionId/versions/:versionId/restore` | Restore collection version | member |
| POST | `/api/v1/collections/:collectionId/items` | Create folder/request | member |
| GET | `/api/v1/collections/:collectionId/items/:itemId` | Read item | viewer |
| PUT | `/api/v1/collections/:collectionId/items/:itemId` | Update item | member |
| DELETE | `/api/v1/collections/:collectionId/items/:itemId` | Move item to trash | member |
| POST | `/api/v1/collections/:collectionId/items/:itemId/clone` | Duplicate item | member |
| POST | `/api/v1/collections/:collectionId/items/:itemId/move` | Re-parent / move across collections | member |
| GET | `/api/v1/collections/:collectionId/items/:itemId/versions` | Item history | viewer |
| POST | `/api/v1/collections/:collectionId/items/:itemId/versions/:versionId/restore` | Restore item version | member |
| POST | `/api/v1/collections/:collectionId/run` | Run all requests of a collection | viewer |
| POST | `/api/v1/collections/:collectionId/items/:itemId/run` | Run a folder (or single request item – see note) | viewer |
| GET | `/api/v1/collections/:collectionId/runs` | Own run history | viewer |
| GET | `/api/v1/collections/:collectionId/runs/:runId` | Run detail | viewer |
| GET | `/api/v1/environments` | List environments | viewer |
| POST | `/api/v1/environments` | Create environment | member |
| GET | `/api/v1/environments/:environmentId` | Read environment | viewer |
| PUT | `/api/v1/environments/:environmentId` | Replace environment (name + all variables) | member |
| POST | `/api/v1/environments/:environmentId/variables` | Append one variable | member |
| POST | `/api/v1/environments/:environmentId/clone` | Duplicate environment | member |
| DELETE | `/api/v1/environments/:environmentId` | Move to trash | member |
| GET | `/api/v1/variables` | List own + team-global variables | viewer |
| GET/PUT | `/api/v1/variables/order` | Display order of variable keys | viewer |
| POST | `/api/v1/variables/:scope` | Create variable | viewer (user) / member (global) |
| PUT | `/api/v1/variables/:scope/:key` | Upsert variable value | same |
| PATCH | `/api/v1/variables/:scope/:key` | Rename / change value | same |
| DELETE | `/api/v1/variables/:scope/:key` | Delete variable | same |
| GET/PUT | `/api/v1/preferences/variable-order` | UI sort/order preference blob | signed in |
| GET | `/api/v1/trash` | List restorable trash roots | viewer |
| POST | `/api/v1/trash/:id/restore/check` | Dry-run a restore | member |
| POST | `/api/v1/trash/:id/restore` | Restore | member |
| GET | `/api/v1/proxy` | Proxy availability / allowed hosts | signed in |
| POST | `/api/v1/proxy` | Execute an HTTP request server-side | signed in |
| GET | `/api/v1/events` | SSE change + presence stream | viewer |
| PUT | `/api/v1/presence` | Heartbeat "where I am" | viewer |
| * | `/api/v1/admin/...` | See §20 | system admin |

---

## 5. Health

### `GET /health`
Public liveness check (not under `/api/v1`).
**200** `{ "status": "ok", "uptime": 123.4, "timestamp": "2026-10-03T00:00:00.000Z" }`

---

## 6. Auth (`/api/v1/auth`)

**User object** returned by several routes:

```ts
type AuthUser = {
  id: string;
  email: string;          // always the canonical @fluttersea.com address
  firstName: string;      // derived server-side from the email
  lastName: string;
  avatarColor: "violet" | "blue" | "green" | "orange" | "rose" | "teal";
  avatarUrl: string | null; // relative "/api/v1/auth/avatars/:id" (same-origin) or absolute URL (cross-origin); null = no photo
  systemRole: "user" | "admin";
};
```

### `POST /auth/request-code`
Email a 6-digit sign-in code.
Allowed domains: `fluttersea.com`, `sisal.com`, `sisal.it`. The code is **always sent to
`<local-part>@fluttersea.com`** (all three domains are the same person).

Body: `{ "email": string }` (valid email ≤ 254, trimmed).

- **202** `{ "message": "If the address is eligible, a sign-in code has been sent.", "email": "name@fluttersea.com" }`
  → show "We sent a code to {email}" and use that `email` for verify.
- Errors: `400 VALIDATION_ERROR`, `400 EMAIL_DOMAIN_NOT_ALLOWED`, `429 AUTH_RATE_LIMITED`
  (default 3 requests / 15 min per email), `503 AUTH_DELIVERY_FAILED` (mail relay failed; retry later).
- Code lifetime default 15 min; requesting a new code invalidates the previous one.

### `POST /auth/verify-code`
Body: `{ "email": string, "code": "123456" }` (`code` exactly 6 digits).
- **200** `{ "user": AuthUser, "expiresAt": ISO }` + `Set-Cookie` (HttpOnly, SameSite=Lax, 30 days default).
- Errors: `400 VALIDATION_ERROR`, `400 EMAIL_DOMAIN_NOT_ALLOWED`,
  `401 INVALID_OR_EXPIRED_CODE` (wrong, expired, or too many attempts – default 5), 
  `429 AUTH_RATE_LIMITED` (default 10 verifications / 15 min per email).
- First successful sign-in creates the account; a new account has **no team** until an owner/admin
  adds it (`403 TEAM_MEMBERSHIP_REQUIRED` on team-scoped calls).

### `POST /auth/dev-login` *(development only)*
Body `{ "email": string }` → same response/cookie as verify-code, no code. Exists only when the
server runs with `NODE_ENV=development` and `AUTH_DEV_BYPASS=true`; otherwise **404**. Never ship this
path in production bundles (gate with a build-time flag).

### `GET /auth/dev-inbox?email=...` *(development only)*
Header `X-Dev-Inbox-Token`. Loopback-only, returns `{ email, code, expiresAt }`. `404` when not
available/forwarded/wrong token; `400 VALIDATION_ERROR` without `email`; `404 DEV_MESSAGE_NOT_FOUND`.

### `GET /auth/me`
**200** `{ "user": AuthUser }`. `401 AUTHENTICATION_REQUIRED` when signed out.

### `PATCH /auth/me/profile`
Only the avatar colour is editable (name/email are derived; any other field → 400).
Body `{ "avatarColor": "violet"|"blue"|"green"|"orange"|"rose"|"teal" }` → **200** `{ "user": AuthUser }`.

### `POST /auth/me/avatar`
`multipart/form-data` with exactly **one** file in field **`avatar`** (no other fields). JPEG / PNG /
WebP, ≤ 5 MB (type detected from bytes). Server re-encodes to a 512×512 WebP.
- **200** `{ "user": AuthUser }` (new `avatarUrl`).
- Errors: `400 AVATAR_UPLOAD_INVALID` (no file / wrong field / extra parts),
  `400 AVATAR_INVALID_IMAGE` (corrupt), `413 AVATAR_TOO_LARGE`, `415 AVATAR_UNSUPPORTED_TYPE`.

### `DELETE /auth/me/avatar`
**200** `{ "user": AuthUser }` (`avatarUrl: null`).

### `GET /auth/avatars/:avatarId`
Image bytes (`image/webp`), immutable cache (each upload has a new id). Requires the session cookie, so
use it in `<img>` on the same site / with credentials. `404 AVATAR_NOT_FOUND`.

### `POST /auth/sign-out`
Always **204**, clears the cookie (works even if already signed out).

---

## 7. Teams (`/api/v1/teams`)
Requires sign-in. Not team-scoped by header (the team is in the path).

### `GET /teams`
Teams the user can switch between (non-archived memberships; system admins get **all** non-archived teams).
**200**
```json
{ "teams": [ { "id": "uuid", "name": "Game Studio", "description": "", "role": "owner", "isMember": true } ] }
```
For a system admin viewing a team they are not in: `role: "owner"`, `isMember: false` (show an "Admin access" badge).
Use this to populate the team switcher and compute permissions; refresh after `403 TEAM_ROLE_REQUIRED`.

### `GET /teams/:teamId/members`
Any member (and system admins) may read the roster. **200**
```json
{ "members": [ { "userId": "uuid", "email": "a@fluttersea.com", "firstName": "A", "lastName": "B",
  "avatarColor": "blue", "avatarUrl": null, "role": "member", "joinedAt": "ISO" } ] }
```
Errors: `404 TEAM_NOT_FOUND`.

### `POST /teams/:teamId/members` — owner / system admin
Body `{ "email": string, "role"?: "owner"|"member"|"viewer" }` (default `member`). Email must use an
allowed domain; it resolves to the fluttersea account (account is created if it has never signed in).
**201** → the member object above.
Errors: `400 VALIDATION_ERROR`, `400 EMAIL_DOMAIN_NOT_ALLOWED`, `403 TEAM_ROLE_REQUIRED`,
`404 TEAM_NOT_FOUND`, `409 TEAM_MEMBER_EXISTS`, `409 TEAM_ARCHIVED`.

### `PATCH /teams/:teamId/members/:userId` — owner / system admin
Body `{ "role": "owner"|"member"|"viewer" }` → **200** member object.
Errors: `403 TEAM_ROLE_REQUIRED`, `404 TEAM_NOT_FOUND`, `404 TEAM_MEMBER_NOT_FOUND`,
`409 TEAM_LAST_OWNER` (a team must keep ≥ 1 owner), `409 TEAM_ARCHIVED`.

### `DELETE /teams/:teamId/members/:userId` — owner / system admin
**204**. The removed user's SSE stream/presence for that team is closed immediately.
Errors: `403 TEAM_ROLE_REQUIRED`, `404 TEAM_NOT_FOUND`, `404 TEAM_MEMBER_NOT_FOUND`, `409 TEAM_LAST_OWNER`.

---

## 8. Collections (`/api/v1/collections`)
Team-scoped (`X-Team-Id`). Names unique (case-insensitive) among the team's active collections →
`409 COLLECTION_NAME_CONFLICT` (`details: { name, conflictingId }`). A collection of another team
answers `404 NOT_FOUND` ("Collection … not found"), same as a missing one.

**Collection auth** (`ScopedAuth | null`): `null` = none configured; see [§21](#21-data-models).

### `GET /collections`
**200** `{ "collections": CollectionSummary[] }` sorted by name.

### `POST /collections` — member
Body:
```ts
{
  name: string;                 // required
  description?: string;         // ≤ 10 000, default ""
  auth?: ScopedAuth | null;     // default null
  items?: TreeNode[];           // optional initial tree, default []  (see §21; ≤ 32 levels deep)
}
```
**201** `CollectionAggregate` (summary + `auth` + full `items` tree).
Errors: `400 VALIDATION_ERROR`, `409 COLLECTION_NAME_CONFLICT`, `409 FOLDER_NAME_CONFLICT`
(two sibling folders with the same name in `items`).

### `GET /collections/:collectionId`
**200** `CollectionAggregate`: `{ id, name, description, createdAt, updatedAt, createdBy, updatedBy, auth, items: ItemNode[] }`.
Tree siblings are sorted by name (case-insensitive). Requests carry both `auth` (saved) and
`effectiveAuth` (resolved, never `inherit`). 

### `PUT /collections/:collectionId` — member
Metadata only; the tree is untouched. Body `{ name, description?, auth? }` — omit `auth` to leave it
unchanged, `null` to clear it.
**200** `CollectionSummary` (**no `auth`/`items`** – refetch `GET` to refresh effective auth).
Records a version snapshot first. Errors: `400`, `404`, `409 COLLECTION_NAME_CONFLICT`.

### `DELETE /collections/:collectionId` — member
Soft delete (collection + all active items go to Trash as one restorable root). **204**.

### `POST /collections/:collectionId/clone` — member
Deep copy named `"<name> (copy)"`, `"(copy 2)"`, … **201** `CollectionAggregate`.

---

## 9. Items (folders & requests)
Under `/collections/:collectionId/items`. Item ids are unique across collections.
Folder names are unique (case-insensitive) among siblings → `409 FOLDER_NAME_CONFLICT`
(`details: { name, parentId, conflictingId }`). **Request names are not unique.**
Siblings are displayed sorted by name; there is no manual order, so no reorder endpoint exists.

### `POST /collections/:collectionId/items` — member
Discriminated by `type`.

Folder:
```json
{ "type": "folder", "parentId": null, "name": "Auth", "description": "", "auth": null }
```
Request:
```json
{
  "type": "request", "parentId": null, "name": "Login", "description": "",
  "method": "POST",                       // GET | POST | PUT | PATCH | DELETE
  "url": "https://api.example.com/login", // ≤ 8192
  "queryParams": [ { "key": "a", "value": "1", "description": "", "enabled": true } ], // ≤ 500 rows
  "headers": [],                            // same row shape, ≤ 500
  "body": { "type": "json", "content": "{\"a\":1}" },  // or null (default). type: json|form-urlencoded|multipart|raw|graphql; content ≤ 1 000 000
  "auth": { "type": "inherit" },            // default inherit; see §21
  "preRequestScript": "",                   // ≤ 32 768, default ""
  "postResponseScript": ""
}
```
`parentId` null = collection root. **201** `ItemNode` (see §21).
Errors: `400 VALIDATION_ERROR`, `400 INVALID_PARENT` (parent missing / not an active folder),
`404 NOT_FOUND` (collection), `409 FOLDER_NAME_CONFLICT`.

### `GET /collections/:collectionId/items/:itemId`
**200** `ItemNode` (folders include their nested `items`). `404 NOT_FOUND`.

### `PUT /collections/:collectionId/items/:itemId` — member
Full replace of the item's own fields (no `parentId`; use move). Body = the same fields as create, with
`type` required and equal to the existing kind. Folder: omit `auth` to keep, `null` to clear.
**200** `ItemNode`. Records a version snapshot first.
Errors: `400 VALIDATION_ERROR`, `400 ITEM_TYPE_MISMATCH` (`details: { expected, received }`),
`404`, `409 FOLDER_NAME_CONFLICT`.

### `DELETE /collections/:collectionId/items/:itemId` — member
Soft delete (item + subtree to Trash). **204**. `404`.

### `POST /collections/:collectionId/items/:itemId/clone` — member
Copies the item (and subtree) next to the original with a `(copy)` name. **201** `ItemNode`. `404`.

### `POST /collections/:collectionId/items/:itemId/move` — member
Moves a folder/request (with its subtree) under another folder or to a collection root, optionally in
another collection **of the same team**.
Body `{ "targetCollectionId": uuid, "parentId": uuid | null }` (`null` = collection root).
**200** `ItemNode` (in its new place).
Errors: `400 VALIDATION_ERROR`, `404 ITEM_NOT_FOUND`, `404 TARGET_NOT_FOUND` (target collection/parent missing or other team),
`409 INVALID_MOVE` (into itself / own subtree / parent is a request),
`409 NAME_CONFLICT` (a folder with that name exists at the destination; `details: { name, parentId, conflictingId }`).

---

## 10. Import

### `POST /collections/:collectionId/import` — member
Atomically adds a tree of folders/requests into a collection (or under a folder). Rate-limited
(**10 / minute / user**), body ≤ 10 MB.

Body:
```ts
{
  parentId?: uuid | null;                  // default null (root); must be an active folder
  items: TreeNode[];                       // ≥ 1, ≤ 2000 nodes total, ≤ 32 levels
  onConflict?: "rename" | "fail";          // default "rename" – applies to root-level folder name clashes
  dryRun?: boolean;                        // default false – validate and report, write nothing
}
```
`TreeNode` is a request (as in §9, with `type: "request"`, no `parentId`) or a folder
`{ type: "folder", name, description?, auth?, items?: TreeNode[] }`.

**201** (or **200** when `dryRun: true`):
```json
{
  "collectionId": "uuid", "parentId": null, "dryRun": false,
  "created": { "folders": 2, "requests": 5 },
  "renamed": [ { "path": ["Auth"], "from": "Auth", "to": "Auth (copy)" } ],
  "warnings": [
    { "path": ["Auth","Login"], "code": "SENSITIVE_HEADER", "header": "Authorization" },
    { "path": ["Auth","Login"], "code": "SENSITIVE_AUTH", "authType": "bearer" }
  ],
  "roots": [ { "id": "uuid", "kind": "folder" } ],   // empty for dryRun
  "changedAt": "ISO"
}
```
Warnings flag literal secrets (placeholders like `{{token}}` do not warn; values are never echoed).
Errors: `400 VALIDATION_ERROR`, `400 IMPORT_TOO_DEEP` (`details.maxDepth`), `400 INVALID_PARENT`,
`400 DUPLICATE_FOLDER_NAME` (two sibling folders in the payload below the roots; `details.path`),
`409 FOLDER_NAME_CONFLICT` (only with `onConflict: "fail"`; `details.conflicts[]`),
`413 IMPORT_TOO_LARGE` (`details.maxItems`), `413 PAYLOAD_TOO_LARGE`, `429 RATE_LIMITED`
(`Retry-After` header, `details.retryAfterSeconds`), `404 NOT_FOUND`.

---

## 11. Version history
History exists for **collection metadata** (name, description, auth) and for **one folder/request**; not
for whole trees. A snapshot is stored right before each successful `PUT` (and before a restore). No snapshot on
create/delete/move. No expiry.

### `GET /collections/:collectionId/versions`
### `GET /collections/:collectionId/items/:itemId/versions`
**200** `{ "versions": [ { "id", "snapshot", "createdAt", "createdBy" } ] }` newest first.
- collection snapshot: `{ name, description, auth? }` (older rows may lack `auth` → treat as `null`)
- folder snapshot: `{ type: "folder", name, description, auth }`
- request snapshot: `{ type: "request", name, description, method, url, queryParams, headers, body, auth, preRequestScript, postResponseScript }`

### `POST …/versions/:versionId/restore` — member
Body-less. Applies the snapshot to the current resource (id/parent/children unchanged) and records the
replaced state as a new version.
**200** collection → `CollectionSummary`; item → `ItemNode`.
Errors: `404 NOT_FOUND` (resource or version missing / belongs to another resource),
`409 COLLECTION_NAME_CONFLICT` / `409 FOLDER_NAME_CONFLICT`.

---

## 12. Collection runner & run history
A run executes saved requests **on the server** sequentially (collection tree order), resolving
`{{variables}}`, running pre-request/post-response scripts (sandboxed QuickJS; `pm.*` API) and
assertions. Synchronous: the response is the finished run. Details and script API:
`frontend-collection-runner.md`.

### `POST /collections/:collectionId/run`
### `POST /collections/:collectionId/items/:itemId/run`
The second form runs the requests under a **folder** (`:itemId` must be an active folder in the collection).
Open to **viewers**. Rate limit **3 runs / minute / user**. Max **100** requests per run; 10 min deadline.

Body: `{ "environmentId"?: uuid }` (send `{}` for none). Variable priority (low→high): team global →
user → selected environment (enabled) → values set by scripts in this run.

**201** `RunDetail`:
```json
{
  "id": "uuid", "collectionId": "uuid", "folderId": null, "environmentId": null,
  "status": "passed" | "failed", "requestCount": 2, "passedCount": 1, "failedCount": 1,
  "startedAt": "ISO", "finishedAt": "ISO", "durationMs": 1000,
  "results": [ {
    "id": "uuid", "position": 0, "itemId": "uuid", "itemName": "Create",
    "status": "passed" | "failed" | "error" | "skipped",
    "httpStatus": 201, "durationMs": 32, "responseSizeBytes": 26,
    "responsePreview": "{...}" /* ≤16 KiB, may contain secrets */, "responseTruncated": false,
    "assertions": [ { "name": "id exists", "passed": false, "errorCode": "ASSERTION_FAILED" } ],
    "errorCode": null
  } ]
}
```
Per-request `errorCode` values: `SCRIPT_TIMEOUT`, `SCRIPT_FAILED`, `SCRIPT_MEMORY_EXCEEDED`,
`SCRIPT_INPUT_TOO_LARGE`, `SCRIPT_OUTPUT_INVALID`, `RUN_VARIABLE_NOT_FOUND`, `PROXY_DISABLED`,
`PROXY_HOST_NOT_ALLOWED`, `PROXY_TIMEOUT`, `PROXY_REQUEST_FAILED`, `RUN_TIMEOUT` (skipped). An upstream
4xx/5xx alone is **not** a failure — add a `pm.test` status assertion.
Request failures never abort the run (they are recorded and the next request runs).

Errors (request-level, before the run starts): `400 VALIDATION_ERROR`, `400 ITEM_NOT_FOLDER`,
`400 RUN_INVALID_URL`, `404 NOT_FOUND` (collection / folder / environment), `413 RUN_TOO_LARGE`
(`details.maxRequests`; nothing is stored), `422 RUN_VARIABLES_TOO_LARGE`,
`422 RUN_VARIABLE_NOT_FOUND` (`details.key`), `429 RATE_LIMITED`.
**Note:** `RUN_VARIABLE_NOT_FOUND` is returned as an HTTP 422 only for failures raised outside a request's execution; when it happens while running a request it is recorded in that request's result (`errorCode`). Handle both.

### `GET /collections/:collectionId/runs?limit=25&offset=0`
Only the **caller's** runs. `limit` 1–100 (default 25), `offset` 0–100000. Unknown query keys → 400.
**200** `{ "runs": RunSummary[], "total": number, "limit": number, "offset": number }` (newest first;
`RunSummary` = run without `results`).

### `GET /collections/:collectionId/runs/:runId`
**200** `RunDetail`. `404 NOT_FOUND` (not yours or missing). No delete endpoint for runs.

---

## 13. Environments (`/api/v1/environments`)
Team-scoped. Names unique (case-insensitive) among active environments of the team →
`409 ENVIRONMENT_NAME_CONFLICT` (`details: { name, conflictingId }`).
Variables are referenced as `{{key}}`; **frontend** substitutes them for proxy sends, the server for runs.

```ts
type Environment = {
  id: string; name: string;
  variables: { key: string; value: string; enabled: boolean }[];  // ordered
  createdAt: string; updatedAt: string; createdBy: string | null; updatedBy: string | null;
};
```
Variable key: 1–256 chars, **no whitespace or `{}`**; value ≤ 65 536 chars. Max **1000** variables.
Two **enabled** variables may not share a key (disabled duplicates are OK).

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/environments` | – | 200 `{ "environments": Environment[] }` |
| POST | `/environments` | `{ name, variables?: [{key,value,enabled?}] }` | 201 `Environment` |
| GET | `/environments/:environmentId` | – | 200 `Environment` |
| PUT | `/environments/:environmentId` | `{ name, variables?: [...] }` (**replaces all variables**) | 200 `Environment` |
| POST | `/environments/:environmentId/variables` | `{ key, value, enabled?: true }` (appended) | 201 `Environment` |
| POST | `/environments/:environmentId/clone` | – | 201 `Environment` (`"<name> (copy)"`) |
| DELETE | `/environments/:environmentId` | – | 204 (to Trash) |

Errors: `400 VALIDATION_ERROR` (incl. duplicate enabled key; `path: ["variables", i, "key"]`),
`400 VARIABLE_KEY_INVALID` / `400 VARIABLE_VALUE_INVALID` (add-variable endpoint only),
`403 TEAM_ROLE_REQUIRED` (viewer writes), `404 NOT_FOUND`, `409 ENVIRONMENT_NAME_CONFLICT`,
`409 VARIABLE_KEY_EXISTS` (add-variable with an existing enabled key),
`422 VARIABLE_LIMIT_REACHED`.

---

## 14. Variables (`/api/v1/variables`)
Team-scoped. Two scopes:
- **`user`** — private to the signed-in user, follows them across teams. Writable by every role.
- **`global`** — shared by the current team. Writable by `member`+ (`403 TEAM_ROLE_REQUIRED` for viewers).

Limits: 500 `user` variables, 1000 `global` per team. Key rules as in §13. Values: create ≤ 64 KiB;
upsert/patch ≤ 1 000 000 chars. Invalid `:scope` → `400 VALIDATION_ERROR`.

```ts
type ScopedVariable = { scope: "user" | "global"; key: string; value: string; updatedAt: string; updatedBy: string | null /* user id */ };
```

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/variables` | – | 200 `{ "variables": ScopedVariable[] }` (own `user` vars, then team `global`; each sorted by key) |
| GET | `/variables/order` | – | 200 `{ "order": string[] }` (the user's saved key display order; `[]` if none) |
| PUT | `/variables/order` | `{ "order": string[] }` (valid keys, no duplicates) | 200 `{ "order": string[] }` |
| POST | `/variables/:scope` | `{ key, value }` | 201 `ScopedVariable` |
| PUT | `/variables/:scope/:key` | `{ value }` — **upsert** (create if missing) | 200 `ScopedVariable` |
| PATCH | `/variables/:scope/:key` | `{ key?, value? }` (≥ 1; `key` renames) | 200 `ScopedVariable` |
| DELETE | `/variables/:scope/:key` | – | 204 |

Errors: `400 VARIABLE_KEY_INVALID`, `400 VARIABLE_VALUE_INVALID` (POST), `400 VALIDATION_ERROR`
(others), `403 TEAM_ROLE_REQUIRED`, `404 NOT_FOUND` (`No user variable named "x"` for PATCH/DELETE),
`409 VARIABLE_KEY_EXISTS` (POST or rename onto an existing key), `422 VARIABLE_LIMIT_REACHED`.
`global` changes are broadcast over SSE (`kind: "variable"`, `id` = key, value-free); `user` changes
are sent only to that user's own streams.

---

## 15. Preferences (`/api/v1/preferences`)
Per-user, **not** team-scoped, signed-in only. Stores an opaque UI blob.

### `GET /preferences/variable-order`
**200** `{ "preferences": VariableOrderPreferences | null }`.

### `PUT /preferences/variable-order`
Body `{ "preferences": { version: 1, sort: { field: "key"|"value", direction: "asc"|"desc" } | null,
manual: { user: string[], global: string[], environments: Record<string, string[]> }, updatedAt: string } }`
(arrays ≤ 1000 strings of ≤ 256 chars; ≤ 200 environment entries; extra keys are kept). Max body 256 KB.
**200** `{ "preferences": <same object> }`. Error: `400 PREFERENCES_INVALID` (`details` = issues).
(Newer UI should prefer `/variables/order`; this one holds the sort/manual preferences.)

---

## 16. Trash (`/api/v1/trash`)
Team-scoped. Only **roots** of deleted things are listed (a trashed folder lists once, not its children).
Items whose parent collection/folder is also trashed are hidden until the parent is restored.

### `GET /trash`
**200** `{ "entries": TrashEntry[] }` newest first:
`{ id, kind: "collection"|"folder"|"request"|"environment", name, collectionId: string|null, parentId: string|null, deletedAt }`.

### `POST /trash/:id/restore/check` — member
Dry run. Optional body (omit or `{}`): `{ "collectionName"?: string, "nameOverrides"?: { [itemOrEnvId]: newName } }`.
**200**
```json
{ "id": "uuid", "kind": "folder", "name": "Auth", "canRestore": false,
  "blocker": { "code": "PARENT_IN_TRASH", "message": "…" } | null,
  "conflicts": [ { "id","kind":"collection|folder|environment","name","collectionId","parentId","conflictingId" } ] }
```
### `POST /trash/:id/restore` — member
Same optional body. `collectionName` is valid only when restoring a collection; override keys must be
ids inside the restored subtree (for an environment: its own id).
**200** the restored resource: collection → `CollectionAggregate`; folder/request → `ItemNode`;
environment → `Environment` (distinguish by the trash entry's `kind`).
Errors: `400 INVALID_RESTORE_OVERRIDE`, `404 NOT_FOUND` (not in trash / other team),
`409 RESTORE_BLOCKED` (`details.blocker`: parent still in trash), `409 RESTORE_CONFLICT`
(`details.conflicts[]`: name taken → call again with `nameOverrides`/`collectionName`).
Recommended flow: `restore/check` → if conflicts, ask for new names → `restore`.
There is no permanent-delete / empty-trash endpoint.

---

## 17. Proxy (`/api/v1/proxy`)
Executes an HTTP request from the server (bypasses browser CORS). Signed-in only (any role). Redirects are
**not** followed (returned as normal 3xx responses). Session cookies are never forwarded.
The server does **not** substitute variables nor apply saved auth — the frontend must resolve both.

### `GET /proxy`
**200** `{ "enabled": boolean, "anyHost": boolean, "allowedHosts": string[] }`. Use it to show whether
execution is available (`enabled: false` ⇒ disable "Send" and explain).

### `POST /proxy`
Body:
```ts
{
  method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"|"OPTIONS";
  url: string;                                  // absolute http(s) URL, ≤ 8192
  headers?: [string, string][];                 // ≤ 500 pairs, duplicates preserved
  body?: string | null;                         // ≤ 10 000 000; ignored for GET/HEAD
}
```
**200** (even when the upstream replied 4xx/5xx — status is in the body):
```json
{ "status": 200, "statusText": "OK", "headers": { "content-type": "application/json" },
  "bodyText": "…", "durationMs": 120, "sizeBytes": 1234, "truncated": false }
```
`truncated: true` ⇒ response was cut at the server limit (default 10 MB). Timeout default 30 s.
Hop-by-hop headers (`host`, `content-length`, `connection`, `transfer-encoding`, …) are dropped.
Errors: `400 VALIDATION_ERROR`, `400 PROXY_INVALID_URL`, `400 PROXY_UNSUPPORTED_SCHEME`,
`400 PROXY_INVALID_HEADER`, `403 PROXY_DISABLED` (no allow-list configured),
`403 PROXY_HOST_NOT_ALLOWED`, `502 PROXY_REQUEST_FAILED`, `504 PROXY_TIMEOUT`.
Do not auto-retry 403s. `bodyText` is UTF-8 text (binary responses are not supported).

---

## 18. Realtime: events (`/api/v1/events`)
Server-Sent Events, **one stream per team** (open a new one when switching team). Use
`new EventSource(url, { withCredentials: true })` with `?teamId=<id>` (EventSource can't set headers).
Reconnect is automatic; `Last-Event-ID` (or `?lastEventId=`) lets the server replay missed events.

Stream (in order): `retry: <ms>` → optional replay / `resync` → `ready` → initial `presence` → live events,
plus `: heartbeat <iso>` comments every ~15 s.

| Event name | `data` | Meaning / UI action |
| --- | --- | --- |
| `ready` | `{ "epoch": "<id>" }` | Stream is live. A **changed epoch** after reconnect = server restarted → refetch everything |
| `change` | `{ kind, id, collectionId, operation, changedAt }` (SSE `id:` = event id) | A shared resource changed; **refetch** it (payload carries no content) |
| `presence` | `{ users: PresenceUser[] }` | Full snapshot of who is where in the team |
| `resync` | `{ "reason": "history_unavailable" }` | Missed events could not be replayed → refetch everything |

`change.kind`: `collection | folder | request | environment | variable`.
`change.operation`: `created | updated | trashed | restored | move`.
`collectionId`: parent collection for items, otherwise `null`. For `variable`, `id` is the variable key and
only `global` changes (team) plus your own `user` changes arrive. Cross-collection moves emit two events
(source and target collection).

`PresenceUser = { userId, firstName, lastName, avatarUrl: null, avatarColor: null, location: { kind: "collection", collectionId } | { kind: "folder"|"request", collectionId, itemId } }`
(look up avatar via the member list).

Errors before the stream starts (normal JSON error): `401`, team-context errors (§2),
`503` with `Retry-After` while the server is shutting down. The stream ends if the user is removed from the
team or the team is archived → refetch `GET /teams`. Slow consumers (> ~1 MB unsent) are disconnected.

---

## 19. Presence

### `PUT /presence`
Heartbeat telling the team where this browser tab currently is. Team-scoped, open to every role. Entries
expire after **45 s** without a heartbeat → send every ~15 s while visible, on every navigation, and
`location: null` when leaving/closing.
Body:
```ts
{
  clientId: string;                  // 1–128 chars, unique per tab (e.g. random id kept in sessionStorage)
  location:
    | { kind: "collection"; collectionId: uuid }
    | { kind: "folder" | "request"; collectionId: uuid; itemId: uuid }
    | null;                          // clear this tab's presence
}
```
**204**. Errors: `400 VALIDATION_ERROR`, `404 NOT_FOUND` (`Presence resource not found`: collection/item missing,
trashed, other team, or `kind` doesn't match the item). Results are delivered to everyone through the
`presence` SSE event; the endpoint returns no data.

---

## 20. Admin (`/api/v1/admin`, system admin only)
Requires `systemRole: "admin"`, otherwise `403 ADMIN_REQUIRED` (`401` when signed out). Not team-scoped.
Mutating team routes are audit-logged.

```ts
type TeamSummary = { id; name; description; memberCount; createdAt; updatedAt; archivedAt: string | null };
type TeamDetail  = TeamSummary & { members: Member[] };   // Member as in §7
type AdminUser   = { id; email; firstName; lastName; avatarColor; avatarUrl: string|null; systemRole: "user"|"admin"; createdAt; hasSignedIn: boolean };
type AdminUserDetail = AdminUser & { teams: { id; name; role; archivedAt: string|null }[] };
```

### Teams
| Method | Path | Body / query | Success |
| --- | --- | --- | --- |
| GET | `/admin/teams?includeArchived=false` | `includeArchived` = `true`/`false` | 200 `{ teams: TeamSummary[] }` |
| POST | `/admin/teams` | `{ name, description?: string }` | 201 `TeamDetail` |
| GET | `/admin/teams/:teamId` | – | 200 `TeamDetail` |
| PATCH | `/admin/teams/:teamId` | `{ name?, description? }` (≥ 1 field) | 200 `TeamDetail` |
| POST | `/admin/teams/:teamId/archive` | – | 200 `TeamDetail` (open streams/presence are closed) |
| POST | `/admin/teams/:teamId/unarchive` | – | 200 `TeamDetail` |
| DELETE | `/admin/teams/:teamId` | – | 204 (team must be archived and empty) |
| GET | `/admin/teams/:teamId/members` | – | 200 `{ members: Member[] }` |
| POST | `/admin/teams/:teamId/members` | `{ email, role?: "owner"|"member"|"viewer" }` | 201 `Member` |
| PATCH | `/admin/teams/:teamId/members/:userId` | `{ role }` | 200 `Member` |
| DELETE | `/admin/teams/:teamId/members/:userId` | – | 204 |

Team errors: `404 TEAM_NOT_FOUND`, `404 TEAM_MEMBER_NOT_FOUND`, `409 TEAM_NAME_CONFLICT`
(`details`), `409 TEAM_ARCHIVED` (already archived / team archived), `409 TEAM_NOT_ARCHIVED`
(unarchive a non-archived team, or delete before archiving), `409 TEAM_NOT_EMPTY` (still owns
collections, environments or variables), `409 TEAM_MEMBER_EXISTS`, `409 TEAM_LAST_OWNER`,
`400 EMAIL_DOMAIN_NOT_ALLOWED`, `400 VALIDATION_ERROR`.

### Users
| Method | Path | Body / query | Success |
| --- | --- | --- | --- |
| GET | `/admin/users?query=&limit=50&offset=0` | `query` ≤ 254 (matches email/first/last name), `limit` 1–200, `offset` ≥ 0 | 200 `{ users: AdminUser[], total }` |
| GET | `/admin/users/:userId` | – | 200 `AdminUserDetail` |
| PATCH | `/admin/users/:userId` | `{ systemRole: "user"|"admin" }` | 200 `AdminUserDetail` |
| DELETE | `/admin/users/:userId` | – | 204 (permanent; see below) |

`DELETE` removes sessions, memberships, run history, personal variables, preferences, avatar. Shared
content stays with `createdBy` = `null`. The deleted user's next call returns `401`.
Errors: `404 USER_NOT_FOUND`, `409 LAST_SYSTEM_ADMIN` (promote someone else first),
`409 CANNOT_DELETE_SELF`, `409 TEAM_LAST_OWNER` (`details.teamId`).

### Audit log
`GET /admin/audit-log?teamId=<uuid>&limit=50&offset=0` (`limit` 1–200)
**200** `{ entries: AuditLogEntry[], total }`, newest first:
```ts
{ id, actor: string | null /* email */, action, targetType: "team"|"team_member"|"user", targetId, teamId: string | null, details: object, createdAt }
```
`action` values: `team.created`, `team.updated`, `team.archived`, `team.unarchived`, `team.deleted`,
`team.member_added`, `team.member_role_changed`, `team.member_removed`, `user.system_role_changed`,
`user.deleted`.

---

## 21. Data models

```ts
type KeyValueRow = { key: string; value: string; description: string; enabled: boolean };
// writes: description (default "") and enabled (default true) are optional; key/value ≤ 8192 chars

type RequestBody = null | { type: "json" | "form-urlencoded" | "multipart" | "raw" | "graphql"; content: string };
// stored verbatim; the server never builds bodies or Content-Type (see frontend-request-body-types.md)

type ScopedAuth =                                      // collection & folder: null = inherit from parent
  | { type: "none" }
  | { type: "basic"; username: string; password: string }
  | { type: "bearer"; token: string }
  | { type: "api-key"; in: "header" | "query"; key: string /* non-empty */; value: string };

type RequestAuth = { type: "inherit" } | ScopedAuth;   // request default: inherit

type CollectionSummary = {
  id: string; name: string; description: string;
  createdAt: string; updatedAt: string; createdBy: string | null; updatedBy: string | null;
};
type CollectionAggregate = CollectionSummary & { auth: ScopedAuth | null; items: ItemNode[] };

type NodeBase = {
  id: string; collectionId: string; parentId: string | null; name: string; description: string;
  createdAt: string; updatedAt: string; createdBy: string | null; updatedBy: string | null;
};
type FolderNode  = NodeBase & { type: "folder"; auth: ScopedAuth | null; items: ItemNode[] };
type RequestNode = NodeBase & {
  type: "request"; method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE"; url: string;
  queryParams: KeyValueRow[]; headers: KeyValueRow[]; body: RequestBody;
  auth: RequestAuth;
  effectiveAuth: ScopedAuth;        // response-only; resolved inheritance, never "inherit"; "none" if nothing configured
  preRequestScript: string; postResponseScript: string;
};
type ItemNode = FolderNode | RequestNode;
```

Auth inheritance: nearest non-null `auth` of ancestor folders → collection; a request with `auth.type`
other than `inherit` always wins; an explicit `{ type: "none" }` stops inheritance.
Credentials are stored/returned in clear text (like header values) — don't log them.

Limits per field: name 200, description 10 000, url 8192, rows 500/list, body 1 000 000, script 32 768.

---

## 22. Error reference

| Status | Code | Where | Frontend handling |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | everywhere | Map `details[].path` to form fields |
| 400 | `BAD_REQUEST` | malformed JSON | Bug |
| 400 | `EMAIL_DOMAIN_NOT_ALLOWED` | auth, team/admin add member | "Use a @fluttersea.com / @sisal.com / @sisal.it address" |
| 400 | `AVATAR_UPLOAD_INVALID`, `AVATAR_INVALID_IMAGE` | avatar | Ask for a valid image |
| 400 | `INVALID_PARENT` | create item, import | Parent no longer exists – refetch tree |
| 400 | `ITEM_TYPE_MISMATCH` | update item | Bug / stale UI |
| 400 | `ITEM_NOT_FOLDER` | folder run | Only folders can be run via `/items/:id/run` |
| 400 | `IMPORT_TOO_DEEP`, `DUPLICATE_FOLDER_NAME` | import | Show message; `details.path` |
| 400 | `INVALID_RESTORE_OVERRIDE` | trash | Bug |
| 400 | `VARIABLE_KEY_INVALID`, `VARIABLE_VALUE_INVALID` | variables/env add | Inline field error |
| 400 | `PREFERENCES_INVALID` | preferences | Bug |
| 400 | `PROXY_INVALID_URL`, `PROXY_UNSUPPORTED_SCHEME`, `PROXY_INVALID_HEADER` | proxy | Inline request error |
| 400 | `RUN_INVALID_URL` | runner | URL invalid after substitution |
| 400 | `TEAM_CONTEXT_REQUIRED` | team-scoped | Prompt to choose a team |
| 401 | `AUTHENTICATION_REQUIRED` | all authed | Redirect to login (clear state) |
| 401 | `INVALID_OR_EXPIRED_CODE` | verify-code | "Wrong or expired code" |
| 403 | `ADMIN_REQUIRED` | admin | Hide admin UI |
| 403 | `TEAM_MEMBERSHIP_REQUIRED` | team-scoped | Empty state: "ask an owner to add you" |
| 403 | `TEAM_ROLE_REQUIRED` | writes | "No permission"; refresh `GET /teams` |
| 403 | `PROXY_DISABLED`, `PROXY_HOST_NOT_ALLOWED` | proxy/runner | Show config hint; don't retry |
| 404 | `NOT_FOUND` | any resource | Stale item – refetch; also unknown route |
| 404 | `TEAM_NOT_FOUND` | team-scoped, teams, admin | Fall back to another team |
| 404 | `ITEM_NOT_FOUND`, `TARGET_NOT_FOUND` | move | Refetch tree |
| 404 | `TEAM_MEMBER_NOT_FOUND`, `USER_NOT_FOUND`, `AVATAR_NOT_FOUND`, `DEV_MESSAGE_NOT_FOUND` | misc | Refetch |
| 409 | `COLLECTION_NAME_CONFLICT`, `ENVIRONMENT_NAME_CONFLICT`, `FOLDER_NAME_CONFLICT`, `NAME_CONFLICT`, `TEAM_NAME_CONFLICT` | create/update/move/restore | Ask for another name (`details.conflictingId`) |
| 409 | `INVALID_MOVE` | move | Disallow drop target |
| 409 | `RESTORE_BLOCKED`, `RESTORE_CONFLICT` | trash | Restore parent first / ask new names |
| 409 | `VARIABLE_KEY_EXISTS` | variables/env | "Key already exists" |
| 409 | `TEAM_MEMBER_EXISTS`, `TEAM_LAST_OWNER`, `TEAM_ARCHIVED`, `TEAM_NOT_ARCHIVED`, `TEAM_NOT_EMPTY` | teams/admin | Message from server |
| 409 | `LAST_SYSTEM_ADMIN`, `CANNOT_DELETE_SELF` | admin users | Message |
| 413 | `PAYLOAD_TOO_LARGE`, `IMPORT_TOO_LARGE`, `RUN_TOO_LARGE`, `AVATAR_TOO_LARGE` | various | Reduce size |
| 415 | `AVATAR_UNSUPPORTED_TYPE` | avatar | JPEG/PNG/WebP only |
| 422 | `VARIABLE_LIMIT_REACHED` | variables/env | Limit reached |
| 422 | `RUN_VARIABLES_TOO_LARGE`, `RUN_VARIABLE_NOT_FOUND` | runner | Fix variables; no auto retry |
| 429 | `AUTH_RATE_LIMITED` | request/verify-code | Wait and retry |
| 429 | `RATE_LIMITED` | import (10/min), run (3/min) | Honour `Retry-After` header / `details.retryAfterSeconds` |
| 502 / 504 | `PROXY_REQUEST_FAILED` / `PROXY_TIMEOUT` | proxy | Offer retry |
| 503 | `AUTH_DELIVERY_FAILED` | request-code | Retry later |
| 503 | *(empty body, `Retry-After`)* | SSE while shutting down | EventSource will reconnect |
| 500 | `INTERNAL_SERVER_ERROR` | any | Generic error toast |

---

## 23. Limits & rate limits

| What | Limit |
| --- | --- |
| Sign-in code requests | 3 / 15 min per email (config) |
| Code verification | 10 / 15 min per email; 5 wrong attempts invalidate the code |
| Collection/folder run | **3 / minute / user**; ≤ 100 requests per run; 10 min deadline |
| Import | **10 / minute / user**; ≤ 2000 nodes; ≤ 32 folder levels; ≤ 10 MB |
| Tree depth (create collection / import) | 32 levels |
| Environment variables | 1000 per environment |
| `user` variables | 500 per user · `global` variables 1000 per team |
| Variable key / value | key ≤ 256 (no whitespace/`{}`); value ≤ 64 KiB on create, ≤ 1 MB on upsert/patch |
| Request body content | 1 000 000 chars |
| Script size | 32 768 chars per hook (1 s CPU, 16 MiB) |
| Proxy | timeout 30 s, response 10 MB, request body 10 MB (server config) |
| Avatar | ≤ 5 MB upload, JPEG/PNG/WebP → 512×512 WebP |
| Presence TTL | 45 s without heartbeat |
| SSE heartbeat / reconnect hint | 15 s / 3 s (server config) |
| Session lifetime | 30 days (server config) |
