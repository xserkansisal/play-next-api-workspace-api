import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import { createCollection, listCollections, readCollection, trashCollection, updateCollection } from "../services/collections.js";
import { cloneCollection, cloneItem } from "../services/clone.js";
import { createItem, readItem, trashItem, updateItem } from "../services/items.js";
import { moveItem } from "../services/move.js";
import { importItems } from "../services/import.js";
import { HttpError } from "../errors.js";
import { createUserRateLimit, type UserRateLimitOptions } from "../middleware/rateLimit.js";
import {
  createCollectionSchema,
  createItemSchema,
  importItemsSchema,
  MAX_IMPORT_NODES,
  MAX_TREE_DEPTH,
  measureImportShape,
  moveItemSchema,
  updateCollectionSchema,
  updateItemSchema,
} from "../validation/schemas.js";

export interface CollectionsRouterOptions {
  importRateLimit?: UserRateLimitOptions;
}

// Above this many imported roots, one collection-level event replaces one event per root: every
// event makes each watching tab refetch the tree, and enough of them would also push everything
// else out of the replay buffer.
const MAX_ROOT_EVENTS = 50;

export function createCollectionsRouter(db: AppDatabase, events: ChangeEventHub, options: CollectionsRouterOptions = {}): Router {
  const router = Router();
  const importRateLimit = createUserRateLimit(options.importRateLimit ?? { limit: 10, windowMs: 60_000 });

  router.get("/", async (_req, res) => {
    res.json({ collections: await listCollections(db) });
  });

  router.post("/", async (req, res) => {
    const collection = await createCollection(db, createCollectionSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: "collection", id: collection.id, collectionId: null, operation: "created", changedAt: collection.updatedAt });
    res.status(201).json(collection);
  });

  router.get("/:collectionId", async (req, res) => {
    res.json(await readCollection(db, req.params.collectionId));
  });

  router.put("/:collectionId", async (req, res) => {
    const collection = await updateCollection(db, req.params.collectionId, updateCollectionSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: "collection", id: collection.id, collectionId: null, operation: "updated", changedAt: collection.updatedAt });
    res.json(collection);
  });

  router.delete("/:collectionId", async (req, res) => {
    const trashed = await trashCollection(db, req.params.collectionId, authenticatedUserId(req));
    events.publish({ kind: "collection", id: trashed.id, collectionId: null, operation: "trashed", changedAt: trashed.deletedAt });
    res.status(204).end();
  });

  router.post("/:collectionId/clone", async (req, res) => {
    const collection = await cloneCollection(db, req.params.collectionId, authenticatedUserId(req));
    events.publish({ kind: "collection", id: collection.id, collectionId: null, operation: "created", changedAt: collection.updatedAt });
    res.status(201).json(collection);
  });

  router.post("/:collectionId/import", importRateLimit, async (req, res) => {
    // Measured before parsing: the tree schema is recursive, and this is what keeps a hostile
    // nesting depth from reaching it.
    const shape = measureImportShape(req.body);
    if (shape.nodes > MAX_IMPORT_NODES) {
      throw new HttpError(413, `An import may contain at most ${MAX_IMPORT_NODES} items`, "IMPORT_TOO_LARGE", {
        maxItems: MAX_IMPORT_NODES,
      });
    }
    if (shape.depth > MAX_TREE_DEPTH) {
      throw new HttpError(400, `Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`, "IMPORT_TOO_DEEP", {
        maxDepth: MAX_TREE_DEPTH,
      });
    }
    const input = importItemsSchema.parse(req.body);
    const result = await importItems(db, req.params.collectionId as string, input, authenticatedUserId(req));
    if (!result.dryRun) {
      if (result.roots.length > MAX_ROOT_EVENTS) {
        events.publish({ kind: "collection", id: result.collectionId, collectionId: null, operation: "updated", changedAt: result.changedAt });
      } else {
        for (const root of result.roots) {
          events.publish({ kind: root.kind, id: root.id, collectionId: result.collectionId, operation: "created", changedAt: result.changedAt });
        }
      }
    }
    res.status(result.dryRun ? 200 : 201).json(result);
  });

  router.post("/:collectionId/items", async (req, res) => {
    const item = await createItem(db, req.params.collectionId, createItemSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: item.type, id: item.id, collectionId: item.collectionId, operation: "created", changedAt: item.updatedAt });
    res.status(201).json(item);
  });

  router.get("/:collectionId/items/:itemId", async (req, res) => {
    res.json(await readItem(db, req.params.collectionId, req.params.itemId));
  });

  router.put("/:collectionId/items/:itemId", async (req, res) => {
    const item = await updateItem(db, req.params.collectionId, req.params.itemId, updateItemSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: item.type, id: item.id, collectionId: item.collectionId, operation: "updated", changedAt: item.updatedAt });
    res.json(item);
  });

  router.post("/:collectionId/items/:itemId/clone", async (req, res) => {
    const item = await cloneItem(db, req.params.collectionId, req.params.itemId, authenticatedUserId(req));
    events.publish({ kind: item.type, id: item.id, collectionId: item.collectionId, operation: "created", changedAt: item.updatedAt });
    res.status(201).json(item);
  });

  router.post("/:collectionId/items/:itemId/move", async (req, res) => {
    const { item, sourceCollectionId } = await moveItem(
      db,
      req.params.collectionId,
      req.params.itemId,
      moveItemSchema.parse(req.body),
      authenticatedUserId(req),
    );
    events.publish({ kind: item.type, id: item.id, collectionId: item.collectionId, operation: "move", changedAt: item.updatedAt });
    // A move across collections changes two trees. A tab showing only the source would otherwise
    // keep the item under its old parent until something else made it refetch.
    if (sourceCollectionId !== item.collectionId) {
      events.publish({ kind: item.type, id: item.id, collectionId: sourceCollectionId, operation: "move", changedAt: item.updatedAt });
    }
    res.json(item);
  });

  router.delete("/:collectionId/items/:itemId", async (req, res) => {
    const trashed = await trashItem(db, req.params.collectionId, req.params.itemId, authenticatedUserId(req));
    events.publish({
      kind: trashed.kind,
      id: trashed.id,
      collectionId: trashed.collectionId,
      operation: "trashed",
      changedAt: trashed.deletedAt,
    });
    res.status(204).end();
  });

  return router;
}
