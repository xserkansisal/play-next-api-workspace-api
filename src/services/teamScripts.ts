import { and, count, eq, ne, sql } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { collectionTreeVersions, itemVersions, requestScriptLinks, teamScripts } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import type { TeamScriptInput } from "../validation/schemas.js";
import { nameKey, newId, nowIso } from "./common.js";
import type { DbExecutor } from "./tree.js";

export type TeamScript = Omit<typeof teamScripts.$inferSelect, "nameKey">;

function toTeamScript(row: typeof teamScripts.$inferSelect): TeamScript {
  const { nameKey: _nameKey, ...script } = row;
  return script;
}

export async function listTeamScripts(db: AppDatabase, teamId: string): Promise<TeamScript[]> {
  const rows = await db.select().from(teamScripts)
    .where(eq(teamScripts.teamId, teamId))
    .orderBy(teamScripts.stage, teamScripts.name);
  return rows.map(toTeamScript);
}

export async function createTeamScript(
  db: AppDatabase,
  teamId: string,
  input: TeamScriptInput,
  actorId: string,
): Promise<TeamScript> {
  const key = nameKey(input.name);
  const existing = await db.select({ id: teamScripts.id }).from(teamScripts)
    .where(and(eq(teamScripts.teamId, teamId), eq(teamScripts.stage, input.stage), eq(teamScripts.nameKey, key)))
    .limit(1);
  if (existing[0]) throw duplicateScript(input.name, input.stage);

  const timestamp = nowIso();
  const id = newId();
  await db.insert(teamScripts).values({
    id,
    teamId,
    name: input.name,
    nameKey: key,
    description: input.description,
    stage: input.stage,
    source: input.source,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: actorId,
    updatedBy: actorId,
  });
  const [created] = await db.select().from(teamScripts).where(eq(teamScripts.id, id)).limit(1);
  if (!created) throw new Error(`New team script ${id} was not persisted`);
  return toTeamScript(created);
}

export async function updateTeamScript(
  db: AppDatabase,
  teamId: string,
  scriptId: string,
  input: TeamScriptInput,
  actorId: string,
): Promise<TeamScript> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(teamScripts)
      .where(and(eq(teamScripts.teamId, teamId), eq(teamScripts.id, scriptId)))
      .limit(1)
      .for("update");
    if (!current) throw new NotFoundError(`Script ${scriptId} not found`);

    if (current.stage !== input.stage) {
      const references = await countScriptReferences(tx, scriptId);
      if (references.current > 0 || references.historical > 0) {
        throw new ConflictError("A script's hook stage cannot change while requests or saved history refer to it", "SCRIPT_IN_USE", {
          referenceCount: references.current,
          historicalReferenceCount: references.historical,
        });
      }
    }

    const key = nameKey(input.name);
    const existing = await tx.select({ id: teamScripts.id }).from(teamScripts)
      .where(and(
        eq(teamScripts.teamId, teamId),
        eq(teamScripts.stage, input.stage),
        eq(teamScripts.nameKey, key),
        ne(teamScripts.id, scriptId),
      ))
      .limit(1);
    if (existing[0]) throw duplicateScript(input.name, input.stage);

    await tx.update(teamScripts).set({
      name: input.name,
      nameKey: key,
      description: input.description,
      stage: input.stage,
      source: input.source,
      updatedAt: nowIso(),
      updatedBy: actorId,
    }).where(eq(teamScripts.id, scriptId));
    const [updated] = await tx.select().from(teamScripts).where(eq(teamScripts.id, scriptId)).limit(1);
    if (!updated) throw new Error(`Updated team script ${scriptId} was not persisted`);
    return toTeamScript(updated);
  });
}

export function deleteTeamScript(db: AppDatabase, teamId: string, scriptId: string): Promise<void> {
  return db.transaction(async (tx) => {
    const [script] = await tx.select({ id: teamScripts.id }).from(teamScripts)
      .where(and(eq(teamScripts.id, scriptId), eq(teamScripts.teamId, teamId)))
      .limit(1)
      .for("update");
    if (!script) throw new NotFoundError(`Script ${scriptId} not found`);
    const references = await countScriptReferences(tx, scriptId);
    if (references.current > 0 || references.historical > 0) {
      throw new ConflictError("A script linked to a request or saved history cannot be deleted", "SCRIPT_IN_USE", {
        referenceCount: references.current,
        historicalReferenceCount: references.historical,
      });
    }
    await tx.delete(teamScripts).where(eq(teamScripts.id, scriptId));
  });
}

async function countScriptReferences(
  db: DbExecutor,
  scriptId: string,
): Promise<{ current: number; historical: number }> {
  const [current, itemHistory, treeHistory] = await Promise.all([
    db.select({ value: count() }).from(requestScriptLinks).where(eq(requestScriptLinks.scriptId, scriptId)),
    db.select({ value: count() }).from(itemVersions)
      .where(sql`JSON_SEARCH(${itemVersions.snapshot}, 'one', ${scriptId}) IS NOT NULL`),
    db.select({ value: count() }).from(collectionTreeVersions)
      .where(sql`JSON_SEARCH(${collectionTreeVersions.snapshot}, 'one', ${scriptId}) IS NOT NULL`),
  ]);
  return {
    current: Number(current[0]?.value ?? 0),
    historical: Number(itemHistory[0]?.value ?? 0) + Number(treeHistory[0]?.value ?? 0),
  };
}

function duplicateScript(name: string, stage: string): ConflictError {
  return new ConflictError(`A ${stage} script named "${name}" already exists in this team`, "SCRIPT_NAME_CONFLICT", {
    name,
    stage,
  });
}
