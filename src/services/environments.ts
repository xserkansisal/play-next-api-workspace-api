import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
import { environments, environmentVariables } from "../db/schema.js";
import { ConflictError, HttpError, NotFoundError } from "../errors.js";
import type { EnvironmentInput, EnvironmentVariableCreateInput } from "../validation/schemas.js";
import { compareByName, nameKey, newId, nowIso, resolveAttribution } from "./common.js";
import { copyNameAsync } from "./copyName.js";
import type { DbExecutor } from "./tree.js";
import { recordActivity } from "./activity.js";
import { decryptEnvironmentValue, encryptEnvironmentValue } from "./secretValues.js";

export interface EnvironmentVariable {
  key: string;
  value: string;
  enabled: boolean;
  isSecret: boolean;
}

function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === "ER_DUP_ENTRY" ||
    (candidate.cause !== undefined && candidate.cause !== error && isDuplicateEntry(candidate.cause));
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

async function hydrate(
  db: DbExecutor,
  rows: EnvironmentRow[],
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment[]> {
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
      list.push({
        key: v.key,
        value: decryptEnvironmentValue(v.value, v.valueEncryptionVersion, encryptionKey, previousEncryptionKey).value,
        enabled: v.enabled,
        isSecret: v.isSecret,
      });
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

export async function addEnvironmentVariable(
  db: AppDatabase,
  id: string,
  input: EnvironmentVariableCreateInput,
  actorId: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment> {
  try {
    return await db.transaction(async (tx) => {
      const [environment] = await tx.select({ id: environments.id, name: environments.name, teamId: environments.teamId })
        .from(environments)
        .where(and(eq(environments.id, id), isNull(environments.deletedAt)))
        .limit(1)
        .for("update");
      if (!environment) throw new NotFoundError(`Environment ${id} not found`);

      const [rowCount] = await tx.select({ value: count() })
        .from(environmentVariables)
        .where(eq(environmentVariables.environmentId, id));
      if (Number(rowCount?.value ?? 0) >= 1000) {
        throw new HttpError(422, "The environment variable limit of 1000 has been reached", "VARIABLE_LIMIT_REACHED");
      }

      const [lastVariable] = await tx.select({ position: environmentVariables.position })
        .from(environmentVariables)
        .where(eq(environmentVariables.environmentId, id))
        .orderBy(desc(environmentVariables.position))
        .limit(1);

      await tx.insert(environmentVariables).values({
        environmentId: id,
        position: (lastVariable?.position ?? -1) + 1,
        ...input,
        value: encryptEnvironmentValue(input.value, encryptionKey),
        valueEncryptionVersion: 1,
      });
      const updatedAt = nowIso();
      await tx.update(environments).set({ updatedAt, updatedBy: actorId }).where(eq(environments.id, id));
      await recordActivity(tx, {
        teamId: environment.teamId,
        actorId,
        action: "environment.variable_added",
        resourceType: "environment",
        resourceId: id,
        resourceName: environment.name,
        details: { variableKey: input.key },
        createdAt: updatedAt,
      });
      return readEnvironment(tx, id, encryptionKey, previousEncryptionKey);
    });
  } catch (error) {
    if (isDuplicateEntry(error)) {
      throw new ConflictError(`An enabled variable named "${input.key}" already exists in this environment`, "VARIABLE_KEY_EXISTS");
    }
    throw error;
  }
}

/** Names are unique among a team's active environments; other teams may reuse them. */
export async function findActiveEnvironmentByName(
  db: DbExecutor,
  teamId: string,
  name: string,
  excludeId?: string,
): Promise<EnvironmentRow | undefined> {
  const rows = await db
    .select()
    .from(environments)
    .where(and(eq(environments.teamId, teamId), eq(environments.nameKey, nameKey(name)), isNull(environments.deletedAt)));
  return rows.find((row) => row.id !== excludeId);
}

/** Whether an environment - active or in Trash - belongs to the team. */
export async function environmentBelongsToTeam(db: DbExecutor, teamId: string, id: string): Promise<boolean> {
  const row = await first(db.select({ teamId: environments.teamId }).from(environments).where(eq(environments.id, id)).limit(1));
  return row?.teamId === teamId;
}

export function environmentNameConflictError(name: string, existingId: string): ConflictError {
  return new ConflictError(`An environment named "${name}" already exists`, "ENVIRONMENT_NAME_CONFLICT", {
    name,
    conflictingId: existingId,
  });
}

async function writeVariables(
  db: DbExecutor,
  environmentId: string,
  variables: EnvironmentInput["variables"],
  encryptionKey: string,
): Promise<void> {
  await db.delete(environmentVariables).where(eq(environmentVariables.environmentId, environmentId));
  if (variables.length > 0) {
    await db.insert(environmentVariables).values(variables.map((v, position) => ({
      environmentId,
      position,
      ...v,
      value: encryptEnvironmentValue(v.value, encryptionKey),
      valueEncryptionVersion: 1,
    })));
  }
}

export async function listEnvironments(
  db: AppDatabase,
  teamId: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment[]> {
  const rows = await db.select().from(environments).where(and(eq(environments.teamId, teamId), isNull(environments.deletedAt)));
  return (await hydrate(db, rows, encryptionKey, previousEncryptionKey)).sort(compareByName);
}

export async function readEnvironment(
  db: DbExecutor,
  id: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment> {
  const [env] = await hydrate(db, [await requireActive(db, id)], encryptionKey, previousEncryptionKey);
  return env!;
}

export function createEnvironment(
  db: AppDatabase,
  teamId: string,
  input: EnvironmentInput,
  actorId: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment> {
  return db.transaction(async (tx) => {
      const existing = await findActiveEnvironmentByName(tx, teamId, input.name);
      if (existing) throw environmentNameConflictError(input.name, existing.id);

      const id = newId();
      const timestamp = nowIso();
      await tx.insert(environments)
        .values({
          id,
          name: input.name,
          nameKey: nameKey(input.name),
          teamId,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        ;
      await writeVariables(tx, id, input.variables, encryptionKey);
      await recordActivity(tx, {
        teamId,
        actorId,
        action: "environment.created",
        resourceType: "environment",
        resourceId: id,
        resourceName: input.name,
        details: { variableCount: input.variables.length },
        createdAt: timestamp,
      });
      return readEnvironment(tx, id, encryptionKey, previousEncryptionKey);
    });
}

/** Explicit save: replaces the environment's name and full variable list (last save wins). */
export function updateEnvironment(
  db: AppDatabase,
  id: string,
  input: EnvironmentInput,
  actorId: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment> {
  return db.transaction(async (tx) => {
      const current = await requireActive(tx, id);
      const existing = await findActiveEnvironmentByName(tx, current.teamId, input.name, id);
      if (existing) throw environmentNameConflictError(input.name, existing.id);

      await tx.update(environments)
        .set({ name: input.name, nameKey: nameKey(input.name), updatedAt: nowIso(), updatedBy: actorId })
        .where(eq(environments.id, id))
        ;
      await writeVariables(tx, id, input.variables, encryptionKey);
      await recordActivity(tx, {
        teamId: current.teamId,
        actorId,
        action: "environment.updated",
        resourceType: "environment",
        resourceId: id,
        resourceName: input.name,
        details: { changedFields: [...(current.name !== input.name ? ["name"] : []), "variables"], variableCount: input.variables.length },
      });
      return readEnvironment(tx, id, encryptionKey, previousEncryptionKey);
    });
}

/**
 * Duplicates an environment under a free name, variables and all.
 *
 * The variables are read back rather than copied row by row, because `writeVariables` is already
 * the one place that decides how a variable list is stored - positions included.
 */
export function cloneEnvironment(
  db: AppDatabase,
  id: string,
  actorId: string,
  encryptionKey: string,
  previousEncryptionKey?: string,
): Promise<Environment> {
  return db.transaction(async (tx) => {
      const { teamId } = await requireActive(tx, id);
      const source = await readEnvironment(tx, id, encryptionKey, previousEncryptionKey);
      const name = await copyNameAsync(
        source.name,
        async (candidate) => (await findActiveEnvironmentByName(tx, teamId, candidate)) !== undefined,
      );

      const newEnvironmentId = newId();
      const timestamp = nowIso();
      await tx.insert(environments)
        .values({
          id: newEnvironmentId,
          name,
          nameKey: nameKey(name),
          teamId,
          createdAt: timestamp,
          updatedAt: timestamp,
          createdBy: actorId,
          updatedBy: actorId,
        })
        ;
      await writeVariables(tx, newEnvironmentId, source.variables, encryptionKey);
      await recordActivity(tx, {
        teamId,
        actorId,
        action: "environment.cloned",
        resourceType: "environment",
        resourceId: newEnvironmentId,
        resourceName: name,
        details: { sourceEnvironmentId: id, variableCount: source.variables.length },
        createdAt: timestamp,
      });
      return readEnvironment(tx, newEnvironmentId, encryptionKey, previousEncryptionKey);
    });
}

export function trashEnvironment(db: AppDatabase, id: string, actorId: string): Promise<{ id: string; deletedAt: string }> {
  return db.transaction(async (tx) => {
      const current = await requireActive(tx, id);
      const deletedAt = nowIso();
      await tx.update(environments).set({ deletedAt, updatedAt: deletedAt, updatedBy: actorId }).where(eq(environments.id, id));
      await recordActivity(tx, {
        teamId: current.teamId,
        actorId,
        action: "environment.trashed",
        resourceType: "environment",
        resourceId: id,
        resourceName: current.name,
        createdAt: deletedAt,
      });
      return { id, deletedAt };
    });
}
