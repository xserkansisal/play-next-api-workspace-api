import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { CreateCollectionInput, UpdateCollectionInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId, nowIso } from "./common.js";
import { insertTree, loadActiveTree, type DbExecutor, type ItemNode } from "./tree.js";

export interface CollectionSummary {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionAggregate extends CollectionSummary {
  items: ItemNode[];
}

type CollectionRow = typeof collections.$inferSelect;

function toSummary(row: CollectionRow): CollectionSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function findActiveCollection(db: DbExecutor, id: string): CollectionRow | undefined {
  return db
    .select()
    .from(collections)
    .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
    .get();
}

export function requireActiveCollection(db: DbExecutor, id: string): CollectionRow {
  const row = findActiveCollection(db, id);
  if (!row) throw new NotFoundError(`Collection ${id} not found`);
  return row;
}

export function findActiveCollectionByName(db: DbExecutor, name: string, excludeId?: string): CollectionRow | undefined {
  return db
    .select()
    .from(collections)
    .where(and(eq(collections.nameKey, nameKey(name)), isNull(collections.deletedAt)))
    .all()
    .find((row) => row.id !== excludeId);
}

export function collectionNameConflictError(name: string, existingId: string): ConflictError {
  return new ConflictError(`A collection named "${name}" already exists`, "COLLECTION_NAME_CONFLICT", {
    name,
    conflictingId: existingId,
  });
}

export function listCollections(db: AppDatabase): CollectionSummary[] {
  return db
    .select()
    .from(collections)
    .where(isNull(collections.deletedAt))
    .all()
    .map(toSummary)
    .sort(compareByName);
}

export function readCollection(db: DbExecutor, id: string): CollectionAggregate {
  const row = requireActiveCollection(db, id);
  return { ...toSummary(row), items: loadActiveTree(db, id).roots };
}

export function createCollection(db: AppDatabase, input: CreateCollectionInput): CollectionAggregate {
  return db.transaction(
    (tx) => {
      const existing = findActiveCollectionByName(tx, input.name);
      if (existing) throw collectionNameConflictError(input.name, existing.id);

      const id = newId();
      const timestamp = nowIso();
      tx.insert(collections)
        .values({
          id,
          name: input.name,
          nameKey: nameKey(input.name),
          description: input.description,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
      insertTree(tx, id, null, input.items, timestamp);
      return readCollection(tx, id);
    },
    { behavior: "immediate" },
  );
}

/** Saves collection-level metadata only; the item tree is never touched. */
export function updateCollection(db: AppDatabase, id: string, input: UpdateCollectionInput): CollectionSummary {
  return db.transaction(
    (tx) => {
      requireActiveCollection(tx, id);
      const existing = findActiveCollectionByName(tx, input.name, id);
      if (existing) throw collectionNameConflictError(input.name, existing.id);

      tx.update(collections)
        .set({ name: input.name, nameKey: nameKey(input.name), description: input.description, updatedAt: nowIso() })
        .where(eq(collections.id, id))
        .run();
      return toSummary(requireActiveCollection(tx, id));
    },
    { behavior: "immediate" },
  );
}

/** Moves a collection and all of its active items to Trash as one restorable root. */
export function trashCollection(db: AppDatabase, id: string): void {
  db.transaction(
    (tx) => {
      requireActiveCollection(tx, id);
      const timestamp = nowIso();
      tx.update(items)
        .set({ deletedAt: timestamp, trashRootId: id })
        .where(and(eq(items.collectionId, id), isNull(items.deletedAt)))
        .run();
      tx.update(collections).set({ deletedAt: timestamp }).where(eq(collections.id, id)).run();
    },
    { behavior: "immediate" },
  );
}
