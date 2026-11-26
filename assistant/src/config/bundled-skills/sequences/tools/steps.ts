import { z } from "zod";

import type { SequenceStep } from "../../../../sequence/types.js";

const stepsSchema = z.array(
  z.object({
    delay_seconds: z.number().nullish(),
    subject: z.string().nullish(),
    body_prompt: z.string().nullish(),
    reply_in_same_conversation: z.boolean().nullish(),
    require_approval: z.boolean().nullish(),
  }),
);

export function parseSteps(input: unknown): SequenceStep[] {
  return stepsSchema.parse(input).map((step, index) => ({
    index,
    delaySeconds: step.delay_seconds ?? 0,
    subjectTemplate: step.subject ?? `Step ${index + 1}`,
    bodyPrompt: step.body_prompt ?? "",
    replyInSameConversation: step.reply_in_same_conversation ?? index > 0,
    requireApproval: step.require_approval ?? false,
  }));
}
