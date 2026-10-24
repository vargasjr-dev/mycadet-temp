import { z } from "zod";
import { getLocalSetting, setLocalSetting } from "@app/utils/local-settings";

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

/**
 * Stamp `assistantId` as onboarded. Idempotent: an existing stamp is kept, so
 * a replayed funnel never rewrites the original completion time. Same device
 * key the web bundle reads, so a completion recorded here is visible to the
 * assistant surface in same-origin shells.
 */
export function markAssistantCompletion(
  id: string,
  at: string = new Date().toISOString(),
): void {
  let record: Record<string, string> = {};
  try {
    const parsed = RecordSchema.safeParse(
      JSON.parse(getLocalSetting(STORAGE_KEY, "{}")),
    );
    if (parsed.success) {
      record = parsed.data;
    }
  } catch {
    // Unreadable record: treat as empty rather than refusing the stamp.
  }
  if (record[id]) {
    return;
  }
  if (!setLocalSetting(STORAGE_KEY, JSON.stringify({ ...record, [id]: at }))) {
    return;
  }
  notifiedRecord = undefined;
}
