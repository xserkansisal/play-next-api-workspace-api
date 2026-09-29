# Deployment and operations

## Deployment model and prerequisites

The supported deployment target is one on-premises VM on the organization's internal network.
The web app and API listen on separate HTTP addresses/ports; there is no reverse proxy in this
deployment. Set `CORS_ORIGIN` to the exact web origin (scheme, hostname, and port, with no path).
TLS is intentionally not used for this scoped internal deployment, which has no credentials in
transit. Revisit this decision before adding sign-in or exposing either service beyond the
internal network.

Requirements:

- Node.js **22.12 or later** and npm.
- PM2 installed for the deployment account (`npm install --global pm2`).
- A persistent writable data directory outside the application checkout, with enough space for
  the SQLite database and backups. Keep it across releases/redeploys; do not put `DATABASE_PATH`
  under the deployment directory.

The repository's `engines` field allows Node >=22.12. `better-sqlite3` is pinned to 12.11.1:
version 13.0.3 segfaulted on the development machine's Node 23.5 runtime. The package override
for drizzle-kit's nested esbuild dependency is also intentional.

## Install and build

From the checked-out release directory:

```sh
npm ci
npm run build
mkdir -p "$HOME/.pm2/logs"
```

Choose a persistent path appropriate for the VM and deployment account (for example a dedicated
directory under `/var/lib`, owned by that account). Do not blindly use that example path; the VM
and filesystem layout are not prescribed here. Create the directory before migration/startup.

## Configure environment and migrate

Export the production settings in the shell or service-management environment used to invoke
PM2. The ecosystem file requires `PORT`, `DATABASE_PATH`, and `CORS_ORIGIN`; it defaults `HOST`
to `0.0.0.0`, `SSE_HEARTBEAT_MS` to `15000`, and `SSE_RETRY_MS` to `3000`.

```sh
export NODE_ENV=production
export HOST=0.0.0.0
export PORT=3000                       # choose an unused internal port
export DATABASE_PATH=/persistent/path/api.sqlite  # choose a persistent path outside this checkout
export CORS_ORIGIN=http://web-vm:5173  # exact web origin; replace with the real internal origin
export SSE_HEARTBEAT_MS=15000
export SSE_RETRY_MS=3000
```

The sample values are not machine-specific configuration; replace the web origin, port, and
persistent path for the VM. The frontend must use the corresponding API HTTP address and port.
CORS is exact-origin and does not enable credentialed requests.

Before upgrading a populated database, stop the API and take a verified backup using the
procedure below. Run the read-only name-key preflight:

```sh
npm run db:check-name-keys
```

If it reports collisions, rename or trash all but one active name in each reported group using
the old API version, then rerun the check until it exits successfully. The safe upgrade path and
reason for this check are documented in the README's
[case-folded name-key migration caveat](../README.md#migration-caveat-case-folded-name-keys).
Migration `0001` backfills with SQLite `lower()` (ASCII-only); startup and `db:migrate`
recompute Unicode name keys in JavaScript and refuse to write if corrected active names collide.

Apply pending migrations explicitly before starting the new release:

```sh
npm run db:migrate
```

The server also applies pending migrations on startup. The explicit command makes migration
failures visible before PM2 starts the service.

## Run with PM2

The repository includes `ecosystem.config.cjs`. It launches the built `dist/server.js`, writes
stdout and stderr to `$PM2_LOG_DIR` (or PM2's standard log directory under the deployment
account's home), restarts on process failure with a delay and bounded rapid-restart attempts,
and gives graceful shutdown 15 seconds.

**Do not change this app to cluster mode or increase `instances`.** Its SSE change-event hub and
replay history are process-local, and the SQLite service assumes a single writable API process.
Multiple PM2 workers would split events and violate that single-writer deployment assumption.

Start and inspect the service:

```sh
PORT="$PORT" DATABASE_PATH="$DATABASE_PATH" CORS_ORIGIN="$CORS_ORIGIN" \
  HOST="$HOST" SSE_HEARTBEAT_MS="$SSE_HEARTBEAT_MS" SSE_RETRY_MS="$SSE_RETRY_MS" \
  pm2 start ecosystem.config.cjs --only play-next-api
pm2 status
pm2 logs play-next-api
```

PM2 sends `SIGINT` when stopping/restarting the process. The API closes the in-memory event hub
first (ending every SSE response), then closes the HTTP server and SQLite connection. A client
will reconnect after restart; since the hub's epoch and 1000-event replay buffer are in memory,
the new process reports unavailable replay history and the client should resync.

After verifying the process and endpoints, persist the PM2 process list and configure PM2's
startup integration for the deployment account:

```sh
pm2 save
pm2 startup
```

Run the exact command printed by `pm2 startup` with the required elevated privileges, then
reboot during an approved maintenance window and verify `pm2 status`, logs, `/health`, and
`/api/v1/events`. `pm2 save` alone does not install the boot-time integration. Re-run `pm2 save`
after intentional process-list changes. Reboot persistence must be validated on the target VM.

## SQLite backup and restore

SQLite runs in WAL mode. While the API is active, committed changes may reside in the `-wal`
sidecar instead of the main `.sqlite` file. Copying only the main file during operation can
silently omit committed writes and can produce an inconsistent backup; copying a live main file
without its matching WAL/SHM files is not a valid backup procedure. Use SQLite's online backup
instead.

### Online backup while the API is running

Set `DATABASE_PATH` and choose a unique backup destination on persistent storage with sufficient
space. The destination should not be the live database path:

```sh
set -eu
BACKUP_PATH=/persistent/backups/api-$(date -u +%Y%m%dT%H%M%SZ).sqlite
mkdir -p "$(dirname "$BACKUP_PATH")"
sqlite3 "$DATABASE_PATH" ".backup '$BACKUP_PATH'"
test "$(sqlite3 "$BACKUP_PATH" 'PRAGMA integrity_check;')" = "ok"
```

The SQLite shell `.backup` command uses SQLite's online backup API and produces a self-contained,
consistent snapshot, including committed pages currently represented in the WAL. Run the
integrity check before considering the backup usable. Protect backups with the same access
controls as the live database, and define retention/restore testing appropriate to the
organization.

### Restore to a fresh path

1. Stop the API with `pm2 stop play-next-api` and verify it is stopped. Do not replace an open
   database.
2. Verify the selected backup:

   ```sh
   test "$(sqlite3 "$BACKUP_PATH" 'PRAGMA integrity_check;')" = "ok"
   ```

3. Restore through SQLite into a new file path. Ensure the destination does not already exist,
   then create its parent directory:

   ```sh
   RESTORE_PATH=/persistent/path/api-restored.sqlite
   test ! -e "$RESTORE_PATH"
   mkdir -p "$(dirname "$RESTORE_PATH")"
   sqlite3 "$RESTORE_PATH" ".restore '$BACKUP_PATH'"
   test "$(sqlite3 "$RESTORE_PATH" 'PRAGMA integrity_check;')" = "ok"
   ```

4. Set `DATABASE_PATH` to the restored path, run `npm run db:migrate`, then start the service
   with PM2 and verify the expected collections/environments through the API.

If copying files is unavoidable, stop the API cleanly first and preserve the database plus its
matching `-wal`/`-shm` sidecars as one stopped snapshot. Never copy only the `.sqlite` while it
is live. A naive copy can lose committed transactions still in the WAL; an inconsistent set of
main/WAL/SHM files can also fail integrity checks or make recovery impossible. Keep the original
files untouched until the restored database has passed integrity checks and application-level
verification.
