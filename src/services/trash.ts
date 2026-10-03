import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import type { RowDataPacket } from "mysql2/promise";
import { first } from "../db/query.js";
import { collections, environments, items } from "../db/schema.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { RestoreInput } from "../validation/schemas.js";
import { nameKey, nowIso } from "./common.js";
import { findActiveCollection, findActiveCollectionByName, readCollection, type CollectionAggregate } from "./collections.js";
import { findActiveEnvironmentByName, readEnvironment, type Environment } from "./environments.js";
import { readItem } from "./items.js";
import { findActiveItem, findActiveSiblingFolder, type DbExecutor, type ItemNode } from "./tree.js";
import { recordActivity } from "./activity.js";
import { recordTreeSnapshot } from "./versions.js";

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

type TrashRoot = { teamId: string } & (
  | { kind: "collection"; row: typeof collections.$inferSelect }
  | { kind: "item"; row: ItemRow }
  | { kind: "environment"; row: typeof environments.$inferSelect }
);

/** Lists deleted roots that can be restored now (item roots whose container is active). */
export async function listTrash(db: AppDatabase, teamId: string): Promise<TrashEntry[]> {
  const entries: TrashEntry[] = [];

  for (const row of await db.select().from(collections).where(and(eq(collections.teamId, teamId), isNotNull(collections.deletedAt)))) {
    entries.push({ id: row.id, kind: "collection", name: row.name, collectionId: null, parentId: null, deletedAt: row.deletedAt! });
  }

  const [itemRoots] = await db.$client.query<RowDataPacket[]>(`
    SELECT i.id, i.kind, i.name, i.collection_id, i.parent_id, i.deleted_at
    FROM items i
    JOIN collections c ON c.id = i.collection_id
    LEFT JOIN items p ON p.id = i.parent_id
    WHERE i.trash_root_id = i.id
      AND c.team_id = ?
      AND c.deleted_at IS NULL
      AND (i.parent_id IS NULL OR p.deleted_at IS NULL)
  `, [teamId]);
  const typedItemRoots = itemRoots as Array<{
    id: string;
    kind: "folder" | "request";
    name: string;
    collection_id: string;
    parent_id: string | null;
    deleted_at: string;
  }>;
  for (const row of typedItemRoots) {
    entries.push({
      id: row.id,
      kind: row.kind,
      name: row.name,
      collectionId: row.collection_id,
      parentId: row.parent_id,
      deletedAt: row.deleted_at,
    });
  }

  for (const row of await db.select().from(environments).where(and(eq(environments.teamId, teamId), isNotNull(environments.deletedAt)))) {
    entries.push({ id: row.id, kind: "environment", name: row.name, collectionId: null, parentId: null, deletedAt: row.deletedAt! });
  }

  return entries.sort((a, b) => (a.deletedAt === b.deletedAt ? a.id.localeCompare(b.id) : a.deletedAt < b.deletedAt ? 1 : -1));
}

// Another team's Trash entry is reported exactly like a missing one.
async function findTrashRoot(db: DbExecutor, teamId: string, id: string): Promise<TrashRoot> {
  const collection = await first(db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), eq(collections.teamId, teamId), isNotNull(collections.deletedAt)))
    .limit(1));
  if (collection) return { kind: "collection", row: collection, teamId };

  const item = await first(db
    .select({ item: items })
    .from(items)
    .innerJoin(collections, eq(items.collectionId, collections.id))
    .where(and(eq(items.id, id), eq(items.trashRootId, id), eq(collections.teamId, teamId)))
    .limit(1));
  if (item) return { kind: "item", row: item.item, teamId };

  const environment = await first(db
    .select()
    .from(environments)
    .where(and(eq(environments.id, id), eq(environments.teamId, teamId), isNotNull(environments.deletedAt)))
    .limit(1));
  if (environment) return { kind: "environment", row: environment, teamId };

  throw new NotFoundError(`Trash item ${id} not found`);
}

function trashKind(root: TrashRoot): TrashKind {
  return root.kind === "item" ? root.row.kind : root.kind;
}

function subtreeRows(db: DbExecutor, rootId: string): Promise<ItemRow[]> {
  return db.select().from(items).where(eq(items.trashRootId, rootId));
}

async function analyze(db: DbExecutor, root: TrashRoot, input: RestoreInput) {
  const overrides = new Map(Object.entries(input.nameOverrides));
  const restoreRows = root.kind === "environment" ? [] : await subtreeRows(db, root.row.id);
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
    const collectionActive = (await findActiveCollection(db, root.row.collectionId)) !== undefined;
    const parentActive = root.row.parentId === null || (await findActiveItem(db, root.row.collectionId, root.row.parentId)) !== undefined;
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
    const existing = await findActiveCollectionByName(db, root.teamId, name, root.row.id);
    if (existing) {
      conflicts.push({ id: root.row.id, kind: "collection", name, collectionId: null, parentId: null, conflictingId: existing.id });
    }
  }

  if (root.kind === "environment") {
    const name = overrides.get(root.row.id) ?? root.row.name;
    const existing = await findActiveEnvironmentByName(db, root.teamId, name, root.row.id);
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
      (await findActiveSiblingFolder(db, row.collectionId, row.parentId, name))?.id ?? restoredFolders.get(groupKey);
    if (conflictingId) {
      conflicts.push({ id: row.id, kind: "folder", name, collectionId: row.collectionId, parentId: row.parentId, conflictingId });
    } else {
      restoredFolders.set(groupKey, row.id);
    }
  }

  return { overrides, restoreRows, blocker, conflicts };
}

export function checkRestore(db: AppDatabase, teamId: string, id: string, input: RestoreInput): Promise<RestoreCheckResult> {
  return db.transaction(async (tx) => {
    const root = await findTrashRoot(tx, teamId, id);
    const { blocker, conflicts } = await analyze(tx, root, input);
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
export function restoreFromTrash(
  db: AppDatabase,
  teamId: string,
  id: string,
  input: RestoreInput,
  actorId: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<RestoreOutcome> {
  return db.transaction(async (tx) => {
      const root = await findTrashRoot(tx, teamId, id);
      if (root.kind === "item") {
        await tx.select({ id: collections.id })
          .from(collections)
          .where(and(eq(collections.id, root.row.collectionId), isNull(collections.deletedAt)))
          .for("update");
      }
      const { overrides, restoreRows, blocker, conflicts } = await analyze(tx, root, input);
      if (blocker) throw new ConflictError(blocker.message, "RESTORE_BLOCKED", { blocker });
      if (conflicts.length > 0) {
        throw new ConflictError("Restoring would create duplicate names", "RESTORE_CONFLICT", { conflicts });
      }

      if (root.kind === "item") await recordTreeSnapshot(tx, root.row.collectionId, actorId);
      const timestamp = nowIso();
      // Rename while still deleted so partial unique indexes never see a transient duplicate.
      for (const row of restoreRows) {
        const name = overrides.get(row.id);
        if (name !== undefined && name !== row.name) {
          await tx.update(items)
            .set({ name, nameKey: nameKey(name), updatedAt: timestamp, updatedBy: actorId })
            .where(eq(items.id, row.id))
            ;
        }
      }

      if (root.kind === "environment") {
        const name = overrides.get(id);
        await tx.update(environments)
          .set({
            deletedAt: null,
            updatedAt: timestamp,
            updatedBy: actorId,
            ...(name !== undefined && name !== root.row.name
              ? { name, nameKey: nameKey(name) }
              : {}),
          })
          .where(eq(environments.id, id))
          ;
        await recordActivity(tx, {
          teamId: root.teamId,
          actorId,
          action: "environment.restored",
          resourceType: "environment",
          resourceId: id,
          resourceName: name ?? root.row.name,
          details: { nameChanged: name !== undefined && name !== root.row.name },
          createdAt: timestamp,
        });
        return {
          resource: {
            kind: "environment",
            environment: await readEnvironment(tx, id, encryptionKey, previousEncryptionKey),
          },
          restoredAt: timestamp,
        };
      }

      if (root.kind === "collection") {
        const name = input.collectionName;
        await tx.update(collections)
          .set({
            deletedAt: null,
            updatedAt: timestamp,
            updatedBy: actorId,
            ...(name !== undefined && name !== root.row.name
              ? { name, nameKey: nameKey(name) }
              : {}),
          })
          .where(eq(collections.id, id))
          ;
      }

      const ids = restoreRows.map((r) => r.id);
      for (let i = 0; i < ids.length; i += 500) {
        await tx.update(items)
          .set({ deletedAt: null, trashRootId: null, updatedAt: timestamp, updatedBy: actorId })
          .where(and(inArray(items.id, ids.slice(i, i + 500)), isNotNull(items.deletedAt)))
          ;
      }

      if (root.kind === "collection") {
        await recordActivity(tx, {
          teamId: root.teamId,
          actorId,
          action: "collection.restored",
          resourceType: "collection",
          resourceId: id,
          resourceName: input.collectionName ?? root.row.name,
          details: { restoredItemCount: ids.length, renamedItemCount: restoreRows.filter((row) => overrides.has(row.id)).length },
          createdAt: timestamp,
        });
        return { resource: { kind: "collection", collection: await readCollection(tx, id) }, restoredAt: timestamp };
      }
      await recordActivity(tx, {
        teamId: root.teamId,
        actorId,
        action: "item.restored",
        resourceType: root.row.kind,
        resourceId: id,
        resourceName: overrides.get(id) ?? root.row.name,
        collectionId: root.row.collectionId,
        details: { restoredItemCount: ids.length, renamedItemCount: restoreRows.filter((row) => overrides.has(row.id)).length },
        createdAt: timestamp,
      });
      return { resource: { kind: root.row.kind, item: await readItem(tx, root.row.collectionId, id) }, restoredAt: timestamp };
    });
}
