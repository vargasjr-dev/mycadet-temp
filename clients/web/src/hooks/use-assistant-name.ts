import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  getAssistantName,
  useResolvedAssistantStore,
} from "@/stores/resolved-assistant-store";

function resolveAssistantName(
  assistantId: string | null,
  identity: { assistantId: string | null; name: string | null },
  shellStamp: { assistantId: string | null; name?: string },
): string | null {
  if (!assistantId) {
    return null;
  }
  if (identity.assistantId === assistantId) {
    const name = identity.name?.trim();
    if (name) {
      return name;
    }
  }
  return shellStamp.assistantId === assistantId
    ? shellStamp.name?.trim() || null
    : null;
}

export function useAssistantName(assistantId: string | null): string | null {
  const name = useAssistantIdentityStore.use.name();
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const resolvedAssistantId = useResolvedAssistantStore.use.assistantId();
  return resolveAssistantName(
    assistantId,
    { assistantId: identityAssistantId, name },
    { assistantId: resolvedAssistantId, name: getAssistantName() },
  );
}
