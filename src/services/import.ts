// Importing a tree of folders and requests into a collection or beneath one of its folders.
//
// Like a copy, an import is one thing: forty requests arriving as forty separate creates would
// leave half a folder behind when the twentieth failed. The whole tree is therefore checked first
// and written in one transaction, and either lands whole or not at all.
//
// Only the roots can collide with anything that already exists. Everything below a root lands
// under a folder created by this same import, so its only possible neighbours are its siblings
// in the payload - which are checked, but never renamed, because a duplicate there is a mistake
// in the file rather than a clash with the user's tree.
//
// There is no sibling order to append to: siblings are shown folders-first and then by name, so
// imported rows simply take their place among what is already there.

import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items, requestDetails, requestHeaders, requestQueryParams } from "../db/schema.js";
import { BadRequestError, ConflictError } from "../errors.js";
import {
  MAX_TREE_DEPTH,
  treeDepth,
  type ImportItemsInput,
  type RequestAuth,
  type RequestItemFields,
  type TreeNodeInput,
} from "../validation/schemas.js";
import { requireActiveCollection } from "./collections.js";
import { nameKey, newId, nowIso } from "./common.js";
import { copyName } from "./copyName.js";
import { authConfigForStorage, findActiveItem, type DbExecutor } from "./tree.js";
import { recordActivity } from "./activity.js";

export interface ImportRenamed {
  path: string[];
  from: string;
  to: string;
}

export type ImportWarning =
  | { path: string[]; code: "SENSITIVE_HEADER"; header: string }
  | { path: string[]; code: "SENSITIVE_AUTH"; authType: "basic" | "bearer" | "api-key" };

export interface ImportedRoot {
  id: string;
  kind: "folder" | "request";
}

export interface ImportResult {
  collectionId: string;
  parentId: string | null;
  dryRun: boolean;
  created: { folders: number; requests: number };
  renamed: ImportRenamed[];
  warnings: ImportWarning[];
  /** Empty for a dry run, since nothing was written. */
  roots: ImportedRoot[];
  changedAt: string;
}

// Headers whose values are credentials. They are stored as given - the user may want them - but
// the caller is told, so a file exported with a live token in it does not go unnoticed.
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
]);
const PLACEHOLDER_ONLY = /^\s*(?:(?:bearer|basic|token)\s+)?\{\{[^{}]+\}\}\s*$/i;

interface FlatRow {
  id: string;
  parentId: string | null;
  node: TreeNodeInput;
  name: string;
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Rejects duplicate folder names among siblings below the roots, where nothing is renamed. */
function assertUniqueNestedFolders(nodes: TreeNodeInput[], path: string[]): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    if (path.length > 0) {
      const key = nameKey(node.name);
      if (seen.has(key)) {
        throw new BadRequestError(`The import contains two folders named "${node.name}" at the same level`, "DUPLICATE_FOLDER_NAME", {
          path: [...path, node.name],
        });
      }
      seen.add(key);
    }
    assertUniqueNestedFolders(node.items, [...path, node.name]);
  }
}

function collectWarnings(nodes: TreeNodeInput[], path: string[], out: ImportWarning[]): void {
  for (const node of nodes) {
    const nodePath = [...path, node.name];
    if (node.type === "folder") {
      collectWarnings(node.items, nodePath, out);
      continue;
    }
    for (const header of node.headers) {
      if (SENSITIVE_HEADERS.has(header.key.trim().toLowerCase()) && header.value.trim() !== "" && !PLACEHOLDER_ONLY.test(header.value)) {
        out.push({ path: nodePath, code: "SENSITIVE_HEADER", header: header.key.trim() });
      }
    }
    if (hasUnresolvedAuthSecret(node.auth)) {
      out.push({ path: nodePath, code: "SENSITIVE_AUTH", authType: node.auth.type });
    }
  }
}

function hasUnresolvedAuthSecret(auth: RequestAuth): auth is Extract<RequestAuth, { type: "basic" | "bearer" | "api-key" }> {
  switch (auth.type) {
    case "basic":
      return auth.password.trim() !== "" && !PLACEHOLDER_ONLY.test(auth.password);
    case "bearer":
      return auth.token.trim() !== "" && !PLACEHOLDER_ONLY.test(auth.token);
    case "api-key":
      return auth.value.trim() !== "" && !PLACEHOLDER_ONLY.test(auth.value);
    case "inherit":
    case "none":
      return false;
  }
}

/** Every node with a fresh id, each parent before its children so the parent key is satisfied. */
function flatten(nodes: TreeNodeInput[], parentId: string | null, rootNames: string[] | null, out: FlatRow[]): void {
  nodes.forEach((node, index) => {
    const id = newId();
    out.push({ id, parentId, node, name: rootNames ? rootNames[index]! : node.name });
    if (node.type === "folder") flatten(node.items, id, null, out);
  });
}

/** Number of folders from the collection root down to and including `parentId`. */
async function folderDepth(db: DbExecutor, collectionId: string, parentId: string | null): Promise<number> {
  let depth = 0;
  for (let current = parentId; current !== null && depth <= MAX_TREE_DEPTH; depth += 1) {
    const row = await findActiveItem(db, collectionId, current);
    current = row?.parentId ?? null;
  }
  return depth;
}

async function activeSiblingFolders(db: DbExecutor, collectionId: string, parentId: string | null) {
  return db
    .select({ id: items.id, nameKey: items.nameKey })
    .from(items)
    .where(
      and(
        eq(items.collectionId, collectionId),
        parentId === null ? isNull(items.parentId) : eq(items.parentId, parentId),
        eq(items.kind, "folder"),
        isNull(items.deletedAt),
      ),
    );
}

async function writeRows(db: DbExecutor, collectionId: string, rows: FlatRow[], timestamp: string, actorId: string): Promise<void> {
  // Rows are parent-first, and InnoDB checks the parent key row by row in statement order, so a
  // child may share a statement with its parent.
  for (const group of chunk(rows, 500)) {
    await db.insert(items).values(
      group.map((row) => ({
        id: row.id,
        collectionId,
        parentId: row.parentId,
        kind: row.node.type,
        name: row.name,
        nameKey: nameKey(row.name),
        description: row.node.description,
        authConfig: row.node.type === "folder" ? row.node.auth ?? null : null,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: actorId,
        updatedBy: actorId,
      })),
    );
  }

  const requests = rows.filter((row): row is FlatRow & { node: RequestItemFields } => row.node.type === "request");
  for (const group of chunk(requests, 500)) {
    await db.insert(requestDetails).values(
      group.map(({ id, node }) => ({
        itemId: id,
        method: node.method,
        url: node.url,
        bodyType: node.body ? node.body.type : null,
        bodyContent: node.body ? node.body.content : null,
        authType: node.auth.type,
        authConfig: authConfigForStorage(node.auth),
        preRequestScript: node.preRequestScript,
        postResponseScript: node.postResponseScript,
      })),
    );
  }
  for (const [table, field] of [
    [requestQueryParams, "queryParams"],
    [requestHeaders, "headers"],
  ] as const) {
    const kvRows = requests.flatMap(({ id, node }) => node[field].map((row, position) => ({ requestId: id, position, ...row })));
    for (const group of chunk(kvRows, 1000)) await db.insert(table).values(group);
  }
}

/**
 * Imports `input.items` under `input.parentId` (or the collection root) of `collectionId`.
 *
 * Root folders whose names are already taken at the target are renamed "Name (copy)", "Name
 * (copy 2)", ... like a clone, unless the caller asked for the import to fail instead. Requests
 * are never renamed; their names are not unique anywhere else either.
 */
export function importItems(db: AppDatabase, collectionId: string, input: ImportItemsInput, actorId: string): Promise<ImportResult> {
  return db.transaction(async (tx) => {
    const collection = await requireActiveCollection(tx, collectionId);
    const { parentId } = input;

    // Held until commit so a concurrent trash or move of the target waits for the import rather
    // than racing it and stranding the new rows under something no longer active.
    await tx.select({ id: collections.id }).from(collections).where(eq(collections.id, collectionId)).for("update");
    if (parentId !== null) {
      const parent = await findActiveItem(tx, collectionId, parentId);
      if (!parent || parent.kind !== "folder") {
        throw new BadRequestError(`Parent ${parentId} is not an active folder in this collection`, "INVALID_PARENT", { parentId });
      }
      await tx.select({ id: items.id }).from(items).where(eq(items.id, parentId)).for("update");
    }

    const depth = (await folderDepth(tx, collectionId, parentId)) + treeDepth(input.items);
    if (depth > MAX_TREE_DEPTH) {
      throw new BadRequestError(`Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`, "IMPORT_TOO_DEEP", {
        depth,
        maxDepth: MAX_TREE_DEPTH,
      });
    }

    assertUniqueNestedFolders(input.items, []);

    const existing = await activeSiblingFolders(tx, collectionId, parentId);
    const existingByKey = new Map(existing.map((row) => [row.nameKey, row.id]));
    const taken = new Set(existingByKey.keys());
    const renamed: ImportRenamed[] = [];
    const conflicts: Array<{ name: string; conflictingId: string | null }> = [];
    const rootNames = input.items.map((node) => {
      if (node.type !== "folder") return node.name;
      const key = nameKey(node.name);
      if (!taken.has(key)) {
        taken.add(key);
        return node.name;
      }
      if (input.onConflict === "fail") {
        conflicts.push({ name: node.name, conflictingId: existingByKey.get(key) ?? null });
        return node.name;
      }
      const name = copyName(node.name, (candidate) => taken.has(nameKey(candidate)));
      taken.add(nameKey(name));
      renamed.push({ path: [node.name], from: node.name, to: name });
      return name;
    });
    if (conflicts.length > 0) {
      throw new ConflictError(
        conflicts.length === 1
          ? `A folder named "${conflicts[0]!.name}" already exists at this level`
          : `${conflicts.length} folders already exist at this level`,
        "FOLDER_NAME_CONFLICT",
        { parentId, conflicts },
      );
    }

    const warnings: ImportWarning[] = [];
    collectWarnings(input.items, [], warnings);

    const rows: FlatRow[] = [];
    flatten(input.items, parentId, rootNames, rows);
    const created = {
      folders: rows.filter((row) => row.node.type === "folder").length,
      requests: rows.filter((row) => row.node.type === "request").length,
    };

    const timestamp = nowIso();
    const base = { collectionId, parentId, dryRun: input.dryRun, created, renamed, warnings, changedAt: timestamp };
    if (input.dryRun) return { ...base, roots: [] };

    await writeRows(tx, collectionId, rows, timestamp, actorId);
    await recordActivity(tx, {
      teamId: collection.teamId,
      actorId,
      action: "collection.imported",
      resourceType: "collection",
      resourceId: collectionId,
      resourceName: collection.name,
      details: { parentId, folders: created.folders, requests: created.requests, renamedFolders: renamed.length },
      createdAt: timestamp,
    });
    const roots = rows.filter((row) => row.parentId === parentId).map((row) => ({ id: row.id, kind: row.node.type }));
    return { ...base, roots };
  });
}
