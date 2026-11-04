import { isLocalEntry, type LockfileAssistant } from "./lockfile-contract";
import { getLockfileData } from "./lockfile";
import { resolveInstanceDir } from "./config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Raw entry from the same authoritative file the parsed data came from.
function findRawAssistant(
  raw: Record<string, unknown>,
  assistantId: string,
): Record<string, unknown> | null {
  if (!Array.isArray(raw.assistants)) return null;
  const entry = raw.assistants.find(
    (assistant) => isRecord(assistant) && assistant.assistantId === assistantId,
  );
  return isRecord(entry) ? entry : null;
}

function lockfileInstanceDir(
  entry: LockfileAssistant | undefined,
): string | undefined {
  return entry && isLocalEntry(entry) ? entry.instanceDir : undefined;
}

export type LockfileInstanceDirResult =
  | { ok: true; instanceDir?: string }
  | { ok: false };

/**
 * The instance directory for a lockfile entry: the persisted one (honoring
 * legacy `baseDataDir` entries the parsed contract drops), else the default
 * location status also falls back to. `instanceDir` is undefined when the
 * entry is missing; `ok: false` when the authoritative lockfile is unreadable,
 * so callers can tell absence from a failed read.
 */
export function resolveLockfileInstanceDir(
  assistantId: string,
): LockfileInstanceDirResult {
  const result = getLockfileData();
  if (!result.ok) {
    return { ok: false };
  }
  const entry = result.data.assistants.find(
    (assistant) => assistant.assistantId === assistantId,
  );
  const rawEntry = findRawAssistant(result.raw, assistantId);
  if (!entry && !rawEntry) {
    return { ok: true };
  }
  try {
    return {
      ok: true,
      instanceDir:
        lockfileInstanceDir(entry) ?? resolveInstanceDir(assistantId),
    };
  } catch {
    return { ok: true };
  }
}
