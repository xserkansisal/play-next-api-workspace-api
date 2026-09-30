import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { closeDatabase, openDatabase } from "./db/client.js";
import { ChangeEventHub } from "./events/hub.js";
import { allowsAnyHost, parseAllowedHosts } from "./services/proxy.js";
import { allowsAnyOrigin } from "./middleware/cors.js";

const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH, { migrate: true });
// Single writable process: change events are fanned out in memory only.
const events = new ChangeEventHub();
const app = createApp({ env, db, events });

// Announced, not left quiet: with "*" there is no allow-list, so any signed-in user can make this
// process reach any host it can reach, including anything bound to loopback on this machine.
if (allowsAnyHost(parseAllowedHosts(env.PROXY_ALLOWED_HOSTS))) {
  console.warn(
    'WARNING: PROXY_ALLOWED_HOSTS is "*", so /api/v1/proxy will send requests to any host. ' +
      "This is an open proxy for every signed-in user. Use it only on a trusted machine.",
  );
}

// Announced for the same reason: with "*" any web page the user visits can call this API with
// their session cookie attached, so a hostile page could act as them.
if (allowsAnyOrigin(env.CORS_ORIGIN)) {
  console.warn(
    'WARNING: CORS_ORIGIN is "*", so any website may call this API with the signed-in user\'s ' +
      "cookie. Use it only on a trusted machine.",
  );
}

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV}), database ${env.DATABASE_PATH}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down`);
  // End long-lived SSE streams so server.close() can finish.
  events.close();
  server.close((err) => {
    closeDatabase(db);
    if (err) {
      console.error(err);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
