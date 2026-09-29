import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, MIGRATIONS_FOLDER, openDatabase, type AppDatabase } from "../../src/db/client.js";
import { inspectNameKeys, NameKeyCollisionError, reconcileNameKeys } from "../../src/db/nameKeys.js";

const dirs: string[] = [];
const dbs: AppDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) closeDatabase(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Opens a file database migrated only through 0000_init (the pre-0001 schema). */
function openAtInitMigration(): { db: AppDatabase; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "name-keys-"));
  dirs.push(dir);
  const folder = join(dir, "migrations");
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((e: { tag: string }) => e.tag === "0000_init");
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(dir, "api.db");
  const db = openDatabase(path, { migrate: false });
  migrate(db, { migrationsFolder: folder });
  return { db, path };
}

const now = "2026-01-01T00:00:00.000Z";

function insertEnvironment(db: AppDatabase, id: string, name: string, deletedAt: string | null = null) {
  db.$client
    .prepare("INSERT INTO environments (id, name, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, now, now, deletedAt);
}

function environmentKeys(db: AppDatabase) {
  return db.$client.prepare("SELECT id, name_key FROM environments ORDER BY id").all();
}

describe("name key reconciliation", () => {
  it("repairs the ASCII-only lower() backfill of migration 0001 on upgrade", () => {
    const { db, path } = openAtInitMigration();
    insertEnvironment(db, "e1", "ÄRGER");
    insertEnvironment(db, "e2", "Staging");
    closeDatabase(db);

    const upgraded = openDatabase(path);
    dbs.push(upgraded);
    expect(environmentKeys(upgraded)).toEqual([
      { id: "e1", name_key: "ärger" },
      { id: "e2", name_key: "staging" },
    ]);
    expect(inspectNameKeys(upgraded)).toEqual({ changes: [], collisions: [] });
  });

  it("preflight reports Unicode-only collisions before 0001 exists, and upgrade refuses without writing", () => {
    const { db, path } = openAtInitMigration();
    insertEnvironment(db, "e1", "ÄRGER");
    insertEnvironment(db, "e2", "ärger");
    insertEnvironment(db, "e3", "ÄrGeR", now); // trashed rows never collide
    const report = inspectNameKeys(db);
    expect(report.collisions).toEqual([{ table: "environments", scope: "global", nameKey: "ärger", ids: ["e1", "e2"] }]);
    expect(report.changes.every((c) => c.from === null)).toBe(true);
    closeDatabase(db);

    expect(() => openDatabase(path)).toThrow(NameKeyCollisionError);

    // Migration 0001 committed, reconciliation wrote nothing; resolve the collision and reopen.
    const raw = openDatabase(path, { migrate: false });
    expect(environmentKeys(raw)).toEqual([
      { id: "e1", name_key: "Ärger" },
      { id: "e2", name_key: "ärger" },
      { id: "e3", name_key: "Ärger" },
    ]);
    raw.$client.prepare("UPDATE environments SET name = 'ÄRGER (2)' WHERE id = 'e1'").run();
    closeDatabase(raw);

    const fixed = openDatabase(path);
    dbs.push(fixed);
    expect(environmentKeys(fixed)).toEqual([
      { id: "e1", name_key: "ärger (2)" },
      { id: "e2", name_key: "ärger" },
      { id: "e3", name_key: "ärger" },
    ]);
  });

  it("reconciles collections and folders with scoped uniqueness; requests may share names", () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const run = (sql: string, ...args: unknown[]) => db.$client.prepare(sql).run(...args);
    run("INSERT INTO collections (id, name, name_key, created_at, updated_at) VALUES ('c1', 'ÉTÉ', 'Été', ?, ?)", now, now);
    const item = (id: string, kind: string, name: string, key: string, parent: string | null = null) =>
      run(
        "INSERT INTO items (id, collection_id, parent_id, kind, name, name_key, created_at, updated_at) VALUES (?, 'c1', ?, ?, ?, ?, ?, ?)",
        id, parent, kind, name, key, now, now,
      );
    item("f1", "folder", "ÜBER", "Über");
    item("f2", "folder", "über", "über", "f1"); // different parent: no collision
    item("r1", "request", "ÜBER", "Über");
    item("r2", "request", "über", "über"); // requests may duplicate names

    const report = reconcileNameKeys(db);
    expect(report.collisions).toEqual([]);
    expect(report.changes.map((c) => c.id).sort()).toEqual(["c1", "f1", "r1"]);
    expect(db.$client.prepare("SELECT name_key FROM collections").pluck().get()).toBe("été");
    expect(db.$client.prepare("SELECT name_key FROM items WHERE id = 'f1'").pluck().get()).toBe("über");
    expect(inspectNameKeys(db).changes).toEqual([]);

    item("f3", "folder", "Über", "Über");
    expect(() => reconcileNameKeys(db)).toThrow(NameKeyCollisionError);
    expect(db.$client.prepare("SELECT name_key FROM items WHERE id = 'f3'").pluck().get()).toBe("Über");
  });
});
