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

  describe("0002_slice7_auth_attribution migration", () => {
    it("preserves pre-auth rows with NULL attribution rather than inventing a user", () => {
      const sqlite = new Database(":memory:");
      try {
        sqlite.pragma("foreign_keys = ON");
        for (const stmt of statements("0000_init.sql")) sqlite.exec(stmt);
        for (const stmt of statements("0001_environment_name_unique.sql")) sqlite.exec(stmt);
        sqlite
          .prepare(
            "INSERT INTO collections (id, name, name_key, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("legacy", "Legacy", "legacy", "", "t", "t");
        for (const stmt of statements("0002_slice7_auth_attribution.sql")) sqlite.exec(stmt);
        const row = sqlite.prepare("SELECT created_by, updated_by FROM collections WHERE id = 'legacy'").get() as {
          created_by: string | null;
          updated_by: string | null;
        };
        expect(row).toEqual({ created_by: null, updated_by: null });
      } finally {
        sqlite.close();
      }
    });
  });
});
