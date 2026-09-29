import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { environments, environmentVariables } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { EnvironmentInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId, nowIso } from "./common.js";
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
}

type EnvironmentRow = typeof environments.$inferSelect;

function hydrate(db: DbExecutor, rows: EnvironmentRow[]): Environment[] {
  const variables = new Map<string, EnvironmentVariable[]>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const varRows = db
      .select()
      .from(environmentVariables)
      .where(inArray(environmentVariables.environmentId, ids.slice(i, i + 500)))
      .orderBy(asc(environmentVariables.environmentId), asc(environmentVariables.position))
      .all();
    for (const v of varRows) {
      const list = variables.get(v.environmentId) ?? [];
      list.push({ key: v.key, value: v.value, enabled: v.enabled });
      variables.set(v.environmentId, list);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    variables: variables.get(row.id) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

function findActive(db: DbExecutor, id: string): EnvironmentRow | undefined {
  return db
    .select()
    .from(environments)
    .where(and(eq(environments.id, id), isNull(environments.deletedAt)))
    .get();
}

function requireActive(db: DbExecutor, id: string): EnvironmentRow {
  const row = findActive(db, id);
  if (!row) throw new NotFoundError(`Environment ${id} not found`);
  return row;
}

export function findActiveEnvironmentByName(db: DbExecutor, name: string, excludeId?: string): EnvironmentRow | undefined {
  return db
    .select()
    .from(environments)
    .where(and(eq(environments.nameKey, nameKey(name)), isNull(environments.deletedAt)))
    .all()
    .find((row) => row.id !== excludeId);
}

export function environmentNameConflictError(name: string, existingId: string): ConflictError {
  return new ConflictError(`An environment named "${name}" already exists`, "ENVIRONMENT_NAME_CONFLICT", {
    name,
    conflictingId: existingId,
  });
}

function writeVariables(db: DbExecutor, environmentId: string, variables: EnvironmentInput["variables"]): void {
  db.delete(environmentVariables).where(eq(environmentVariables.environmentId, environmentId)).run();
  if (variables.length > 0) {
    db.insert(environmentVariables)
      .values(variables.map((v, position) => ({ environmentId, position, ...v })))
      .run();
  }
}

export function listEnvironments(db: AppDatabase): Environment[] {
  const rows = db.select().from(environments).where(isNull(environments.deletedAt)).all();
  return hydrate(db, rows).sort(compareByName);
}

export function readEnvironment(db: DbExecutor, id: string): Environment {
  const [env] = hydrate(db, [requireActive(db, id)]);
  return env!;
}

export function createEnvironment(db: AppDatabase, input: EnvironmentInput): Environment {
  return db.transaction(
    (tx) => {
      const existing = findActiveEnvironmentByName(tx, input.name);
      if (existing) throw environmentNameConflictError(input.name, existing.id);

      const id = newId();
      const timestamp = nowIso();
      tx.insert(environments)
        .values({ id, name: input.name, nameKey: nameKey(input.name), createdAt: timestamp, updatedAt: timestamp })
        .run();
      writeVariables(tx, id, input.variables);
      return readEnvironment(tx, id);
    },
    { behavior: "immediate" },
  );
}

/** Explicit save: replaces the environment's name and full variable list (last save wins). */
export function updateEnvironment(db: AppDatabase, id: string, input: EnvironmentInput): Environment {
  return db.transaction(
    (tx) => {
      requireActive(tx, id);
      const existing = findActiveEnvironmentByName(tx, input.name, id);
      if (existing) throw environmentNameConflictError(input.name, existing.id);

      tx.update(environments)
        .set({ name: input.name, nameKey: nameKey(input.name), updatedAt: nowIso() })
        .where(eq(environments.id, id))
        .run();
      writeVariables(tx, id, input.variables);
      return readEnvironment(tx, id);
    },
    { behavior: "immediate" },
  );
}

export function trashEnvironment(db: AppDatabase, id: string): { id: string; deletedAt: string } {
  return db.transaction(
    (tx) => {
      requireActive(tx, id);
      const deletedAt = nowIso();
      tx.update(environments).set({ deletedAt }).where(eq(environments.id, id)).run();
      return { id, deletedAt };
    },
    { behavior: "immediate" },
  );
}
