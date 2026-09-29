import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { closeDatabase, openDatabase } from "./db/client.js";

const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH, { migrate: true });
const app = createApp({ env, db });

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV}), database ${env.DATABASE_PATH}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}, shutting down`);
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
