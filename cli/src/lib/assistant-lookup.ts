import { getAssistantDisplayName } from "@mycadet/local-mode";
import { loadAllAssistants } from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

/**
 * The CLI's name-or-ID targeting: resolve a user-typed identifier against
 * the lockfile (exact ID wins, then a unique display-name match), with the
 * error formatting the command edges print. CLI-only UX — the operations
 * resolve through findAssistant instead.
 */

export type AssistantLookupResult =
  | { status: "found"; entry: LockfileAssistant }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: LockfileAssistant[] };

function getAssistantDisplayNameCandidates(entry: LockfileAssistant): string[] {
  const name = entry.name?.trim();
  return name ? [name] : [];
}

export function lookupAssistantByIdentifier(
  identifier: string,
): AssistantLookupResult {
  const entries = loadAllAssistants();
  const exactId = entries.find((entry) => entry.assistantId === identifier);
  if (exactId) {
    return { status: "found", entry: exactId };
  }

  const displayMatches = entries.filter((entry) =>
    getAssistantDisplayNameCandidates(entry).includes(identifier),
  );
  if (displayMatches.length === 1) {
    return { status: "found", entry: displayMatches[0]! };
  }
  if (displayMatches.length > 1) {
    return { status: "ambiguous", matches: displayMatches };
  }

  return { status: "not_found" };
}

export function formatAssistantLookupError(
  identifier: string,
  result: AssistantLookupResult = lookupAssistantByIdentifier(identifier),
): string {
  if (result.status === "ambiguous") {
    const matches = result.matches
      .map(
        (entry) => `${getAssistantDisplayName(entry)} (${entry.assistantId})`,
      )
      .join(", ");
    return `Multiple assistants match '${identifier}': ${matches}. Use the assistant ID to disambiguate.`;
  }

  return `No assistant found with name or ID '${identifier}'.`;
}
