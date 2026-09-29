import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../../src/db/client.js";

function statements(file: string): string[] {
  return readFileSync(join(MIGRATIONS_FOLDER, file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("0001_environment_name_unique migration", () => {
  it("backfills name_key for existing environments", () => {
    const sqlite = new Database(":memory:");
    try {
      for (const stmt of statements("0000_init.sql")) sqlite.exec(stmt);
      sqlite
        .prepare("INSERT INTO environments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .run("e1", "Staging", "t", "t");
      for (const stmt of statements("0001_environment_name_unique.sql")) sqlite.exec(stmt);
      expect(sqlite.prepare("SELECT name_key FROM environments WHERE id = 'e1'").pluck().get()).toBe("staging");
    } finally {
      sqlite.close();
    }
  });
});
