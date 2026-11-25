import { z } from "zod";

import { jsonObjectSchema } from "./json-object-schema.js";

export const migratedLlmSchema = z.looseObject({
  default: jsonObjectSchema.optional(),
  profiles: z.record(z.string(), jsonObjectSchema).optional(),
  callSites: jsonObjectSchema.optional(),
});

export const configWithCallSitesSchema = z.looseObject({
  llm: z.looseObject({
    callSites: z.record(z.string(), jsonObjectSchema),
  }),
});

export const configWithActiveProfileSchema = z.looseObject({
  llm: z.looseObject({
    activeProfile: z.string(),
    callSites: jsonObjectSchema,
  }),
});

export const configWithOptionalCallSitesSchema = z.looseObject({
  llm: z.looseObject({ callSites: jsonObjectSchema.optional() }),
});
