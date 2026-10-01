import { closeDatabase, openDatabase } from "../db/client.js";
import { loadEnv } from "../config/env.js";
import { seedPresenceTestUsers } from "./seedData.js";

async function main(): Promise<void> {
  const env = loadEnv();
  if (env.NODE_ENV === "production") throw new Error("Presence test users cannot be seeded in production");
  const db = await openDatabase(env);
  try {
    const count = await seedPresenceTestUsers(db);
    console.log(`Prepared ${count} database-backed presence test users with random active locations.`);
  } finally {
    await closeDatabase(db);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
