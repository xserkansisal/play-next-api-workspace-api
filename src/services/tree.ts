import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { MySql2Transaction } from "drizzle-orm/mysql2";
import type { AppDatabase } from "../db/client.js";
import * as schema from "../db/schema.js";
import { items, requestDetails, requestHeaders, requestQueryParams, users } from "../db/schema.js";
import { first } from "../db/query.js";
import { ConflictError } from "../errors.js";
import type { RequestItemFields, TreeNodeInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId } from "./common.js";

export type DbExecutor = AppDatabase | MySql2Transaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

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
  createdBy: string | null;
  updatedBy: string | null;
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
export async function loadActiveTree(
  db: DbExecutor,
  collectionId: string,
): Promise<{ roots: ItemNode[]; byId: Map<string, ItemNode> }> {
  const rows = await db.select().from(items).where(and(eq(items.collectionId, collectionId), isNull(items.deletedAt)));
  const nodes = await buildNodes(db, rows);

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

async function buildNodes(db: DbExecutor, rows: ItemRow[]): Promise<Map<string, ItemNode>> {
  const requestIds = rows.filter((r) => r.kind === "request").map((r) => r.id);
  const details = new Map<string, typeof requestDetails.$inferSelect>();
  const params = new Map<string, KeyValueRow[]>();
  const headers = new Map<string, KeyValueRow[]>();
  const userIds = [...new Set(rows.flatMap((row) => [row.createdBy, row.updatedBy]).filter((id): id is string => id !== null))];
  const userEmails = new Map(
    userIds.length === 0
      ? []
      : (await db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(inArray(users.id, userIds))).map((user) => [user.id, user.email] as const),
  );

  for (const chunk of chunks(requestIds, 500)) {
    for (const d of await db.select().from(requestDetails).where(inArray(requestDetails.itemId, chunk))) {
      details.set(d.itemId, d);
    }
    for (const [table, target] of [
      [requestQueryParams, params],
      [requestHeaders, headers],
    ] as const) {
      const kvRows = await db
        .select()
        .from(table)
        .where(inArray(table.requestId, chunk))
        .orderBy(asc(table.requestId), asc(table.position));
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
      createdBy: row.createdBy ? userEmails.get(row.createdBy) ?? null : null,
      updatedBy: row.updatedBy ? userEmails.get(row.updatedBy) ?? null : null,
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

export async function findActiveItem(db: DbExecutor, collectionId: string, itemId: string): Promise<ItemRow | undefined> {
  return first(
    db
      .select()
      .from(items)
      .where(and(eq(items.id, itemId), eq(items.collectionId, collectionId), isNull(items.deletedAt)))
      .limit(1),
  );
}

export async function findActiveSiblingFolder(
  db: DbExecutor,
  collectionId: string,
  parentId: string | null,
  name: string,
  excludeId?: string,
): Promise<ItemRow | undefined> {
  const rows = await db
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
    );
  return rows.find((r) => r.id !== excludeId);
}

export function folderConflictError(name: string, parentId: string | null, existingId: string): ConflictError {
  return new ConflictError(`A folder named "${name}" already exists at this level`, "FOLDER_NAME_CONFLICT", {
    name,
    parentId,
    conflictingId: existingId,
  });
}

export async function writeRequestDetails(
  db: DbExecutor,
  itemId: string,
  fields: RequestItemFields,
  isNew: boolean,
): Promise<void> {
  const values = {
    method: fields.method,
    url: fields.url,
    bodyType: fields.body ? fields.body.type : null,
    bodyContent: fields.body ? fields.body.content : null,
    authType: fields.auth.type,
  };
  if (isNew) {
    await db.insert(requestDetails).values({ itemId, ...values });
  } else {
    await db.update(requestDetails).set(values).where(eq(requestDetails.itemId, itemId));
    await db.delete(requestQueryParams).where(eq(requestQueryParams.requestId, itemId));
    await db.delete(requestHeaders).where(eq(requestHeaders.requestId, itemId));
  }
  if (fields.queryParams.length > 0) {
    await db
      .insert(requestQueryParams)
      .values(fields.queryParams.map((row, position) => ({ requestId: itemId, position, ...row })));
  }
  if (fields.headers.length > 0) {
    await db
      .insert(requestHeaders)
      .values(fields.headers.map((row, position) => ({ requestId: itemId, position, ...row })));
  }
}

/** Inserts a validated tree beneath `parentId`, rejecting duplicate sibling folder names. */
export async function insertTree(
  db: DbExecutor,
  collectionId: string,
  parentId: string | null,
  nodes: TreeNodeInput[],
  timestamp: string,
  actorId: string,
): Promise<void> {
  const seenFolders = new Map<string, string>();
  for (const node of nodes) {
    const id = newId();
    if (node.type === "folder") {
      const key = nameKey(node.name);
      const existing = seenFolders.get(key) ?? (await findActiveSiblingFolder(db, collectionId, parentId, node.name))?.id;
      if (existing) throw folderConflictError(node.name, parentId, existing);
      seenFolders.set(key, id);
    }
    await db.insert(items).values({
      id,
      collectionId,
      parentId,
      kind: node.type,
      name: node.name,
      nameKey: nameKey(node.name),
      description: node.description,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: actorId,
      updatedBy: actorId,
    });
    if (node.type === "request") await writeRequestDetails(db, id, node, true);
    else await insertTree(db, collectionId, id, node.items, timestamp, actorId);
  }
}

/** Returns the IDs of `itemId` and all its active descendants. */
export async function activeSubtreeIds(db: DbExecutor, itemId: string): Promise<string[]> {  const root = await first(
    db.select({ id: items.id }).from(items).where(and(eq(items.id, itemId), isNull(items.deletedAt))).limit(1),
  );
  if (!root) return [];

  const ids = [itemId];
  let parents = [itemId];
  while (parents.length > 0) {
    const children = await db
      .select({ id: items.id })
      .from(items)
      .where(and(inArray(items.parentId, parents), isNull(items.deletedAt)));
    parents = children.map((row) => row.id);
    ids.push(...parents);
  }
  return ids;
}

/**
 * Returns the IDs of `itemId` and every descendant, trashed ones included.
 *
 * A move has to carry the whole branch: the parent-and-collection foreign key is blind to
 * `deleted_at`, so a trashed descendant left behind in the old collection would both break the
 * write and, if it somehow survived, restore into a collection its ancestors have left.
 */
export async function wholeSubtreeIds(db: DbExecutor, itemId: string): Promise<string[]> {
  const ids = [itemId];
  let parents = [itemId];
  while (parents.length > 0) {
    const children = await db.select({ id: items.id }).from(items).where(inArray(items.parentId, parents));
    parents = children.map((row) => row.id);
    ids.push(...parents);
  }
  return ids;
}
