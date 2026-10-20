import { z } from "zod";

const SelectionStateSchema = z.object({
  assistantSelection: z.object({
    id: z.string().min(1),
  }),
});

/**
 * A chosen assistant rides react-router location state between the account
 * chooser and the shell. History state survives reloads and restarts, so
 * malformed state must never resolve to a selection. Selections carry no
 * scope tag: the shell resolves assistants same-origin, and history state
 * never crosses origins to begin with.
 */
export function assistantSelectionState(id: string) {
  return { assistantSelection: { id } };
}

export function selectedAssistantId(state: unknown): string | undefined {
  const parsed = SelectionStateSchema.safeParse(state);
  return parsed.success ? parsed.data.assistantSelection.id : undefined;
}
