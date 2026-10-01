import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
import { collections, items } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { CreateCollectionInput, UpdateCollectionInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId, nowIso, resolveAttribution } from "./common.js";
import { insertTree, loadActiveTree, type DbExecutor, type ItemNode } from "./tree.js";
import type { ScopedAuth } from "../validation/schemas.js";
import {
  findCollectionVersion,
  listCollectionVersions,
  recordCollectionVersion,
} from "./versions.js";

export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export interface CollectionAggregate extends CollectionSummary {
  auth: ScopedAuth | null;
  items: ItemNode[];
}

type CollectionRow = typeof collections.$inferSelect;

async function toSummary(db: DbExecutor, row: CollectionRow): Promise<CollectionSummary> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...await resolveAttribution(db, row.createdBy, row.updatedBy),
  };
}

export function findActiveCollection(db: DbExecutor, id: string): Promise<CollectionRow | undefined> {
  return first(db.select().from(collections).where(and(eq(collections.id, id), isNull(collections.deletedAt))).limit(1));
}

export async function requireActiveCollection(db: DbExecutor, id: string): Promise<CollectionRow> {
  const row = await findActiveCollection(db, id);
  if (!row) throw new NotFoundError(`Collection ${id} not found`);
  return row;
}

async function lockActiveCollection(db: DbExecutor, id: string): Promise<CollectionRow> {
  const row = await first(
    db.select().from(collections).where(and(eq(collections.id, id), isNull(collections.deletedAt))).limit(1).for("update"),
  );
  if (!row) throw new NotFoundError(`Collection ${id} not found`);
  return row;
}

export async function findActiveCollectionByName(db: DbExecutor, name: string, excludeId?: string): Promise<CollectionRow | undefined> {
  const rows = await db
    .select()
    .from(collections)
    .where(and(eq(collections.nameKey, nameKey(name)), isNull(collections.deletedAt)));
  return rows.find((row) => row.id !== excludeId);
}

export function collectionNameConflictError(name: string, existingId: string): ConflictError {
  return new ConflictError(`A collection named "${name}" already exists`, "COLLECTION_NAME_CONFLICT", {
    name,
    conflictingId: existingId,
  });
}

export async function listCollections(db: AppDatabase): Promise<CollectionSummary[]> {
  const rows = await db
    .select()
    .from(collections)
    .where(isNull(collections.deletedAt));
  return (await Promise.all(rows.map((row) => toSummary(db, row)))).sort(compareByName);
}

export async function getCollectionVersions(db: AppDatabase, id: string) {
  await requireActiveCollection(db, id);
  return listCollectionVersions(db, id);
}

export async function restoreCollectionVersion(
  db: AppDatabase,
  id: string,
  versionId: string,
  actorId: string,
): Promise<CollectionSummary> {
  return db.transaction(async (tx) => {
    const current = await lockActiveCollection(tx, id);
    const version = await findCollectionVersion(tx, id, versionId);
    const snapshot = version.snapshot;
    const existing = await findActiveCollectionByName(tx, snapshot.name, id);
    if (existing) throw collectionNameConflictError(snapshot.name, existing.id);

    await recordCollectionVersion(tx, id, { name: current.name, description: current.description, auth: current.authConfig }, actorId);
    await tx
      .update(collections)
      .set({
        name: snapshot.name,
        nameKey: nameKey(snapshot.name),
        description: snapshot.description,
        authConfig: snapshot.auth ?? null,
        updatedAt: nowIso(),
        updatedBy: actorId,
      })
      .where(eq(collections.id, id));
    return toSummary(tx, await requireActiveCollection(tx, id));
  });
}

export async function readCollection(db: DbExecutor, id: string): Promise<CollectionAggregate> {
  const row = await requireActiveCollection(db, id);
  const [summary, tree] = await Promise.all([toSummary(db, row), loadActiveTree(db, id)]);
  return { ...summary, auth: row.authConfig, items: tree.roots };
}

export function createCollection(db: AppDatabase, input: CreateCollectionInput, actorId: string): Promise<CollectionAggregate> {
  return db.transaction(async (tx) => {
      const existing = await findActiveCollectionByName(tx, input.name);
      if (existing) throw collectionNameConflictError(input.name, existing.id);

      const id = newId();
      const timestamp = nowIso();
      await tx.insert(collections)
        .values({
          id,
          name: input.name,
          nameKey: nameKey(input.name),
          description: input.description,
          authConfig: input.auth,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        ;
      await insertTree(tx, id, null, input.items, timestamp, actorId);
      return readCollection(tx, id);
    });
}

/** Saves collection-level metadata only; the item tree is never touched. */
export function updateCollection(db: AppDatabase, id: string, input: UpdateCollectionInput, actorId: string): Promise<CollectionSummary> {
  return db.transaction(async (tx) => {
      const current = await lockActiveCollection(tx, id);
      const existing = await findActiveCollectionByName(tx, input.name, id);
      if (existing) throw collectionNameConflictError(input.name, existing.id);

      await recordCollectionVersion(tx, id, { name: current.name, description: current.description, auth: current.authConfig }, actorId);
      const changes = {
        name: input.name,
        nameKey: nameKey(input.name),
        description: input.description,
        updatedAt: nowIso(),
        updatedBy: actorId,
        ...(input.auth !== undefined ? { authConfig: input.auth } : {}),
      };
      await tx.update(collections)
        .set(changes)
        .where(eq(collections.id, id))
        ;
      return toSummary(tx, await requireActiveCollection(tx, id));
    });
}

/** Moves a collection and all of its active items to Trash as one restorable root. */
export function trashCollection(db: AppDatabase, id: string, actorId: string): Promise<{ id: string; deletedAt: string }> {
  return db.transaction(async (tx) => {
      await requireActiveCollection(tx, id);
      const timestamp = nowIso();
      await tx.update(items)
        .set({ deletedAt: timestamp, trashRootId: id, updatedAt: timestamp, updatedBy: actorId })
        .where(and(eq(items.collectionId, id), isNull(items.deletedAt)))
        ;
      await tx.update(collections).set({ deletedAt: timestamp, updatedAt: timestamp, updatedBy: actorId }).where(eq(collections.id, id));
      return { id, deletedAt: timestamp };
    });
}
