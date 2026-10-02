import { z } from "zod";
import { TEAM_ROLES } from "../db/schema.js";
import { nameSchema } from "./schemas.js";

const teamDescriptionSchema = z.string().max(10_000);
const emailSchema = z.string().trim().pipe(z.email().max(254));
const booleanQuerySchema = z.enum(["true", "false"]).transform((value) => value === "true");

export const teamRoleSchema = z.enum(TEAM_ROLES);

export const createTeamSchema = z.strictObject({
  name: nameSchema,
  description: teamDescriptionSchema.default(""),
});

export const updateTeamSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: teamDescriptionSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, "Nothing to update");

export const listTeamsQuerySchema = z.object({
  includeArchived: booleanQuerySchema.default(false),
});

export const addTeamMemberSchema = z.strictObject({
  email: emailSchema,
  role: teamRoleSchema.default("member"),
});

export const updateTeamMemberSchema = z.strictObject({
  role: teamRoleSchema,
});

export const listUsersQuerySchema = z.object({
  query: z.string().trim().max(254).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const updateUserSchema = z.strictObject({
  systemRole: z.enum(["user", "admin"]),
});

export const listAuditLogQuerySchema = z.object({
  teamId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type TeamRole = z.infer<typeof teamRoleSchema>;
