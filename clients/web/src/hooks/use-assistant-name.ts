import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

function resolveAssistantName(
  assistantId: string | null,
  identity: { assistantId: string | null; name: string | null },
  entry: { assistantId: string; name?: string } | null,
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
  return (
    (entry && entry.assistantId === assistantId
      ? (entry.name?.trim() || null)
      : null)
  );
}

export function readAssistantName(assistantId: string | null): string | null {
  return resolveAssistantName(
    assistantId,
    useAssistantIdentityStore.getState(),
    useResolvedAssistantStore.getState().assistant,
  );
}

export function useAssistantName(assistantId: string | null): string | null {
  const name = useAssistantIdentityStore.use.name();
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const entry = useResolvedAssistantStore.use.assistant();
  return resolveAssistantName(
    assistantId,
    { assistantId: identityAssistantId, name },
    entry,
  );
}
