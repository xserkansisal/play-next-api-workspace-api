import { eq, inArray } from "drizzle-orm";
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

export function readItem(db: DbExecutor, collectionId: string, itemId: string): ItemNode {
  requireActiveCollection(db, collectionId);
  const node = loadActiveTree(db, collectionId).byId.get(itemId);
  if (!node) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`);
  return node;
}

function requireActiveItem(db: DbExecutor, collectionId: string, itemId: string) {
  const row = findActiveItem(db, collectionId, itemId);
  if (!row) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`);
  return row;
}

export function createItem(db: AppDatabase, collectionId: string, input: CreateItemInput, actorId: string): ItemNode {
  return db.transaction(
    (tx) => {
      requireActiveCollection(tx, collectionId);
      if (input.parentId !== null) {
        const parent = findActiveItem(tx, collectionId, input.parentId);
        if (!parent || parent.kind !== "folder") {
          throw new BadRequestError(
            `Parent ${input.parentId} is not an active folder in this collection`,
            "INVALID_PARENT",
            { parentId: input.parentId },
          );
        }
      }
      if (input.type === "folder") {
        const existing = findActiveSiblingFolder(tx, collectionId, input.parentId, input.name);
        if (existing) throw folderConflictError(input.name, input.parentId, existing.id);
      }

      const id = newId();
      const timestamp = nowIso();
      tx.insert(items)
        .values({
          id,
          collectionId,
          parentId: input.parentId,
          kind: input.type,
          name: input.name,
          nameKey: nameKey(input.name),
          description: input.description,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        .run();
      if (input.type === "request") writeRequestDetails(tx, id, input, true);
      return readItem(tx, collectionId, id);
    },
    { behavior: "immediate" },
  );
}

/** Saves one folder's or request's own fields; parent, children, and siblings are untouched. */
export function updateItem(
  db: AppDatabase,
  collectionId: string,
  itemId: string,
  input: UpdateItemInput,
  actorId: string,
): ItemNode {
  return db.transaction(
    (tx) => {
      requireActiveCollection(tx, collectionId);
      const row = requireActiveItem(tx, collectionId, itemId);
      if (row.kind !== input.type) {
        throw new BadRequestError(`Item ${itemId} is a ${row.kind}, not a ${input.type}`, "ITEM_TYPE_MISMATCH", {
          expected: row.kind,
          received: input.type,
        });
      }
      if (input.type === "folder") {
        const existing = findActiveSiblingFolder(tx, collectionId, row.parentId, input.name, itemId);
        if (existing) throw folderConflictError(input.name, row.parentId, existing.id);
      }

      tx.update(items)
        .set({
          name: input.name,
          nameKey: nameKey(input.name),
          description: input.description,
          updatedAt: nowIso(),
          updatedBy: actorId,
        })
        .where(eq(items.id, itemId))
        .run();
      if (input.type === "request") writeRequestDetails(tx, itemId, input, false);
      return readItem(tx, collectionId, itemId);
    },
    { behavior: "immediate" },
  );
}

/** Moves an item (and, for folders, its active descendants) to Trash as one restorable root. */
export interface TrashedItem {
  id: string;
  collectionId: string;
  kind: "folder" | "request";
  deletedAt: string;
}

export function trashItem(db: AppDatabase, collectionId: string, itemId: string, actorId: string): TrashedItem {
  return db.transaction(
    (tx) => {
      requireActiveCollection(tx, collectionId);
      const row = requireActiveItem(tx, collectionId, itemId);
      const ids = activeSubtreeIds(tx, itemId);
      const timestamp = nowIso();
      for (let i = 0; i < ids.length; i += 500) {
        tx.update(items)
          .set({ deletedAt: timestamp, trashRootId: itemId, updatedAt: timestamp, updatedBy: actorId })
          .where(inArray(items.id, ids.slice(i, i + 500)))
          .run();
      }
      return { id: itemId, collectionId, kind: row.kind, deletedAt: timestamp };
    },
    { behavior: "immediate" },
  );
}
