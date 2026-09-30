import { z } from "zod";

export const emailInputSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
});

export const verifyCodeInputSchema = z.strictObject({
  email: z.string().trim().pipe(z.email().max(254)),
  code: z.string().regex(/^\d{6}$/),
});
