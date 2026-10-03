import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collections, items, openapiSyncItems, openapiSyncs } from "../db/schema.js";
import { BadRequestError, ConflictError } from "../errors.js";
import type { ApplyOpenApiSyncInput } from "../validation/openapiSchemas.js";
import type { RequestItemFields, ScopedAuth } from "../validation/schemas.js";
import { convertOpenApiSpec, type OpenApiConversion, type OpenApiOperation } from "./openapi.js";
import { requireActiveCollection, readCollection } from "./collections.js";
import { findActiveSiblingFolder, type DbExecutor, type ItemNode, type RequestNode, writeRequestDetails } from "./tree.js";
import { nameKey, newId, nowIso } from "./common.js";
import { recordItemVersion, recordTreeSnapshot } from "./versions.js";
import { redactRequestAuth, redactSensitiveJsonText, redactSensitiveUrl } from "./openapiValues.js";
import { recordActivity } from "./activity.js";

type SyncRow = typeof openapiSyncItems.$inferSelect;
type SyncSourceRow = typeof openapiSyncs.$inferSelect;

type SyncChangeKind =
  | "add"
  | "adopt"
  | "update"
  | "move"
  | "unchanged"
  | "local-edit"
  | "conflict"
  | "delete"
  | "delete-conflict"
  | "missing";

export interface OpenApiSyncChange {
  key: string;
  kind: SyncChangeKind;
  contractChanged?: boolean;
  recreatable?: boolean;
  operationId?: string;
  method: RequestItemFields["method"];
  path: string;
  itemId?: string;
  candidateItemIds?: string[];
  changedFields?: string[];
  before?: Partial<RequestItemFields>;
  after?: Partial<RequestItemFields>;
  beforeFolderPath?: string[];
  afterFolderPath?: string[];
}

export interface OpenApiSyncPreview {
  collectionId: string;
  linked: boolean;
  source: { title: string; version: string };
  previewToken: string;
  changes: OpenApiSyncChange[];
  warnings: OpenApiConversion["warnings"];
}

interface InternalPlan {
  preview: OpenApiSyncPreview;
  conversion: OpenApiConversion;
  syncSource: SyncSourceRow | undefined;
  syncRows: SyncRow[];
  requestsById: Map<string, RequestNode>;
  folderPathByRequestId: Map<string, string[]>;
  operationsByKey: Map<string, OpenApiOperation>;
  staleById: Map<string, SyncRow>;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationKey(operation: Pick<OpenApiOperation, "operationId" | "method" | "requestPath">): string {
  return operation.operationId
    ? `operationId:${operation.operationId}`
    : `route:${operation.method}:${operation.requestPath}`;
}

function routeKey(method: string, path: string): string {
  return `route:${method}:${path.replace(/\{\{([^{}]+)\}\}/g, "{$1}")}`;
}

function sourcePath(operation: OpenApiOperation): string {
  return operation.requestPath.replace(/\{\{([^{}]+)\}\}/g, "{$1}");
}

function sameFolderPath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => nameKey(name) === nameKey(right[index]!));
}

function requestPath(url: string): string {
  const absolute = url.match(/^[a-z][a-z\d+.-]*:\/\/[^/?#]+([^?#]*)/i);
  const path = absolute
    ? absolute[1] || "/"
    : url.startsWith("{{baseUrl}}")
      ? url.slice("{{baseUrl}}".length).split(/[?#]/, 1)[0] || "/"
      : url.split(/[?#]/, 1)[0] || "/";
  return path.replace(/\{\{([^{}]+)\}\}/g, "{$1}");
}

function snapshot(node: RequestNode): RequestItemFields {
  return {
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
    preRequestScriptIds: node.preRequestScriptIds,
    postResponseScriptIds: node.postResponseScriptIds,
  };
}

function flattenRequests(nodes: ItemNode[], target = new Map<string, RequestNode>()): Map<string, RequestNode> {
  for (const node of nodes) {
    if (node.type === "folder") flattenRequests(node.items, target);
    else target.set(node.id, node);
  }
  return target;
}

function mapRequestFolderPaths(
  nodes: ItemNode[],
  path: string[] = [],
  target = new Map<string, string[]>(),
): Map<string, string[]> {
  for (const node of nodes) {
    if (node.type === "folder") mapRequestFolderPaths(node.items, [...path, node.name], target);
    else target.set(node.id, path);
  }
  return target;
}

function changedFields(before: RequestItemFields, after: RequestItemFields): string[] {
  return (Object.keys(after) as Array<keyof RequestItemFields>).filter((key) => stable(before[key]) !== stable(after[key]));
}

function identityHash(key: string): string {
  return sha256(key);
}

function specHash(conversion: OpenApiConversion): string {
  return sha256(stable({
    title: conversion.name,
    version: conversion.sourceVersion,
    componentSchemas: conversion.componentSchemas,
    operations: conversion.operations.map((operation) => ({
      key: operationKey(operation),
      path: operation.path,
      fields: operation.fields,
      responses: operation.responses,
      folderPath: operation.folderPath,
      folderAuth: operation.folderAuth,
      folderDescriptions: operation.folderDescriptions,
    })),
  }));
}

function previewFields(fields: RequestItemFields): Partial<RequestItemFields> {
  const isSensitive = (key: string) => /(?:token|secret|password|api[-_]?key|authorization|credential|cookie)/i.test(key);
  const auth = redactRequestAuth(fields.auth);
  const safeRows = (rows: RequestItemFields["headers"]) => rows.map((row) => ({
    ...row,
    ...(isSensitive(row.key) ? { value: `{{${row.key}}}` } : {}),
  }));
  let body = fields.body;
  if (body?.type === "json") {
    body = { ...body, content: redactSensitiveJsonText(body.content).value };
  }
  return {
    name: fields.name,
    description: fields.description,
    method: fields.method,
    url: redactSensitiveUrl(fields.url).value,
    queryParams: safeRows(fields.queryParams),
    headers: safeRows(fields.headers),
    body,
    auth,
  };
}

function allTrackedByRoute(rows: SyncRow[]): Map<string, SyncRow> {
  return new Map(rows.map((row) => [routeKey(row.method, row.path), row]));
}

function trackedForOperation(rows: SyncRow[], operation: OpenApiOperation): SyncRow | undefined {
  return (operation.operationId ? rows.find((row) => row.operationId === operation.operationId) : undefined)
    ?? rows.find((row) => routeKey(row.method, row.path) === routeKey(operation.method, sourcePath(operation)));
}

function ensureUniqueInputChoices(input: ApplyOpenApiSyncInput): void {
  if (new Set(input.deleteItemIds).size !== input.deleteItemIds.length) {
    throw new BadRequestError("deleteItemIds must not contain duplicates", "OPENAPI_SYNC_INVALID_CHOICE");
  }
  if (new Set(input.recreate).size !== input.recreate.length) {
    throw new BadRequestError("recreate must not contain duplicates", "OPENAPI_SYNC_INVALID_CHOICE");
  }
}

async function ensureFolderPath(
  db: DbExecutor,
  collectionId: string,
  operation: OpenApiOperation,
  actorId: string,
  timestamp: string,
): Promise<string | null> {
  let parentId: string | null = null;
  for (const [index, name] of operation.folderPath.entries()) {
    const existing = await findActiveSiblingFolder(db, collectionId, parentId, name);
    if (existing) {
      parentId = existing.id;
      continue;
    }
    const id = newId();
    await db.insert(items).values({
      id,
      collectionId,
      parentId,
      kind: "folder",
      name,
      nameKey: nameKey(name),
      description: operation.folderDescriptions[index] ?? "",
      authConfig: operation.folderAuth[index] ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: actorId,
      updatedBy: actorId,
    });
    parentId = id;
  }
  return parentId;
}

async function createRequestForSync(
  db: DbExecutor,
  collectionId: string,
  operation: OpenApiOperation,
  actorId: string,
  timestamp: string,
): Promise<string> {
  const id = newId();
  const parentId = await ensureFolderPath(db, collectionId, operation, actorId, timestamp);
  await db.insert(items).values({
    id,
    collectionId,
    parentId,
    kind: "request",
    name: operation.fields.name,
    nameKey: nameKey(operation.fields.name),
    description: operation.fields.description,
    authConfig: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: actorId,
    updatedBy: actorId,
  });
  await writeRequestDetails(db, id, operation.fields, true);
  return id;
}

async function writeRequestForSync(
  db: DbExecutor,
  current: RequestNode,
  fields: RequestItemFields,
  actorId: string,
  timestamp: string,
): Promise<void> {
  await recordItemVersion(db, current, actorId);
  await db.update(items)
    .set({
      name: fields.name,
      nameKey: nameKey(fields.name),
      description: fields.description,
      updatedAt: timestamp,
      updatedBy: actorId,
    })
    .where(and(eq(items.id, current.id), eq(items.collectionId, current.collectionId), isNull(items.deletedAt)));
  await writeRequestDetails(db, current.id, {
    ...fields,
    preRequestScriptIds: current.preRequestScriptIds,
    postResponseScriptIds: current.postResponseScriptIds,
  }, false);
}

async function moveRequestForSync(
  db: DbExecutor,
  current: RequestNode,
  operation: OpenApiOperation,
  actorId: string,
  timestamp: string,
): Promise<boolean> {
  const parentId = await ensureFolderPath(db, current.collectionId, operation, actorId, timestamp);
  if (parentId === current.parentId) return false;
  await db.update(items)
    .set({ parentId, updatedAt: timestamp, updatedBy: actorId })
    .where(and(eq(items.id, current.id), eq(items.collectionId, current.collectionId), isNull(items.deletedAt)));
  return true;
}

async function saveTracking(
  db: DbExecutor,
  collectionId: string,
  itemId: string,
  operation: OpenApiOperation,
  timestamp: string,
): Promise<void> {
  const existing = await db.select({ itemId: openapiSyncItems.itemId })
    .from(openapiSyncItems)
    .where(eq(openapiSyncItems.itemId, itemId))
    .limit(1);
  const values = {
    collectionId,
    identityHash: identityHash(operationKey(operation)),
    operationId: operation.operationId,
    method: operation.method,
    path: sourcePath(operation),
    sourceFolderPath: operation.folderPath,
    sourceSnapshot: operation.fields,
    updatedAt: timestamp,
  };
  if (existing.length > 0) {
    await db.update(openapiSyncItems).set(values).where(eq(openapiSyncItems.itemId, itemId));
  } else {
    await db.insert(openapiSyncItems).values({ itemId, ...values });
  }
}

async function updateSyncSource(
  db: DbExecutor,
  collectionId: string,
  conversion: OpenApiConversion,
  timestamp: string,
  actorId: string,
): Promise<void> {
  if (conversion.name.length > 200 || conversion.sourceVersion.length > 100) {
    throw new BadRequestError("OpenAPI title or version is too long for sync metadata", "OPENAPI_SYNC_METADATA_TOO_LONG");
  }
  const values = {
    specHash: specHash(conversion),
    specTitle: conversion.name,
    specVersion: conversion.sourceVersion,
    sourceSpec: {
      openapiVersion: conversion.sourceVersion,
      componentsSchemas: conversion.componentSchemas,
      operations: conversion.operations.map((operation) => ({
        operationId: operation.operationId,
        method: operation.method,
        path: sourcePath(operation),
        responses: operation.responses,
      })),
    },
    syncedAt: timestamp,
    updatedBy: actorId,
  };
  const [existing] = await db.select({ collectionId: openapiSyncs.collectionId })
    .from(openapiSyncs)
    .where(eq(openapiSyncs.collectionId, collectionId))
    .limit(1);
  if (existing) {
    await db.update(openapiSyncs).set(values).where(eq(openapiSyncs.collectionId, collectionId));
  } else {
    await db.insert(openapiSyncs).values({ collectionId, ...values });
  }
}

async function buildPlan(db: DbExecutor, collectionId: string, conversion: OpenApiConversion): Promise<InternalPlan> {
  if (
    conversion.name.length > 200
    || conversion.sourceVersion.length > 100
    || conversion.operations.some((operation) => (operation.operationId?.length ?? 0) > 500)
  ) {
    throw new BadRequestError("OpenAPI title, version, or operationId is too long for sync metadata", "OPENAPI_SYNC_METADATA_TOO_LONG");
  }
  await requireActiveCollection(db, collectionId);
  const collection = await readCollection(db, collectionId);
  const requestsById = flattenRequests(collection.items);
  const folderPathByRequestId = mapRequestFolderPaths(collection.items);
  const [syncSource] = await db.select().from(openapiSyncs).where(eq(openapiSyncs.collectionId, collectionId)).limit(1);
  const syncRows = await db.select().from(openapiSyncItems).where(eq(openapiSyncItems.collectionId, collectionId));
  const trackedById = new Map(syncRows.map((row) => [row.itemId, row]));
  const byOperationId = new Map(syncRows.filter((row) => row.operationId).map((row) => [row.operationId!, row]));
  const byRoute = allTrackedByRoute(syncRows);
  const operationsByKey = new Map<string, OpenApiOperation>();
  const matchedTrackedIds = new Set<string>();
  const changes: OpenApiSyncChange[] = [];
  const sourceHash = specHash(conversion);

  for (const operation of conversion.operations) {
    const key = operationKey(operation);
    if (operationsByKey.has(key)) {
      throw new BadRequestError(`OpenAPI contains duplicate sync identity "${key}"`, "OPENAPI_DUPLICATE_OPERATION_ID", { key });
    }
    operationsByKey.set(key, operation);
    const tracked = (operation.operationId ? byOperationId.get(operation.operationId) : undefined)
      ?? byRoute.get(routeKey(operation.method, sourcePath(operation)));
    if (tracked) {
      matchedTrackedIds.add(tracked.itemId);
      const current = requestsById.get(tracked.itemId);
      if (!current) {
        changes.push({
          key,
          kind: "missing",
          recreatable: true,
          operationId: operation.operationId ?? undefined,
          method: operation.method,
          path: sourcePath(operation),
          itemId: tracked.itemId,
        });
        continue;
      }
      const before = snapshot(current);
      const baseline = tracked.sourceSnapshot;
      const previousContract = syncSource?.sourceSpec?.operations.find((candidate) =>
        operation.operationId
          ? candidate.operationId === operation.operationId
          : candidate.method === operation.method && routeKey(candidate.method, candidate.path) === routeKey(operation.method, sourcePath(operation)));
      const contractChanged = syncSource?.sourceSpec
        ? stable({
            componentsSchemas: syncSource.sourceSpec.componentsSchemas,
            responses: previousContract?.responses ?? {},
          }) !== stable({
            componentsSchemas: conversion.componentSchemas,
            responses: operation.responses,
          })
        : Object.keys(operation.responses).length > 0;
      const sourceChanged = stable(baseline) !== stable(operation.fields);
      const localChanged = stable(baseline) !== stable(before);
      const needsMove = !sameFolderPath(folderPathByRequestId.get(current.id) ?? [], operation.folderPath);
      const fieldsChanged = changedFields(before, operation.fields);
      if (needsMove) fieldsChanged.push("folderPath");
      const kind: SyncChangeKind = !sourceChanged && !localChanged
        ? needsMove ? "move" : "unchanged"
        : sourceChanged && !localChanged
          ? "update"
          : !sourceChanged
            ? "local-edit"
            : stable(before) === stable(operation.fields)
              ? "unchanged"
              : "conflict";
      changes.push({
        key,
        kind,
        operationId: operation.operationId ?? undefined,
        method: operation.method,
        path: sourcePath(operation),
        itemId: current.id,
        ...(contractChanged ? { contractChanged: true } : {}),
        changedFields: kind === "local-edit"
          ? [...changedFields(baseline, before), ...(contractChanged ? ["responses"] : [])]
          : [...fieldsChanged, ...(contractChanged ? ["responses"] : [])],
        ...(kind === "update" || kind === "conflict"
          ? { before: previewFields(before), after: previewFields(operation.fields) }
          : {}),
        ...(needsMove
          ? {
              beforeFolderPath: folderPathByRequestId.get(current.id) ?? [],
              afterFolderPath: operation.folderPath,
            }
          : {}),
      });
      continue;
    }

    const candidates = [...requestsById.values()].filter((request) =>
      !trackedById.has(request.id)
      && request.method === operation.method
      && requestPath(request.url) === sourcePath(operation));
    changes.push({
      key,
      kind: candidates.length > 0 ? "adopt" : "add",
      operationId: operation.operationId ?? undefined,
      method: operation.method,
      path: sourcePath(operation),
      candidateItemIds: candidates.map((request) => request.id),
      ...(candidates.length > 0 ? { after: previewFields(operation.fields) } : {}),
      afterFolderPath: operation.folderPath,
    });
  }

  const staleById = new Map<string, SyncRow>();
  for (const row of syncRows) {
    if (matchedTrackedIds.has(row.itemId)) continue;
    staleById.set(row.itemId, row);
    const current = requestsById.get(row.itemId);
    if (!current) {
      changes.push({
        key: row.operationId ? `operationId:${row.operationId}` : routeKey(row.method, row.path),
        kind: "missing",
        operationId: row.operationId ?? undefined,
        method: row.method,
        path: row.path,
        itemId: row.itemId,
      });
      continue;
    }
    const localChanged = stable(snapshot(current)) !== stable(row.sourceSnapshot);
    changes.push({
      key: row.operationId ? `operationId:${row.operationId}` : routeKey(row.method, row.path),
      kind: localChanged ? "delete-conflict" : "delete",
      operationId: row.operationId ?? undefined,
      method: row.method,
      path: row.path,
      itemId: row.itemId,
      ...(localChanged
        ? { changedFields: changedFields(row.sourceSnapshot, snapshot(current)), before: previewFields(snapshot(current)) }
        : {}),
    });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.kind.localeCompare(b.kind));
  const token = sha256(stable({
    collection,
    sourceHash,
    syncSource,
    syncRows: [...syncRows].sort((a, b) => a.itemId.localeCompare(b.itemId)),
  }));
  return {
    preview: {
      collectionId,
      linked: syncSource !== undefined,
      source: { title: conversion.name, version: conversion.sourceVersion },
      previewToken: token,
      changes,
      warnings: conversion.warnings,
    },
    conversion,
    syncSource,
    syncRows,
    requestsById,
    folderPathByRequestId,
    operationsByKey,
    staleById,
  };
}

export async function previewOpenApiSync(
  db: AppDatabase,
  collectionId: string,
  spec: Parameters<typeof convertOpenApiSpec>[0],
): Promise<OpenApiSyncPreview> {
  const conversion = convertOpenApiSpec(spec);
  return (await buildPlan(db, collectionId, conversion)).preview;
}

export interface OpenApiSyncApplyResult {
  collectionId: string;
  changedAt: string;
  applied: { added: number; adopted: number; updated: number; moved: number; deleted: number; recreated: number };
  pending: OpenApiSyncChange[];
  deletedItemIds: string[];
}

export function applyOpenApiSync(
  db: AppDatabase,
  collectionId: string,
  input: ApplyOpenApiSyncInput,
  actorId: string,
): Promise<OpenApiSyncApplyResult> {
  ensureUniqueInputChoices(input);
  const conversion = convertOpenApiSpec(input.spec);
  return db.transaction(async (tx) => {
    await tx.select({ id: collections.id })
      .from(collections)
      .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
      .for("update");
    const collection = await requireActiveCollection(tx, collectionId);
    await tx.select().from(openapiSyncItems)
      .where(eq(openapiSyncItems.collectionId, collectionId))
      .for("update");
    await tx.select({ id: items.id })
      .from(items)
      .where(eq(items.collectionId, collectionId))
      .for("update");

    const plan = await buildPlan(tx, collectionId, conversion);
    if (input.previewToken.toLowerCase() !== plan.preview.previewToken) {
      throw new ConflictError("The collection or spec changed after preview; create a new preview", "OPENAPI_SYNC_PREVIEW_STALE");
    }
    const changeByKey = new Map(plan.preview.changes.map((change) => [change.key, change]));
    for (const [key, itemId] of Object.entries(input.adopt)) {
      const change = changeByKey.get(key);
      if (change?.kind !== "adopt" || !change.candidateItemIds?.includes(itemId)) {
        throw new BadRequestError(`Item ${itemId} is not an adoption candidate for "${key}"`, "OPENAPI_SYNC_INVALID_CHOICE", { key, itemId });
      }
    }
    for (const [key, resolution] of Object.entries(input.conflicts)) {
      const change = changeByKey.get(key);
      if (change?.kind !== "conflict") {
        throw new BadRequestError(`"${key}" is not a sync conflict`, "OPENAPI_SYNC_INVALID_CHOICE", { key, resolution });
      }
    }
    for (const change of plan.preview.changes) {
      if (change.kind === "conflict" && input.conflicts[change.key] === undefined) {
        throw new BadRequestError(`Choose whether to keep or replace local changes for "${change.key}"`, "OPENAPI_SYNC_RESOLUTION_REQUIRED", {
          key: change.key,
          itemId: change.itemId,
        });
      }
    }
    for (const itemId of input.deleteItemIds) {
      if (!plan.staleById.has(itemId)) {
        throw new BadRequestError(`Item ${itemId} is not pending removal from this sync source`, "OPENAPI_SYNC_INVALID_CHOICE", { itemId });
      }
    }
    for (const key of input.recreate) {
      if (changeByKey.get(key)?.kind !== "missing" || !plan.operationsByKey.has(key)) {
        throw new BadRequestError(`"${key}" is not a missing tracked operation`, "OPENAPI_SYNC_INVALID_CHOICE", { key });
      }
    }

    await recordTreeSnapshot(tx, collectionId, actorId);
    const timestamp = nowIso();
    const applied = { added: 0, adopted: 0, updated: 0, moved: 0, deleted: 0, recreated: 0 };
    const deletedItemIds: string[] = [];
    await updateSyncSource(tx, collectionId, conversion, timestamp, actorId);
    const trackedByOperation = plan.conversion.operations.map((operation) => ({
      operation,
      row: trackedForOperation(plan.syncRows, operation),
    }));
    for (const { operation, row } of trackedByOperation) {
      const key = operationKey(operation);
      const change = changeByKey.get(key)!;
      if (change.kind === "missing") {
        if (!input.recreate.includes(key)) continue;
        if (row) await tx.delete(openapiSyncItems).where(eq(openapiSyncItems.itemId, row.itemId));
        const itemId = await createRequestForSync(tx, collectionId, operation, actorId, timestamp);
        await saveTracking(tx, collectionId, itemId, operation, timestamp);
        applied.recreated += 1;
        continue;
      }
      if (change.kind === "adopt") {
        const candidateId = input.adopt[key];
        if (!candidateId) {
          const itemId = await createRequestForSync(tx, collectionId, operation, actorId, timestamp);
          await saveTracking(tx, collectionId, itemId, operation, timestamp);
          applied.added += 1;
        } else {
          const current = plan.requestsById.get(candidateId);
          if (!current) throw new ConflictError("An adoption candidate is no longer active", "OPENAPI_SYNC_PREVIEW_STALE", { itemId: candidateId });
          if (stable(snapshot(current)) !== stable(operation.fields)) {
            await writeRequestForSync(tx, current, operation.fields, actorId, timestamp);
          }
          if (!sameFolderPath(plan.folderPathByRequestId.get(candidateId) ?? [], operation.folderPath)
            && await moveRequestForSync(tx, current, operation, actorId, timestamp)) {
            applied.moved += 1;
          }
          await saveTracking(tx, collectionId, candidateId, operation, timestamp);
          applied.adopted += 1;
        }
        continue;
      }
      if (change.kind === "add") {
        const itemId = await createRequestForSync(tx, collectionId, operation, actorId, timestamp);
        await saveTracking(tx, collectionId, itemId, operation, timestamp);
        applied.added += 1;
        continue;
      }

      if (!row || !change.itemId) continue;
      const current = plan.requestsById.get(change.itemId);
      if (!current) continue;
      if (!sameFolderPath(plan.folderPathByRequestId.get(current.id) ?? [], operation.folderPath)
        && await moveRequestForSync(tx, current, operation, actorId, timestamp)) {
        applied.moved += 1;
      }
      if (change.kind === "update" || (change.kind === "conflict" && input.conflicts[key] === "spec")) {
        await writeRequestForSync(tx, current, operation.fields, actorId, timestamp);
        applied.updated += 1;
      }
      await saveTracking(
        tx,
        collectionId,
        current.id,
        operation,
        timestamp,
      );
      if (change.kind === "local-edit") {
        await tx.update(openapiSyncItems)
          .set({ sourceSnapshot: row.sourceSnapshot })
          .where(eq(openapiSyncItems.itemId, current.id));
      }
    }

    for (const [itemId, row] of plan.staleById) {
      if (!input.deleteItemIds.includes(itemId)) continue;
      const current = plan.requestsById.get(itemId);
      if (current) {
        await tx.update(items)
          .set({ deletedAt: timestamp, trashRootId: itemId, updatedAt: timestamp, updatedBy: actorId })
          .where(and(eq(items.id, itemId), eq(items.collectionId, collectionId), isNull(items.deletedAt)));
        applied.deleted += 1;
        deletedItemIds.push(itemId);
      }
      await tx.delete(openapiSyncItems).where(eq(openapiSyncItems.itemId, row.itemId));
    }

    const pending = plan.preview.changes.filter((change) =>
      (change.kind === "delete" || change.kind === "delete-conflict")
        ? !input.deleteItemIds.includes(change.itemId ?? "")
        : change.kind === "missing"
          && !input.recreate.includes(change.key)
          && !input.deleteItemIds.includes(change.itemId ?? ""));
    await recordActivity(tx, {
      teamId: collection.teamId,
      actorId,
      action: "collection.openapi_synced",
      resourceType: "collection",
      resourceId: collectionId,
      resourceName: collection.name,
      details: { ...applied, pendingCount: pending.length },
      createdAt: timestamp,
    });

    return {
      collectionId,
      changedAt: timestamp,
      applied,
      pending,
      deletedItemIds,
    };
  });
}
