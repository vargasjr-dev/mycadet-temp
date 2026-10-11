import { hatchAssistant } from "@/assistant/api";
import { setSelectedAssistant } from "@/assistant/selection";
import { extractErrorMessage } from "@/utils/api-errors";

export type CreateCloudAssistantResult =
  { ok: true; id: string } | { ok: false; error: string };

/**
 * Create a new managed (cloud-hosted) assistant and switch to it.
 *
 * Mirrors the native client's "New Assistant" flow: hatch with `mode: "create"`
 * so the cloud provisions an *additional* assistant (rather than `ensure`,
 * which hands back the existing one), refresh the lockfile so the new entry is
 * present for the tray/CLI, then select it via `setSelectedAssistant`.
 *
 * The new assistant starts in `initializing`; the lifecycle resolves it to
 * `active` once the cloud finishes provisioning. Never throws — failures
 * come back as `{ ok: false, error }`.
 */
export async function createCloudAssistant(
  name?: string,
): Promise<CreateCloudAssistantResult> {
  const result = await hatchAssistant(name ? { name } : undefined, "create");
  if (!result.ok) {
    return {
      ok: false,
      error: extractErrorMessage(
        result.error,
        undefined,
        "Failed to create assistant.",
      ),
    };
  }

  await setSelectedAssistant(result.data.id);
  return { ok: true, id: result.data.id };
}
