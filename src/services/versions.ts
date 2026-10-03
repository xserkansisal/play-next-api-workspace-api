import type { AppDatabase } from "../db/client.js";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  collectionTreeVersions,
  collectionVersions,
  collections,
  itemVersions,
  type CollectionTreeSnapshot,
  type CollectionTreeSnapshotNode,
} from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import type { FolderItemFields, RequestItemFields, ScopedAuth } from "../validation/schemas.js";
import { newId, nowIso, resolveAttribution } from "./common.js";
import { loadActiveTree, type DbExecutor, type ItemNode } from "./tree.js";

export type CollectionVersionSnapshot = { name: string; description: string; auth?: ScopedAuth | null };
export type ItemVersionSnapshot = FolderItemFields | RequestItemFields;

function snapshotItemCount(nodes: CollectionTreeSnapshotNode[]): number {
  return nodes.reduce((count, node) => count + 1 + (node.type === "folder" ? snapshotItemCount(node.items) : 0), 0);
}

export async function recordCollectionTreeVersion(
  db: DbExecutor,
  collectionId: string,
  snapshot: CollectionTreeSnapshot,
  actorId: string,
): Promise<void> {
  await db.insert(collectionTreeVersions).values({
    id: newId(),
    collectionId,
    snapshot,
    itemCount: snapshotItemCount(snapshot.items),
    createdAt: nowIso(),
    createdBy: actorId,
  });
}

function treeSnapshotNode(node: ItemNode): CollectionTreeSnapshotNode {
  if (node.type === "folder") {
    return {
      id: node.id,
      type: "folder",
      name: node.name,
      description: node.description,
      auth: node.auth,
      items: node.items.map(treeSnapshotNode),
    };
  }
  return {
    id: node.id,
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
}

export async function getCurrentTreeSnapshot(
  db: DbExecutor,
  collectionId: string,
  forUpdate = false,
): Promise<CollectionTreeSnapshot> {
  const collectionQuery = db
    .select()
    .from(collections)
    .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
    .limit(1);
  const [collection] = forUpdate ? await collectionQuery.for("update") : await collectionQuery;
  if (!collection) throw new NotFoundError(`Collection ${collectionId} not found`);
  const tree = await loadActiveTree(db, collectionId, { forUpdate });
  return {
    name: collection.name,
    description: collection.description,
    auth: collection.authConfig,
    items: tree.roots.map(treeSnapshotNode),
  };
}

export async function recordTreeSnapshot(db: DbExecutor, collectionId: string, actorId: string): Promise<void> {
  await recordCollectionTreeVersion(db, collectionId, await getCurrentTreeSnapshot(db, collectionId, true), actorId);
}

export async function listCollectionTreeVersions(db: AppDatabase, collectionId: string, limit: number, offset: number) {
  const rows = await db
    .select({
      id: collectionTreeVersions.id,
      itemCount: collectionTreeVersions.itemCount,
      createdAt: collectionTreeVersions.createdAt,
      createdBy: collectionTreeVersions.createdBy,
    })
    .from(collectionTreeVersions)
    .where(eq(collectionTreeVersions.collectionId, collectionId))
    .orderBy(desc(collectionTreeVersions.createdAt), desc(collectionTreeVersions.id))
    .limit(limit + 1)
    .offset(offset);
  const hasMore = rows.length > limit;
  const snapshots = await Promise.all(
    rows.slice(0, limit).map(async (row) => ({
      id: row.id,
      itemCount: row.itemCount,
      createdAt: row.createdAt,
      createdBy: (await resolveAttribution(db, null, row.createdBy)).updatedBy,
    })),
  );
  return { snapshots, nextOffset: hasMore ? offset + limit : null };
}

export async function findCollectionTreeVersion(db: DbExecutor, collectionId: string, versionId: string) {
  const [version] = await db
    .select()
    .from(collectionTreeVersions)
    .where(and(eq(collectionTreeVersions.id, versionId), eq(collectionTreeVersions.collectionId, collectionId)))
    .limit(1);
  if (!version) throw new NotFoundError(`Collection snapshot ${versionId} not found`);
  return version;
}

function itemSnapshot(item: ItemNode): ItemVersionSnapshot {
  if (item.type === "folder") return { type: "folder", name: item.name, description: item.description, auth: item.auth };
  return {
    type: "request",
    name: item.name,
    description: item.description,
    method: item.method,
    url: item.url,
    queryParams: item.queryParams,
    headers: item.headers,
    body: item.body,
    auth: item.auth,
    preRequestScript: item.preRequestScript,
    postResponseScript: item.postResponseScript,
  };
}

export async function recordCollectionVersion(
  db: DbExecutor,
  collectionId: string,
  snapshot: CollectionVersionSnapshot,
  actorId: string,
): Promise<void> {
  await db.insert(collectionVersions).values({
    id: newId(),
    collectionId,
    snapshot,
    createdAt: nowIso(),
    createdBy: actorId,
  });
}

export async function listCollectionVersions(db: AppDatabase, collectionId: string) {
  const rows = await db
    .select()
    .from(collectionVersions)
    .where(eq(collectionVersions.collectionId, collectionId))
    .orderBy(desc(collectionVersions.createdAt), desc(collectionVersions.id));
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      snapshot: row.snapshot,
      createdAt: row.createdAt,
      createdBy: (await resolveAttribution(db, null, row.createdBy)).updatedBy,
    })),
  );
}

export async function findCollectionVersion(db: DbExecutor, collectionId: string, versionId: string) {
  const [version] = await db
    .select()
    .from(collectionVersions)
    .where(and(eq(collectionVersions.id, versionId), eq(collectionVersions.collectionId, collectionId)))
    .limit(1);
  if (!version) throw new NotFoundError(`Collection version ${versionId} not found`);
  return version;
}

export async function recordItemVersion(db: DbExecutor, item: ItemNode, actorId: string): Promise<void> {
  await db.insert(itemVersions).values({
    id: newId(),
    itemId: item.id,
    snapshot: itemSnapshot(item),
    createdAt: nowIso(),
    createdBy: actorId,
  });
}

export async function listItemVersions(db: AppDatabase, itemId: string) {
  const rows = await db
    .select()
    .from(itemVersions)
    .where(eq(itemVersions.itemId, itemId))
    .orderBy(desc(itemVersions.createdAt), desc(itemVersions.id));
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      snapshot: row.snapshot,
      createdAt: row.createdAt,
      createdBy: (await resolveAttribution(db, null, row.createdBy)).updatedBy,
    })),
  );
}

export async function findItemVersion(db: DbExecutor, itemId: string, versionId: string) {
  const [version] = await db
    .select()
    .from(itemVersions)
    .where(and(eq(itemVersions.id, versionId), eq(itemVersions.itemId, itemId)))
    .limit(1);
  if (!version) throw new NotFoundError(`Item version ${versionId} not found`);
  return version;
}
