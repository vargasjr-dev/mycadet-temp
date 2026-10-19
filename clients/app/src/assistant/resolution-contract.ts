import { z } from "zod";

function publicUrl(value: string): boolean {
  if (/[\\\u0000-\u0020]/.test(value) || value.startsWith("//")) {
    return false;
  }
  if (
    (!value.startsWith("/") &&
      !/^https?:\/\//i.test(value) &&
      value.includes(":")) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value, "https://app.example");
    if (url.username || url.password || url.search || url.hash) {
      return false;
    }
    return (
      value.startsWith("/") ||
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

export const PublicUrlSchema = z
  .string()
  .min(1)
  .refine(
    publicUrl,
    "Expected a public host URL without credentials or query parameters.",
  );
export const ResolvedAssistantSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  url: PublicUrlSchema.refine((value) => {
    if (!publicUrl(value)) {
      return false;
    }
    return new URL(value, "https://app.example").pathname
      .replace(/\/$/, "")
      .endsWith("/assistant");
  }, "UI entry must end at /assistant/."),
});

export const AssistantDetailSchema = ResolvedAssistantSchema.extend({
  status: z.literal("active"),
});

export const AssistantChoiceSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .nullish()
    .transform((name) => name?.trim() || "New Assistant"),
});

export const AssistantResolutionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), assistant: ResolvedAssistantSchema }),
  z.object({ status: z.literal("starting") }),
  z.object({ status: z.literal("unavailable") }),
  z.object({
    status: z.literal("selection"),
    assistants: z.array(AssistantChoiceSchema),
  }),
  z.object({ status: z.literal("empty") }),
  z.object({ status: z.literal("unauthenticated") }),
]);
export type ResolvedAssistant = z.infer<typeof ResolvedAssistantSchema>;
export type AssistantResolution = z.infer<typeof AssistantResolutionSchema>;
export const AssistantNavigationSchema = z.object({
  source: z.literal("mycadet-web-nav"),
  nav: z.enum(["push", "replace", "pop"]),
  path: z.string(),
});
