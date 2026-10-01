import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { userPreferences, users, variableDisplayOrders, variables } from "../db/schema.js";
import { ConflictError, HttpError, NotFoundError } from "../errors.js";
import type { VariableOrderPreferences } from "../validation/schemas.js";
import { newId, nowIso } from "./common.js";

/**
 * Where a captured value lives.
 *
 * `user` is private to one person and follows them across tabs and machines; `global` is shared by
 * everyone signed in. Two scopes rather than one because the common case - a token or a piece of
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

// The owner of a row at this scope: `null` for global, which is what the generated unique keys and
// the table's check constraint both expect. Getting this wrong would either hide a global value
// from everyone or expose one person's value to the whole team.
function ownerFor(scope: VariableScope, userId: string): string | null {
  return scope === "user" ? userId : null;
}

function matches(scope: VariableScope, userId: string, key: string) {
  const owner = ownerFor(scope, userId);
  return and(
    eq(variables.scope, scope),
    owner === null ? isNull(variables.userId) : eq(variables.userId, owner),
    eq(variables.key, key),
  );
}

/**
 * Everything this user may see: their own user-scope rows plus every global row.
 *
 * Another person's user-scope rows are not merely hidden from the response - they are never
 * selected, so there is no filtering step that a later change could forget.
 */
export async function listVariables(db: AppDatabase, userId: string): Promise<ScopedVariable[]> {
  const [rows, globals] = await Promise.all([
    db
      .select()
      .from(variables)
      .where(and(eq(variables.scope, "user"), eq(variables.userId, userId)))
      .orderBy(asc(variables.key)),
    db.select().from(variables).where(eq(variables.scope, "global")).orderBy(asc(variables.key)),
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
  userId: string,
  scope: VariableScope,
  key: string,
  value: string,
): Promise<ScopedVariable> {
  return db.transaction(async (tx) => {
    if (scope === "user") {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
    } else {
      await tx.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1).for("update");
    }
    const [existing] = await tx.select().from(variables).where(matches(scope, userId, key)).limit(1).for("update");
    const now = nowIso();
    if (existing) {
      await tx.update(variables)
        .set({ value, updatedAt: now, updatedBy: userId })
        .where(eq(variables.id, existing.id));
      return { scope, key, value, updatedAt: now, updatedBy: userId };
    }

    const [total] = await tx.select({ value: count() }).from(variables)
      .where(scope === "user"
        ? and(eq(variables.scope, scope), eq(variables.userId, userId))
        : eq(variables.scope, scope));
    const limit = scope === "user" ? 500 : 1000;
    if (Number(total?.value ?? 0) >= limit) {
      throw new HttpError(422, `The ${scope} variable limit of ${limit} has been reached`, "VARIABLE_LIMIT_REACHED");
    }

    await tx.insert(variables).values({
      id: newId(),
      scope,
      userId: ownerFor(scope, userId),
      key,
      value,
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    });
    return { scope, key, value, updatedAt: now, updatedBy: userId };
  });
}

export async function createVariable(
  db: AppDatabase,
  userId: string,
  scope: VariableScope,
  key: string,
  value: string,
): Promise<ScopedVariable> {
  try {
    return await db.transaction(async (tx) => {
      if (scope === "user") {
        await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      } else {
        await tx.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1).for("update");
      }
      const [existing] = await tx.select({ id: variables.id }).from(variables)
        .where(matches(scope, userId, key))
        .limit(1)
        .for("update");
      if (existing) {
        throw new ConflictError(
          `"${key}" already exists in ${scope === "user" ? "Only me" : "Everyone"}.`,
          "VARIABLE_KEY_EXISTS",
        );
      }
      const [total] = await tx.select({ value: count() }).from(variables)
        .where(scope === "user"
          ? and(eq(variables.scope, scope), eq(variables.userId, userId))
          : eq(variables.scope, scope));
      const limit = scope === "user" ? 500 : 1000;
      if (Number(total?.value ?? 0) >= limit) {
        throw new HttpError(422, `The ${scope} variable limit of ${limit} has been reached`, "VARIABLE_LIMIT_REACHED");
      }

      const now = nowIso();
      await tx.insert(variables).values({
        id: newId(),
        scope,
        userId: ownerFor(scope, userId),
        key,
        value,
        createdAt: now,
        updatedAt: now,
        updatedBy: userId,
      });
      return { scope, key, value, updatedAt: now, updatedBy: userId };
    });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw new ConflictError(`"${key}" already exists in ${scope === "user" ? "Only me" : "Everyone"}.`, "VARIABLE_KEY_EXISTS");
    }
    throw error;
  }
}

export async function updateVariable(
  db: AppDatabase,
  userId: string,
  scope: VariableScope,
  key: string,
  patch: { key?: string; value?: string },
): Promise<ScopedVariable> {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(variables).where(matches(scope, userId, key)).limit(1).for("update");
      if (!existing) throw new NotFoundError(`No ${scope} variable named "${key}"`);

      const updatedKey = patch.key ?? existing.key;
      if (updatedKey !== existing.key) {
        const [conflict] = await tx.select({ id: variables.id }).from(variables)
          .where(matches(scope, userId, updatedKey))
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
        .set({ key: updatedKey, value, updatedAt, updatedBy: userId })
        .where(eq(variables.id, existing.id));
      return { scope, key: updatedKey, value, updatedAt, updatedBy: userId };
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

export async function deleteVariable(db: AppDatabase, userId: string, scope: VariableScope, key: string): Promise<void> {
  const [existing] = await db.select().from(variables).where(matches(scope, userId, key)).limit(1);
  if (!existing) throw new NotFoundError(`No ${scope} variable named "${key}"`);
  await db.delete(variables).where(eq(variables.id, existing.id));
}

function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "ER_DUP_ENTRY" ||
    (candidate.cause !== undefined && candidate.cause !== error && isDuplicateEntry(candidate.cause));
}
