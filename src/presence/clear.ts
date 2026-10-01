import { closeDatabase, openDatabase } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { clearPresenceTestUsers } from "./seedData.js";

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === "production") throw new Error("Presence test users cannot be removed in production");
  const db = await openDatabase(env);
  try {
    const count = await clearPresenceTestUsers(db);
    console.log(`Removed ${count} database-backed presence test users.`);
  } finally {
    await closeDatabase(db);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
