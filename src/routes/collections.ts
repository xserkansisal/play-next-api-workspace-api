import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId } from "../middleware/authenticate.js";
import { createCollection, listCollections, readCollection, trashCollection, updateCollection } from "../services/collections.js";
import { cloneCollection, cloneItem } from "../services/clone.js";
import { createItem, readItem, trashItem, updateItem } from "../services/items.js";
import {
  createCollectionSchema,
  createItemSchema,
  updateCollectionSchema,
  updateItemSchema,
} from "../validation/schemas.js";

export function createCollectionsRouter(db: AppDatabase, events: ChangeEventHub): Router {
  const router = Router();

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
