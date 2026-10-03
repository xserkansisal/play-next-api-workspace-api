import { fileURLToPath } from "node:url";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import type { Env } from "../config/env.js";
import { migrateEnvironmentValues } from "./environmentValueMigration.js";
import * as schema from "./schema.js";

export type AppDatabase = MySql2Database<typeof schema> & { $client: Pool };

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle-mysql", import.meta.url));

export interface OpenDatabaseOptions {
  migrate?: boolean;
}

function assertSupportedServer(version: string, collation: string): void {
  const parsed = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (
    version.includes("MariaDB") ||
    !parsed ||
    Number(parsed[1]) < 8 ||
    (Number(parsed[1]) === 8 && Number(parsed[2]) === 0 && Number(parsed[3]) < 16)
  ) {
    throw new Error(`MySQL 8.0.16 or newer is required; connected server reports ${version}`);
  }
  if (collation !== "utf8mb4_0900_bin") {
    throw new Error(
      `Database ${collation || "(unknown)"} collation is unsupported; create ${process.env.MYSQL_DATABASE ?? "the database"} with utf8mb4_0900_bin (exact, case-sensitive text comparisons)`,
    );
  }
}

export async function openDatabase(env: Env, options: OpenDatabaseOptions = {}): Promise<AppDatabase> {
  const pool = createPool({
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    database: env.MYSQL_DATABASE,
    charset: "utf8mb4",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT VERSION() AS version, @@collation_database AS collation",
    );
    const server = rows[0];
    if (!server || typeof server.version !== "string" || typeof server.collation !== "string") {
      throw new Error("MySQL did not return its server version and database collation");
    }
    assertSupportedServer(server.version, server.collation);

    const db = drizzle(pool, { schema, mode: "default" }) as AppDatabase;
    if (options.migrate ?? true) await runMigrations(db, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export async function runMigrations(db: AppDatabase, encryptionKey: string, previousKey?: string): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await migrateEnvironmentValues(db, encryptionKey, previousKey);
}

export async function closeDatabase(db: AppDatabase): Promise<void> {
  await db.$client.end();
}
