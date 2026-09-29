import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { RunResult } from "better-sqlite3";
import * as schema from "../db/schema.js";
import { items, requestDetails, requestHeaders, requestQueryParams } from "../db/schema.js";
import { ConflictError } from "../errors.js";
import type { RequestItemFields, TreeNodeInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId } from "./common.js";

export type DbExecutor = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

export interface KeyValueRow {
  key: string;
  value: string;
  description: string;
  enabled: boolean;
}

interface NodeBase {
  id: string;
  collectionId: string;
  parentId: string | null;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface FolderNode extends NodeBase {
  type: "folder";
  items: ItemNode[];
}

export interface RequestNode extends NodeBase {
  type: "request";
  method: RequestItemFields["method"];
  url: string;
  queryParams: KeyValueRow[];
  headers: KeyValueRow[];
  body: { type: "json"; content: string } | null;
  auth: { type: "none" };
}

export type ItemNode = FolderNode | RequestNode;

type ItemRow = typeof items.$inferSelect;

/** Loads the active item tree of a collection, with siblings sorted alphabetically. */
export function loadActiveTree(db: DbExecutor, collectionId: string): { roots: ItemNode[]; byId: Map<string, ItemNode> } {
  const rows = db
    .select()
    .from(items)
    .where(and(eq(items.collectionId, collectionId), isNull(items.deletedAt)))
    .all();
  const nodes = buildNodes(db, rows);

  const roots: ItemNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (!node.parentId) roots.push(node);
    else if (parent?.type === "folder") parent.items.push(node);
  }
  const sortRecursive = (list: ItemNode[]) => {
    list.sort(compareByName);
    for (const node of list) if (node.type === "folder") sortRecursive(node.items);
  };
  sortRecursive(roots);
  return { roots, byId: nodes };
}

function buildNodes(db: DbExecutor, rows: ItemRow[]): Map<string, ItemNode> {
  const requestIds = rows.filter((r) => r.kind === "request").map((r) => r.id);
  const details = new Map<string, typeof requestDetails.$inferSelect>();
  const params = new Map<string, KeyValueRow[]>();
  const headers = new Map<string, KeyValueRow[]>();

  for (const chunk of chunks(requestIds, 500)) {
    for (const d of db.select().from(requestDetails).where(inArray(requestDetails.itemId, chunk)).all()) {
      details.set(d.itemId, d);
    }
    for (const [table, target] of [
      [requestQueryParams, params],
      [requestHeaders, headers],
    ] as const) {
      const kvRows = db
        .select()
        .from(table)
        .where(inArray(table.requestId, chunk))
        .orderBy(asc(table.requestId), asc(table.position))
        .all();
      for (const row of kvRows) {
        const list = target.get(row.requestId) ?? [];
        list.push({ key: row.key, value: row.value, description: row.description, enabled: row.enabled });
        target.set(row.requestId, list);
      }
    }
  }

  const nodes = new Map<string, ItemNode>();
  for (const row of rows) {
    const base: NodeBase = {
      id: row.id,
      collectionId: row.collectionId,
      parentId: row.parentId,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.kind === "folder") {
      nodes.set(row.id, { ...base, type: "folder", items: [] });
    } else {
      const d = details.get(row.id);
      if (!d) throw new Error(`Request ${row.id} is missing its details row`);
      nodes.set(row.id, {
        ...base,
        type: "request",
        method: d.method,
        url: d.url,
        queryParams: params.get(row.id) ?? [],
        headers: headers.get(row.id) ?? [],
        body: d.bodyType === "json" && d.bodyContent !== null ? { type: "json", content: d.bodyContent } : null,
        auth: { type: d.authType },
      });
    }
  }
  return nodes;
}

function* chunks<T>(list: T[], size: number): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}

export function findActiveItem(db: DbExecutor, collectionId: string, itemId: string): ItemRow | undefined {
  return db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.collectionId, collectionId), isNull(items.deletedAt)))
    .get();
}

export function findActiveSiblingFolder(
  db: DbExecutor,
  collectionId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
): ItemRow | undefined {
  const rows = db
    .select()
    .from(items)
    .where(
      and(
        eq(items.collectionId, collectionId),
        parentId === null ? isNull(items.parentId) : eq(items.parentId, parentId),
        eq(items.kind, "folder"),
        eq(items.nameKey, nameKey(name)),
        isNull(items.deletedAt),
      ),
    )
    .all();
  return rows.find((r) => r.id !== excludeId);
}

export function folderConflictError(name: string, parentId: string | null, existingId: string): ConflictError {
  return new ConflictError(`A folder named "${name}" already exists at this level`, "FOLDER_NAME_CONFLICT", {
    name,
    parentId,
    conflictingId: existingId,
  });
}

export function writeRequestDetails(db: DbExecutor, itemId: string, fields: RequestItemFields, isNew: boolean): void {
  const values = {
    method: fields.method,
    url: fields.url,
    bodyType: fields.body ? fields.body.type : null,
    bodyContent: fields.body ? fields.body.content : null,
    authType: fields.auth.type,
  };
  if (isNew) {
    db.insert(requestDetails).values({ itemId, ...values }).run();
  } else {
    db.update(requestDetails).set(values).where(eq(requestDetails.itemId, itemId)).run();
    db.delete(requestQueryParams).where(eq(requestQueryParams.requestId, itemId)).run();
    db.delete(requestHeaders).where(eq(requestHeaders.requestId, itemId)).run();
  }
  if (fields.queryParams.length > 0) {
    db.insert(requestQueryParams)
      .values(fields.queryParams.map((row, position) => ({ requestId: itemId, position, ...row })))
      .run();
  }
  if (fields.headers.length > 0) {
    db.insert(requestHeaders)
      .values(fields.headers.map((row, position) => ({ requestId: itemId, position, ...row })))
      .run();
  }
}

/** Inserts a validated tree beneath `parentId`, rejecting duplicate sibling folder names. */
export function insertTree(
  db: DbExecutor,
  collectionId: string,
  parentId: string | null,
  nodes: TreeNodeInput[],
  timestamp: string,
): void {
  const seenFolders = new Map<string, string>();
  for (const node of nodes) {
    const id = newId();
    if (node.type === "folder") {
      const key = nameKey(node.name);
      const existing = seenFolders.get(key) ?? findActiveSiblingFolder(db, collectionId, parentId, node.name)?.id;
      if (existing) throw folderConflictError(node.name, parentId, existing);
      seenFolders.set(key, id);
    }
    db.insert(items)
      .values({
        id,
        collectionId,
        parentId,
        kind: node.type,
        name: node.name,
        nameKey: nameKey(node.name),
        description: node.description,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .run();
    if (node.type === "request") writeRequestDetails(db, id, node, true);
    else insertTree(db, collectionId, id, node.items, timestamp);
  }
}

/** Returns the IDs of `itemId` and all its active descendants. */
export function activeSubtreeIds(db: DbExecutor, itemId: string): string[] {
  const rows = db.all<{ id: string }>(sql`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM items WHERE id = ${itemId} AND deleted_at IS NULL
      UNION ALL
      SELECT i.id FROM items i JOIN subtree s ON i.parent_id = s.id WHERE i.deleted_at IS NULL
    )
    SELECT id FROM subtree
  `);
  return rows.map((r) => r.id);
}
