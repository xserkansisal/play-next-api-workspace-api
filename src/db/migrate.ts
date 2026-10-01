import { loadEnv } from "../config/env.js";
import { closeDatabase, openDatabase } from "./client.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const db = await openDatabase(env, { migrate: true });
  await closeDatabase(db);
  console.log(`Migrations applied to MySQL database ${env.MYSQL_DATABASE}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
