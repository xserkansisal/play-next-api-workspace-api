import { and, asc, eq, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { variables } from "../db/schema.js";
import { NotFoundError } from "../errors.js";
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

// The owner of a row at this scope: `null` for global, which is what the partial unique index and
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
export function listVariables(db: AppDatabase, userId: string): ScopedVariable[] {
  const rows = db
    .select()
    .from(variables)
    .where(
      and(
        eq(variables.scope, "user"),
        eq(variables.userId, userId),
      ),
    )
    .orderBy(asc(variables.key))
    .all();
  const globals = db
    .select()
    .from(variables)
    .where(eq(variables.scope, "global"))
    .orderBy(asc(variables.key))
    .all();
  return [...rows, ...globals].map(toScopedVariable);
}

/**
 * Writes a value at one scope, replacing any previous value for that key.
 *
 * Upsert rather than create/update because a captured value has no identity of its own: saving
 * `token` twice means the second reading replaced the first, never that there are now two.
 */
export function setVariable(
  db: AppDatabase,
  userId: string,
  scope: VariableScope,
  key: string,
  value: string,
): ScopedVariable {
  const now = nowIso();
  const existing = db.select().from(variables).where(matches(scope, userId, key)).get();
  if (existing) {
    const updated = db
      .update(variables)
      .set({ value, updatedAt: now, updatedBy: userId })
      .where(eq(variables.id, existing.id))
      .returning()
      .get();
    return toScopedVariable(updated);
  }
  const inserted = db
    .insert(variables)
    .values({
      id: newId(),
      scope,
      userId: ownerFor(scope, userId),
      key,
      value,
      createdAt: now,
      updatedAt: now,
      updatedBy: userId,
    })
    .returning()
    .get();
  return toScopedVariable(inserted);
}

export function deleteVariable(db: AppDatabase, userId: string, scope: VariableScope, key: string): void {
  const existing = db.select().from(variables).where(matches(scope, userId, key)).get();
  if (!existing) throw new NotFoundError(`No ${scope} variable named "${key}"`);
  db.delete(variables).where(eq(variables.id, existing.id)).run();
}
