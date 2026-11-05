import { requestScopeKey } from "@/utils/request-scope-key";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";

/** Subscribe to {@link currentRequestScopeKey}. */
export function useRequestScopeKey(): string {
  const activeAssistantId = useActiveAssistantId();
  return requestScopeKey({ assistantId: activeAssistantId });
}
