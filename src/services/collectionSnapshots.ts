import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items, type CollectionTreeSnapshot, type CollectionTreeSnapshotNode } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { RequestItemFields, TreeNodeInput } from "../validation/schemas.js";
import { nameKey, newId, nowIso, resolveAttribution } from "./common.js";
import { recordActivity } from "./activity.js";
import { requireActiveCollection, findActiveCollectionByName, collectionNameConflictError, readCollection } from "./collections.js";
import { type DbExecutor, writeRequestDetails } from "./tree.js";
import { getCurrentTreeSnapshot, listCollectionTreeVersions, recordTreeSnapshot, findCollectionTreeVersion } from "./versions.js";

type FlatSnapshotNode = {
  id: string;
  parentId: string | null;
  node: CollectionTreeSnapshotNode;
};

function flattenSnapshot(nodes: CollectionTreeSnapshotNode[], parentId: string | null, out: FlatSnapshotNode[] = []): FlatSnapshotNode[] {
  for (const node of nodes) {
    out.push({ id: node.id, parentId, node });
    if (node.type === "folder") flattenSnapshot(node.items, node.id, out);
  }
  return out;
}

function snapshotInput(node: CollectionTreeSnapshotNode): TreeNodeInput {
  if (node.type === "folder") {
    return {
      type: "folder",
      name: node.name,
      description: node.description,
      auth: node.auth,
      items: node.items.map(snapshotInput),
    };
  }
  const request: RequestItemFields = {
    type: "request",
    name: node.name,
    description: node.description,
    method: node.method,
    url: node.url,
    queryParams: node.queryParams,
    headers: node.headers,
    body: node.body,
    auth: node.auth,
    preRequestScript: node.preRequestScript,
    postResponseScript: node.postResponseScript,
  };
  return request;
}

export async function listTreeSnapshots(db: AppDatabase, collectionId: string, limit: number, offset: number) {
  await requireActiveCollection(db, collectionId);
  return listCollectionTreeVersions(db, collectionId, limit, offset);
}

export async function getTreeSnapshot(db: AppDatabase, collectionId: string, snapshotId: string) {
  await requireActiveCollection(db, collectionId);
  const version = await findCollectionTreeVersion(db, collectionId, snapshotId);
  return {
    id: version.id,
    snapshot: version.snapshot,
    itemCount: version.itemCount,
    createdAt: version.createdAt,
    createdBy: (await resolveAttribution(db, null, version.createdBy)).updatedBy,
  };
}

function normalizedNode(node: CollectionTreeSnapshotNode): Record<string, unknown> {
  if (node.type === "folder") {
    return { type: node.type, name: node.name, description: node.description, auth: node.auth };
  }
  return {
    type: node.type,
    name: node.name,
    description: node.description,
    method: node.method,
    url: node.url,
    queryParams: node.queryParams,
    headers: node.headers,
    body: node.body,
    auth: node.auth,
    preRequestScript: node.preRequestScript,
    postResponseScript: node.postResponseScript,
  };
}

function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

function flattenWithPaths(snapshot: CollectionTreeSnapshot) {
  const result = new Map<string, { parentId: string | null; path: string[]; node: CollectionTreeSnapshotNode }>();
  const visit = (nodes: CollectionTreeSnapshotNode[], parentId: string | null, path: string[]) => {
    for (const node of nodes) {
      const nodePath = [...path, node.name];
      result.set(node.id, { parentId, path: nodePath, node });
      if (node.type === "folder") visit(node.items, node.id, nodePath);
    }
  };
  visit(snapshot.items, null, []);
  return result;
}

export async function diffTreeSnapshots(
  db: AppDatabase,
  collectionId: string,
  fromId: string,
  toId: string,
) {
  return db.transaction(async (tx) => {
    await requireActiveCollection(tx, collectionId);
    const from = (await findCollectionTreeVersion(tx, collectionId, fromId)).snapshot;
    const to = toId === "current"
      ? await currentSnapshot(tx, collectionId)
      : (await findCollectionTreeVersion(tx, collectionId, toId)).snapshot;
    const before = flattenWithPaths(from);
    const after = flattenWithPaths(to);
    const added: Array<{ id: string; path: string[]; node: CollectionTreeSnapshotNode }> = [];
    const removed: Array<{ id: string; path: string[]; node: CollectionTreeSnapshotNode }> = [];
    const moved: Array<{ id: string; fromParentId: string | null; toParentId: string | null; fromPath: string[]; toPath: string[] }> = [];
    const changed: Array<{ id: string; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> }> = [];

    for (const [id, entry] of before) {
      const next = after.get(id);
      if (!next) {
        removed.push({ id, path: entry.path, node: entry.node });
        continue;
      }
      if (entry.parentId !== next.parentId) {
        moved.push({
          id,
          fromParentId: entry.parentId,
          toParentId: next.parentId,
          fromPath: entry.path,
          toPath: next.path,
        });
      }
      const beforeFields = normalizedNode(entry.node);
      const afterFields = normalizedNode(next.node);
      const fields = changedFields(beforeFields, afterFields);
      if (fields.length > 0) changed.push({ id, fields, before: beforeFields, after: afterFields });
    }
    for (const [id, entry] of after) {
      if (!before.has(id)) added.push({ id, path: entry.path, node: entry.node });
    }
    return {
      from: { id: fromId, name: from.name, description: from.description, auth: from.auth },
      to: { id: toId, name: to.name, description: to.description, auth: to.auth },
      collectionFields: changedFields(
        { name: from.name, description: from.description, auth: from.auth },
        { name: to.name, description: to.description, auth: to.auth },
      ),
      items: { added, removed, moved, changed },
    };
  });
}

async function currentSnapshot(db: DbExecutor, collectionId: string): Promise<CollectionTreeSnapshot> {
  return getCurrentTreeSnapshot(db, collectionId);
}

async function findExistingItemRows(db: DbExecutor, ids: string[]) {
  const found = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    found.push(...await db.select().from(items).where(inArray(items.id, ids.slice(offset, offset + 500))));
  }
  return found;
}

export async function restoreTreeSnapshot(
  db: AppDatabase,
  collectionId: string,
  snapshotId: string,
  actorId: string,
) {
  return db.transaction(async (tx) => {
    const [collection] = await tx.select().from(collections)
      .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
      .limit(1)
      .for("update");
    if (!collection) throw new NotFoundError(`Collection ${collectionId} not found`);
    const version = await findCollectionTreeVersion(tx, collectionId, snapshotId);
    const target = flattenSnapshot(version.snapshot.items, null);
    const targetIds = target.map((entry) => entry.id);
    const existingRows = await findExistingItemRows(tx, targetIds);
    const targetById = new Map(target.map((entry) => [entry.id, entry]));
    const elsewhere = existingRows.filter((row) => row.collectionId !== collectionId);
    if (elsewhere.length > 0) {
      throw new ConflictError(
        "Restoring this snapshot would move items back from another collection",
        "SNAPSHOT_ITEM_MOVED",
        { itemIds: elsewhere.map((row) => row.id) },
      );
    }
    const typeConflicts = existingRows.filter((row) => {
      const snapshotNode = targetById.get(row.id)?.node;
      return snapshotNode && (row.kind === "folder") !== (snapshotNode.type === "folder");
    });
    if (typeConflicts.length > 0) {
      throw new ConflictError("Snapshot item types no longer match stored items", "SNAPSHOT_ITEM_TYPE_CONFLICT", {
        itemIds: typeConflicts.map((row) => row.id),
      });
    }

    const existingCollection = await findActiveCollectionByName(tx, collection.teamId, version.snapshot.name, collectionId);
    if (existingCollection) throw collectionNameConflictError(version.snapshot.name, existingCollection.id);

    await recordTreeSnapshot(tx, collectionId, actorId);
    const currentRows = await tx.select({ id: items.id, deletedAt: items.deletedAt })
      .from(items)
      .where(eq(items.collectionId, collectionId));
    const timestamp = nowIso();
    const activeIds = currentRows.filter((row) => row.deletedAt === null).map((row) => row.id);
    for (let offset = 0; offset < activeIds.length; offset += 500) {
      await tx.update(items)
        .set({ deletedAt: timestamp, trashRootId: sql`${items.id}`, updatedAt: timestamp, updatedBy: actorId })
        .where(inArray(items.id, activeIds.slice(offset, offset + 500)));
    }

    const byId = new Map(existingRows.map((row) => [row.id, row]));
    for (const entry of target) {
      const prior = byId.get(entry.id);
      if (!prior) {
        const node = snapshotInput(entry.node);
        await tx.insert(items).values({
          id: entry.id,
          collectionId,
          parentId: entry.parentId,
          kind: entry.node.type,
          name: entry.node.name,
          nameKey: nameKey(entry.node.name),
          description: entry.node.description,
          authConfig: entry.node.type === "folder" ? entry.node.auth : null,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        });
        if (node.type === "request") await writeRequestDetails(tx, entry.id, node, true);
        continue;
      }
      await tx.update(items)
        .set({
          name: entry.node.name,
          nameKey: nameKey(entry.node.name),
          description: entry.node.description,
          parentId: entry.parentId,
          authConfig: entry.node.type === "folder" ? entry.node.auth : null,
          deletedAt: null,
          trashRootId: null,
          updatedAt: timestamp,
          updatedBy: actorId,
        })
        .where(eq(items.id, entry.id));
      const request = snapshotInput(entry.node);
      if (request.type === "request") await writeRequestDetails(tx, entry.id, request, false);
    }

    await tx.update(collections)
      .set({
        name: version.snapshot.name,
        nameKey: nameKey(version.snapshot.name),
        description: version.snapshot.description,
        authConfig: version.snapshot.auth,
        updatedAt: timestamp,
        updatedBy: actorId,
      })
      .where(eq(collections.id, collectionId));
    await recordActivity(tx, {
      teamId: collection.teamId,
      actorId,
      action: "collection.snapshot_restored",
      resourceType: "collection",
      resourceId: collectionId,
      resourceName: version.snapshot.name,
      details: { snapshotId, restoredItemCount: target.length },
      createdAt: timestamp,
    });
    return readCollection(tx, collectionId);
  });
}
