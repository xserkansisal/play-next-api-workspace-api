import { loadEnv } from "../config/env.js";
import { closeDatabase, openDatabase } from "./client.js";
import { inspectNameKeys } from "./nameKeys.js";

// Read-only report (also usable as a preflight before migrations); never modifies data.
const env = loadEnv();
const db = openDatabase(env.DATABASE_PATH, { migrate: false });
try {
  const report = inspectNameKeys(db);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.collisions.length > 0 ? 1 : 0;
} finally {
  closeDatabase(db);
}
