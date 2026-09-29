import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type AppDatabase } from "../../src/db/client.js";

let db: AppDatabase;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => closeDatabase(db));

const now = "2026-01-01T00:00:00.000Z";

function insertCollection(id: string, nameKey: string, deletedAt: string | null = null) {
  db.$client
    .prepare("INSERT INTO collections (id, name, name_key, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, nameKey, nameKey, now, now, deletedAt);
}

function insertItem(id: string, collectionId: string, parentId: string | null, kind: string, nameKey: string, deletedAt: string | null = null) {
  db.$client
    .prepare(
      "INSERT INTO items (id, collection_id, parent_id, kind, name, name_key, created_at, updated_at, deleted_at, trash_root_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, collectionId, parentId, kind, nameKey, nameKey, now, now, deletedAt, deletedAt ? id : null);
}

describe("database schema constraints", () => {
  it("enables foreign keys and applies migrations idempotently", () => {
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    const tables = db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
    expect(tables).toEqual(
      expect.arrayContaining(["collections", "items", "request_details", "request_query_params", "request_headers", "environments", "environment_variables"]),
    );
  });

  it("enforces unique active collection names only among active rows", () => {
    insertCollection("c1", "orders");
    expect(() => insertCollection("c2", "orders")).toThrow(/UNIQUE/);
    insertCollection("c3", "orders", now);
  });

  it("enforces unique active environment names only among active rows", () => {
    const insert = db.$client.prepare(
      "INSERT INTO environments (id, name, name_key, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("e1", "Dev", "dev", now, now, null);
    expect(() => insert.run("e2", "DEV", "dev", now, now, null)).toThrow(/UNIQUE/);
    insert.run("e3", "dev", "dev", now, now, now);
  });

  it("enforces unique active sibling folder names, including at the root", () => {
    insertCollection("c1", "c");
    insertItem("f1", "c1", null, "folder", "shared");
    expect(() => insertItem("f2", "c1", null, "folder", "shared")).toThrow(/UNIQUE/);
    insertItem("r1", "c1", null, "request", "shared");
    insertItem("f3", "c1", null, "folder", "shared", now);
    insertItem("f4", "c1", "f1", "folder", "shared");
  });

  it("requires parents to exist in the same collection", () => {
    insertCollection("c1", "a");
    insertCollection("c2", "b");
    insertItem("f1", "c1", null, "folder", "f");
    expect(() => insertItem("x", "c2", "f1", "folder", "x")).toThrow(/FOREIGN KEY/);
    expect(() => insertItem("y", "missing", null, "folder", "y")).toThrow(/FOREIGN KEY/);
  });

  it("rejects invalid kinds, methods, auth types, and inconsistent Trash state", () => {
    insertCollection("c1", "a");
    expect(() => insertItem("x", "c1", null, "socket", "x")).toThrow(/CHECK/);
    insertItem("r1", "c1", null, "request", "r");
    const insertDetails = db.$client.prepare("INSERT INTO request_details (item_id, method, url, auth_type) VALUES (?, ?, ?, ?)");
    expect(() => insertDetails.run("r1", "OPTIONS", "", "none")).toThrow(/CHECK/);
    expect(() => insertDetails.run("r1", "GET", "", "bearer")).toThrow(/CHECK/);
    expect(() =>
      db.$client.prepare("UPDATE items SET deleted_at = ? WHERE id = 'r1'").run(now),
    ).toThrow(/CHECK/);
  });
});
