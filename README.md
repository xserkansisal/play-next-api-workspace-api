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

## Configuration

Environment variables are validated with Zod in `src/config/env.ts`:

| Variable   | Default       | Notes                                  |
| ---------- | ------------- | -------------------------------------- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST`     | `0.0.0.0`     |                                        |
| `PORT`     | `3000`        | Integer 0–65535                        |
| `DATABASE_PATH` | `./data/api.sqlite` | SQLite file; parent directory is created if missing |

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
folder names (request names may repeat).

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
| POST | `/api/v1/trash/:id/restore` | Atomic subtree restore. Body: `{ "collectionName"?: string, "nameOverrides"?: { [itemId]: newName } }` |

There is no permanent delete. Conflicts return `409` (`COLLECTION_NAME_CONFLICT`,
`FOLDER_NAME_CONFLICT`, `RESTORE_CONFLICT`, `RESTORE_BLOCKED`); invalid input returns `400`
(`VALIDATION_ERROR`, `INVALID_PARENT`, `ITEM_TYPE_MISMATCH`, `INVALID_RESTORE_OVERRIDE`).

## Structure

- `src/app.ts` – `createApp()` factory (no network side effects; used by tests)
- `src/server.ts` – startup entry point (loads env, listens, graceful shutdown)
- `src/middleware/errorHandler.ts` – 404 + centralized JSON error handling
- `src/routes/` – `GET /health` and the `/api/v1` routers (HTTP + Zod parsing only)
- `src/services/` – persistence/business rules with explicit transaction boundaries
- `src/validation/schemas.ts` – Zod request schemas
- `src/db/` – Drizzle schema, connection/migration helpers, migrate CLI
- `tests/unit`, `tests/integration` – Vitest and Supertest suites

Errors are returned as `{ "error": { "code", "message", "details?" } }`.
