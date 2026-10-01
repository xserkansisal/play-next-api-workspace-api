# play-next-api-workspace-api

Standalone Node.js + Express + TypeScript API service for Play Next workspaces.

## Requirements

- Node.js >= 22.12 (see `engines` in `package.json`)
- npm

## Getting started

```sh
npm install
cp .env.example .env   # optional; defaults are used when unset
npm run dev            # http://localhost:3000/health
```

## Scripts

| Script              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `npm run dev`       | Start with watch mode via `tsx` (loads `.env`) |
| `npm run build`     | Compile `src/` to `dist/`                      |
| `npm start`         | Run the compiled server (loads `.env`)         |
| `npm run typecheck` | Type-check sources and tests                   |
| `npm test`          | Run Vitest unit + Supertest integration tests  |
| `npm run db:generate` | Generate a MySQL migration from `src/db/schema.ts` into `drizzle-mysql/` |
| `npm run db:migrate`  | Apply pending migrations to the configured MySQL database (also applied on startup) |
| `npm run db:check`    | Check generated migrations for consistency     |
| `npm run presence:seed` | Idempotently create ten database-backed presence test users at random active resources (development/test only) |
| `npm run presence:clear` | Remove seeded presence test users (development/test only) |
| `npm run mail:check` | Connects and authenticates against the configured SMTP relay without sending anything (exit 1 on failure) |

See [Deployment and operations](docs/deployment.md) for MySQL provisioning, PM2 deployment, migrations, and backup/restore.

## Configuration

Environment variables are validated with Zod in `src/config/env.ts`:

| Variable   | Default       | Notes                                  |
| ---------- | ------------- | -------------------------------------- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST`     | `0.0.0.0`     | Bind address; use `127.0.0.1` behind a same-host reverse proxy |
| `PORT`     | `3000`        | Integer 0–65535                        |
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | MySQL 8.0.16+ server |
| `MYSQL_USER` / `MYSQL_PASSWORD` | `play_next_api` / unset | Database credentials; password required in production |
| `MYSQL_DATABASE` | `play_next_api` | Existing database, created with `utf8mb4_0900_bin` collation |
| `CORS_ORIGIN` | unset | Optional exact browser origin when accessing the API directly or from Vite; credentialed requests are allowed only from that origin; `*` echoes whatever origin calls, see "Allowing every origin"; not needed for same-origin nginx proxying |
| `SSE_HEARTBEAT_MS` | `15000` | SSE heartbeat comment interval (1000–300000) |
| `SSE_RETRY_MS` | `3000` | Reconnect delay advertised to SSE clients via `retry:` (100–300000) |
| `AUTH_CODE_PEPPER` | development-only placeholder | HMAC key for sign-in codes; a six-digit code is exhaustible from a stolen hash without it. Generate per environment with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Production refuses example and repeated-character values. See [deployment.md](docs/deployment.md#sign-in-code-pepper) |
| `AUTH_CODE_TTL_SECONDS` | `900` | Sign-in code lifetime (15 minutes by default; range 60–3600) |
| `AUTH_CODE_MAX_ATTEMPTS` | `5` | Wrong attempts allowed per code before it is invalidated |
| `AUTH_CODE_REQUEST_LIMIT` / `AUTH_CODE_REQUEST_WINDOW_SECONDS` | `3` / `900` | Code requests allowed per normalized email per window |
| `AUTH_CODE_VERIFY_LIMIT` / `AUTH_CODE_VERIFY_WINDOW_SECONDS` | `10` / `900` | Verification requests allowed per normalized email per window |
| `AUTH_SESSION_TTL_SECONDS` | `2592000` | Server-side session lifetime (one month by default) |
| `AUTH_COOKIE_NAME` | `play_next_session` | Session cookie name |
| `AUTH_COOKIE_SECURE` | `false` | Adds the cookie's `Secure` attribute when enabled; keep false only for the current HTTP-only internal deployment |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | host/from required in production; port `587`, secure `false` | Organization SMTP transport; setting host and sender switches on real delivery in any mode; username and password must be set together; see "Configuring email delivery" |
| `AUTH_DEV_INBOX_TOKEN` | unset | Optional 32+ character token enabling the `/api/v1/auth/dev-inbox` development helper for a directly connected local caller; refused for anything relayed through a proxy; never set in production |

JSON request bodies are limited to 50 MiB (50 × 1024 × 1024 bytes) to support larger
collection imports. Each individual request body's `content` is still limited to 1,000,000
characters, and tree depth to 32; collection imports can contain many requests within those
per-item limits.

## Persistence

Shared data is stored in MySQL 8.0.16+ via [Drizzle ORM](https://orm.drizzle.team/) and
`mysql2`. The async pool uses database transactions for multi-row writes. Create the database
with `utf8mb4_0900_bin` collation so normalized keys and identifiers retain exact comparisons.
The schema lives in `src/db/schema.ts`; MySQL migrations in `drizzle-mysql/` are generated with
`npm run db:generate` and committed.

Normalized tables: `collections`, `items` (folders and requests as a recursive tree via
`parent_id`), `request_details`, ordered `request_query_params` / `request_headers`,
`environments`, and ordered `environment_variables`. IDs are UUIDs, timestamps are ISO-8601 UTC
strings, and deletion is a soft delete (`deleted_at`, plus `trash_root_id` on items so a subtree
is restored together). Sibling order is not persisted; lists are returned alphabetically.
Indexed generated columns preserve the previous partial-unique-index behavior: active collection
and environment names are unique, as are active sibling folder names (request names may repeat).
Scoped variables retain one key per user and one global value per key.

## API (v1)

| Method | Route | Description |
| ------ | ----- | ----------- |
| POST | `/api/v1/auth/request-code` | Request a sign-in code by email |
| POST | `/api/v1/auth/verify-code` | Verify a code, return the current user's profile, and issue the session cookie |
| GET | `/api/v1/auth/me` | Read the current signed-in user's persisted profile |
| POST | `/api/v1/auth/sign-out` | Revoke the current server-side session |
| GET | `/api/v1/collections` | Active collections (metadata) |
| POST | `/api/v1/collections` | Create a collection, optionally with a nested `items` tree (atomic) |
| GET | `/api/v1/collections/:id` | Collection with its active item tree |
| PUT | `/api/v1/collections/:id` | Save name/description only |
| DELETE | `/api/v1/collections/:id` | Move collection and its items to Trash |
| POST | `/api/v1/collections/:id/clone` | Copy the collection and its whole active tree under a free name |
| POST | `/api/v1/collections/:id/items` | Create a `folder` or `request` (optional `parentId`) |
| GET | `/api/v1/collections/:id/items/:itemId` | Read one item (folders include their subtree) |
| PUT | `/api/v1/collections/:id/items/:itemId` | Save one item's own fields; never rewrites the tree |
| DELETE | `/api/v1/collections/:id/items/:itemId` | Move item (and descendants) to Trash |
| POST | `/api/v1/collections/:id/items/:itemId/clone` | Copy a folder (with its subtree) or a request, beside the original |
| POST | `/api/v1/collections/:id/items/:itemId/move` | Reparent a folder (with its subtree) or a request, within or across collections |
| GET/POST | `/api/v1/environments` | List / create environments |
| GET/PUT/DELETE | `/api/v1/environments/:id` | Read / save (replaces variables) / move to Trash |
| POST | `/api/v1/environments/:id/clone` | Copy the environment and its variables under a free name |
| GET | `/api/v1/variables` | This user's own variables plus every global one |
| GET | `/api/v1/variables/order` | Read this user's saved display order of variable names |
| PUT | `/api/v1/variables/order` | Replace this user's display order. Body: `{ "order": string[] }` |
| PUT | `/api/v1/variables/:scope/:key` | Save a value at `user` or `global` scope. Body: `{ "value": string }` |
| PATCH | `/api/v1/variables/:scope/:key` | Update a value and/or atomically rename a variable. Body: `{ "key"?: string, "value"?: string }` |
| POST | `/api/v1/variables/:scope` | Create-only scoped variable. Body: `{ "key": string, "value": string }`; duplicate keys return `409` |
| DELETE | `/api/v1/variables/:scope/:key` | Forget one variable at that scope |
| POST | `/api/v1/environments/:id/variables` | Append one variable row to an environment; enabled-key conflicts return `409` |
| GET | `/api/v1/preferences/variable-order` | Read this user's variable ordering preference (`null` when not saved) |
| PUT | `/api/v1/preferences/variable-order` | Save this user's variable ordering preference (maximum request size: 256 KB) |
| PUT | `/api/v1/presence` | Refresh or clear the current browser tab's collection/folder/request location |
| GET | `/api/v1/trash` | Restorable deleted roots (`kind`, `deletedAt`) |
| POST | `/api/v1/trash/:id/restore/check` | Read-only conflict report; accepts the same body as restore |
| POST | `/api/v1/trash/:id/restore` | Atomic subtree restore. Body: `{ "collectionName"?: string, "nameOverrides"?: { [itemId or environmentId]: newName } }` |
| GET | `/api/v1/events` | Server-Sent Events stream of value-free change notifications and live presence snapshots |

There is no permanent delete. Conflicts return `409` (`COLLECTION_NAME_CONFLICT`,
`FOLDER_NAME_CONFLICT`, `ENVIRONMENT_NAME_CONFLICT`, `RESTORE_CONFLICT`, `RESTORE_BLOCKED`); invalid input returns `400`
(`VALIDATION_ERROR`, `INVALID_PARENT`, `ITEM_TYPE_MISMATCH`, `INVALID_RESTORE_OVERRIDE`).

The authenticated user object returned by `verify-code` and `me` includes `firstName` and
`lastName`, derived from the verified email address on first sign-in and persisted in `users`.
These fields are read-only; there is no endpoint for editing or looking up another user's profile.
Deploy migration `0004_spooky_trish_tilby` before deploying API code that reads these fields.

Presence is session-authenticated and ephemeral: each `(user, clientId)` tab has an independent
location with a maximum 45-second TTL. The `/api/v1/events` stream sends a full `presence`
snapshot on connection and whenever the snapshot changes. Snapshots contain display names and
resource IDs only; they never include email addresses, request URLs, request data, or tokens.

To preview presence without hard-coded frontend fixtures, create active workspace resources,
run `npm run presence:seed`, and restart the API with `PRESENCE_SIMULATOR_ENABLED=true`. The ten
synthetic profiles and their randomly assigned active locations are stored in MySQL. The API
re-reads those records and refreshes their in-memory heartbeats every 15 seconds, changing their
stored random location once per minute. This switch is rejected in production. Use
`npm run presence:clear` to remove the synthetic users.

## Scoped variables

A value read out of a response - a token, a piece of game state - is reused in the next request
through the same `{{key}}` substitution as an environment variable. It is stored at one of two
scopes:

- **`user`** belongs to the signed-in account. Nobody else can read it, write it or delete it, and
  a request for it never selects another person's rows in the first place.
- **`global`** is shared by everyone signed in.

They are a separate table from `environment_variables` on purpose. An environment is a shared,
exportable document that people edit by hand; writing a value captured from one person's session
into it would silently change what every teammate sends, and would then be exported with the
collection.

The two scopes live in one table with a nullable `user_id`, so one query and one route serve both.
A check constraint is what keeps the halves from drifting: a `user` row with no owner would be
readable by everybody, which is the exact opposite of what the scope means. Two partial unique
indexes let one person's `token` coexist with everyone else's and with the single global one.

Writes are upserts - saving `token` twice means the second reading replaced the first, never that
there are now two. Keys must be usable as `{{key}}`, so the same rule as environment variables
applies: no whitespace, no braces.

Only a **global** write is announced over SSE. A personal value concerns one person, and
broadcasting it would make every other client refetch for nothing while telling the whole team
which keys that person holds.

Display order is an independent per-user preference. Its complete list of names may include
variables from an environment selected in the client, and does not create, update, or delete
variable values. Names follow the same key rule (non-empty, at most 200 characters, no whitespace
or braces), and duplicates are rejected; an empty order is valid.

Values are stored in plain text, exactly as environment variables already are. Nothing here makes
a secret safer than it is in an environment.

## Making a copy

The three `clone` endpoints duplicate a collection, an item (folder or request), or an
environment. Each writes the copy in a single transaction, so it either exists whole or not at
all - a client doing the same thing for a forty-request folder would need forty calls, and a
failure halfway through would leave the user a half-folder to clean up.

The copy is named `X (copy)`, then `X (copy 2)`, and so on until the name is free. A trailing
marker on the source is stripped first, so copying `Orders (copy)` gives `Orders (copy 2)` rather
than nesting markers. Only the root is renamed: everything below it moves to a new parent, where
its own name cannot collide. A cloned item keeps its source's parent so the copy appears next to
the original, and the copy is attributed to whoever asked for it, not the original author.
Trashed rows are left behind.

## Moving an item

`POST /api/v1/collections/:id/items/:itemId/move` takes
`{ "targetCollectionId": string, "parentId": string | null }` and returns the moved item with its
subtree in its new position. `parentId` is the destination folder, or `null` for the collection
root.

This is a reparent, never a reorder. Siblings are returned folder-agnostic and alphabetical, and
no sibling index is stored, so there is nothing a drop *between* two rows could persist. Manual
ordering would need a persisted position on every item and is deliberately out of scope.

The whole subtree moves in one transaction, trashed descendants included: the parent reference is
a foreign key on `(parent_id, collection_id)` that does not look at `deleted_at`, so a trashed
child left behind would both break the write and later restore into a collection its ancestors
have left. For the same reason a cross-collection move suspends that key for the duration of the
rewrite - there is no order in which a subtree can change collection one row at a time - and
restores it before the connection goes back to the pool. The sibling-folder-name index is never
suspended and remains the last word on uniqueness.

Rejections, all of which the client also blocks during the drag, so only a stale tab reaches them:

| Condition | Status | Code |
|---|---|---|
| The item, or the collection it is named in, does not exist | `404` | `ITEM_NOT_FOUND` |
| `targetCollectionId` or `parentId` does not exist | `404` | `TARGET_NOT_FOUND` |
| `parentId` is the item, a descendant of it, or a request | `409` | `INVALID_MOVE` |
| A sibling folder in the destination already has that name | `409` | `NAME_CONFLICT` |

Name conflicts apply to folders only; sibling requests may share a name, as they may anywhere
else. A move emits a `move` change event carrying the item's new `collectionId`, and a second one
for the source collection when the two differ, so a tab watching only the old collection stops
showing the item under its old parent.

## Email code sign-in

Only `fluttersea.com`, `sisal.com`, and `sisal.it` addresses can request a six-digit code.
Codes expire after 15 minutes by default, are stored only as peppered HMAC hashes, are
single-use, and are invalidated after five failed attempts. Code requests and verification
attempts are rate-limited independently per normalized email. Responses do not disclose whether
an eligible address already has an account. There is no per-IP rate limit; the API does not
trust forwarded client-IP headers from nginx.

`POST /api/v1/auth/request-code` accepts `{ "email": "..." }` and returns `202`. Verify with
`POST /api/v1/auth/verify-code` and `{ "email": "...", "code": "123456" }`; successful
verification sets an `HttpOnly`, `SameSite=Lax` session cookie. `GET /api/v1/auth/me` returns
the signed-in user and `POST /api/v1/auth/sign-out` revokes the server-side session. All
collections, items, environments, Trash, and SSE routes require that cookie. Browser
`EventSource` connections use cookies; the Vite development origin must be allowed through
`CORS_ORIGIN` and its client must enable credentials. Credentialed CORS is enabled only for the
exact configured origin.

### Allowing every origin

If the workspace is opened from an address that is not fixed — a machine's LAN IP, a colleague's
laptop — set the value to `*`:

```
CORS_ORIGIN=*
```

The response still names **the caller's own origin**, never a literal `*`: a browser refuses to
send credentials to a wildcard, and this API authenticates with a session cookie, so echoing is the
only form of "any origin" that works here. `Vary: Origin` stops a cache from handing one origin's
allowance to another. Only a bare `*` is the wildcard — a pattern such as `https://*.example.com`
is kept as the literal origin it looks like and therefore matches nothing, so a half-remembered
guess fails closed instead of quietly opening the API. The API prints a warning at startup when it
is set, because with `*` any page the user visits can call this API with their cookie attached.

Note what this setting is *not*: it governs who may call **this** API. It cannot make some other
server you are testing send `Access-Control-Allow-Origin` — that header belongs to that server.

SMTP host, port, TLS mode, credentials and sender address are configurable; production requires
`SMTP_HOST` and `SMTP_FROM`, and accepts SMTP authentication only when both user and password are
provided. SMTP delivery has not been verified against the organization's server. Development and
tests use an in-memory sender that does not send or log mail. For local development only, set a
long random `AUTH_DEV_INBOX_TOKEN` to expose the latest unexpired code at
`GET /api/v1/auth/dev-inbox?email=...`, with the token in `X-Dev-Inbox-Token`; the route is not
registered in production, and in development it serves only a genuinely local caller. "Local" has
to be checked twice: a reverse proxy on the same machine makes every caller look local, because
the address the API sees is nginx's, so a request carrying `X-Forwarded-For`, `X-Real-IP` or
`Forwarded` is refused regardless of its apparent address. Without that second check, running a
development-mode API behind nginx would hand sign-in codes for any eligible address to anyone
holding the token.

### Configuring email delivery

Six settings, of which two decide everything else:

| Setting | What it is | Notes |
| --- | --- | --- |
| `SMTP_HOST` | The relay's hostname | Required for real delivery |
| `SMTP_FROM` | The envelope/header sender | Required for real delivery; must be an address the relay is willing to send as |
| `SMTP_PORT` | `587` by default | `587` for STARTTLS, `465` for implicit TLS, `25` for an unauthenticated internal relay |
| `SMTP_SECURE` | `false` by default | `true` only for an implicit-TLS port such as `465`. On `587` this must stay `false` - the connection still upgrades to TLS via STARTTLS |
| `SMTP_USER` / `SMTP_PASSWORD` | Credentials | Set **both or neither**; the API refuses to start with one of the two. Omit both for a relay that authorizes by source address |

`SMTP_HOST` and `SMTP_FROM` together are the switch: set them and the API sends real mail; leave
either unset and it uses an in-memory sender that delivers nothing. That is deliberately not tied
to `NODE_ENV`, so the settings can be exercised in development rather than first tried in the one
deployment where a mistake costs the most. Configuring SMTP also withdraws the dev-inbox helper
automatically, since that helper only reads the in-memory sender.

Define them wherever the process gets its environment: a gitignored `.env` for local work, or the
exported environment / PM2 ecosystem file on a VM (see
[Deployment and operations](docs/deployment.md)). They hold a password, so they do not belong in a
checked-in file or in shell history.

Check them before a user is waiting on a code:

```sh
npm run mail:check
```

This opens the connection and authenticates, but sends nothing. It is not a promise that mail
arrives - relaying rules, SPF/DMARC and recipient filtering are decided after this point, and only
a real send exercises those. What it does rule out is the majority of setup failures: an
unreachable host, a `SMTP_SECURE` that does not match the port, and credentials the relay rejects.

Only `fluttersea.com`, `sisal.com` and `sisal.it` addresses can request a code
(`ALLOWED_EMAIL_DOMAINS` in `src/auth/service.ts`), so a test send has to go to one of those.

If delivery fails, the caller gets `503 AUTH_DELIVERY_FAILED` with no reason - naming it would
confirm the address is eligible, which the uniform responses exist to avoid. The reason is written
to the server log instead, because it is a property of this server's configuration and the operator
is the one who needs it.

Sessions are stored as token hashes and can be revoked server-side. Cookie `Secure` defaults to
false because the current internal deployment deliberately uses plain HTTP; this means sign-in
codes and session cookies are not protected from network observation. Keep the service strictly
on the trusted internal network and revisit TLS and `AUTH_COOKIE_SECURE=true` before any broader
exposure. Authenticated writes record creator and last updater emails for collections, items, and
environments. Existing pre-auth rows keep `NULL` attribution rather than being assigned a
fabricated user. This is attribution only: signed-in users share and can edit all data.

## Live change notifications (SSE)

`GET /api/v1/events` (`text/event-stream`) tells clients *that* something changed so they can
refetch it; it never carries data. Like every collection, environment and Trash route, it
requires the session cookie; browser `EventSource` sends the cookie automatically for a
same-origin connection. A frame is emitted only after a create, update, move to
Trash or restore of a collection, folder, request or environment has been **committed**. Reads,
restore checks and failed writes (4xx/5xx) emit nothing.

```text
retry: 3000

event: ready
data: {"epoch":"<uuid>"}

id: <epoch>:42
event: change
data: {"eventId":"<epoch>:42","kind":"request","id":"<itemId>","collectionId":"<collectionId>","operation":"updated","changedAt":"2026-01-01T00:00:00.000Z"}

: heartbeat 2026-01-01T00:00:15.000Z
```

- `kind`: `collection` | `folder` | `request` | `environment`; `operation`: `created` |
  `updated` | `trashed` | `restored` | `move`; `collectionId` is the owning collection for folders/requests and `null` for
  collections and environments. Payloads never include names, URLs, headers, query params, bodies or
  environment variable values. A subtree trash or restore emits one event for its root, and so does
  a move - except across collections, which emits one for the destination and one for the source.
- **Heartbeat:** a `: heartbeat` comment every `SSE_HEARTBEAT_MS` keeps proxies from timing out
  idle connections.
- **Reconnect:** `retry:` sets the browser `EventSource` reconnect delay. On reconnect the
  browser sends `Last-Event-ID` (clients can also pass `?lastEventId=`); missed events are
  replayed from an in-memory buffer (last 1000 events) before `ready`. If they cannot be
  replayed (the server restarted so the epoch changed, the ID is too old, or it is malformed),
  the server sends `event: resync` (`{"reason":"history_unavailable"}`) and the client should
  refetch whatever it has displayed.
- **Lifecycle:** each connection's heartbeat and subscription are released when the client
  disconnects. A client whose socket buffer stays full is dropped (it will reconnect). On
  shutdown the server ends every stream before closing, and new connections get `503`.
- **Single process:** the hub (`src/events/hub.ts`) is in-memory. Run exactly one API process
  for the deployment; there is no cross-process or distributed fan-out.
- **Reverse proxy:** nginx buffers proxied responses by default. Its `/api` location must disable
  proxy buffering and use a long read timeout for SSE. If live updates stop while the API
  otherwise appears healthy, check nginx buffering/timeouts first.

## Running a request from the server (`/api/v1/proxy`)

A browser-based REST client cannot reach a server that does not send CORS headers. That is a
restriction the browser places on the *page*, not a property of the request: the same call succeeds
from curl or Postman. For those targets the client can ask this API to make the request instead.

**This is server-side request forgery by design, so it is disabled until you opt in.** Set
`PROXY_ALLOWED_HOSTS` to the hosts that may be reached, as `host` or `host:port`, comma separated.
While it is empty every proxy call returns `403 PROXY_DISABLED`. Inside a private network an open
proxy is worth *more* to an attacker than one on the public internet, because this process can reach
hosts they cannot — so keep the list to what you actually need.

```
PROXY_ALLOWED_HOSTS=localhost:7799,internal-api.example.com
```

### Allowing every host

If you cannot name your targets in advance — a local tool pointed at whatever host you happen to be
testing today — set the value to `*`:

```
PROXY_ALLOWED_HOSTS=*
```

Be clear about what that does: it removes the allow-list, which is the only real boundary here.
Every signed-in user can then make this process send a request to **any host it can reach**,
including `127.0.0.1`, anything else bound to loopback on that machine, a cloud metadata endpoint,
and every host on its private network. The API prints a warning at startup when it is set. It is a
reasonable setting for a laptop you control; it is not a reasonable setting for anything shared or
exposed. Only `*` on its own is a wildcard — there is no `*.example.com` or `192.168.*`.

What protects you, beyond the allow-list:

- **Redirects are never followed.** An allow-listed host could otherwise redirect to a cloud
  metadata endpoint or another internal service and smuggle the response back. A redirect is
  returned to the caller as an ordinary response instead.
- **Only `http` and `https`.** No `file:`, `gopher:` or `data:`.
- **Nothing about your session is forwarded.** Outgoing headers come only from the submitted
  request, so the `play_next_session` cookie cannot leak to a third-party host.
- Hop-by-hop headers are dropped, and `PROXY_TIMEOUT_MS` and `PROXY_MAX_RESPONSE_BYTES` bound how
  much one request can cost.

Matching is exact — `example.com` does not admit `evil-example.com` or `sub.example.com`. There are
no wildcards. Adding a host requires an API restart.

Not defended against: an allow-listed name is trusted, so if you allow-list a host whose DNS an
attacker controls, they choose the address this process connects to. The allow-list is
operator-controlled configuration, so that is a deliberate trade.

Both routes require authentication.

- `GET /api/v1/proxy` — `{ enabled, allowedHosts }`, so the client can say what is reachable instead
  of only finding out by failing.
- `POST /api/v1/proxy` — `{ method, url, headers: [[name, value]], body }`, returning
  `{ status, statusText, headers, bodyText, durationMs, sizeBytes, truncated }`.

The target's status travels *inside* the response body, and the proxy call itself returns 200. An
upstream 404 is a successfully executed request; collapsing the two would make it impossible to tell
an upstream error from a proxy failure. Proxy failures use their own codes: `PROXY_DISABLED`,
`PROXY_HOST_NOT_ALLOWED`, `PROXY_INVALID_URL`, `PROXY_UNSUPPORTED_SCHEME`, `PROXY_REQUEST_FAILED`
(502) and `PROXY_TIMEOUT` (504). `truncated` is true when the response hit the size limit, so the
body must not be treated as complete.

## Operations

### Single-origin web/API deployment

For the on-prem deployment, nginx serves the web app and proxies `/api` to the PM2-managed API
on the same origin. Browser requests are same-origin, so CORS is not part of the normal
deployment path. `CORS_ORIGIN` remains available only for direct browser access to the API port
or development against the Vite server.

Bind the API to `127.0.0.1` when nginx runs on the same VM; `HOST` is configurable even though
the application default is `0.0.0.0`. Verify the actual listener is loopback-only (for example
with `ss -ltnp`) and that the nginx upstream targets that address and the configured `PORT`.
Do not expose the API port to other network hosts.

The API does not enable Express proxy trust or consume forwarded client-IP headers. Behind nginx,
the remote address visible to the API is nginx's address. No per-IP rate limit is implemented;
before adding one, explicitly design trusted proxy/client-IP handling, or the limiter could treat
all users as nginx and throttle them together.

Nginx must disable response buffering and allow a long read timeout for `/api` SSE responses.
If live updates fail while ordinary API requests and health checks still work, check nginx's
SSE buffering and timeout settings first—the API can remain healthy while the proxy hides or
delays the stream.

### Backup and restore

Use `mysqldump --single-transaction` for an online consistent backup and restore into a newly
created MySQL database with the required `utf8mb4_0900_bin` collation. The supported cutover is a
clean MySQL installation; existing SQLite files are not imported or modified.

## Structure

- `src/app.ts` – `createApp()` factory (no network side effects; used by tests)
- `src/server.ts` – startup entry point (loads env, listens, graceful shutdown)
- `src/middleware/errorHandler.ts` – 404 + centralized JSON error handling
- `src/routes/` – `GET /health` and the `/api/v1` routers (HTTP + Zod parsing only), including the SSE endpoint
- `src/events/` – in-process change-event hub (publish after commit, replay buffer)
- `src/services/` – persistence/business rules with explicit transaction boundaries
- `src/validation/schemas.ts` – Zod request schemas
- `src/db/` – Drizzle MySQL schema, connection/migration helpers, and migration CLI
- `tests/unit`, `tests/integration` – Vitest and Supertest suites

Errors are returned as `{ "error": { "code", "message", "details?" } }`.
