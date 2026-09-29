import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import { createCollection, listCollections, readCollection, trashCollection, updateCollection } from "../services/collections.js";
import { createItem, readItem, trashItem, updateItem } from "../services/items.js";
import {
  createCollectionSchema,
  createItemSchema,
  updateCollectionSchema,
  updateItemSchema,
} from "../validation/schemas.js";

export function createCollectionsRouter(db: AppDatabase): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ collections: listCollections(db) });
  });

  router.post("/", (req, res) => {
    res.status(201).json(createCollection(db, createCollectionSchema.parse(req.body)));
  });

  router.get("/:collectionId", (req, res) => {
    res.json(readCollection(db, req.params.collectionId));
  });

  router.put("/:collectionId", (req, res) => {
    res.json(updateCollection(db, req.params.collectionId, updateCollectionSchema.parse(req.body)));
  });

  router.delete("/:collectionId", (req, res) => {
    trashCollection(db, req.params.collectionId);
    res.status(204).end();
  });

  router.post("/:collectionId/items", (req, res) => {
    res.status(201).json(createItem(db, req.params.collectionId, createItemSchema.parse(req.body)));
  });

  router.get("/:collectionId/items/:itemId", (req, res) => {
    res.json(readItem(db, req.params.collectionId, req.params.itemId));
  });

  router.put("/:collectionId/items/:itemId", (req, res) => {
    res.json(updateItem(db, req.params.collectionId, req.params.itemId, updateItemSchema.parse(req.body)));
  });

  router.delete("/:collectionId/items/:itemId", (req, res) => {
    trashItem(db, req.params.collectionId, req.params.itemId);
    res.status(204).end();
  });

  return router;
}
