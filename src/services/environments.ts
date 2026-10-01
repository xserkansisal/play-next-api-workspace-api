import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
import { environments, environmentVariables } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { EnvironmentInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId, nowIso, resolveAttribution } from "./common.js";
import { copyNameAsync } from "./copyName.js";
import type { DbExecutor } from "./tree.js";

export interface EnvironmentVariable {
  key: string;
  value: string;
  enabled: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  updatedBy: string | null;
}

type EnvironmentRow = typeof environments.$inferSelect;

async function hydrate(db: DbExecutor, rows: EnvironmentRow[]): Promise<Environment[]> {
  const variables = new Map<string, EnvironmentVariable[]>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const varRows = await db
      .select()
      .from(environmentVariables)
      .where(inArray(environmentVariables.environmentId, ids.slice(i, i + 500)))
      .orderBy(asc(environmentVariables.environmentId), asc(environmentVariables.position));
    for (const v of varRows) {
      const list = variables.get(v.environmentId) ?? [];
      list.push({ key: v.key, value: v.value, enabled: v.enabled });
      variables.set(v.environmentId, list);
    }
  }
  return Promise.all(rows.map(async (row) => ({
    id: row.id,
    name: row.name,
    variables: variables.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...await resolveAttribution(db, row.createdBy, row.updatedBy),
  })));
}

function findActive(db: DbExecutor, id: string): Promise<EnvironmentRow | undefined> {
  return first(db
    .select()
    .from(environments)
    .where(and(eq(environments.id, id), isNull(environments.deletedAt)))
    .limit(1));
}

async function requireActive(db: DbExecutor, id: string): Promise<EnvironmentRow> {
  const row = await findActive(db, id);
  if (!row) throw new NotFoundError(`Environment ${id} not found`);
  return row;
}

export async function findActiveEnvironmentByName(db: DbExecutor, name: string, excludeId?: string): Promise<EnvironmentRow | undefined> {
  const rows = await db
    .select()
    .from(environments)
    .where(and(eq(environments.nameKey, nameKey(name)), isNull(environments.deletedAt)));
  return rows.find((row) => row.id !== excludeId);
}

export function environmentNameConflictError(name: string, existingId: string): ConflictError {
  return new ConflictError(`An environment named "${name}" already exists`, "ENVIRONMENT_NAME_CONFLICT", {
    name,
    conflictingId: existingId,
  });
}

async function writeVariables(db: DbExecutor, environmentId: string, variables: EnvironmentInput["variables"]): Promise<void> {
  await db.delete(environmentVariables).where(eq(environmentVariables.environmentId, environmentId));
  if (variables.length > 0) {
    await db.insert(environmentVariables).values(variables.map((v, position) => ({ environmentId, position, ...v })));
  }
}

export async function listEnvironments(db: AppDatabase): Promise<Environment[]> {
  const rows = await db.select().from(environments).where(isNull(environments.deletedAt));
  return (await hydrate(db, rows)).sort(compareByName);
}

export async function readEnvironment(db: DbExecutor, id: string): Promise<Environment> {
  const [env] = await hydrate(db, [await requireActive(db, id)]);
  return env!;
}

export function createEnvironment(db: AppDatabase, input: EnvironmentInput, actorId: string): Promise<Environment> {
  return db.transaction(async (tx) => {
      const existing = await findActiveEnvironmentByName(tx, input.name);
      if (existing) throw environmentNameConflictError(input.name, existing.id);

      const id = newId();
      const timestamp = nowIso();
      await tx.insert(environments)
        .values({
          id,
          name: input.name,
          nameKey: nameKey(input.name),
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        ;
      await writeVariables(tx, id, input.variables);
      return readEnvironment(tx, id);
    });
}

/** Explicit save: replaces the environment's name and full variable list (last save wins). */
export function updateEnvironment(db: AppDatabase, id: string, input: EnvironmentInput, actorId: string): Promise<Environment> {
  return db.transaction(async (tx) => {
      await requireActive(tx, id);
      const existing = await findActiveEnvironmentByName(tx, input.name, id);
      if (existing) throw environmentNameConflictError(input.name, existing.id);

      await tx.update(environments)
        .set({ name: input.name, nameKey: nameKey(input.name), updatedAt: nowIso(), updatedBy: actorId })
        .where(eq(environments.id, id))
        ;
      await writeVariables(tx, id, input.variables);
      return readEnvironment(tx, id);
    });
}

/**
 * Duplicates an environment under a free name, variables and all.
 *
 * The variables are read back rather than copied row by row, because `writeVariables` is already
 * the one place that decides how a variable list is stored - positions included.
 */
export function cloneEnvironment(db: AppDatabase, id: string, actorId: string): Promise<Environment> {
  return db.transaction(async (tx) => {
      const source = await readEnvironment(tx, id);
      const name = await copyNameAsync(
        source.name,
        async (candidate) => (await findActiveEnvironmentByName(tx, candidate)) !== undefined,
      );

      const newEnvironmentId = newId();
      const timestamp = nowIso();
      await tx.insert(environments)
        .values({
          id: newEnvironmentId,
          name,
          nameKey: nameKey(name),
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        ;
      await writeVariables(tx, newEnvironmentId, source.variables);
      return readEnvironment(tx, newEnvironmentId);
    });
}

export function trashEnvironment(db: AppDatabase, id: string, actorId: string): Promise<{ id: string; deletedAt: string }> {
  return db.transaction(async (tx) => {
      await requireActive(tx, id);
      const deletedAt = nowIso();
      await tx.update(environments).set({ deletedAt, updatedAt: deletedAt, updatedBy: actorId }).where(eq(environments.id, id));
      return { id, deletedAt };
    });
}
