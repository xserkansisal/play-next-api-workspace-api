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
| `npm run db:generate` | Generate a SQL migration from `src/db/schema.ts` into `drizzle/` |
| `npm run db:migrate`  | Apply pending migrations to `DATABASE_PATH` (the server also applies them on startup) |
| `npm run db:check`    | Check generated migrations for consistency     |
| `npm run db:check-name-keys` | Read-only report of stale case-folded name keys and Unicode name collisions (exit 1 on collisions) |

See [Deployment and operations](docs/deployment.md) for PM2 deployment, migration, and SQLite backup/restore procedures.

## Configuration

Environment variables are validated with Zod in `src/config/env.ts`:

| Variable   | Default       | Notes                                  |
| ---------- | ------------- | -------------------------------------- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST`     | `0.0.0.0`     | Bind address; use `127.0.0.1` behind a same-host reverse proxy |
| `PORT`     | `3000`        | Integer 0–65535                        |
| `DATABASE_PATH` | `./data/api.sqlite` | SQLite file; parent directory is created if missing |
| `CORS_ORIGIN` | unset | Optional exact browser origin when accessing the API directly or from Vite; not needed for same-origin nginx proxying; no credentials are enabled |
| `SSE_HEARTBEAT_MS` | `15000` | SSE heartbeat comment interval (1000–300000) |
| `SSE_RETRY_MS` | `3000` | Reconnect delay advertised to SSE clients via `retry:` (100–300000) |

## Persistence

Shared data is stored in SQLite via [Drizzle ORM](https://orm.drizzle.team/) and the
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) driver (synchronous, so every
write runs in a single `BEGIN IMMEDIATE` transaction). The schema lives in `src/db/schema.ts`;
migrations in `drizzle/` are generated with `npm run db:generate` and committed.

Normalized tables: `collections`, `items` (folders and requests as a recursive tree via
`parent_id`), `request_details`, ordered `request_query_params` / `request_headers`,
`environments`, and ordered `environment_variables`. IDs are UUIDs, timestamps are ISO-8601 UTC
strings, and deletion is a soft delete (`deleted_at`, plus `trash_root_id` on items so a subtree
is restored together). Sibling order is not persisted; lists are returned alphabetically.
Partial unique indexes enforce case-insensitive unique active collection names and sibling
folder names (request names may repeat), and case-insensitive unique active environment names.

## API (v1)

| Method | Route | Description |
| ------ | ----- | ----------- |
| GET | `/api/v1/collections` | Active collections (metadata) |
| POST | `/api/v1/collections` | Create a collection, optionally with a nested `items` tree (atomic) |
| GET | `/api/v1/collections/:id` | Collection with its active item tree |
| PUT | `/api/v1/collections/:id` | Save name/description only |
| DELETE | `/api/v1/collections/:id` | Move collection and its items to Trash |
| POST | `/api/v1/collections/:id/items` | Create a `folder` or `request` (optional `parentId`) |
| GET | `/api/v1/collections/:id/items/:itemId` | Read one item (folders include their subtree) |
| PUT | `/api/v1/collections/:id/items/:itemId` | Save one item's own fields; never rewrites the tree |
| DELETE | `/api/v1/collections/:id/items/:itemId` | Move item (and descendants) to Trash |
| GET/POST | `/api/v1/environments` | List / create environments |
| GET/PUT/DELETE | `/api/v1/environments/:id` | Read / save (replaces variables) / move to Trash |
| GET | `/api/v1/trash` | Restorable deleted roots (`kind`, `deletedAt`) |
| POST | `/api/v1/trash/:id/restore/check` | Read-only conflict report; accepts the same body as restore |
| POST | `/api/v1/trash/:id/restore` | Atomic subtree restore. Body: `{ "collectionName"?: string, "nameOverrides"?: { [itemId or environmentId]: newName } }` |
| GET | `/api/v1/events` | Server-Sent Events stream of value-free change notifications |

There is no permanent delete. Conflicts return `409` (`COLLECTION_NAME_CONFLICT`,
`FOLDER_NAME_CONFLICT`, `ENVIRONMENT_NAME_CONFLICT`, `RESTORE_CONFLICT`, `RESTORE_BLOCKED`); invalid input returns `400`
(`VALIDATION_ERROR`, `INVALID_PARENT`, `ITEM_TYPE_MISMATCH`, `INVALID_RESTORE_OVERRIDE`).

## Live change notifications (SSE)

`GET /api/v1/events` (`text/event-stream`) tells clients *that* something changed so they can
refetch it; it never carries data. A frame is emitted only after a create, update, move to
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
  `updated` | `trashed` | `restored`; `collectionId` is the owning collection for folders/requests and `null` for
  collections and environments. Payloads never include names, URLs, headers, query params, bodies or
  environment variable values. A subtree trash or restore emits one event for its root.
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
  per SQLite database; there is no cross-process or distributed fan-out.
- **Reverse proxy:** nginx buffers proxied responses by default. Its `/api` location must disable
  proxy buffering and use a long read timeout for SSE. If live updates stop while the API
  otherwise appears healthy, check nginx buffering/timeouts first.

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

The API does not currently enable Express proxy trust or consume forwarded client-IP headers.
Behind nginx, the remote address visible to the API is nginx's address. Before Slice 7 email
sign-in and per-IP rate limiting, explicitly design and implement trusted proxy/client-IP
handling; otherwise the limiter could treat all users as nginx and throttle them together.

Nginx must disable response buffering and allow a long read timeout for `/api` SSE responses.
If live updates fail while ordinary API requests and health checks still work, check nginx's
SSE buffering and timeout settings first—the API can remain healthy while the proxy hides or
delays the stream.

### Backup and restore

The database is a single SQLite file in WAL mode. For a live backup, use SQLite's online backup
API (for example `sqlite3 "$DATABASE_PATH" ".backup backup.sqlite"`), then verify the backup
with `PRAGMA integrity_check`. Do not copy only the `.sqlite` file while the API is running:
committed pages may still be in `-wal`, so such a copy can omit recent data or be inconsistent.
See [Deployment and operations](docs/deployment.md#sqlite-backup-and-restore) for a tested
backup and restore procedure.

### Migration caveat: case-folded name keys

Uniqueness checks compare a `name_key` column computed in JavaScript with
`name.normalize("NFC").toLowerCase()`, which is locale-independent Unicode. SQL migrations
cannot reproduce that: `0001_environment_name_unique` backfills `environments.name_key` with
SQLite's `lower()`, which folds **ASCII only**. On a database that already held environments,
that would give non-ASCII names (such as `ÄRGER` → `Ärger`) wrong keys, so `ärger` could be
created alongside it. Names that differ only in non-ASCII case would also slip past the new
unique index. (Names that differ only in ASCII case make the migration itself fail and roll
back.) No deployment data exists yet, so today this matters only for local databases.

Safeguards:

1. After migrations, startup (and `npm run db:migrate`) runs `reconcileNameKeys`
   (`src/db/nameKeys.ts`). In one transaction it recomputes every collection, item and
   environment `name_key` in JavaScript. If the corrected keys would make active names collide,
   it refuses to write anything and the process exits with the colliding IDs, rather than
   weakening uniqueness.
2. Safe upgrade path for any populated database:
   1. Stop the API and back up the database (see above).
   2. Preflight: run `npm run db:check-name-keys`. It is read-only, also works before `0001`
      is applied, and lists every group of active names that collide case-insensitively.
   3. Resolve each collision by renaming or trashing all but one entry (for example with
      `sqlite3` on the stopped database, or through the API on the old version). Repeat step 2
      until it exits `0`.
   4. Start the API (or run `npm run db:migrate`). Migrations and key reconciliation run, then
      step 2 reports no changes.
   5. If startup reports a `NameKeyCollisionError`, `0001` has already committed but keys are
      unchanged. Resolve the listed IDs and start again, or restore the backup.
3. Future migrations that add or change `name_key`-style columns must not rely on SQL
   `lower()`/`upper()`. Backfill a placeholder in SQL and leave the real value to
   `reconcileNameKeys`, which runs after every migration.

## Structure

- `src/app.ts` – `createApp()` factory (no network side effects; used by tests)
- `src/server.ts` – startup entry point (loads env, listens, graceful shutdown)
- `src/middleware/errorHandler.ts` – 404 + centralized JSON error handling
- `src/routes/` – `GET /health` and the `/api/v1` routers (HTTP + Zod parsing only), including the SSE endpoint
- `src/events/` – in-process change-event hub (publish after commit, replay buffer)
- `src/services/` – persistence/business rules with explicit transaction boundaries
- `src/validation/schemas.ts` – Zod request schemas
- `src/db/` – Drizzle schema, connection/migration helpers, name-key reconciliation, migrate/check CLIs
- `tests/unit`, `tests/integration` – Vitest and Supertest suites

Errors are returned as `{ "error": { "code", "message", "details?" } }`.
