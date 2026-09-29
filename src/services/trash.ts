import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, environments, items } from "../db/schema.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { RestoreInput } from "../validation/schemas.js";
import { nameKey, nowIso } from "./common.js";
import { findActiveCollection, findActiveCollectionByName, readCollection, type CollectionAggregate } from "./collections.js";
import { findActiveEnvironmentByName, readEnvironment, type Environment } from "./environments.js";
import { readItem } from "./items.js";
import { findActiveItem, findActiveSiblingFolder, type DbExecutor, type ItemNode } from "./tree.js";

export type TrashKind = "collection" | "folder" | "request" | "environment";

export interface TrashEntry {
  id: string;
  kind: TrashKind;
  name: string;
  collectionId: string | null;
  parentId: string | null;
  deletedAt: string;
}

export interface RestoreConflict {
  id: string;
  kind: "collection" | "folder" | "environment";
  name: string;
  collectionId: string | null;
  parentId: string | null;
  conflictingId: string;
}

export interface RestoreBlocker {
  code: "PARENT_IN_TRASH";
  message: string;
}

export interface RestoreCheckResult {
  id: string;
  kind: TrashKind;
  name: string;
  canRestore: boolean;
  blocker: RestoreBlocker | null;
  conflicts: RestoreConflict[];
}

export type RestoredResource =
  | { kind: "collection"; collection: CollectionAggregate }
  | { kind: "folder" | "request"; item: ItemNode }
  | { kind: "environment"; environment: Environment };

type ItemRow = typeof items.$inferSelect;

type TrashRoot =
  | { kind: "collection"; row: typeof collections.$inferSelect }
  | { kind: "item"; row: ItemRow }
  | { kind: "environment"; row: typeof environments.$inferSelect };

/** Lists deleted roots that can be restored now (item roots whose container is active). */
export function listTrash(db: AppDatabase): TrashEntry[] {
  const entries: TrashEntry[] = [];

  for (const row of db.select().from(collections).where(isNotNull(collections.deletedAt)).all()) {
    entries.push({ id: row.id, kind: "collection", name: row.name, collectionId: null, parentId: null, deletedAt: row.deletedAt! });
  }

  const itemRoots = db.all<{
    id: string;
    kind: "folder" | "request";
    name: string;
    collection_id: string;
    parent_id: string | null;
    deleted_at: string;
  }>(sql`
    SELECT i.id, i.kind, i.name, i.collection_id, i.parent_id, i.deleted_at
    FROM items i
    JOIN collections c ON c.id = i.collection_id
    LEFT JOIN items p ON p.id = i.parent_id
    WHERE i.trash_root_id = i.id
      AND c.deleted_at IS NULL
      AND (i.parent_id IS NULL OR p.deleted_at IS NULL)
  `);
  for (const row of itemRoots) {
    entries.push({
      id: row.id,
      kind: row.kind,
      name: row.name,
      collectionId: row.collection_id,
      parentId: row.parent_id,
      deletedAt: row.deleted_at,
    });
  }

  for (const row of db.select().from(environments).where(isNotNull(environments.deletedAt)).all()) {
    entries.push({ id: row.id, kind: "environment", name: row.name, collectionId: null, parentId: null, deletedAt: row.deletedAt! });
  }

  return entries.sort((a, b) => (a.deletedAt === b.deletedAt ? a.id.localeCompare(b.id) : a.deletedAt < b.deletedAt ? 1 : -1));
}

function findTrashRoot(db: DbExecutor, id: string): TrashRoot {
  const collection = db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), isNotNull(collections.deletedAt)))
    .get();
  if (collection) return { kind: "collection", row: collection };

  const item = db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.trashRootId, id)))
    .get();
  if (item) return { kind: "item", row: item };

  const environment = db
    .select()
    .from(environments)
    .where(and(eq(environments.id, id), isNotNull(environments.deletedAt)))
    .get();
  if (environment) return { kind: "environment", row: environment };

  throw new NotFoundError(`Trash item ${id} not found`);
}

function trashKind(root: TrashRoot): TrashKind {
  return root.kind === "item" ? root.row.kind : root.kind;
}

function subtreeRows(db: DbExecutor, rootId: string): ItemRow[] {
  return db.select().from(items).where(eq(items.trashRootId, rootId)).all();
}

function analyze(db: DbExecutor, root: TrashRoot, input: RestoreInput) {
  const overrides = new Map(Object.entries(input.nameOverrides));
  const restoreRows = root.kind === "environment" ? [] : subtreeRows(db, root.row.id);
  // Environments have no subtree; their own ID is the only valid override key.
  const restoreIds = new Set(root.kind === "environment" ? [root.row.id] : restoreRows.map((r) => r.id));

  if (root.kind !== "collection" && input.collectionName !== undefined) {
    throw new BadRequestError("collectionName can only be used when restoring a collection", "INVALID_RESTORE_OVERRIDE");
  }
  const unknownIds = [...overrides.keys()].filter((id) => !restoreIds.has(id));
  if (unknownIds.length > 0) {
    throw new BadRequestError("Name overrides reference items outside the restored subtree", "INVALID_RESTORE_OVERRIDE", {
      ids: unknownIds,
    });
  }

  let blocker: RestoreBlocker | null = null;
  if (root.kind === "item") {
    const collectionActive = findActiveCollection(db, root.row.collectionId) !== undefined;
    const parentActive = root.row.parentId === null || findActiveItem(db, root.row.collectionId, root.row.parentId) !== undefined;
    if (!collectionActive || !parentActive) {
      blocker = {
        code: "PARENT_IN_TRASH",
        message: "The containing collection or folder is in Trash; restore it first",
      };
    }
  }

  const conflicts: RestoreConflict[] = [];
  if (root.kind === "collection") {
    const name = input.collectionName ?? root.row.name;
    const existing = findActiveCollectionByName(db, name, root.row.id);
    if (existing) {
      conflicts.push({ id: root.row.id, kind: "collection", name, collectionId: null, parentId: null, conflictingId: existing.id });
    }
  }

  if (root.kind === "environment") {
    const name = overrides.get(root.row.id) ?? root.row.name;
    const existing = findActiveEnvironmentByName(db, name, root.row.id);
    if (existing) {
      conflicts.push({ id: root.row.id, kind: "environment", name, collectionId: null, parentId: null, conflictingId: existing.id });
    }
  }

  const restoredFolders = new Map<string, string>();
  for (const row of restoreRows) {
    if (row.kind !== "folder") continue;
    const name = overrides.get(row.id) ?? row.name;
    const groupKey = `${row.collectionId}\u0000${row.parentId ?? ""}\u0000${nameKey(name)}`;
    const conflictingId =
      findActiveSiblingFolder(db, row.collectionId, row.parentId, name)?.id ?? restoredFolders.get(groupKey);
    if (conflictingId) {
      conflicts.push({ id: row.id, kind: "folder", name, collectionId: row.collectionId, parentId: row.parentId, conflictingId });
    } else {
      restoredFolders.set(groupKey, row.id);
    }
  }

  return { overrides, restoreRows, blocker, conflicts };
}

export function checkRestore(db: AppDatabase, id: string, input: RestoreInput): RestoreCheckResult {
  return db.transaction((tx) => {
    const root = findTrashRoot(tx, id);
    const { blocker, conflicts } = analyze(tx, root, input);
    return {
      id,
      kind: trashKind(root),
      name: root.row.name,
      canRestore: blocker === null && conflicts.length === 0,
      blocker,
      conflicts,
    };
  });
}

export interface RestoreOutcome {
  resource: RestoredResource;
  restoredAt: string;
}

/** Restores a Trash root and its whole subtree atomically, applying name overrides. */
export function restoreFromTrash(db: AppDatabase, id: string, input: RestoreInput, actorId: string): RestoreOutcome {
  return db.transaction(
    (tx) => {
      const root = findTrashRoot(tx, id);
      const { overrides, restoreRows, blocker, conflicts } = analyze(tx, root, input);
      if (blocker) throw new ConflictError(blocker.message, "RESTORE_BLOCKED", { blocker });
      if (conflicts.length > 0) {
        throw new ConflictError("Restoring would create duplicate names", "RESTORE_CONFLICT", { conflicts });
      }

      const timestamp = nowIso();
      // Rename while still deleted so partial unique indexes never see a transient duplicate.
      for (const row of restoreRows) {
        const name = overrides.get(row.id);
        if (name !== undefined && name !== row.name) {
          tx.update(items)
            .set({ name, nameKey: nameKey(name), updatedAt: timestamp, updatedBy: actorId })
            .where(eq(items.id, row.id))
            .run();
        }
      }

      if (root.kind === "environment") {
        const name = overrides.get(id);
        tx.update(environments)
          .set({
            deletedAt: null,
            updatedAt: timestamp,
            updatedBy: actorId,
            ...(name !== undefined && name !== root.row.name
              ? { name, nameKey: nameKey(name) }
              : {}),
          })
          .where(eq(environments.id, id))
          .run();
        return { resource: { kind: "environment", environment: readEnvironment(tx, id) }, restoredAt: timestamp };
      }

      if (root.kind === "collection") {
        const name = input.collectionName;
        tx.update(collections)
          .set({
            deletedAt: null,
            updatedAt: timestamp,
            updatedBy: actorId,
            ...(name !== undefined && name !== root.row.name
              ? { name, nameKey: nameKey(name) }
              : {}),
          })
          .where(eq(collections.id, id))
          .run();
      }

      const ids = restoreRows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) {
        tx.update(items)
          .set({ deletedAt: null, trashRootId: null, updatedAt: timestamp, updatedBy: actorId })
          .where(and(inArray(items.id, ids.slice(i, i + 500)), isNotNull(items.deletedAt)))
          .run();
      }

      if (root.kind === "collection") {
        return { resource: { kind: "collection", collection: readCollection(tx, id) }, restoredAt: timestamp };
      }
      return { resource: { kind: root.row.kind, item: readItem(tx, root.row.collectionId, id) }, restoredAt: timestamp };
    },
    { behavior: "immediate" },
  );
}
