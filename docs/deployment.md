# Deployment and operations

## Deployment model and prerequisites

The supported deployment target is one on-premises VM on the organization's internal network.
Nginx serves the web build and reverse-proxies `/api` to the PM2-managed API. The browser sees a
single origin, so CORS is not needed for normal operation. `CORS_ORIGIN` is only relevant when
accessing the API port directly from a browser or when developing against Vite.

When nginx runs on the API VM, bind the API to `127.0.0.1` so the service port is not exposed to
other machines. The API's `HOST` setting is configurable; while the application default is
`0.0.0.0`, the PM2 ecosystem config defaults to loopback. Verify the bound address and port
(for example, `ss -ltnp`) and verify nginx's upstream points to that same local address and
configured port. Do not open the API port to the network.

TLS is intentionally not used for this scoped internal deployment. With email sign-in, codes and
session cookies travel over plain HTTP and are observable to anyone able to capture internal
network traffic; this is a deliberate but security-relevant tradeoff, not protection for
credentials in transit. Keep the services internal-only and revisit TLS plus
`AUTH_COOKIE_SECURE=true` before any exposure beyond the internal network.

Requirements:

- Node.js **22.12 or later** and npm.
- PM2 installed for the deployment account (`npm install --global pm2`).
- A persistent writable data directory outside the application checkout, with enough space for
  the SQLite database and backups. Keep it across releases/redeploys; do not put `DATABASE_PATH`
  under the deployment directory.

The repository's `engines` field allows Node >=22.12. `better-sqlite3` is pinned to 12.11.1:
version 13.0.3 segfaulted on the development machine's Node 23.5 runtime. The package override
for drizzle-kit's nested esbuild dependency is also intentional.

The API accepts JSON request bodies up to 50 MiB (50 × 1024 × 1024 bytes), including atomic
nested collection imports. This limit must be matched by any reverse proxy in front of the API.
Individual request-body `content` remains limited to 1,000,000 characters, and imported folder
trees may be at most 32 levels deep.

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
PM2. The ecosystem file requires `PORT`, `DATABASE_PATH`, and `AUTH_CODE_PEPPER`; production
environment validation also requires `SMTP_HOST` and `SMTP_FROM`. It defaults `HOST` to
`127.0.0.1`, `SSE_HEARTBEAT_MS` to `15000`, `SSE_RETRY_MS` to `3000`, the code lifetime to
900 seconds, the code-attempt limit to 5, request/verify rate limits to 3/10 per 900 seconds,
session lifetime to 2,592,000 seconds, and cookie Secure to false. Set `CORS_ORIGIN` only for
direct browser access or Vite development; credentialed CORS is restricted to that exact origin.

```sh
export NODE_ENV=production
export HOST=127.0.0.1                  # nginx connects locally; keep the API port off the network
export PORT=3000                       # choose an unused local port
export DATABASE_PATH=/persistent/path/api.sqlite  # choose a persistent path outside this checkout
# Optional only for direct browser access or Vite development:
# export CORS_ORIGIN=http://localhost:5173
export SSE_HEARTBEAT_MS=15000
export SSE_RETRY_MS=3000
export AUTH_CODE_PEPPER=          # generate once, paste the result here - see "Sign-in code pepper" below
export AUTH_CODE_TTL_SECONDS=900
export AUTH_CODE_MAX_ATTEMPTS=5
export AUTH_CODE_REQUEST_LIMIT=3
export AUTH_CODE_REQUEST_WINDOW_SECONDS=900
export AUTH_CODE_VERIFY_LIMIT=10
export AUTH_CODE_VERIFY_WINDOW_SECONDS=900
export AUTH_SESSION_TTL_SECONDS=2592000
export AUTH_COOKIE_NAME=play_next_session
export AUTH_COOKIE_SECURE=false
export SMTP_HOST=smtp.internal.example
export SMTP_PORT=587
export SMTP_SECURE=false
# Set both or neither:
export SMTP_USER=
export SMTP_PASSWORD=
export SMTP_FROM=play-next@example.internal
# Server-side request execution, used by "Send from: Server" for targets that send no CORS
# headers. Off unless set. Name the hosts as "host" or "host:port", comma separated; "*" removes
# the allow-list entirely and makes this an open proxy for every signed-in user.
export PROXY_ALLOWED_HOSTS=10.29.125.148:7799
```

The sample values are not machine-specific configuration; choose an unused port and persistent
path for the VM. The web browser uses nginx's origin; nginx's `/api` upstream uses the loopback
API address and port. The API's CORS middleware permits only the exact configured origin and
enables credentials for that origin only. Do not set `CORS_ORIGIN` for the normal same-origin
nginx deployment.

The SMTP settings above are examples, not verified organizational settings. Production requires
`SMTP_HOST` and `SMTP_FROM`; `SMTP_USER` and `SMTP_PASSWORD` must be supplied together when the
relay requires authentication. Do not place secrets in checked-in files or command history.

### Keeping the settings in a file on the server

Typing the exports by hand puts the pepper and the SMTP password into shell history, and they are
lost on the next login. Keep them in one file instead, owned by the deployment account and
readable only by it:

```sh
sudo install -o "$USER" -g "$(id -gn)" -m 600 /dev/null /etc/play-next-api.env
# edit /etc/play-next-api.env, then before starting PM2:
set -a; . /etc/play-next-api.env; set +a
pm2 start ecosystem.config.cjs --only play-next-api
```

Two things about that file decide whether the deployment works, and neither announces itself:

**Quote any value containing `#`.** Everything from an unquoted `#` onwards is discarded as a
comment. `SMTP_PASSWORD=s3cret#with-hash` reaches the relay as `s3cret`, which the relay answers
with a plain authentication failure - nothing points at the file. Verified against a real SMTP
server: the relay logged the password it received as `"s3cret"`. Write `SMTP_PASSWORD='s3cret#with-hash'`
and run `npm run mail:check`, which catches this before a user does.

**A variable already set in the environment wins over the file.** Node's `--env-file` and the
shell both leave an existing value alone, so a stale `export` in `.bashrc` or a value baked into
the PM2 process list silently overrides what the file says. After editing the file, restart with
`pm2 restart play-next-api --update-env`; without `--update-env` PM2 reuses the environment it
captured when the process was first started.

`npm start` also reads a `.env` in the repository root, which is convenient for a quick check but
is not the deployment path: it is inside the checkout, so it is easy to overwrite on the next
deploy. Prefer the file outside the checkout.

The variables this API reads are listed in `.env.example`. `tests/unit/ecosystem.test.ts` checks
the PM2 ecosystem file forwards every one of them, because a setting that is exported but not
forwarded produces no error - the API just runs on the default. That is exactly how the
server-side proxy came to be disabled under PM2 while `PROXY_ALLOWED_HOSTS` was exported.

`SMTP_SECURE` is the setting most often wrong: it means implicit TLS from the first byte, which is
port `465`. On `587` it must stay `false`, because that port starts in the clear and upgrades
through STARTTLS - setting it true there produces a connection that hangs or fails rather than a
message saying the port was wrong.

Verify the relay before anyone depends on it, from the VM and with the same environment the API
will run with:

```sh
npm run mail:check
```

It connects and authenticates without sending, and exits non-zero with the underlying reason on
failure. A pass rules out an unreachable host, a wrong TLS mode and rejected credentials; it does
not prove mail is delivered, because relaying rules, SPF/DMARC and recipient filtering all apply
after this point. Follow it with one real sign-in to an address in an allowed domain
(`fluttersea.com`, `sisal.com`, `sisal.it`).

If a sign-in code cannot be delivered, the caller receives `503 AUTH_DELIVERY_FAILED` with no
reason - disclosing it would reveal that the address is eligible. The reason is written to the
server log, so check PM2's log for the API when users report that codes never arrive.

Sign-in codes are six digits, single-use, hashed with `AUTH_CODE_PEPPER`, valid for 15 minutes
by default, and invalidated after five failed attempts. Request and verification limits are
configured per normalized email, not per IP. The application does not trust `X-Forwarded-For`.
Sessions last one month by default, are revocable server-side, and are issued in
`HttpOnly; SameSite=Lax` cookies. `AUTH_COOKIE_SECURE=false` is necessary for the current
plain-HTTP deployment; setting it true before HTTPS would prevent browsers from sending the
cookie. Because this deployment has no TLS, sign-in codes and session cookies are visible to
network observers on the internal network. Do not extend access beyond that network without
revisiting TLS.

In development/tests the default sender holds the latest code in memory and never sends/logs it.
For local manual development, optionally set `AUTH_DEV_INBOX_TOKEN` to a random value of at
least 32 characters; the development-only route `GET /api/v1/auth/dev-inbox?email=...` reveals
the current code only when the token is supplied in `X-Dev-Inbox-Token` **and** the caller is
connected directly. A request relayed through a proxy is refused: behind nginx every caller's
address is nginx's own, so an address check alone would admit the whole network. Never enable
this in production, and do not assume nginx makes it safe in development either.

### Sign-in code pepper

`AUTH_CODE_PEPPER` is the HMAC key the API signs sign-in codes with before storing them. Only
the hash is ever written to the database.

It exists because a sign-in code is six digits - one million possibilities. Whoever steals the
database also gets the challenge id each hash was bound to, so with a plain hash they can simply
try every code and read off the match. Measured on the deployment laptop: exhausting the whole
six-digit space against an unpeppered hash recovered the code in **213 ms**. The same exhaustive
search against a peppered hash found nothing, because the key it needs is in the environment and
not in the file that was stolen. That is the entire job of this value, and it only works while
the pepper is secret and separate from the database.

Session cookies deliberately do not use it. A session token is 256 random bits, so there is
nothing to exhaust, and it is stored as a plain SHA-256 digest.

Generate one per environment - never reuse staging's in production:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Put the result in the environment or the PM2 ecosystem file, the same place as the SMTP
password. Never commit it. Production refuses to start on any value this repository has
printed as an example, and on a long value typed by repeating one character - 32 characters of
`a` is a length, not a secret.

Rotating it is cheap, which makes it a usable response to a suspected leak. This was measured,
not assumed, by booting the app twice over one database with different peppers: **existing
sessions stayed signed in**, codes **already in flight were rejected**, and newly requested
codes worked. So a rotation logs nobody out; it only means anyone mid-sign-in requests another
code. `tests/integration/auth.test.ts` locks this behaviour in.

Note that with no TLS in front of the API, the code itself still travels in plain text over the
internal network. The pepper protects a stolen database, not the wire.

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
PORT="$PORT" DATABASE_PATH="$DATABASE_PATH" HOST="$HOST" \
  SSE_HEARTBEAT_MS="$SSE_HEARTBEAT_MS" SSE_RETRY_MS="$SSE_RETRY_MS" \
  pm2 start ecosystem.config.cjs --only play-next-api
pm2 status
pm2 logs play-next-api
```

Do not set `CORS_ORIGIN` for the regular nginx/same-origin deployment. When testing direct
browser access or using Vite, provide the exact origin in PM2's environment and restart/update
the PM2 process environment accordingly.

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

## Reverse-proxy considerations

The nginx web configuration is maintained with the web deployment, not by this API. Its `/api`
location must proxy to the API's loopback address and `PORT`, preserve the SSE response as a
stream, set `proxy_buffering off`, and allow a long `proxy_read_timeout`. Nginx buffers proxied
responses by default; incorrect buffering or a short read timeout is the most likely reason
live updates stop while API health checks continue to pass. Treat this as a proxy issue first
when ordinary API calls work but SSE notifications do not arrive.

The API does not trust proxy headers or resolve the original client address from
`X-Forwarded-For`. Behind nginx, it sees nginx's address as the peer. Per-IP rate limiting is
not implemented; if added, first design a trusted-proxy boundary and client-IP policy. Blindly
trusting arbitrary forwarded headers could let clients spoof their source address.

There is one place where the peer address is consulted, and it is worth knowing why it is not a
counter-example: the development-only dev-inbox route. Because a proxy makes every caller look
local, that route treats the presence of any forwarding header as proof the request was relayed
and refuses it. That is the one safe direction to read an untrusted header in - it can only close
the route, never open it - and it is not a basis for trusting these headers anywhere else.

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
