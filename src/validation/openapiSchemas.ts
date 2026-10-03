import { z } from "zod";
import { IMPORT_BODY_LIMIT, idSchema, nameSchema } from "./schemas.js";

const MAX_OPENAPI_TEXT_LENGTH = 10 * 1024 * 1024;

export const openApiDocumentSchema = z.union([
  z.string().max(MAX_OPENAPI_TEXT_LENGTH),
  z.record(z.string(), z.unknown()),
]);

export const createOpenApiCollectionSchema = z.strictObject({
  spec: openApiDocumentSchema,
  name: nameSchema.optional(),
  description: z.string().max(10_000).optional(),
});
export type CreateOpenApiCollectionInput = z.output<typeof createOpenApiCollectionSchema>;

export const importOpenApiSchema = z.strictObject({
  spec: openApiDocumentSchema,
  parentId: idSchema.nullable().default(null),
  onConflict: z.enum(["rename", "fail"]).default("rename"),
  dryRun: z.boolean().default(false),
});
export type ImportOpenApiInput = z.output<typeof importOpenApiSchema>;

export const exportOpenApiQuerySchema = z.strictObject({
  version: z.enum(["3.0", "3.1"]).default("3.1"),
  format: z.enum(["json", "yaml"]).default("json"),
});

export const previewOpenApiSyncSchema = z.strictObject({
  spec: openApiDocumentSchema,
});

export const applyOpenApiSyncSchema = z.strictObject({
  spec: openApiDocumentSchema,
  previewToken: z.string().regex(/^[a-f0-9]{64}$/i),
  adopt: z.record(z.string().max(1000), idSchema).default({}),
  conflicts: z.record(z.string().max(1000), z.enum(["keep", "spec"])).default({}),
  deleteItemIds: z.array(idSchema).max(2_000).default([]),
  recreate: z.array(z.string().max(1000)).max(2_000).default([]),
});
export type ApplyOpenApiSyncInput = z.output<typeof applyOpenApiSyncSchema>;

export const OPENAPI_BODY_LIMIT = IMPORT_BODY_LIMIT;
