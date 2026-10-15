import { z } from "zod";
import { createAssistantBackup } from "@/assistant/api";

export type ManagedExportStep = "preparing" | "exporting";
export interface ManagedExportOptions {
  onStep?: (step: ManagedExportStep) => void;
}
export async function exportManagedBundle(
  assistantId: string,
  { onStep }: ManagedExportOptions = {},
) {
  onStep?.("preparing");
  onStep?.("exporting");
  const result = await createAssistantBackup(assistantId);
  if (!result.ok) {
    throw new Error("Cloud backup creation failed.");
  }
  const backup = z
    .object({ snapshot_name: z.string().min(1) })
    .parse(result.data);
  return { bundleKey: backup.snapshot_name, runtimeVersion: undefined };
}
export function exportBundleFilename(label: string, date: Date): string {
  const safeLabel = label
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 64);
  return `${safeLabel || "assistant"}-${date.toISOString().slice(0, 10)}.tar.gz`;
}
