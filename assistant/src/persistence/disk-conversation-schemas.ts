import { z } from "zod";

/** The legacy conversation view written to meta.json and messages.jsonl. */
export const diskConversationMetaSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  type: z.string().optional(),
  channel: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const diskConversationMessageSchema = z.object({
  role: z.string(),
  ts: z.string().optional(),
  content: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        name: z.string().optional(),
        input: z.unknown(),
      }),
    )
    .optional(),
  toolResults: z.array(z.object({ content: z.unknown() })).optional(),
  attachments: z.array(z.unknown()).optional(),
});

export type DiskMeta = z.infer<typeof diskConversationMetaSchema>;
export type DiskMessageRecord = z.infer<typeof diskConversationMessageSchema>;
