import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { teams, userPreferences, users, variableDisplayOrders, variables } from "../db/schema.js";
import { ConflictError, HttpError, NotFoundError } from "../errors.js";
import type { VariableOrderPreferences } from "../validation/schemas.js";
import { newId, nowIso } from "./common.js";
import type { DbExecutor } from "./tree.js";
import { recordActivity } from "./activity.js";

/**
 * Where a captured value lives.
 *
 * `user` is private to one person and follows them across tabs, machines and teams; `global` is
 * shared by everyone in the team the request works in. Two scopes rather than one because the common case - a token or a piece of
 * game state captured from *my* session - is meaningless to a teammate, while a handful of values
 * genuinely are shared.
 */
export const VARIABLE_SCOPES = ["user", "global"] as const;
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

export interface ScopedVariable {
  scope: VariableScope;
  key: string;
  value: string;
  updatedAt: string;
  updatedBy: string | null;
}

function toScopedVariable(row: typeof variables.$inferSelect): ScopedVariable {
  return {
    scope: row.scope as VariableScope,
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** Who is asking: the person, and the team whose shared values they work with. */
export interface VariableActor {
  userId: string;
  teamId: string;
}

// The owner of a row at this scope: a user row has a user and no team, a global row a team and no
// user, which is what the generated unique keys and the table's check constraint both expect.
// Getting this wrong would either hide a global value from its team or expose one person's value.
function ownerFor(scope: VariableScope, actor: VariableActor): { userId: string | null; teamId: string | null } {
  return scope === "user" ? { userId: actor.userId, teamId: null } : { userId: null, teamId: actor.teamId };
}

function ownedBy(scope: VariableScope, actor: VariableActor) {
  return scope === "user"
    ? and(eq(variables.scope, scope), eq(variables.userId, actor.userId), isNull(variables.teamId))
    : and(eq(variables.scope, scope), isNull(variables.userId), eq(variables.teamId, actor.teamId));
}

function matches(scope: VariableScope, actor: VariableActor, key: string) {
  return and(ownedBy(scope, actor), eq(variables.key, key));
}

// Serialises writes at one scope so the per-owner limit cannot be overshot by concurrent inserts.
async function lockOwner(tx: DbExecutor, scope: VariableScope, actor: VariableActor): Promise<void> {
  if (scope === "user") {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, actor.userId)).for("update");
  } else {
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, actor.teamId)).for("update");
  }
}

/**
 * Everything this user may see: their own user-scope rows plus the global rows of the team.
 *
 * Another person's user-scope rows, and other teams' global rows, are not merely hidden from the
 * response - they are never selected, so there is no filtering step a later change could forget.
 */
export async function listVariables(db: AppDatabase, actor: VariableActor): Promise<ScopedVariable[]> {
  const [rows, globals] = await Promise.all([
    db.select().from(variables).where(ownedBy("user", actor)).orderBy(asc(variables.key)),
    db.select().from(variables).where(ownedBy("global", actor)).orderBy(asc(variables.key)),
  ]);
  return [...rows, ...globals].map(toScopedVariable);
}

export async function getVariableDisplayOrder(db: AppDatabase, userId: string): Promise<string[]> {
  const [preference] = await db
    .select({ order: variableDisplayOrders.order })
    .from(variableDisplayOrders)
    .where(eq(variableDisplayOrders.userId, userId))
    .limit(1);
  return preference?.order ?? [];
}

export async function setVariableDisplayOrder(
  db: AppDatabase,
  userId: string,
  order: string[],
): Promise<string[]> {
  await db
    .insert(variableDisplayOrders)
    .values({ userId, order })
    .onDuplicateKeyUpdate({ set: { order } });
  return order;
}

export async function getVariableOrderPreferences(
  db: AppDatabase,
  userId: string,
): Promise<VariableOrderPreferences | null> {
  const [preference] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.name, "variable-order")))
    .limit(1);
  return (preference?.value as VariableOrderPreferences | undefined) ?? null;
}

export async function setVariableOrderPreferences(
  db: AppDatabase,
  userId: string,
  preferences: VariableOrderPreferences,
): Promise<VariableOrderPreferences> {
  await db
    .insert(userPreferences)
    .values({ userId, name: "variable-order", value: preferences })
    .onDuplicateKeyUpdate({ set: { value: preferences } });
  return preferences;
}

/**
 * Writes a value at one scope, replacing any previous value for that key.
 *
 * Upsert rather than create/update because a captured value has no identity of its own: saving
 * `token` twice means the second reading replaced the first, never that there are now two.
 */
export async function setVariable(
  db: AppDatabase,
  actor: VariableActor,
  scope: VariableScope,
  key: string,
  value: string,
): Promise<ScopedVariable> {
  return db.transaction(async (tx) => {
    await lockOwner(tx, scope, actor);
    const [existing] = await tx.select().from(variables).where(matches(scope, actor, key)).limit(1).for("update");
    const now = nowIso();
    if (existing) {
      await tx.update(variables)
        .set({ value, updatedAt: now, updatedBy: actor.userId })
        .where(eq(variables.id, existing.id));
      if (scope === "global") {
        await recordActivity(tx, {
          teamId: actor.teamId,
          actorId: actor.userId,
          action: "variable.updated",
          resourceType: "variable",
          resourceId: existing.id,
          resourceName: key,
          details: { changedFields: ["value"] },
          createdAt: now,
        });
      }
      return { scope, key, value, updatedAt: now, updatedBy: actor.userId };
    }

    const [total] = await tx.select({ value: count() }).from(variables)
      .where(ownedBy(scope, actor));
    const limit = scope === "user" ? 500 : 1000;
    if (Number(total?.value ?? 0) >= limit) {
      throw new HttpError(422, `The ${scope} variable limit of ${limit} has been reached`, "VARIABLE_LIMIT_REACHED");
    }

    const id = newId();
    await tx.insert(variables).values({
      id,
      scope,
      ...ownerFor(scope, actor),
      key,
      value,
      createdAt: now,
      updatedAt: now,
      updatedBy: actor.userId,
    });
    if (scope === "global") {
      await recordActivity(tx, {
        teamId: actor.teamId,
        actorId: actor.userId,
        action: "variable.created",
        resourceType: "variable",
        resourceId: id,
        resourceName: key,
        createdAt: now,
      });
    }
    return { scope, key, value, updatedAt: now, updatedBy: actor.userId };
  });
}

export async function createVariable(
  db: AppDatabase,
  actor: VariableActor,
  scope: VariableScope,
  key: string,
  value: string,
): Promise<ScopedVariable> {
  try {
    return await db.transaction(async (tx) => {
      await lockOwner(tx, scope, actor);
      const [existing] = await tx.select({ id: variables.id }).from(variables)
        .where(matches(scope, actor, key))
        .limit(1)
        .for("update");
      if (existing) {
        throw new ConflictError(
          `"${key}" already exists in ${scope === "user" ? "Only me" : "Everyone in this team"}.`,
          "VARIABLE_KEY_EXISTS",
        );
      }
      const [total] = await tx.select({ value: count() }).from(variables)
        .where(ownedBy(scope, actor));
      const limit = scope === "user" ? 500 : 1000;
      if (Number(total?.value ?? 0) >= limit) {
        throw new HttpError(422, `The ${scope} variable limit of ${limit} has been reached`, "VARIABLE_LIMIT_REACHED");
      }

      const now = nowIso();
      const id = newId();
      await tx.insert(variables).values({
        id,
        scope,
        ...ownerFor(scope, actor),
        key,
        value,
        createdAt: now,
        updatedAt: now,
        updatedBy: actor.userId,
      });
      if (scope === "global") {
        await recordActivity(tx, {
          teamId: actor.teamId,
          actorId: actor.userId,
          action: "variable.created",
          resourceType: "variable",
          resourceId: id,
          resourceName: key,
          createdAt: now,
        });
      }
      return { scope, key, value, updatedAt: now, updatedBy: actor.userId };
    });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw new ConflictError(`"${key}" already exists in ${scope === "user" ? "Only me" : "Everyone in this team"}.`, "VARIABLE_KEY_EXISTS");
    }
    throw error;
  }
}

export async function updateVariable(
  db: AppDatabase,
  actor: VariableActor,
  scope: VariableScope,
  key: string,
  patch: { key?: string; value?: string },
): Promise<ScopedVariable> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(variables).where(matches(scope, actor, key)).limit(1).for("update");
      if (!existing) throw new NotFoundError(`No ${scope} variable named "${key}"`);

      const updatedKey = patch.key ?? existing.key;
      if (updatedKey !== existing.key) {
        const [conflict] = await tx.select({ id: variables.id }).from(variables)
          .where(matches(scope, actor, updatedKey))
          .limit(1)
          .for("update");
        if (conflict) {
          throw new ConflictError(
            `A ${scope} variable named "${updatedKey}" already exists`,
            "VARIABLE_KEY_EXISTS",
          );
        }
      }

      const updatedAt = nowIso();
      const value = patch.value ?? existing.value;
      await tx.update(variables)
        .set({ key: updatedKey, value, updatedAt, updatedBy: actor.userId })
        .where(eq(variables.id, existing.id));
      if (scope === "global") {
        await recordActivity(tx, {
          teamId: actor.teamId,
          actorId: actor.userId,
          action: updatedKey === key ? "variable.updated" : "variable.renamed",
          resourceType: "variable",
          resourceId: existing.id,
          resourceName: updatedKey,
          details: {
            changedFields: [...(updatedKey !== key ? ["key"] : []), ...(patch.value !== undefined ? ["value"] : [])],
            ...(updatedKey !== key ? { previousKey: key } : {}),
          },
          createdAt: updatedAt,
        });
      }
      return { scope, key: updatedKey, value, updatedAt, updatedBy: actor.userId };
    });
  } catch (error) {
    if (patch.key !== undefined && patch.key !== key && isDuplicateEntry(error)) {
      throw new ConflictError(
        `A ${scope} variable named "${patch.key}" already exists`,
        "VARIABLE_KEY_EXISTS",
      );
    }
    throw error;
  }
}

export async function deleteVariable(db: AppDatabase, actor: VariableActor, scope: VariableScope, key: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(variables).where(matches(scope, actor, key)).limit(1).for("update");
    if (!existing) throw new NotFoundError(`No ${scope} variable named "${key}"`);
    await tx.delete(variables).where(eq(variables.id, existing.id));
    if (scope === "global") {
      await recordActivity(tx, {
        teamId: actor.teamId,
        actorId: actor.userId,
        action: "variable.deleted",
        resourceType: "variable",
        resourceId: existing.id,
        resourceName: existing.key,
      });
    }
  });
}

function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "ER_DUP_ENTRY" ||
    (candidate.cause !== undefined && candidate.cause !== error && isDuplicateEntry(candidate.cause));
}
