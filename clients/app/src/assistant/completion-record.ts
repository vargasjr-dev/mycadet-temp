import { z } from "zod";
import { getLocalSetting } from "@app/utils/local-settings";

const STORAGE_KEY = "device:onboarded_assistants";
const RecordSchema = z.record(z.string(), z.string());
const ChangeSchema = z.object({
  key: z.literal(STORAGE_KEY),
  value: z.string().nullable(),
});
let notifiedRecord: Record<string, string> | undefined;
if (typeof window !== "undefined") {
  window.addEventListener("cadet:pref-changed", (event) => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const change = ChangeSchema.safeParse(event.detail);
    if (!change.success) {
      return;
    }
    try {
      const parsed = RecordSchema.safeParse(
        JSON.parse(change.data.value ?? "{}"),
      );
      if (parsed.success) {
        notifiedRecord = parsed.data;
      }
    } catch {
      // An invalid completion notification cannot change account routing.
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      notifiedRecord = undefined;
    }
  });
}

/** Completion remains assistant-owned; account routing only reads its device record. */
export function readAssistantCompletion(id: string): string | undefined {
  if (notifiedRecord) {
    return notifiedRecord[id] || undefined;
  }
  try {
    const parsed = RecordSchema.safeParse(
      JSON.parse(getLocalSetting(STORAGE_KEY, "{}")),
    );
    return parsed.success ? parsed.data[id] || undefined : undefined;
  } catch {
    return undefined;
  }
}
