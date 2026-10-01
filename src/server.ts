import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { closeDatabase, openDatabase } from "./db/client.js";
import { ChangeEventHub } from "./events/hub.js";
import { allowsAnyHost, parseAllowedHosts } from "./services/proxy.js";
import { allowsAnyOrigin } from "./middleware/cors.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = await openDatabase(env, { migrate: true });
  // Single writable process: change events are fanned out in memory only.
  const events = new ChangeEventHub();
  const app = createApp({ env, db, events });

  if (allowsAnyHost(parseAllowedHosts(env.PROXY_ALLOWED_HOSTS))) {
    console.warn(
      'WARNING: PROXY_ALLOWED_HOSTS is "*", so /api/v1/proxy will send requests to any host. ' +
        "This is an open proxy for every signed-in user. Use it only on a trusted machine.",
    );
  }
  if (allowsAnyOrigin(env.CORS_ORIGIN)) {
    console.warn(
      'WARNING: CORS_ORIGIN is "*", so any website may call this API with the signed-in user\'s ' +
        "cookie. Use it only on a trusted machine.",
    );
  }

  const server = app.listen(env.PORT, env.HOST, () => {
    console.log(`API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV}), MySQL database ${env.MYSQL_DATABASE}`);
  });

  function shutdown(signal: NodeJS.Signals): void {
    console.log(`Received ${signal}, shutting down`);
    events.close();
    server.close((err) => {
      void closeDatabase(db).then(() => {
        if (err) {
          console.error(err);
          process.exit(1);
        }
        process.exit(0);
      }).catch((closeError: unknown) => {
        console.error(closeError);
        process.exit(1);
      });
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("API failed to start:", err);
  process.exitCode = 1;
});
