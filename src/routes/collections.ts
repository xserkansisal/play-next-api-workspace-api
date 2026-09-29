import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import { createCollection, listCollections, readCollection, trashCollection, updateCollection } from "../services/collections.js";
import { createItem, readItem, trashItem, updateItem } from "../services/items.js";
import {
  createCollectionSchema,
  createItemSchema,
  updateCollectionSchema,
  updateItemSchema,
} from "../validation/schemas.js";

// Services commit synchronously before returning, so publishing afterwards only reports committed writes.
export function createCollectionsRouter(db: AppDatabase, events: ChangeEventHub): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ collections: listCollections(db) });
  });

  router.post("/", (req, res) => {
    const collection = createCollection(db, createCollectionSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: "collection", id: collection.id, collectionId: null, operation: "created", changedAt: collection.updatedAt });
    res.status(201).json(collection);
  });

  router.get("/:collectionId", (req, res) => {
    res.json(readCollection(db, req.params.collectionId));
  });

  router.put("/:collectionId", (req, res) => {
    const collection = updateCollection(db, req.params.collectionId, updateCollectionSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: "collection", id: collection.id, collectionId: null, operation: "updated", changedAt: collection.updatedAt });
    res.json(collection);
  });

  router.delete("/:collectionId", (req, res) => {
    const trashed = trashCollection(db, req.params.collectionId, authenticatedUserId(req));
    events.publish({ kind: "collection", id: trashed.id, collectionId: null, operation: "trashed", changedAt: trashed.deletedAt });
    res.status(204).end();
  });

  router.post("/:collectionId/items", (req, res) => {
    const item = createItem(db, req.params.collectionId, createItemSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: item.type, id: item.id, collectionId: item.collectionId, operation: "created", changedAt: item.updatedAt });
    res.status(201).json(item);
  });

  router.get("/:collectionId/items/:itemId", (req, res) => {
    res.json(readItem(db, req.params.collectionId, req.params.itemId));
  });

  router.put("/:collectionId/items/:itemId", (req, res) => {
    const item = updateItem(db, req.params.collectionId, req.params.itemId, updateItemSchema.parse(req.body), authenticatedUserId(req));
    events.publish({ kind: item.type, id: item.id, collectionId: item.collectionId, operation: "updated", changedAt: item.updatedAt });
    res.json(item);
  });

  router.delete("/:collectionId/items/:itemId", (req, res) => {
    const trashed = trashItem(db, req.params.collectionId, req.params.itemId, authenticatedUserId(req));
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
