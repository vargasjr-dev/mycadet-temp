import { z } from "zod";
import { listAssistants } from "@app/assistant/api";
import { readAssistantCompletion } from "@app/assistant/completion-record";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { isLocalModeHostAvailable } from "@app/runtime/local-host-transport";

const LockfileSchema = z.object({
  assistants: z.array(
    z.object({
      assistantId: z.string().min(1),
      onboardedAt: z.string().optional(),
      hatchedAt: z.string().optional(),
    }),
  ),
});
const HATCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isReturningAssistant(assistant: {
  id: string;
  created?: string;
  onboardedAt?: string;
}): boolean {
  if (assistant.onboardedAt || readAssistantCompletion(assistant.id)) {
    return true;
  }
  const created = Date.parse(assistant.created ?? "");
  return Number.isFinite(created) && Date.now() - created >= HATCH_AGE_MS;
}

/** Fresh account and host reads avoid coupling account routing to Web's stores. */
export async function readReturningUser(): Promise<boolean> {
  if (isLocalModeHostAvailable()) {
    try {
      const bridge = getElectronBridge();
      let payload: unknown;
      if (bridge?.localMode) {
        payload = await bridge.localMode.readLockfile();
      } else {
        const response = await fetch("/assistant/__local/lockfile", {
          signal: AbortSignal.timeout(5000),
        });
        payload = response.ok ? await response.json() : null;
      }
      const parsed = LockfileSchema.safeParse(payload);
      if (
        parsed.success &&
        parsed.data.assistants.some((assistant) =>
          isReturningAssistant({
            id: assistant.assistantId,
            created: assistant.hatchedAt,
            onboardedAt: assistant.onboardedAt,
          }),
        )
      ) {
        return true;
      }
    } catch {
      // Cloud membership can still identify a returning user when the host is offline.
    }
  }
  const result = await listAssistants({ signal: AbortSignal.timeout(5000) });
  return result.ok && result.data.some(isReturningAssistant);
}
