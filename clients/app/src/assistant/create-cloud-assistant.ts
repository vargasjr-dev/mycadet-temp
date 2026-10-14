import { hatchAssistant } from "@app/assistant/api";
import { writeSelectedAssistantId } from "@app/assistant/selected-assistant-storage";

export type CreateCloudAssistantResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export async function createCloudAssistant(
  name?: string,
): Promise<CreateCloudAssistantResult> {
  const result = await hatchAssistant(name);
  if (!result.ok) {
    return { ok: false, error: result.error.detail };
  }
  writeSelectedAssistantId(result.data.id);
  return { ok: true, id: result.data.id };
}
