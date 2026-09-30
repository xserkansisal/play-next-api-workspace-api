import { nameKey } from "../services/common.js";
import type { AppDatabase } from "./client.js";

type Table = "collections" | "items" | "environments";

export interface NameKeyChange {
  table: Table;
  id: string;
  /** Null when the column does not exist yet (pre-migration preflight). */
  from: string | null;
  to: string;
}

export interface NameKeyCollision {
  table: Table;
  /** Uniqueness scope: "global" or "<collectionId>/<parentId|root>" for folders. */
  scope: string;
  nameKey: string;
  ids: string[];
}

export interface NameKeyReport {
  changes: NameKeyChange[];
  collisions: NameKeyCollision[];
}

export class NameKeyCollisionError extends Error {
  constructor(public readonly collisions: NameKeyCollision[]) {
    super(
      "Active names collide under case-insensitive (Unicode) comparison; rename or trash one of each group, then retry:\n" +
        collisions.map((c) => `  - ${c.table} [${c.scope}] "${c.nameKey}": ${c.ids.join(", ")}`).join("\n"),
    );
    this.name = "NameKeyCollisionError";
  }
}

interface Row {
  id: string;
  name: string;
  name_key: string | null;
  deleted_at: string | null;
  scope: string;
  unique: number;
}

function query(table: Table, keyColumn: string): string {
  if (table === "items") {
    return `SELECT id, name, ${keyColumn} AS name_key, deleted_at,
              collection_id || '/' || coalesce(parent_id, 'root') AS scope,
              kind = 'folder' AS "unique"
            FROM items`;
  }
  return `SELECT id, name, ${keyColumn} AS name_key, deleted_at, 'global' AS scope, 1 AS "unique" FROM ${table}`;
}

function hasColumn(db: AppDatabase, table: Table, column: string): boolean {
  return (db.$client.pragma(`table_info(${table})`) as Array<{ name: string }>).some((c) => c.name === column);
}

const TABLES: Table[] = ["collections", "items", "environments"];

/**
 * Compares stored `name_key` values with the application's Unicode case folding. SQL
 * backfills (e.g. migration 0001 uses ASCII-only `lower()`) may leave keys that differ.
 */
export function inspectNameKeys(db: AppDatabase): NameKeyReport {
  const changes: NameKeyChange[] = [];
  const collisions: NameKeyCollision[] = [];
  for (const table of TABLES) {
    const keyColumn = hasColumn(db, table, "name_key") ? "name_key" : "NULL";
    const groups = new Map<string, { scope: string; key: string; ids: string[] }>();
    for (const row of db.$client.prepare(query(table, keyColumn)).all() as Row[]) {
      const key = nameKey(row.name);
      if (key !== row.name_key) changes.push({ table, id: row.id, from: row.name_key, to: key });
      if (row.deleted_at === null && row.unique) {
        const groupKey = `${row.scope}\u0000${key}`;
        const group = groups.get(groupKey) ?? { scope: row.scope, key, ids: [] };
        group.ids.push(row.id);
        groups.set(groupKey, group);
      }
    }
    for (const group of groups.values()) {
      if (group.ids.length > 1) collisions.push({ table, scope: group.scope, nameKey: group.key, ids: group.ids.sort() });
    }
  }
  return { changes, collisions };
}

/**
 * Rewrites stale name keys in one transaction. Refuses (without writing) when the corrected
 * keys would make active names collide, so uniqueness is never silently weakened.
 */
export function reconcileNameKeys(db: AppDatabase): NameKeyReport {
  return db.$client
    .transaction(() => {
      const report = inspectNameKeys(db);
      if (report.collisions.length > 0) throw new NameKeyCollisionError(report.collisions);
      if (report.changes.length === 0) return report;
      // Two phases so partial unique indexes never see a transient duplicate.
      for (const change of report.changes) {
        db.$client.prepare(`UPDATE ${change.table} SET name_key = ? WHERE id = ?`).run(`\u0000reconcile:${change.id}`, change.id);
      }
      for (const change of report.changes) {
        db.$client.prepare(`UPDATE ${change.table} SET name_key = ? WHERE id = ?`).run(change.to, change.id);
      }
      return report;
    })
    .immediate();
}
