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

## Configuration

Environment variables are validated with Zod in `src/config/env.ts`:

| Variable   | Default       | Notes                                  |
| ---------- | ------------- | -------------------------------------- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST`     | `0.0.0.0`     |                                        |
| `PORT`     | `3000`        | Integer 0–65535                        |

## Structure

- `src/app.ts` – `createApp()` factory (no network side effects; used by tests)
- `src/server.ts` – startup entry point (loads env, listens, graceful shutdown)
- `src/middleware/errorHandler.ts` – 404 + centralized JSON error handling
- `src/routes/health.ts` – `GET /health`
- `tests/unit`, `tests/integration` – Vitest and Supertest suites

Errors are returned as `{ "error": { "code", "message", "details?" } }`.
