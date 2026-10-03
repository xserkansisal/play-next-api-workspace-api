import { Router } from "express";
import type { AppDatabase } from "../db/client.js";
import type { ChangeEventHub } from "../events/hub.js";
import { authenticatedUserId, requestTeamId } from "../middleware/authenticate.js";
import { guardCollectionParam } from "./teamGuards.js";
import {
  createCollection,
  getCollectionVersions,
  listCollections,
  readCollection,
  restoreCollectionVersion,
  trashCollection,
  updateCollection,
} from "../services/collections.js";
import { cloneCollection, cloneItem } from "../services/clone.js";
import { createItem, getItemVersions, readItem, restoreItemVersion, trashItem, updateItem } from "../services/items.js";
import { moveItem } from "../services/move.js";
import { importItems } from "../services/import.js";
import { convertOpenApiSpec } from "../services/openapi.js";
import { exportCollectionAsOpenApi } from "../services/openapiExport.js";
import { applyOpenApiSync, previewOpenApiSync } from "../services/openapiSync.js";
import { diffTreeSnapshots, getTreeSnapshot, listTreeSnapshots, restoreTreeSnapshot } from "../services/collectionSnapshots.js";
import { stringify as stringifyYaml } from "yaml";
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
  collectionSnapshotDiffQuerySchema,
  collectionSnapshotListQuerySchema,
} from "../validation/schemas.js";
import {
  createOpenApiCollectionSchema,
  exportOpenApiQuerySchema,
  applyOpenApiSyncSchema,
  importOpenApiSchema,
  previewOpenApiSyncSchema,
} from "../validation/openapiSchemas.js";

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
  guardCollectionParam(router, db);

  router.get("/", async (req, res) => {
    res.json({ collections: await listCollections(db, requestTeamId(req)) });
  });

  router.post("/openapi", importRateLimit, async (req, res) => {
    const input = createOpenApiCollectionSchema.parse(req.body);
    const converted = convertOpenApiSpec(input.spec);
    const collectionInput = createCollectionSchema.parse({
      name: input.name ?? converted.name,
      description: input.description ?? converted.description,
      auth: converted.auth,
      items: converted.items,
    });
    const collection = await createCollection(db, requestTeamId(req), collectionInput, authenticatedUserId(req));
    events.publish(requestTeamId(req), {
      kind: "collection",
      id: collection.id,
      collectionId: null,
      operation: "created",
      changedAt: collection.updatedAt,
    });
    res.status(201).json({ collection, warnings: converted.warnings });
  });

  router.post("/", async (req, res) => {
    const collection = await createCollection(db, requestTeamId(req), createCollectionSchema.parse(req.body), authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: "collection", id: collection.id, collectionId: null, operation: "created", changedAt: collection.updatedAt });
    res.status(201).json(collection);
  });

  router.get("/:collectionId", async (req, res) => {
    res.json(await readCollection(db, req.params.collectionId));
  });

  router.get("/:collectionId/export/openapi", async (req, res) => {
    const { version, format } = exportOpenApiQuerySchema.parse(req.query);
    const collection = await readCollection(db, req.params.collectionId);
    const document = exportCollectionAsOpenApi(collection, version);
    const body = format === "yaml" ? stringifyYaml(document) : `${JSON.stringify(document, null, 2)}\n`;
    const extension = format === "yaml" ? "yaml" : "json";
    const safeName = collection.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";
    res
      .type(format === "yaml" ? "application/yaml" : "application/vnd.oai.openapi+json")
      .attachment(`${safeName}-openapi.${extension}`)
      .send(body);
  });

  router.get("/:collectionId/versions", async (req, res) => {
    res.json({ versions: await getCollectionVersions(db, req.params.collectionId) });
  });

  router.get("/:collectionId/snapshots", async (req, res) => {
    const { limit, offset } = collectionSnapshotListQuerySchema.parse(req.query);
    res.json(await listTreeSnapshots(db, req.params.collectionId, limit, offset));
  });

  router.get("/:collectionId/snapshots/diff", async (req, res) => {
    const query = collectionSnapshotDiffQuerySchema.parse(req.query);
    res.json(await diffTreeSnapshots(db, req.params.collectionId, query.from, query.to));
  });

  router.get("/:collectionId/snapshots/:snapshotId", async (req, res) => {
    res.json(await getTreeSnapshot(db, req.params.collectionId, req.params.snapshotId));
  });

  router.post("/:collectionId/snapshots/:snapshotId/restore", async (req, res) => {
    const collection = await restoreTreeSnapshot(
      db,
      req.params.collectionId,
      req.params.snapshotId,
      authenticatedUserId(req),
    );
    events.publish(requestTeamId(req), {
      kind: "collection",
      id: collection.id,
      collectionId: null,
      operation: "updated",
      changedAt: collection.updatedAt,
    });
    res.json(collection);
  });

  router.post("/:collectionId/versions/:versionId/restore", async (req, res) => {
    const collection = await restoreCollectionVersion(
      db,
      req.params.collectionId,
      req.params.versionId,
      authenticatedUserId(req),
    );
    events.publish(requestTeamId(req), { kind: "collection", id: collection.id, collectionId: null, operation: "updated", changedAt: collection.updatedAt });
    res.json(collection);
  });

  router.put("/:collectionId", async (req, res) => {
    const collection = await updateCollection(db, req.params.collectionId, updateCollectionSchema.parse(req.body), authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: "collection", id: collection.id, collectionId: null, operation: "updated", changedAt: collection.updatedAt });
    res.json(collection);
  });

  router.delete("/:collectionId", async (req, res) => {
    const trashed = await trashCollection(db, req.params.collectionId, authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: "collection", id: trashed.id, collectionId: null, operation: "trashed", changedAt: trashed.deletedAt });
    res.status(204).end();
  });

  router.post("/:collectionId/clone", async (req, res) => {
    const collection = await cloneCollection(db, req.params.collectionId, authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: "collection", id: collection.id, collectionId: null, operation: "created", changedAt: collection.updatedAt });
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
        events.publish(requestTeamId(req), { kind: "collection", id: result.collectionId, collectionId: null, operation: "updated", changedAt: result.changedAt });
      } else {
        for (const root of result.roots) {
          events.publish(requestTeamId(req), { kind: root.kind, id: root.id, collectionId: result.collectionId, operation: "created", changedAt: result.changedAt });
        }
      }
    }
    res.status(result.dryRun ? 200 : 201).json(result);
  });

  router.post("/:collectionId/import/openapi", importRateLimit, async (req, res) => {
    const input = importOpenApiSchema.parse(req.body);
    const converted = convertOpenApiSpec(input.spec);
    const importInput = importItemsSchema.parse({
      parentId: input.parentId,
      onConflict: input.onConflict,
      dryRun: input.dryRun,
      items: converted.items,
    });
    const result = await importItems(db, req.params.collectionId as string, importInput, authenticatedUserId(req));
    if (!result.dryRun) {
      if (result.roots.length > MAX_ROOT_EVENTS) {
        events.publish(requestTeamId(req), {
          kind: "collection",
          id: result.collectionId,
          collectionId: null,
          operation: "updated",
          changedAt: result.changedAt,
        });
      } else {
        for (const root of result.roots) {
          events.publish(requestTeamId(req), {
            kind: root.kind,
            id: root.id,
            collectionId: result.collectionId,
            operation: "created",
            changedAt: result.changedAt,
          });
        }
      }
    }
    res.status(result.dryRun ? 200 : 201).json({ ...result, warnings: [...converted.warnings, ...result.warnings] });
  });

  router.post("/:collectionId/sync/openapi/preview", importRateLimit, async (req, res) => {
    const { spec } = previewOpenApiSyncSchema.parse(req.body);
    res.json(await previewOpenApiSync(db, req.params.collectionId as string, spec));
  });

  router.post("/:collectionId/sync/openapi/apply", importRateLimit, async (req, res) => {
    const result = await applyOpenApiSync(
      db,
      req.params.collectionId as string,
      applyOpenApiSyncSchema.parse(req.body),
      authenticatedUserId(req),
    );
    for (const itemId of result.deletedItemIds) {
      events.publish(requestTeamId(req), {
        kind: "request",
        id: itemId,
        collectionId: result.collectionId,
        operation: "trashed",
        changedAt: result.changedAt,
      });
    }
    if (result.applied.added + result.applied.adopted + result.applied.updated + result.applied.moved + result.applied.recreated > 0) {
      events.publish(requestTeamId(req), {
        kind: "collection",
        id: result.collectionId,
        collectionId: null,
        operation: "updated",
        changedAt: result.changedAt,
      });
    }
    res.json(result);
  });

  router.post("/:collectionId/items", async (req, res) => {
    const item = await createItem(db, req.params.collectionId, createItemSchema.parse(req.body), authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: item.type, id: item.id, collectionId: item.collectionId, operation: "created", changedAt: item.updatedAt });
    res.status(201).json(item);
  });

  router.get("/:collectionId/items/:itemId", async (req, res) => {
    res.json(await readItem(db, req.params.collectionId, req.params.itemId));
  });

  router.get("/:collectionId/items/:itemId/versions", async (req, res) => {
    res.json({ versions: await getItemVersions(db, req.params.collectionId, req.params.itemId) });
  });

  router.post("/:collectionId/items/:itemId/versions/:versionId/restore", async (req, res) => {
    const item = await restoreItemVersion(
      db,
      req.params.collectionId,
      req.params.itemId,
      req.params.versionId,
      authenticatedUserId(req),
    );
    events.publish(requestTeamId(req), { kind: item.type, id: item.id, collectionId: item.collectionId, operation: "updated", changedAt: item.updatedAt });
    res.json(item);
  });

  router.put("/:collectionId/items/:itemId", async (req, res) => {
    const item = await updateItem(db, req.params.collectionId, req.params.itemId, updateItemSchema.parse(req.body), authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: item.type, id: item.id, collectionId: item.collectionId, operation: "updated", changedAt: item.updatedAt });
    res.json(item);
  });

  router.post("/:collectionId/items/:itemId/clone", async (req, res) => {
    const item = await cloneItem(db, req.params.collectionId, req.params.itemId, authenticatedUserId(req));
    events.publish(requestTeamId(req), { kind: item.type, id: item.id, collectionId: item.collectionId, operation: "created", changedAt: item.updatedAt });
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
    events.publish(requestTeamId(req), { kind: item.type, id: item.id, collectionId: item.collectionId, operation: "move", changedAt: item.updatedAt });
    // A move across collections changes two trees. A tab showing only the source would otherwise
    // keep the item under its old parent until something else made it refetch.
    if (sourceCollectionId !== item.collectionId) {
      events.publish(requestTeamId(req), { kind: item.type, id: item.id, collectionId: sourceCollectionId, operation: "move", changedAt: item.updatedAt });
    }
    res.json(item);
  });

  router.delete("/:collectionId/items/:itemId", async (req, res) => {
    const trashed = await trashItem(db, req.params.collectionId, req.params.itemId, authenticatedUserId(req));
    events.publish(requestTeamId(req), {
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
