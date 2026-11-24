import { z } from "zod";

export const inferenceProfileSessionResponseSchema = z.object({
  conversationId: z.string(),
  profile: z.string().nullable(),
  sessionId: z.string().nullable(),
  expiresAt: z.number().nullable(),
  ttlSeconds: z.number().nullable().optional(),
  replaced: z
    .object({
      profile: z.string().nullable(),
      sessionId: z.string().nullable(),
      expiresAt: z.number().nullable(),
    })
    .nullable(),
});
