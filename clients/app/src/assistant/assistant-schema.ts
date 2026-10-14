import { z } from "zod";

/** Account-facing assistant identity; runtime and avatar data stay in web. */
export const AssistantSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  created: z.string().optional(),
});
export const AssistantPageSchema = z.object({
  results: z.array(AssistantSchema),
  next: z.string().nullable().optional(),
});
export type Assistant = z.infer<typeof AssistantSchema>;
