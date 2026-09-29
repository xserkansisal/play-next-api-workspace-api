import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

// Timestamps are ISO-8601 UTC strings. `name_key` holds a case-folded name used for
// case-insensitive uniqueness. `trash_root_id` identifies the Trash root a soft-deleted
// row was moved with, so a whole subtree can be restored together.

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    uniqueIndex("collections_active_name_unique").on(t.nameKey).where(sql`"deleted_at" IS NULL`),
  ],
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id),
    parentId: text("parent_id"),
    // Non-null sibling-group key so root-level folders participate in the unique index.
    parentKey: text("parent_key")
      .notNull()
      .generatedAlwaysAs(sql`coalesce("parent_id", '')`, { mode: "virtual" }),
    kind: text("kind", { enum: ["folder", "request"] }).notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    trashRootId: text("trash_root_id"),
  },
  (t) => [
    check("items_kind_check", sql`"kind" IN ('folder', 'request')`),
    check("items_trash_state_check", sql`("deleted_at" IS NULL) = ("trash_root_id" IS NULL)`),
    uniqueIndex("items_id_collection_unique").on(t.id, t.collectionId),
    // A parent must be an item of the same collection.
    foreignKey({
      name: "items_parent_same_collection_fk",
      columns: [t.parentId, t.collectionId],
      foreignColumns: [t.id, t.collectionId] as [AnySQLiteColumn, AnySQLiteColumn],
    }),
    index("items_collection_parent_idx").on(t.collectionId, t.parentId),
    index("items_trash_root_idx").on(t.trashRootId),
    uniqueIndex("items_active_sibling_folder_name_unique")
      .on(t.collectionId, t.parentKey, t.nameKey)
      .where(sql`"kind" = 'folder' AND "deleted_at" IS NULL`),
  ],
);

export const requestDetails = sqliteTable(
  "request_details",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => items.id),
    method: text("method", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }).notNull(),
    url: text("url").notNull(),
    bodyType: text("body_type", { enum: ["json"] }),
    bodyContent: text("body_content"),
    authType: text("auth_type", { enum: ["none"] })
      .notNull()
      .default("none"),
  },
  () => [
    check("request_details_method_check", sql`"method" IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')`),
    check("request_details_auth_check", sql`"auth_type" = 'none'`),
    check(
      "request_details_body_check",
      sql`("body_type" IS NULL AND "body_content" IS NULL) OR ("body_type" = 'json' AND "body_content" IS NOT NULL)`,
    ),
  ],
);

function keyValueRowColumns() {
  return {
    requestId: text("request_id")
      .notNull()
      .references(() => requestDetails.itemId),
    position: integer("position").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    description: text("description").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  };
}

export const requestQueryParams = sqliteTable("request_query_params", keyValueRowColumns(), (t) => [
  primaryKey({ name: "request_query_params_pk", columns: [t.requestId, t.position] }),
  check("request_query_params_position_check", sql`"position" >= 0`),
]);

export const requestHeaders = sqliteTable("request_headers", keyValueRowColumns(), (t) => [
  primaryKey({ name: "request_headers_pk", columns: [t.requestId, t.position] }),
  check("request_headers_position_check", sql`"position" >= 0`),
]);

export const environments = sqliteTable("environments", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
});

export const environmentVariables = sqliteTable(
  "environment_variables",
  {
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id),
    position: integer("position").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [
    primaryKey({ name: "environment_variables_pk", columns: [t.environmentId, t.position] }),
    uniqueIndex("environment_variables_key_unique").on(t.environmentId, t.key),
    check("environment_variables_position_check", sql`"position" >= 0`),
  ],
);
