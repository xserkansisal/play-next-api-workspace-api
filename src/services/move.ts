// Reparenting a folder or a request, with everything beneath it.
//
// This is a move, never a reorder. Siblings are rendered folders-first and then alphabetically,
// derived from the name alone, so there is no sibling index to persist and dropping between two
// rows would have nothing to save. A drop therefore resolves to exactly one of two destinations:
// inside a folder, or at the root of a collection.
//
// The whole subtree moves in one transaction. A partial move would leave descendants pointing at
// a parent that is no longer where they are, which no client could then reach or repair.

import { eq, inArray, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { items } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { MoveItemInput } from "../validation/schemas.js";
import { findActiveCollection } from "./collections.js";
import { nowIso } from "./common.js";
import { readItem } from "./items.js";
import { findActiveItem, findActiveSiblingFolder, wholeSubtreeIds, type DbExecutor, type ItemNode } from "./tree.js";

export interface MovedItem {
  item: ItemNode;
  /** The collection the item came from, so a tab watching it can drop the stale row. */
  sourceCollectionId: string;
}

function invalidMove(message: string, details?: unknown): ConflictError {
  return new ConflictError(message, "INVALID_MOVE", details);
}

/**
 * Rewrites the collection of a set of rows while the parent-and-collection foreign key is
 * suspended.
 *
 * That key points at `(id, collection_id)` on this same table, so there is no order in which a
 * subtree can change collection one row at a time: writing a parent first orphans its children,
 * writing a child first points it at a parent that has not moved. The constraint is only
 * satisfied again once every row in the branch has been rewritten, which is what makes the
 * suspension safe here - the rows are chosen as a closed subtree, so the key holds again before
 * the statement sequence ends.
 *
 * Checks are restored unconditionally, including when the surrounding transaction is rolling
 * back, because the session is handed back to the pool afterwards and must not carry the
 * suspension into the next request.
 */
async function rewriteCollection(db: DbExecutor, ids: string[], collectionId: string): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  try {
    for (let i = 0; i < ids.length; i += 500) {
      await db.update(items).set({ collectionId }).where(inArray(items.id, ids.slice(i, i + 500)));
    }
  } finally {
    await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  }
}

/**
 * Moves `itemId` under `parentId` in `targetCollectionId`, taking its subtree with it.
 *
 * The client blocks every rejection below while the drag is in progress, so a correct client
 * never sends one. They are enforced anyway: a tab that loaded its copy of the tree an hour ago
 * can still send a move that was legal when it was loaded, and the cycle check in particular is
 * what stops a folder being made its own ancestor and taking the branch out of the tree for good.
 */
export function moveItem(
  db: AppDatabase,
  collectionId: string,
  itemId: string,
  input: MoveItemInput,
  actorId: string,
): Promise<MovedItem> {
  return db.transaction(async (tx) => {
    const source = await findActiveCollection(tx, collectionId);
    if (!source) {
      throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`, "ITEM_NOT_FOUND");
    }
    const row = await findActiveItem(tx, collectionId, itemId);
    if (!row) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`, "ITEM_NOT_FOUND");

    const { targetCollectionId, parentId } = input;
    // A collection of another team is reported exactly like a missing one: items never cross teams.
    const target = await findActiveCollection(tx, targetCollectionId);
    if (!target || target.teamId !== source.teamId) {
      throw new NotFoundError(`Collection ${targetCollectionId} not found`, "TARGET_NOT_FOUND");
    }
    if (parentId === itemId) throw invalidMove("An item cannot be moved into itself", { itemId });

    if (parentId !== null) {
      const parent = await findActiveItem(tx, targetCollectionId, parentId);
      if (!parent) throw new NotFoundError(`Parent ${parentId} not found in collection ${targetCollectionId}`, "TARGET_NOT_FOUND");
      if (parent.kind !== "folder") throw invalidMove(`Parent ${parentId} is a request, not a folder`, { parentId });
    }

    // Read once, before anything is written: this is both the cycle check and the list of rows
    // whose collection has to follow the root.
    const subtreeIds = await wholeSubtreeIds(tx, itemId);
    if (parentId !== null && subtreeIds.includes(parentId)) {
      throw invalidMove("An item cannot be moved inside its own subtree", { itemId, parentId });
    }

    if (row.kind === "folder") {
      const existing = await findActiveSiblingFolder(tx, targetCollectionId, parentId, row.name, itemId);
      if (existing) {
        throw new ConflictError(`A folder named "${row.name}" already exists here.`, "NAME_CONFLICT", {
          name: row.name,
          parentId,
          conflictingId: existing.id,
        });
      }
    }

    if (targetCollectionId !== collectionId) await rewriteCollection(tx, subtreeIds, targetCollectionId);
    // Written after the branch has landed in the target collection, so the parent reference is
    // already within one collection when the key starts checking it again.
    await tx
      .update(items)
      .set({ parentId, updatedAt: nowIso(), updatedBy: actorId })
      .where(eq(items.id, itemId));

    return { item: await readItem(tx, targetCollectionId, itemId), sourceCollectionId: collectionId };
  });
}
