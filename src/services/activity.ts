import { and, desc, eq, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
import { teamActivityLog, users } from "../db/schema.js";
import { BadRequestError } from "../errors.js";
import type { ActivityQuery } from "../validation/activitySchemas.js";
import type { DbExecutor } from "./tree.js";
import { nowIso } from "./common.js";

export type ActivityResourceType = "collection" | "folder" | "request" | "environment" | "variable";
export const ACTIVITY_ACTIONS = [
  "collection.created",
  "collection.updated",
  "collection.version_restored",
  "collection.cloned",
  "collection.trashed",
  "collection.restored",
  "collection.imported",
  "collection.openapi_synced",
  "item.created",
  "item.updated",
  "item.version_restored",
  "item.cloned",
  "item.moved",
  "item.trashed",
  "item.restored",
  "environment.created",
  "environment.variable_added",
  "environment.updated",
  "environment.cloned",
  "environment.trashed",
  "environment.restored",
  "variable.created",
  "variable.updated",
  "variable.renamed",
  "variable.deleted",
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface ActivityEntryInput {
  teamId: string;
  actorId: string;
  action: ActivityAction;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceName: string;
  collectionId?: string | null;
  details?: Record<string, unknown>;
  createdAt?: string;
}

export async function recordActivity(db: DbExecutor, entry: ActivityEntryInput): Promise<void> {
  const actor = await first(db.select({ email: users.email }).from(users).where(eq(users.id, entry.actorId)).limit(1));
  if (!actor) throw new Error(`Activity actor ${entry.actorId} does not exist`);
  await db.insert(teamActivityLog).values({
    id: randomUUID(),
    teamId: entry.teamId,
    actorId: entry.actorId,
    actorEmail: actor.email,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    resourceName: entry.resourceName,
    collectionId: entry.collectionId ?? null,
    details: entry.details ?? {},
    createdAt: entry.createdAt ?? nowIso(),
  });
}

export interface ActivityCursor {
  teamId: string;
  createdAt: string;
  id: string;
}

function encodeCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeActivityCursor(encoded: string, teamId: string): ActivityCursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      typeof value !== "object" || value === null
      || !("teamId" in value) || value.teamId !== teamId
      || !("createdAt" in value) || typeof value.createdAt !== "string"
      || !("id" in value) || typeof value.id !== "string"
      || !/^\d{4}-\d{2}-\d{2}T/.test(value.createdAt)
      || !/^[0-9a-f-]{36}$/i.test(value.id)
    ) throw new Error("Invalid activity cursor");
    return { teamId, createdAt: value.createdAt, id: value.id };
  } catch {
    throw new BadRequestError("Activity cursor is invalid", "ACTIVITY_CURSOR_INVALID");
  }
}

export async function listActivity(
  db: AppDatabase,
  teamId: string,
  query: ActivityQuery,
): Promise<{ entries: Array<{
  id: string;
  actor: string;
  action: string;
  resourceType: ActivityResourceType;
  resourceId: string;
  resourceName: string;
  collectionId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}>; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeActivityCursor(query.cursor, teamId) : undefined;
  const rows = await db
    .select({
      id: teamActivityLog.id,
      actor: teamActivityLog.actorEmail,
      action: teamActivityLog.action,
      resourceType: teamActivityLog.resourceType,
      resourceId: teamActivityLog.resourceId,
      resourceName: teamActivityLog.resourceName,
      collectionId: teamActivityLog.collectionId,
      details: teamActivityLog.details,
      createdAt: teamActivityLog.createdAt,
    })
    .from(teamActivityLog)
    .where(and(
      eq(teamActivityLog.teamId, teamId),
      cursor
        ? or(
            lt(teamActivityLog.createdAt, cursor.createdAt),
            and(eq(teamActivityLog.createdAt, cursor.createdAt), lt(teamActivityLog.id, cursor.id)),
          )
        : undefined,
    ))
    .orderBy(desc(teamActivityLog.createdAt), desc(teamActivityLog.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const entries = rows.slice(0, query.limit);
  const last = entries.at(-1);
  return {
    entries,
    nextCursor: hasMore && last ? encodeCursor({ teamId, createdAt: last.createdAt, id: last.id }) : null,
  };
}
