// Copying a collection, a folder, or a request.
//
// This runs on the server rather than in the client for one reason that matters and two that
// help. The one that matters: there is no endpoint that writes a subtree of items, only
// `createItem`, which writes a single node. A client copying a folder of forty requests would
// make forty calls, and a failure at the twentieth would leave half a folder behind that the
// user has to find and clean up. A copy is one thing, so it is written in one transaction and
// either exists whole or does not exist.
//
// The two that help: a large collection would otherwise be downloaded and re-uploaded in full
// just to duplicate it, and the free-name search belongs next to the uniqueness constraint it is
// searching against rather than a round trip away from it.
//
// Only the root is renamed. Everything below it lands under a new parent, where its own name
// cannot collide with anything - a folder's children are unique among themselves already, and
// they stay that way when the whole group moves together.

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items, requestDetails, requestHeaders, requestQueryParams } from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import {
  findActiveCollectionByName,
  readCollection,
  requireActiveCollection,
  type CollectionAggregate,
} from "./collections.js";
import { nameKey, newId, nowIso } from "./common.js";
import { copyNameAsync } from "./copyName.js";
import { readItem } from "./items.js";
import { activeSubtreeIds, findActiveItem, findActiveSiblingFolder, type DbExecutor, type ItemNode } from "./tree.js";
import { recordActivity } from "./activity.js";

type ItemRow = typeof items.$inferSelect;

function chunk<T>(list: T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

interface CopyPlan {
  /** The one row that is re-parented and renamed, or null when whole roots are being copied. */
  rootId: string | null;
  /** Where the root attaches in the target. Ignored when `rootId` is null. */
  rootParentId: string | null;
  rootName: string | null;
}

/**
 * The rows ordered so every row comes after its parent.
 *
 * The parent id column is a real foreign key, so a child written before its parent is rejected
 * outright. Neither source query promises an order that satisfies that: the subtree query
 * returns rows by id, and even the per-collection query only happens to be in insertion order.
 */
function parentFirst(rows: ItemRow[]): ItemRow[] {
  const childrenOf = new Map<string, ItemRow[]>();
  const present = new Set(rows.map((row) => row.id));
  const roots: ItemRow[] = [];
  for (const row of rows) {
    // A parent outside the copied set means this row is a root of what is being copied, whatever
    // it points at in the source.
    if (row.parentId === null || !present.has(row.parentId)) roots.push(row);
    else childrenOf.set(row.parentId, [...(childrenOf.get(row.parentId) ?? []), row]);
  }

  const ordered: ItemRow[] = [];
  for (const queue = [...roots]; queue.length > 0; ) {
    const row = queue.shift()!;
    ordered.push(row);
    queue.push(...(childrenOf.get(row.id) ?? []));
  }
  return ordered;
}

/**
 * Writes `rows` into `targetCollectionId` with fresh ids, each row pointing at the copy of its
 * old parent. Returns the id map so the caller can find the new root.
 */
async function copySubtree(
  db: DbExecutor,
  rows: ItemRow[],
  targetCollectionId: string,
  plan: CopyPlan,
  timestamp: string,
  actorId: string,
): Promise<Map<string, string>> {
  // Built before any insert so a child can be written in the same pass as its parent, whatever
  // order the rows came back in.
  const newIds = new Map(rows.map((row) => [row.id, newId()]));

  for (const row of parentFirst(rows)) {
    const isRoot = row.id === plan.rootId;
    const name = isRoot && plan.rootName !== null ? plan.rootName : row.name;
    await db.insert(items)
      .values({
        id: newIds.get(row.id)!,
        collectionId: targetCollectionId,
        // The root's parent lies outside the copied set, so it takes the plan's value rather
        // than a lookup that would find nothing.
        parentId: isRoot ? plan.rootParentId : row.parentId === null ? null : newIds.get(row.parentId)!,
        kind: row.kind,
        name,
        nameKey: nameKey(name),
        description: row.description,
        authConfig: row.kind === "folder" ? row.authConfig : null,
        createdAt: timestamp,
        updatedAt: timestamp,
        // The copy is new content by whoever asked for it. Carrying the original's author over
        // would credit them with a row they never wrote.
        createdBy: actorId,
        updatedBy: actorId,
      });
  }

  const requestIds = rows.filter((row) => row.kind === "request").map((row) => row.id);
  for (const group of chunk(requestIds)) {
    for (const detail of await db.select().from(requestDetails).where(inArray(requestDetails.itemId, group))) {
      await db.insert(requestDetails).values({ ...detail, itemId: newIds.get(detail.itemId)! });
    }
    // Position is carried over rather than re-derived, so headers and params keep the order the
    // user put them in.
    for (const table of [requestQueryParams, requestHeaders] as const) {
      const kvRows = await db
        .select()
        .from(table)
        .where(inArray(table.requestId, group))
        .orderBy(asc(table.requestId), asc(table.position));
      if (kvRows.length > 0) {
        await db.insert(table).values(kvRows.map((row) => ({ ...row, requestId: newIds.get(row.requestId)! })));
      }
    }
  }

  return newIds;
}

/** Duplicates a collection and its whole active item tree under a free name. */
export function cloneCollection(db: AppDatabase, id: string, actorId: string): Promise<CollectionAggregate> {
  return db.transaction(async (tx) => {
    const source = await requireActiveCollection(tx, id);
    const name = await copyNameAsync(
      source.name,
      async (candidate) => (await findActiveCollectionByName(tx, source.teamId, candidate)) !== undefined,
    );

    const newCollectionId = newId();
    const timestamp = nowIso();
    await tx.insert(collections).values({
      id: newCollectionId,
      name,
      nameKey: nameKey(name),
      description: source.description,
      authConfig: source.authConfig,
      teamId: source.teamId,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: actorId,
      updatedBy: actorId,
    });

    const rows = await tx.select().from(items).where(and(eq(items.collectionId, id), isNull(items.deletedAt)));
    // Nothing is re-rooted or renamed here: every row keeps its own parent within the new
    // collection, and the collection's new name is the only one that had to be free.
    await copySubtree(tx, rows, newCollectionId, { rootId: null, rootParentId: null, rootName: null }, timestamp, actorId);
    await recordActivity(tx, {
      teamId: source.teamId,
      actorId,
      action: "collection.cloned",
      resourceType: "collection",
      resourceId: newCollectionId,
      resourceName: name,
      details: { sourceCollectionId: id, itemCount: rows.length },
      createdAt: timestamp,
    });

    return readCollection(tx, newCollectionId);
  });
}

/** True when an active item of any kind with this name already sits under the same parent. */
async function siblingNameTaken(db: DbExecutor, collectionId: string, parentId: string | null, name: string): Promise<boolean> {
  const rows = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.collectionId, collectionId),
          parentId === null ? isNull(items.parentId) : eq(items.parentId, parentId),
          eq(items.nameKey, nameKey(name)),
          isNull(items.deletedAt),
        ),
      )
      .limit(1);
  return rows.length > 0;
}

/**
 * Duplicates a folder (with everything inside it) or a single request, next to the original.
 *
 * The copy keeps the source's parent so it appears beside what it was copied from - dropping it
 * at the collection root instead would make a copy taken from four levels down hard to find.
 */
export function cloneItem(db: AppDatabase, collectionId: string, itemId: string, actorId: string): Promise<ItemNode> {
  return db.transaction(async (tx) => {
    const collection = await requireActiveCollection(tx, collectionId);
    const source = await findActiveItem(tx, collectionId, itemId);
    if (!source) throw new NotFoundError(`Item ${itemId} not found in collection ${collectionId}`);

    // A folder only has to clear other folders, since that is all the index constrains. Requests
    // are numbered too so the copy remains distinguishable in the tree.
    const name = await copyNameAsync(source.name, async (candidate) =>
      source.kind === "folder"
        ? (await findActiveSiblingFolder(tx, collectionId, source.parentId, candidate)) !== undefined
        : siblingNameTaken(tx, collectionId, source.parentId, candidate),
    );

    const subtreeIds = await activeSubtreeIds(tx, itemId);
    const rows = (
      await Promise.all(chunk(subtreeIds).map((group) => tx.select().from(items).where(inArray(items.id, group))))
    ).flat();

    const timestamp = nowIso();
    const newIds = await copySubtree(
      tx,
      rows,
      collectionId,
      { rootId: itemId, rootParentId: source.parentId, rootName: name },
      timestamp,
      actorId,
    );
    await recordActivity(tx, {
      teamId: collection.teamId,
      actorId,
      action: "item.cloned",
      resourceType: source.kind,
      resourceId: newIds.get(itemId)!,
      resourceName: name,
      collectionId,
      details: { sourceItemId: itemId, subtreeItemCount: rows.length },
      createdAt: timestamp,
    });
    return readItem(tx, collectionId, newIds.get(itemId)!);
  });
}
