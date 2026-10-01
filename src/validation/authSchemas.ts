import { z } from "zod";
import { AVATAR_COLORS } from "../auth/avatar.js";

export const emailInputSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
});

export const verifyCodeInputSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  code: z.string().regex(/^\d{6}$/),
});

export const updateProfileInputSchema = z.strictObject({
  avatarColor: z.enum(AVATAR_COLORS),
});
