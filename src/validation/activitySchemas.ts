import { z } from "zod";

export const activityQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export type ActivityQuery = z.output<typeof activityQuerySchema>;
