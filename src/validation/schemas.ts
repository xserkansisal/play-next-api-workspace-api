import { z } from "zod";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_URL_LENGTH = 8_192;
const MAX_ROWS = 500;
const MAX_ROW_TEXT_LENGTH = 8_192;
const MAX_BODY_LENGTH = 1_000_000;
export const MAX_RUN_REQUESTS = 100;
export const MAX_SCRIPT_LENGTH = 32_768;
const requestScriptSchema = z.string().max(MAX_SCRIPT_LENGTH).default("");
const MAX_VARIABLE_KEY_LENGTH = 256;
const MAX_VARIABLE_VALUE_LENGTH = 64 * 1024;
export const MAX_TREE_DEPTH = 32;
export const MAX_IMPORT_NODES = 2_000;
export const IMPORT_BODY_LIMIT = "10mb";

export const idSchema = z.uuid();

export const nameSchema = z
  .string()
  .trim()
  .min(1, "Name must not be empty")
  .max(MAX_NAME_LENGTH, `Name must be at most ${MAX_NAME_LENGTH} characters`);

const descriptionSchema = z.string().max(MAX_DESCRIPTION_LENGTH).default("");

export const keyValueRowSchema = z.strictObject({
  key: z.string().max(MAX_ROW_TEXT_LENGTH),
  value: z.string().max(MAX_ROW_TEXT_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).default(""),
  enabled: z.boolean().default(true),
});

// Content is stored verbatim so the client can substitute {{variables}} before sending.
export const requestBodySchema = z
  .strictObject({
    type: z.enum(["json", "form-urlencoded", "multipart", "raw", "graphql"]),
    content: z.string().max(MAX_BODY_LENGTH),
  })
  .nullable()
  .default(null);

const authUsernameSchema = z.string().max(MAX_ROW_TEXT_LENGTH);
const authSecretSchema = z.string().max(MAX_ROW_TEXT_LENGTH);

export const requestAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("inherit") }),
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("basic"),
    username: authUsernameSchema,
    password: authSecretSchema,
  }),
  z.strictObject({ type: z.literal("bearer"), token: authSecretSchema }),
  z.strictObject({
    type: z.literal("api-key"),
    in: z.enum(["header", "query"]),
    key: authUsernameSchema.min(1),
    value: authSecretSchema,
  }),
]);
export type RequestAuth = z.output<typeof requestAuthSchema>;

export const scopedAuthSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({
    type: z.literal("basic"),
    username: authUsernameSchema,
    password: authSecretSchema,
  }),
  z.strictObject({ type: z.literal("bearer"), token: authSecretSchema }),
  z.strictObject({
    type: z.literal("api-key"),
    in: z.enum(["header", "query"]),
    key: authUsernameSchema.min(1),
    value: authSecretSchema,
  }),
]);
export type ScopedAuth = z.output<typeof scopedAuthSchema>;

export const authSchema = requestAuthSchema.default({ type: "inherit" });

const requestFields = {
  name: nameSchema,
  description: descriptionSchema,
  method: z.enum(HTTP_METHODS),
  url: z.string().max(MAX_URL_LENGTH),
  queryParams: z.array(keyValueRowSchema).max(MAX_ROWS).default([]),
  headers: z.array(keyValueRowSchema).max(MAX_ROWS).default([]),
  body: requestBodySchema,
  auth: authSchema,
  preRequestScript: requestScriptSchema,
  postResponseScript: requestScriptSchema,
};

const folderFields = {
  name: nameSchema,
  description: descriptionSchema,
  auth: scopedAuthSchema.nullable().optional(),
};

export const requestItemFieldsSchema = z.strictObject({ type: z.literal("request"), ...requestFields });
export const folderItemFieldsSchema = z.strictObject({ type: z.literal("folder"), ...folderFields });

export type RequestItemFields = z.output<typeof requestItemFieldsSchema>;
export type FolderItemFields = z.output<typeof folderItemFieldsSchema>;

const parentIdSchema = idSchema.nullable().default(null);

export const createItemSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("folder"), parentId: parentIdSchema, ...folderFields }),
  z.strictObject({ type: z.literal("request"), parentId: parentIdSchema, ...requestFields }),
]);
export type CreateItemInput = z.output<typeof createItemSchema>;

export const updateItemSchema = z.discriminatedUnion("type", [folderItemFieldsSchema, requestItemFieldsSchema]);
export type UpdateItemInput = z.output<typeof updateItemSchema>;

export const moveItemSchema = z.strictObject({
  targetCollectionId: idSchema,
  parentId: idSchema.nullable(),
});
export type MoveItemInput = z.output<typeof moveItemSchema>;

export type TreeNodeInput = RequestItemFields | (FolderItemFields & { items: TreeNodeInput[] });

const treeRequestSchema = requestItemFieldsSchema;
const treeFolderSchema = z.strictObject({
  type: z.literal("folder"),
  ...folderFields,
  get items(): z.ZodDefault<z.ZodArray<typeof treeNodeSchema>> {
    return z.array(treeNodeSchema).default([]);
  },
});
const treeNodeSchema: z.ZodType<TreeNodeInput, unknown> = z.discriminatedUnion("type", [
  treeFolderSchema,
  treeRequestSchema,
]) as unknown as z.ZodType<TreeNodeInput, unknown>;

export function treeDepth(nodes: TreeNodeInput[], depth = 1): number {
  let max = nodes.length > 0 ? depth : depth - 1;
  for (const node of nodes) {
    if (node.type === "folder") max = Math.max(max, treeDepth(node.items, depth + 1));
  }
  return max;
}

export const createCollectionSchema = z
  .strictObject({
    name: nameSchema,
    description: descriptionSchema,
    auth: scopedAuthSchema.nullable().default(null),
    items: z.array(treeNodeSchema).default([]),
  })
  .refine((value) => treeDepth(value.items) <= MAX_TREE_DEPTH, {
    message: `Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`,
    path: ["items"],
  });
export type CreateCollectionInput = z.output<typeof createCollectionSchema>;

export const importItemsSchema = z
  .strictObject({
    parentId: parentIdSchema,
    items: z.array(treeNodeSchema).min(1, "At least one item is required"),
    onConflict: z.enum(["rename", "fail"]).default("rename"),
    dryRun: z.boolean().default(false),
  })
  .refine((value) => treeDepth(value.items) <= MAX_TREE_DEPTH, {
    message: `Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`,
    path: ["items"],
  });
export type ImportItemsInput = z.output<typeof importItemsSchema>;

export interface ImportShape {
  nodes: number;
  depth: number;
}

/**
 * Counts nodes and nesting of an unvalidated import body without recursion.
 *
 * The tree schema is recursive, so a hostile body nested thousands of levels deep would exhaust
 * the stack inside zod before any depth rule got to run. This walks the raw JSON iteratively and
 * stops as soon as either limit is passed, so the caller can reject it before parsing.
 */
export function measureImportShape(body: unknown, limits = { nodes: MAX_IMPORT_NODES, depth: MAX_TREE_DEPTH }): ImportShape {
  const root = typeof body === "object" && body !== null ? (body as { items?: unknown }).items : undefined;
  let nodes = 0;
  let depth = 0;
  const stack: Array<{ list: unknown; level: number }> = [{ list: root, level: 1 }];
  while (stack.length > 0) {
    const { list, level } = stack.pop()!;
    if (!Array.isArray(list) || list.length === 0) continue;
    nodes += list.length;
    depth = Math.max(depth, level);
    if (nodes > limits.nodes || depth > limits.depth) break;
    for (const node of list) {
      if (typeof node === "object" && node !== null) stack.push({ list: (node as { items?: unknown }).items, level: level + 1 });
    }
  }
  return { nodes, depth };
}

export const updateCollectionSchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema,
  auth: scopedAuthSchema.nullable().optional(),
});
export type UpdateCollectionInput = z.output<typeof updateCollectionSchema>;

export const collectionSnapshotDiffQuerySchema = z.strictObject({
  from: idSchema,
  to: z.union([idSchema, z.literal("current")]),
});

export const collectionSnapshotListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const collectionRunSchema = z.strictObject({
  environmentId: idSchema.optional(),
});
export type CollectionRunInput = z.output<typeof collectionRunSchema>;

export const runHistoryQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type RunHistoryQuery = z.output<typeof runHistoryQuerySchema>;

export const environmentVariableSchema = z.strictObject({
  key: z
    .string()
    .trim()
    .min(1, "Variable key must not be empty")
    .max(MAX_VARIABLE_KEY_LENGTH)
    .regex(/^[^\s{}]+$/, "Variable key must not contain whitespace or braces"),
  value: z.string().max(MAX_VARIABLE_VALUE_LENGTH),
  enabled: z.boolean().default(true),
});

// Scoped variables reuse the environment key rules: both are referenced as {{key}}, so a key that
// breaks that reference is just as unusable here. Values are larger than a row's text because a
// captured value is whatever the response held - game state, for instance, is a whole JSON object.
export const variableKeySchema = environmentVariableSchema.shape.key;

export const variableScopeSchema = z.enum(["user", "global"]);

export const variableInputSchema = z.strictObject({
  value: z.string().max(MAX_BODY_LENGTH),
});
export type VariableInput = z.output<typeof variableInputSchema>;

export const variableCreateInputSchema = z.strictObject({
  key: variableKeySchema,
  value: z.string().max(MAX_VARIABLE_VALUE_LENGTH),
});

export const environmentVariableCreateInputSchema = z.strictObject({
  key: variableKeySchema,
  value: z.string().max(MAX_VARIABLE_VALUE_LENGTH),
  enabled: z.boolean().default(true),
});
export type EnvironmentVariableCreateInput = z.output<typeof environmentVariableCreateInputSchema>;

export const variablePatchSchema = z
  .strictObject({
    key: variableKeySchema.optional(),
    value: z.string().max(MAX_BODY_LENGTH).optional(),
  })
  .refine((value) => value.key !== undefined || value.value !== undefined, {
    message: "At least one of key or value must be provided",
  });

const variableOrderSortSchema = z.looseObject({
  field: z.enum(["key", "value"]),
  direction: z.enum(["asc", "desc"]),
});

const variableOrderManualSchema = z.looseObject({
  user: z.array(z.string().max(256)).max(1000),
  global: z.array(z.string().max(256)).max(1000),
  environments: z.record(z.string(), z.array(z.string().max(256)).max(1000)).superRefine((entries, ctx) => {
    if (Object.keys(entries).length > 200) {
      ctx.addIssue({
        code: "custom",
        message: "manual.environments must contain at most 200 entries",
      });
    }
  }),
});

export const variableOrderPreferencesSchema = z.looseObject({
  version: z.literal(1),
  sort: variableOrderSortSchema.nullable(),
  manual: variableOrderManualSchema,
  updatedAt: z.string(),
});
export type VariableOrderPreferences = z.output<typeof variableOrderPreferencesSchema>;

export const variableDisplayOrderSchema = z
  .strictObject({
    order: z.array(variableKeySchema),
  })
  .superRefine(({ order }, ctx) => {
    const seen = new Set<string>();
    order.forEach((key, index) => {
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate variable key "${key}"`,
          path: ["order", index],
        });
      }
      seen.add(key);
    });
  });
export type VariableDisplayOrderInput = z.output<typeof variableDisplayOrderSchema>;

export const environmentInputSchema = z
  .strictObject({
    name: nameSchema,
    variables: z.array(environmentVariableSchema).max(1000).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.variables.forEach((variable, index) => {
      if (variable.enabled && seen.has(variable.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate variable key "${variable.key}"`,
          path: ["variables", index, "key"],
        });
      }
      if (variable.enabled) seen.add(variable.key);
    });
  });
export type EnvironmentInput = z.output<typeof environmentInputSchema>;

export const restoreSchema = z
  .strictObject({
    collectionName: nameSchema.optional(),
    nameOverrides: z.record(idSchema, nameSchema).default({}),
  })
  .default({ nameOverrides: {} });
export type RestoreInput = z.output<typeof restoreSchema>;
