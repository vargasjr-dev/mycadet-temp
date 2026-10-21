import { z } from "zod";

const SelectionStateSchema = z.object({
  assistantSelection: z.object({
    id: z.string().min(1),
    /**
     * Same-origin API base for entries the default same-origin `/v1`
     * resolution cannot serve: a paired assistant's gateway rides the
     * shell's paired-gateway path (the lockfile entry allowlists it and
     * the shell injects its guardian credential server-side). Absent for
     * every ordinary selection, which resolves same-origin as before.
     */
    apiBase: z.string().min(1).optional(),
  }),
});

/**
 * A chosen assistant rides react-router location state between the account
 * chooser and the shell. History state survives reloads and restarts, so
 * malformed state must never resolve to a selection. Selections carry no
 * scope tag: the shell resolves assistants same-origin, and history state
 * never crosses origins to begin with.
 */
export function assistantSelectionState(id: string, apiBase?: string) {
  return {
    assistantSelection: apiBase ? { id, apiBase } : { id },
  };
}

export function selectedAssistantState(
  state: unknown,
): { id: string; apiBase?: string } | undefined {
  const parsed = SelectionStateSchema.safeParse(state);
  return parsed.success ? parsed.data.assistantSelection : undefined;
}

export function selectedAssistantId(state: unknown): string | undefined {
  return selectedAssistantState(state)?.id;
}
