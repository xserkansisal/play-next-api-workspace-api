import { and, desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collectionVersions, itemVersions } from "../db/schema.js";
import { NotFoundError } from "../errors.js";
import type { FolderItemFields, RequestItemFields, ScopedAuth } from "../validation/schemas.js";
import { newId, nowIso, resolveAttribution } from "./common.js";
import type { DbExecutor, ItemNode } from "./tree.js";

export type CollectionVersionSnapshot = { name: string; description: string; auth?: ScopedAuth | null };
export type ItemVersionSnapshot = FolderItemFields | RequestItemFields;

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
