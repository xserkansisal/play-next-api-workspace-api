import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { reconcileNameKeys } from "./nameKeys.js";
import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// Resolves to <repo>/drizzle from both src/db (tsx) and dist/db (compiled).
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface OpenDatabaseOptions {
  migrate?: boolean;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): AppDatabase {
  if (path !== ":memory:" && !path.startsWith("file:")) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (path !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  const db = drizzle(sqlite, { schema }) as AppDatabase;
  if (options.migrate ?? true) {
    try {
      runMigrations(db);
    } catch (err) {
      sqlite.close();
      throw err;
    }
  }
  return db;
}

/** Applies pending migrations, then repairs name keys that SQL backfills could not fold correctly. */
export function runMigrations(db: AppDatabase): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  reconcileNameKeys(db);
}

export function closeDatabase(db: AppDatabase): void {
  db.$client.close();
}
