import { z } from "zod";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_URL_LENGTH = 8_192;
const MAX_ROWS = 500;
const MAX_ROW_TEXT_LENGTH = 8_192;
const MAX_BODY_LENGTH = 1_000_000;
const MAX_TREE_DEPTH = 32;

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

// Content is stored verbatim: it may contain {{variables}} that only become valid JSON
// after substitution, so parseability is checked by the client before sending.
export const requestBodySchema = z
  .strictObject({
    type: z.literal("json"),
    content: z.string().max(MAX_BODY_LENGTH),
  })
  .nullable()
  .default(null);

export const authSchema = z.strictObject({ type: z.literal("none") }).default({ type: "none" });

const requestFields = {
  name: nameSchema,
  description: descriptionSchema,
  method: z.enum(HTTP_METHODS),
  url: z.string().max(MAX_URL_LENGTH),
  queryParams: z.array(keyValueRowSchema).max(MAX_ROWS).default([]),
  headers: z.array(keyValueRowSchema).max(MAX_ROWS).default([]),
  body: requestBodySchema,
  auth: authSchema,
};

const folderFields = {
  name: nameSchema,
  description: descriptionSchema,
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

function treeDepth(nodes: TreeNodeInput[], depth = 1): number {
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
    items: z.array(treeNodeSchema).default([]),
  })
  .refine((value) => treeDepth(value.items) <= MAX_TREE_DEPTH, {
    message: `Folders may be nested at most ${MAX_TREE_DEPTH} levels deep`,
    path: ["items"],
  });
export type CreateCollectionInput = z.output<typeof createCollectionSchema>;

export const updateCollectionSchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema,
});
export type UpdateCollectionInput = z.output<typeof updateCollectionSchema>;

export const environmentVariableSchema = z.strictObject({
  key: z
    .string()
    .trim()
    .min(1, "Variable key must not be empty")
    .max(MAX_NAME_LENGTH)
    .regex(/^[^\s{}]+$/, "Variable key must not contain whitespace or braces"),
  value: z.string().max(MAX_ROW_TEXT_LENGTH),
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
    variables: z.array(environmentVariableSchema).max(MAX_ROWS).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.variables.forEach((variable, index) => {
      if (seen.has(variable.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate variable key "${variable.key}"`,
          path: ["variables", index, "key"],
        });
      }
      seen.add(variable.key);
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
