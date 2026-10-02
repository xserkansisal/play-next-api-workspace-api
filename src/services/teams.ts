import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import type { AppDatabase } from "../db/client.js";
import { first } from "../db/query.js";
import { adminAuditLog, collections, environments, teamMembers, teams, users, variables } from "../db/schema.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { validateAllowedEmail, type SystemRole } from "../auth/service.js";
import { deriveUserProfileName } from "../auth/profile.js";
import type { AddTeamMemberInput, CreateTeamInput, TeamRole, UpdateTeamInput } from "../validation/adminSchemas.js";
import { compareByName, nameKey, nowIso } from "./common.js";
import type { DbExecutor } from "./tree.js";

export interface TeamSummary {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TeamMember {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarColor: string;
  role: TeamRole;
  joinedAt: string;
}

export interface TeamDetail extends TeamSummary {
  members: TeamMember[];
}

export interface AdminUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarColor: string;
  systemRole: SystemRole;
  createdAt: string;
  /** False for an account an admin created that has never signed in. */
  hasSignedIn: boolean;
}

export interface UserTeamMembership {
  id: string;
  name: string;
  role: TeamRole;
  archivedAt: string | null;
}

export interface AdminUserDetail extends AdminUser {
  teams: UserTeamMembership[];
}

export interface MyTeam {
  id: string;
  name: string;
  description: string;
  role: TeamRole;
}

export interface AuditLogEntry {
  id: string;
  actor: string | null;
  action: string;
  targetType: "team" | "team_member" | "user";
  targetId: string;
  teamId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

type TeamRow = typeof teams.$inferSelect;

async function recordAudit(
  tx: DbExecutor,
  entry: {
    actorId: string;
    action: string;
    targetType: AuditLogEntry["targetType"];
    targetId: string;
    teamId: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(adminAuditLog).values({
    id: randomUUID(),
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    teamId: entry.teamId,
    details: entry.details ?? {},
    createdAt: nowIso(),
  });
}

function teamNotFound(id: string): NotFoundError {
  return new NotFoundError(`Team ${id} not found`, "TEAM_NOT_FOUND");
}

async function lockTeam(tx: DbExecutor, id: string): Promise<TeamRow> {
  const row = await first(tx.select().from(teams).where(eq(teams.id, id)).limit(1).for("update"));
  if (!row) throw teamNotFound(id);
  return row;
}

async function lockActiveTeam(tx: DbExecutor, id: string): Promise<TeamRow> {
  const row = await lockTeam(tx, id);
  if (row.archivedAt !== null) {
    throw new ConflictError(`Team "${row.name}" is archived; unarchive it first`, "TEAM_ARCHIVED");
  }
  return row;
}

async function ensureTeamNameFree(tx: DbExecutor, name: string, excludeId?: string): Promise<void> {
  const existing = await first(tx.select({ id: teams.id }).from(teams).where(eq(teams.nameKey, nameKey(name))).limit(1));
  if (existing && existing.id !== excludeId) {
    throw new ConflictError(`A team named "${name}" already exists`, "TEAM_NAME_CONFLICT", {
      name,
      conflictingId: existing.id,
    });
  }
}

async function memberCounts(db: DbExecutor, teamIds: string[]): Promise<Map<string, number>> {
  if (teamIds.length === 0) return new Map();
  const rows = await db
    .select({ teamId: teamMembers.teamId, value: count() })
    .from(teamMembers)
    .where(inArray(teamMembers.teamId, teamIds))
    .groupBy(teamMembers.teamId);
  return new Map(rows.map((row) => [row.teamId, Number(row.value)]));
}

function toSummary(row: TeamRow, memberCount: number): TeamSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

export async function listTeams(db: AppDatabase, options: { includeArchived: boolean }): Promise<TeamSummary[]> {
  const rows = await db
    .select()
    .from(teams)
    .where(options.includeArchived ? undefined : isNull(teams.archivedAt));
  const counts = await memberCounts(db, rows.map((row) => row.id));
  return rows.map((row) => toSummary(row, counts.get(row.id) ?? 0)).sort(compareByName);
}

export async function listTeamMembers(db: DbExecutor, teamId: string): Promise<TeamMember[]> {
  await requireTeam(db, teamId);
  return selectMembers(db, teamId);
}

const ROLE_ORDER: Record<TeamRole, number> = { owner: 0, admin: 1, member: 2 };

async function selectMembers(db: DbExecutor, teamId: string): Promise<TeamMember[]> {
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatarColor: users.avatarColor,
      role: teamMembers.role,
      joinedAt: teamMembers.createdAt,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));
  return rows.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
}

async function requireTeam(db: DbExecutor, id: string): Promise<TeamRow> {
  const row = await first(db.select().from(teams).where(eq(teams.id, id)).limit(1));
  if (!row) throw teamNotFound(id);
  return row;
}

export async function readTeam(db: DbExecutor, id: string): Promise<TeamDetail> {
  const row = await requireTeam(db, id);
  const members = await selectMembers(db, id);
  return { ...toSummary(row, members.length), members };
}

export function createTeam(db: AppDatabase, input: CreateTeamInput, actorId: string): Promise<TeamDetail> {
  return db.transaction(async (tx) => {
    await ensureTeamNameFree(tx, input.name);
    const id = randomUUID();
    const timestamp = nowIso();
    await tx.insert(teams).values({
      id,
      name: input.name,
      nameKey: nameKey(input.name),
      description: input.description,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: actorId,
      updatedBy: actorId,
    });
    await recordAudit(tx, {
      actorId,
      action: "team.created",
      targetType: "team",
      targetId: id,
      teamId: id,
      details: { name: input.name },
    });
    return readTeam(tx, id);
  });
}

export function updateTeam(db: AppDatabase, id: string, input: UpdateTeamInput, actorId: string): Promise<TeamDetail> {
  return db.transaction(async (tx) => {
    const current = await lockTeam(tx, id);
    if (input.name !== undefined) await ensureTeamNameFree(tx, input.name, id);
    await tx
      .update(teams)
      .set({
        ...(input.name !== undefined ? { name: input.name, nameKey: nameKey(input.name) } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: nowIso(),
        updatedBy: actorId,
      })
      .where(eq(teams.id, id));
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined && input.name !== current.name) changes.name = { from: current.name, to: input.name };
    if (input.description !== undefined && input.description !== current.description) changes.description = true;
    await recordAudit(tx, { actorId, action: "team.updated", targetType: "team", targetId: id, teamId: id, details: changes });
    return readTeam(tx, id);
  });
}

export function setTeamArchived(db: AppDatabase, id: string, archived: boolean, actorId: string): Promise<TeamDetail> {
  return db.transaction(async (tx) => {
    const current = await lockTeam(tx, id);
    if ((current.archivedAt !== null) === archived) {
      throw new ConflictError(
        archived ? `Team "${current.name}" is already archived` : `Team "${current.name}" is not archived`,
        archived ? "TEAM_ARCHIVED" : "TEAM_NOT_ARCHIVED",
      );
    }
    const timestamp = nowIso();
    await tx
      .update(teams)
      .set({ archivedAt: archived ? timestamp : null, updatedAt: timestamp, updatedBy: actorId })
      .where(eq(teams.id, id));
    await recordAudit(tx, {
      actorId,
      action: archived ? "team.archived" : "team.unarchived",
      targetType: "team",
      targetId: id,
      teamId: id,
      details: { name: current.name },
    });
    return readTeam(tx, id);
  });
}

/** Permanent removal. Only an archived team may be deleted, so deletion is always a second step. */
export function deleteTeam(db: AppDatabase, id: string, actorId: string): Promise<void> {
  return db.transaction(async (tx) => {
    const current = await lockTeam(tx, id);
    if (current.archivedAt === null) {
      throw new ConflictError(`Archive team "${current.name}" before deleting it`, "TEAM_NOT_ARCHIVED");
    }
    // Trashed resources count too: deleting the team would otherwise orphan them silently.
    const owned = await Promise.all([
      tx.select({ id: collections.id }).from(collections).where(eq(collections.teamId, id)).limit(1),
      tx.select({ id: environments.id }).from(environments).where(eq(environments.teamId, id)).limit(1),
      tx.select({ id: variables.id }).from(variables).where(eq(variables.teamId, id)).limit(1),
    ]);
    if (owned.some((rows) => rows.length > 0)) {
      throw new ConflictError(
        `Team "${current.name}" still owns collections, environments or variables`,
        "TEAM_NOT_EMPTY",
      );
    }
    await tx.delete(teams).where(eq(teams.id, id));
    await recordAudit(tx, {
      actorId,
      action: "team.deleted",
      targetType: "team",
      targetId: id,
      teamId: id,
      details: { name: current.name },
    });
  });
}

/**
 * Finds the account for an address, creating one that has never signed in when needed. Sign-in
 * upserts by email, so the person later picks up this row - and the memberships on it.
 */
async function findOrCreateUserByEmail(tx: DbExecutor, rawEmail: string): Promise<typeof users.$inferSelect> {
  const email = validateAllowedEmail(rawEmail);
  await tx
    .insert(users)
    .values({ id: randomUUID(), email, ...deriveUserProfileName(email), createdAt: nowIso() })
    .onDuplicateKeyUpdate({ set: { email } });
  const user = await first(tx.select().from(users).where(eq(users.email, email)).limit(1));
  if (!user) throw new Error("User row disappeared while a team member was being added");
  return user;
}

async function lockMemberships(tx: DbExecutor, teamId: string) {
  return tx.select().from(teamMembers).where(eq(teamMembers.teamId, teamId)).for("update");
}

function lastOwnerError(): ConflictError {
  return new ConflictError("A team must keep at least one owner", "TEAM_LAST_OWNER");
}

export function addTeamMember(
  db: AppDatabase,
  teamId: string,
  input: AddTeamMemberInput,
  actorId: string,
): Promise<TeamMember> {
  return db.transaction(async (tx) => {
    await lockActiveTeam(tx, teamId);
    const user = await findOrCreateUserByEmail(tx, input.email);
    const memberships = await lockMemberships(tx, teamId);
    if (memberships.some((membership) => membership.userId === user.id)) {
      throw new ConflictError(`${user.email} is already a member of this team`, "TEAM_MEMBER_EXISTS");
    }
    await tx.insert(teamMembers).values({ teamId, userId: user.id, role: input.role, createdAt: nowIso(), addedBy: actorId });
    await recordAudit(tx, {
      actorId,
      action: "team.member_added",
      targetType: "team_member",
      targetId: user.id,
      teamId,
      details: { email: user.email, role: input.role },
    });
    const member = (await selectMembers(tx, teamId)).find((m) => m.userId === user.id);
    return member!;
  });
}

export function updateTeamMemberRole(
  db: AppDatabase,
  teamId: string,
  userId: string,
  role: TeamRole,
  actorId: string,
): Promise<TeamMember> {
  return db.transaction(async (tx) => {
    await lockActiveTeam(tx, teamId);
    const memberships = await lockMemberships(tx, teamId);
    const current = memberships.find((membership) => membership.userId === userId);
    if (!current) throw new NotFoundError(`User ${userId} is not a member of this team`, "TEAM_MEMBER_NOT_FOUND");
    if (current.role === "owner" && role !== "owner" && memberships.filter((m) => m.role === "owner").length === 1) {
      throw lastOwnerError();
    }
    if (current.role !== role) {
      await tx.update(teamMembers).set({ role }).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
      await recordAudit(tx, {
        actorId,
        action: "team.member_role_changed",
        targetType: "team_member",
        targetId: userId,
        teamId,
        details: { from: current.role, to: role },
      });
    }
    const member = (await selectMembers(tx, teamId)).find((m) => m.userId === userId);
    return member!;
  });
}

export function removeTeamMember(db: AppDatabase, teamId: string, userId: string, actorId: string): Promise<void> {
  return db.transaction(async (tx) => {
    await lockActiveTeam(tx, teamId);
    const memberships = await lockMemberships(tx, teamId);
    const current = memberships.find((membership) => membership.userId === userId);
    if (!current) throw new NotFoundError(`User ${userId} is not a member of this team`, "TEAM_MEMBER_NOT_FOUND");
    if (current.role === "owner" && memberships.filter((m) => m.role === "owner").length === 1) {
      throw lastOwnerError();
    }
    await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
    const user = await first(tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1));
    await recordAudit(tx, {
      actorId,
      action: "team.member_removed",
      targetType: "team_member",
      targetId: userId,
      teamId,
      details: { email: user?.email ?? null, role: current.role },
    });
  });
}

const adminUserColumns = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  avatarColor: users.avatarColor,
  systemRole: users.systemRole,
  createdAt: users.createdAt,
  // Qualified by hand: drizzle renders a bare `id` here, which the subquery would bind to s.id.
  hasSignedIn: sql<number>`EXISTS (SELECT 1 FROM auth_sessions s WHERE s.user_id = \`users\`.\`id\`)`,
};

function toAdminUser(row: Omit<AdminUser, "hasSignedIn"> & { hasSignedIn: number | boolean }): AdminUser {
  return { ...row, hasSignedIn: Boolean(Number(row.hasSignedIn)) };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function listUsers(
  db: AppDatabase,
  options: { query?: string; limit: number; offset: number },
): Promise<{ users: AdminUser[]; total: number }> {
  let where: SQL | undefined;
  if (options.query) {
    const pattern = `%${escapeLike(options.query.toLowerCase())}%`;
    where = or(
      like(users.email, pattern),
      like(sql`lower(${users.firstName})`, pattern),
      like(sql`lower(${users.lastName})`, pattern),
    );
  }
  const [rows, [total]] = await Promise.all([
    db.select(adminUserColumns).from(users).where(where).orderBy(asc(users.email)).limit(options.limit).offset(options.offset),
    db.select({ value: count() }).from(users).where(where),
  ]);
  return { users: rows.map(toAdminUser), total: Number(total?.value ?? 0) };
}

async function userTeams(db: DbExecutor, userId: string): Promise<UserTeamMembership[]> {
  const rows = await db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role, archivedAt: teams.archivedAt })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId));
  return rows.sort(compareByName);
}

export async function readUser(db: DbExecutor, id: string): Promise<AdminUserDetail> {
  const row = await first(db.select(adminUserColumns).from(users).where(eq(users.id, id)).limit(1));
  if (!row) throw new NotFoundError(`User ${id} not found`, "USER_NOT_FOUND");
  return { ...toAdminUser(row), teams: await userTeams(db, id) };
}

export function updateUserSystemRole(
  db: AppDatabase,
  userId: string,
  systemRole: SystemRole,
  actorId: string,
): Promise<AdminUserDetail> {
  return db.transaction(async (tx) => {
    // Locking every admin row serialises concurrent demotions, so two admins cannot each remove
    // the other and leave the system with none.
    const admins = await tx.select({ id: users.id }).from(users).where(eq(users.systemRole, "admin")).for("update");
    const target = await first(tx.select().from(users).where(eq(users.id, userId)).limit(1).for("update"));
    if (!target) throw new NotFoundError(`User ${userId} not found`, "USER_NOT_FOUND");
    if (target.systemRole === systemRole) return readUser(tx, userId);
    if (target.systemRole === "admin" && admins.length === 1) {
      throw new ConflictError("The system must keep at least one administrator", "LAST_SYSTEM_ADMIN");
    }
    await tx.update(users).set({ systemRole }).where(eq(users.id, userId));
    await recordAudit(tx, {
      actorId,
      action: "user.system_role_changed",
      targetType: "user",
      targetId: userId,
      teamId: null,
      details: { email: target.email, from: target.systemRole, to: systemRole },
    });
    return readUser(tx, userId);
  });
}

export async function listAuditLog(
  db: AppDatabase,
  options: { teamId?: string; limit: number; offset: number },
): Promise<{ entries: AuditLogEntry[]; total: number }> {
  const where = options.teamId ? eq(adminAuditLog.teamId, options.teamId) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: adminAuditLog.id,
        actor: users.email,
        action: adminAuditLog.action,
        targetType: adminAuditLog.targetType,
        targetId: adminAuditLog.targetId,
        teamId: adminAuditLog.teamId,
        details: adminAuditLog.details,
        createdAt: adminAuditLog.createdAt,
      })
      .from(adminAuditLog)
      .leftJoin(users, eq(adminAuditLog.actorId, users.id))
      .where(where)
      .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(adminAuditLog).where(where),
  ]);
  return { entries: rows, total: Number(total?.value ?? 0) };
}

/** The teams a user may switch between: memberships of teams that are not archived. */
export async function listMyTeams(db: AppDatabase, userId: string): Promise<MyTeam[]> {
  const rows = await db
    .select({ id: teams.id, name: teams.name, description: teams.description, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(and(eq(teamMembers.userId, userId), isNull(teams.archivedAt)));
  return rows.sort(compareByName);
}

export interface TeamContext {
  id: string;
  name: string;
  role: TeamRole;
}

/**
 * The teams a user may work in right now, i.e. memberships of teams that are not archived. Read on
 * every request so removing a member or archiving a team takes effect on the very next call.
 */
export async function findActiveMemberships(db: DbExecutor, userId: string, teamId?: string): Promise<TeamContext[]> {
  return db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(and(
      eq(teamMembers.userId, userId),
      isNull(teams.archivedAt),
      ...(teamId === undefined ? [] : [eq(teams.id, teamId)]),
    ))
    .limit(teamId === undefined ? 1000 : 1);
}
