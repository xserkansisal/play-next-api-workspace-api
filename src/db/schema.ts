import { sql } from "drizzle-orm";
import {
  customType,
  boolean,
  check,
  foreignKey,
  index,
  int,
  json,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
  text,
} from "drizzle-orm/mysql-core";
import type { RequestAuth, ScopedAuth } from "../validation/schemas.js";

// Keep text comparisons byte-exact by creating the database with utf8mb4_0900_bin.
// Timestamps remain ISO-8601 UTC strings so the API's ordering/comparison semantics do not change.

const id = (name: string) => varchar(name, { length: 36 });
const timestamp = (name: string) => varchar(name, { length: 24 });
const description = (name: string) => text(name).notNull().default(sql`('')`);

export const users = mysqlTable("users", {
  id: id("id").primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  firstName: varchar("first_name", { length: 320 }).notNull().default(""),
  lastName: varchar("last_name", { length: 320 }).notNull().default(""),
  avatarColor: varchar("avatar_color", { length: 16 }).notNull().default("violet"),
  // System-wide role, independent of team membership: an admin manages teams and users but does
  // not gain access to any team's content by holding this role.
  systemRole: mysqlEnum("system_role", ["user", "admin"]).notNull().default("user"),
  createdAt: timestamp("created_at").notNull(),
});

export const teams = mysqlTable(
  "teams",
  {
    id: id("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    // Unique across archived teams too, so unarchiving can never collide with a newer team.
    nameKey: varchar("name_key", { length: 400 }).notNull().unique(),
    description: description("description"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    archivedAt: timestamp("archived_at"),
    createdBy: id("created_by").references(() => users.id),
    updatedBy: id("updated_by").references(() => users.id),
  },
);

// Per-team role, independent of the system role: owner manages the team's members, member edits its
// content, viewer only reads it and sends requests.
export const TEAM_ROLES = ["owner", "member", "viewer"] as const;

export const teamMembers = mysqlTable(
  "team_members",
  {
    teamId: id("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: mysqlEnum("role", TEAM_ROLES).notNull().default("member"),
    createdAt: timestamp("created_at").notNull(),
    addedBy: id("added_by").references(() => users.id),
  },
  (t) => [
    primaryKey({ name: "team_members_pk", columns: [t.teamId, t.userId] }),
    index("team_members_user_idx").on(t.userId),
  ],
);

export const adminAuditLog = mysqlTable(
  "admin_audit_log",
  {
    id: id("id").primaryKey(),
    actorId: id("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
    targetType: mysqlEnum("target_type", ["team", "team_member", "user"]).notNull(),
    // Kept as plain ids rather than foreign keys: an entry must outlive the team or user it names.
    targetId: id("target_id").notNull(),
    teamId: id("team_id"),
    details: json("details").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    index("admin_audit_log_created_idx").on(t.createdAt),
    index("admin_audit_log_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

const mediumBlob = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "mediumblob",
});

// One processed image per user. The id changes on every upload so avatar URLs can be cached
// forever and a replacement can never be served from a stale cache entry.
export const userAvatars = mysqlTable("user_avatars", {
  userId: id("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  id: id("id").notNull().unique(),
  contentType: varchar("content_type", { length: 32 }).notNull(),
  data: mediumBlob("data").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const authCodes = mysqlTable(
  "auth_codes",
  {
    id: id("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    attempts: int("attempts").notNull().default(0),
    consumedAt: timestamp("consumed_at"),
  },
  (t) => [index("auth_codes_email_created_idx").on(t.email, t.createdAt)],
);

export const authSessions = mysqlTable(
  "auth_sessions",
  {
    id: id("id").primaryKey(),
    userId: id("user_id").notNull().references(() => users.id),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId), index("auth_sessions_expiry_idx").on(t.expiresAt)],
);

export const authRateLimits = mysqlTable(
  "auth_rate_limits",
  {
    email: varchar("email", { length: 320 }).notNull(),
    purpose: mysqlEnum("purpose", ["request_code", "verify_code"]).notNull(),
    windowStartedAt: timestamp("window_started_at").notNull(),
    attempts: int("attempts").notNull(),
  },
  (t) => [primaryKey({ name: "auth_rate_limits_pk", columns: [t.email, t.purpose] })],
);

export const collections = mysqlTable(
  "collections",
  {
    id: id("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    nameKey: varchar("name_key", { length: 400 }).notNull(),
    activeNameKey: varchar("active_name_key", { length: 400 }).generatedAlwaysAs(
      sql`CASE WHEN ${sql.identifier("deleted_at")} IS NULL THEN ${sql.identifier("name_key")} ELSE NULL END`,
      { mode: "virtual" },
    ),
    description: description("description"),
    authConfig: json("auth_config").$type<ScopedAuth | null>().default(null),
    teamId: id("team_id")
      .notNull()
      .references(() => teams.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    deletedAt: timestamp("deleted_at"),
    createdBy: id("created_by").references(() => users.id),
    updatedBy: id("updated_by").references(() => users.id),
  },
  (t) => [uniqueIndex("collections_team_active_name_unique").on(t.teamId, t.activeNameKey)],
);

export const collectionVersions = mysqlTable(
  "collection_versions",
  {
    id: id("id").primaryKey(),
    collectionId: id("collection_id")
      .notNull()
      .references(() => collections.id),
    snapshot: json("snapshot").$type<{ name: string; description: string; auth?: ScopedAuth | null }>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    createdBy: id("created_by").references(() => users.id),
  },
  (t) => [index("collection_versions_collection_created_idx").on(t.collectionId, t.createdAt)],
);

export const items = mysqlTable(
  "items",
  {
    id: id("id").primaryKey(),
    collectionId: id("collection_id")
      .notNull()
      .references(() => collections.id),
    parentId: id("parent_id"),
    parentKey: varchar("parent_key", { length: 36 }).generatedAlwaysAs(
      sql`coalesce(${sql.identifier("parent_id")}, '')`,
      { mode: "virtual" },
    ),
    kind: mysqlEnum("kind", ["folder", "request"]).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    nameKey: varchar("name_key", { length: 400 }).notNull(),
    activeFolderNameKey: varchar("active_folder_name_key", { length: 400 }).generatedAlwaysAs(
      sql`CASE WHEN ${sql.identifier("kind")} = 'folder' AND ${sql.identifier("deleted_at")} IS NULL THEN ${sql.identifier("name_key")} ELSE NULL END`,
      { mode: "virtual" },
    ),
    description: description("description"),
    authConfig: json("auth_config").$type<ScopedAuth | null>().default(null),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    deletedAt: timestamp("deleted_at"),
    trashRootId: id("trash_root_id"),
    createdBy: id("created_by").references(() => users.id),
    updatedBy: id("updated_by").references(() => users.id),
  },
  (t) => [
    check("items_trash_state_check", sql`(${t.deletedAt} IS NULL) = (${t.trashRootId} IS NULL)`),
    uniqueIndex("items_id_collection_unique").on(t.id, t.collectionId),
    foreignKey({
      name: "items_parent_same_collection_fk",
      columns: [t.parentId, t.collectionId],
      foreignColumns: [t.id, t.collectionId],
    }),
    index("items_collection_parent_idx").on(t.collectionId, t.parentId),
    index("items_trash_root_idx").on(t.trashRootId),
    uniqueIndex("items_active_sibling_folder_name_unique").on(t.collectionId, t.parentKey, t.activeFolderNameKey),
  ],
);

export const itemVersions = mysqlTable(
  "item_versions",
  {
    id: id("id").primaryKey(),
    itemId: id("item_id")
      .notNull()
      .references(() => items.id),
    snapshot: json("snapshot")
      .$type<
        | { type: "folder"; name: string; description: string; auth?: ScopedAuth | null }
        | {
            type: "request";
            name: string;
            description: string;
            method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
            url: string;
            queryParams: Array<{ key: string; value: string; description: string; enabled: boolean }>;
            headers: Array<{ key: string; value: string; description: string; enabled: boolean }>;
            body: { type: "json" | "form-urlencoded" | "multipart" | "raw" | "graphql"; content: string } | null;
            auth: RequestAuth;
            preRequestScript: string;
            postResponseScript: string;
          }
      >()
      .notNull(),
    createdAt: timestamp("created_at").notNull(),
    createdBy: id("created_by").references(() => users.id),
  },
  (t) => [index("item_versions_item_created_idx").on(t.itemId, t.createdAt)],
);

export const presenceTestUsers = mysqlTable(
  "presence_test_users",
  {
    userId: id("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: id("client_id").notNull().unique(),
    locationKind: mysqlEnum("location_kind", ["collection", "folder", "request"]).notNull(),
    collectionId: id("collection_id")
      .notNull()
      .references(() => collections.id),
    itemId: id("item_id").references(() => items.id),
    locationUpdatedAt: timestamp("location_updated_at").notNull(),
  },
  (t) => [
    check(
      "presence_test_location_shape_check",
      sql`(${t.locationKind} = 'collection' AND ${t.itemId} IS NULL) OR (${t.locationKind} IN ('folder', 'request') AND ${t.itemId} IS NOT NULL)`,
    ),
  ],
);

export const requestDetails = mysqlTable(
  "request_details",
  {
    itemId: id("item_id")
      .primaryKey()
      .references(() => items.id),
    method: mysqlEnum("method", ["GET", "POST", "PUT", "PATCH", "DELETE"]).notNull(),
    url: varchar("url", { length: 8192 }).notNull(),
    bodyType: mysqlEnum("body_type", ["json", "form-urlencoded", "multipart", "raw", "graphql"]),
    bodyContent: mediumtext("body_content"),
    authType: mysqlEnum("auth_type", ["inherit", "none", "basic", "bearer", "api-key"]).notNull().default("inherit"),
    authConfig: json("auth_config").$type<Record<string, string> | null>(),
    preRequestScript: mediumtext("pre_request_script").notNull().default(""),
    postResponseScript: mediumtext("post_response_script").notNull().default(""),
  },
  (t) => [
    check(
      "request_details_body_check",
      sql`(${t.bodyType} IS NULL AND ${t.bodyContent} IS NULL) OR (${t.bodyType} IS NOT NULL AND ${t.bodyContent} IS NOT NULL)`,
    ),
  ],
);

export const testRuns = mysqlTable(
  "test_runs",
  {
    id: id("id").primaryKey(),
    collectionId: id("collection_id").notNull().references(() => collections.id),
    folderId: id("folder_id"),
    environmentId: id("environment_id").references(() => environments.id),
    userId: id("user_id").notNull().references(() => users.id),
    status: mysqlEnum("status", ["running", "passed", "failed", "error"]).notNull(),
    requestCount: int("request_count").notNull(),
    passedCount: int("passed_count").notNull().default(0),
    failedCount: int("failed_count").notNull().default(0),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
    durationMs: int("duration_ms"),
  },
  (t) => [
    index("test_runs_collection_user_started_idx").on(t.collectionId, t.userId, t.startedAt),
    index("test_runs_user_started_idx").on(t.userId, t.startedAt),
  ],
);

export const testRunResults = mysqlTable(
  "test_run_results",
  {
    id: id("id").primaryKey(),
    runId: id("run_id").notNull().references(() => testRuns.id, { onDelete: "cascade" }),
    position: int("position").notNull(),
    itemId: id("item_id").notNull(),
    itemName: varchar("item_name", { length: 200 }).notNull(),
    status: mysqlEnum("status", ["passed", "failed", "error", "skipped"]).notNull(),
    httpStatus: int("http_status"),
    durationMs: int("duration_ms").notNull(),
    responseSizeBytes: int("response_size_bytes"),
    responsePreview: text("response_preview"),
    responseTruncated: boolean("response_truncated").notNull().default(false),
    assertions: json("assertions")
      .$type<Array<{ name: string; passed: boolean; errorCode?: string }>>()
      .notNull(),
    errorCode: varchar("error_code", { length: 64 }),
  },
  (t) => [
    index("test_run_results_run_position_idx").on(t.runId, t.position),
    check("test_run_results_position_check", sql`${t.position} >= 0`),
  ],
);

function keyValueRowColumns() {
  return {
    requestId: id("request_id")
      .notNull()
      .references(() => requestDetails.itemId),
    position: int("position").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    description: description("description"),
    enabled: boolean("enabled").notNull().default(true),
  };
}

export const requestQueryParams = mysqlTable("request_query_params", keyValueRowColumns(), (t) => [
  primaryKey({ name: "request_query_params_pk", columns: [t.requestId, t.position] }),
  check("request_query_params_position_check", sql`${t.position} >= 0`),
]);

export const requestHeaders = mysqlTable("request_headers", keyValueRowColumns(), (t) => [
  primaryKey({ name: "request_headers_pk", columns: [t.requestId, t.position] }),
  check("request_headers_position_check", sql`${t.position} >= 0`),
]);

export const environments = mysqlTable(
  "environments",
  {
    id: id("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    nameKey: varchar("name_key", { length: 400 }).notNull(),
    activeNameKey: varchar("active_name_key", { length: 400 }).generatedAlwaysAs(
      sql`CASE WHEN ${sql.identifier("deleted_at")} IS NULL THEN ${sql.identifier("name_key")} ELSE NULL END`,
      { mode: "virtual" },
    ),
    teamId: id("team_id")
      .notNull()
      .references(() => teams.id),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    deletedAt: timestamp("deleted_at"),
    createdBy: id("created_by").references(() => users.id),
    updatedBy: id("updated_by").references(() => users.id),
  },
  (t) => [uniqueIndex("environments_team_active_name_unique").on(t.teamId, t.activeNameKey)],
);

export const environmentVariables = mysqlTable(
  "environment_variables",
  {
    environmentId: id("environment_id")
      .notNull()
      .references(() => environments.id),
    position: int("position").notNull(),
    key: varchar("key", { length: 256 }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    enabledKey: varchar("enabled_key", { length: 256 }).generatedAlwaysAs(
      sql`CASE WHEN ${sql.identifier("enabled")} = 1 THEN ${sql.identifier("key")} ELSE NULL END`,
      { mode: "virtual" },
    ),
    value: mediumtext("value").notNull(),
  },
  (t) => [
    primaryKey({ name: "environment_variables_pk", columns: [t.environmentId, t.position] }),
    uniqueIndex("environment_variables_enabled_key_unique").on(t.environmentId, t.enabledKey),
    check("environment_variables_position_check", sql`${t.position} >= 0`),
  ],
);

export const variables = mysqlTable(
  "variables",
  {
    id: id("id").primaryKey(),
    scope: mysqlEnum("scope", ["user", "global"]).notNull(),
    userId: id("user_id").references(() => users.id),
    // Set for `global` rows only: "global" means everyone in this team, not everyone signed in.
    teamId: id("team_id").references(() => teams.id),
    key: varchar("key", { length: 256 }).notNull(),
    userScopedKey: varchar("user_scoped_key", { length: 256 }).generatedAlwaysAs(
      sql`CASE WHEN ${sql.identifier("scope")} = 'user' THEN ${sql.identifier("key")} ELSE NULL END`,
      { mode: "virtual" },
    ),
    globalScopedKey: varchar("global_scoped_key", { length: 256 }).generatedAlwaysAs(
      sql`CASE WHEN ${sql.identifier("scope")} = 'global' THEN ${sql.identifier("key")} ELSE NULL END`,
      { mode: "virtual" },
    ),
    value: mediumtext("value").notNull(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    updatedBy: id("updated_by").references(() => users.id),
  },
  (t) => [
    check(
      "variables_owner_check",
      sql`(${t.scope} = 'user' AND ${t.userId} IS NOT NULL AND ${t.teamId} IS NULL) OR (${t.scope} = 'global' AND ${t.userId} IS NULL AND ${t.teamId} IS NOT NULL)`,
    ),
    uniqueIndex("variables_user_key_unique").on(t.userId, t.userScopedKey),
    uniqueIndex("variables_team_global_key_unique").on(t.teamId, t.globalScopedKey),
  ],
);

export const variableDisplayOrders = mysqlTable("variable_display_orders", {
  userId: id("user_id")
    .primaryKey()
    .references(() => users.id),
  order: json("order").$type<string[]>().notNull(),
});

export const userPreferences = mysqlTable(
  "user_preferences",
  {
    userId: id("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    value: json("value").notNull(),
  },
  (t) => [primaryKey({ name: "user_preferences_pk", columns: [t.userId, t.name] })],
);
