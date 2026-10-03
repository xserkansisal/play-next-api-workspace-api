import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { items } from "../db/schema.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import type { CreateItemInput, UpdateItemInput } from "../validation/schemas.js";
import { nameKey, newId, nowIso } from "./common.js";
import { requireActiveCollection } from "./collections.js";
import {
  activeSubtreeIds,
  findActiveItem,
  findActiveSiblingFolder,
  folderConflictError,
  loadActiveTree,
  writeRequestDetails,
  type DbExecutor,
  type ItemNode,
} from "./tree.js";
import { findItemVersion, listItemVersions, recordItemVersion } from "./versions.js";
import { recordActivity } from "./activity.js";

export async function readItem(db: DbExecutor, collectionId: string, itemId: string): Promise<ItemNode> {
  await requireActiveCollection(db, collectionId);
  const node = (await loadActiveTree(db, collectionId)).byId.get(itemId);
  if (!node) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`);
  return node;
}

export async function getItemVersions(db: AppDatabase, collectionId: string, itemId: string) {
  await requireActiveCollection(db, collectionId);
  await requireActiveItem(db, collectionId, itemId);
  return listItemVersions(db, itemId);
}

export function restoreItemVersion(
  db: AppDatabase,
  collectionId: string,
  itemId: string,
  versionId: string,
  actorId: string,
): Promise<ItemNode> {
  return db.transaction(async (tx) => {
    const row = await lockActiveItem(tx, collectionId, itemId);
    const collection = await requireActiveCollection(tx, collectionId);
    const current = await readItem(tx, collectionId, itemId);
    const version = await findItemVersion(tx, itemId, versionId);
    const snapshot = version.snapshot;
    if (snapshot.type !== row.kind) throw new Error(`Item version ${versionId} has a mismatched item type`);

    if (snapshot.type === "folder") {
      const existing = await findActiveSiblingFolder(tx, collectionId, row.parentId, snapshot.name, itemId);
      if (existing) throw folderConflictError(snapshot.name, row.parentId, existing.id);
    }

    await recordItemVersion(tx, current, actorId);
    await tx
      .update(items)
      .set({
        name: snapshot.name,
        nameKey: nameKey(snapshot.name),
        description: snapshot.description,
        ...(snapshot.type === "folder" ? { authConfig: snapshot.auth ?? null } : {}),
        updatedAt: nowIso(),
        updatedBy: actorId,
      })
      .where(eq(items.id, itemId));
    if (snapshot.type === "request") await writeRequestDetails(tx, itemId, snapshot, false);
    await recordActivity(tx, {
      teamId: collection.teamId,
      actorId,
      action: "item.version_restored",
      resourceType: row.kind,
      resourceId: itemId,
      resourceName: snapshot.name,
      collectionId,
      details: { changedFields: snapshot.type === "folder" ? ["name", "description", "auth"] : ["name", "description", "method", "url", "queryParams", "headers", "body", "auth", "preRequestScript", "postResponseScript"] },
    });
    return readItem(tx, collectionId, itemId);
  });
}

async function requireActiveItem(db: DbExecutor, collectionId: string, itemId: string) {
  const row = await findActiveItem(db, collectionId, itemId);
  if (!row) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`);
  return row;
}

async function lockActiveItem(db: DbExecutor, collectionId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.collectionId, collectionId), isNull(items.deletedAt)))
    .limit(1)
    .for("update");
  if (!row) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`);
  return row;
}

export function createItem(db: AppDatabase, collectionId: string, input: CreateItemInput, actorId: string): Promise<ItemNode> {
  return db.transaction(async (tx) => {
      const collection = await requireActiveCollection(tx, collectionId);
      if (input.parentId !== null) {
        const parent = await findActiveItem(tx, collectionId, input.parentId);
        if (!parent || parent.kind !== "folder") {
          throw new BadRequestError(
            `Parent ${input.parentId} is not an active folder in this collection`,
            "INVALID_PARENT",
            { parentId: input.parentId },
          );
        }
      }
      if (input.type === "folder") {
        const existing = await findActiveSiblingFolder(tx, collectionId, input.parentId, input.name);
        if (existing) throw folderConflictError(input.name, input.parentId, existing.id);
      }

      const id = newId();
      const timestamp = nowIso();
      await tx.insert(items)
        .values({
          id,
          collectionId,
          parentId: input.parentId,
          kind: input.type,
          name: input.name,
          nameKey: nameKey(input.name),
          description: input.description,
          authConfig: input.type === "folder" ? input.auth ?? null : null,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        ;
      if (input.type === "request") await writeRequestDetails(tx, id, input, true);
      await recordActivity(tx, {
        teamId: collection.teamId,
        actorId,
        action: "item.created",
        resourceType: input.type,
        resourceId: id,
        resourceName: input.name,
        collectionId,
      });
      return readItem(tx, collectionId, id);
    });
}

/** Saves one folder's or request's own fields; parent, children, and siblings are untouched. */
export function updateItem(
  db: AppDatabase,
  collectionId: string,
  itemId: string,
  input: UpdateItemInput,
  actorId: string,
): Promise<ItemNode> {
  return db.transaction(async (tx) => {
      const row = await lockActiveItem(tx, collectionId, itemId);
      const collection = await requireActiveCollection(tx, collectionId);
      if (row.kind !== input.type) {
        throw new BadRequestError(`Item ${itemId} is a ${row.kind}, not a ${input.type}`, "ITEM_TYPE_MISMATCH", {
          expected: row.kind,
          received: input.type,
        });
      }
      if (input.type === "folder") {
        const existing = await findActiveSiblingFolder(tx, collectionId, row.parentId, input.name, itemId);
        if (existing) throw folderConflictError(input.name, row.parentId, existing.id);
      }

      const current = await readItem(tx, collectionId, itemId);
      await recordItemVersion(tx, current, actorId);
      const changedFields = input.type === "folder" && current.type === "folder"
        ? [
            ...(current.name !== input.name ? ["name"] : []),
            ...(current.description !== input.description ? ["description"] : []),
            ...(input.auth !== undefined && JSON.stringify(current.auth) !== JSON.stringify(input.auth) ? ["auth"] : []),
          ]
        : input.type === "request" && current.type === "request"
          ? (["name", "description", "method", "url", "queryParams", "headers", "body", "auth", "preRequestScript", "postResponseScript"] as const)
              .filter((field) => JSON.stringify(current[field]) !== JSON.stringify(input[field]))
          : (() => { throw new Error(`Item ${itemId} changed type while locked`); })();
      await tx.update(items)
        .set({
          name: input.name,
          nameKey: nameKey(input.name),
          description: input.description,
          updatedAt: nowIso(),
          updatedBy: actorId,
          ...(input.type === "folder" && input.auth !== undefined ? { authConfig: input.auth } : {}),
        })
        .where(eq(items.id, itemId))
        ;
      if (input.type === "request") await writeRequestDetails(tx, itemId, input, false);
      await recordActivity(tx, {
        teamId: collection.teamId,
        actorId,
        action: "item.updated",
        resourceType: row.kind,
        resourceId: itemId,
        resourceName: input.name,
        collectionId,
        details: { changedFields },
      });
      return readItem(tx, collectionId, itemId);
    });
}

/** Moves an item (and, for folders, its active descendants) to Trash as one restorable root. */
export interface TrashedItem {
  id: string;
  collectionId: string;
  kind: "folder" | "request";
  deletedAt: string;
}

export function trashItem(db: AppDatabase, collectionId: string, itemId: string, actorId: string): Promise<TrashedItem> {
  return db.transaction(async (tx) => {
      const collection = await requireActiveCollection(tx, collectionId);
      const row = await requireActiveItem(tx, collectionId, itemId);
      const ids = await activeSubtreeIds(tx, itemId);
      const timestamp = nowIso();
      for (let i = 0; i < ids.length; i += 500) {
        await tx.update(items)
          .set({ deletedAt: timestamp, trashRootId: itemId, updatedAt: timestamp, updatedBy: actorId })
          .where(inArray(items.id, ids.slice(i, i + 500)))
          ;
      }
      await recordActivity(tx, {
        teamId: collection.teamId,
        actorId,
        action: "item.trashed",
        resourceType: row.kind,
        resourceId: itemId,
        resourceName: row.name,
        collectionId,
        details: { subtreeItemCount: ids.length },
        createdAt: timestamp,
      });
      return { id: itemId, collectionId, kind: row.kind, deletedAt: timestamp };
    });
}
