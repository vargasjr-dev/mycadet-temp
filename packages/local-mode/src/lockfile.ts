import fs from "node:fs";
import path from "node:path";

import {
  LockfileSchema,
  parseLockfile,
  type Lockfile,
  type LockfileAssistant,
} from "./lockfile-contract";
import { LockfileAssistantSchema } from "./lockfile-contract";
import { resolveLockfilePath } from "./config";

import { withLockfileLock } from "./lockfile-lock";
import { stripSensitiveFields } from "./util";

/**
 * The one lockfile read: the first existing candidate file parsed against the
 * contract, degrading to the empty registry when no file parses. Takes no
 * input — the paths resolve from the process's environment (the same
 * `CADET_ENVIRONMENT` / persisted-default resolution every host and the CLI
 * share), so every consumer of a lockfile answers the same question about the
 * same bytes.
 */
export function readLockfile(): Lockfile {
  const lockfilePath = resolveLockfilePath();
  if (!fs.existsSync(lockfilePath)) return LockfileSchema.parse({});
  try {
    const parsed = LockfileSchema.safeParse(
      JSON.parse(fs.readFileSync(lockfilePath, "utf-8")),
    );
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Malformed lockfile degrades to the empty registry.
  }
  return LockfileSchema.parse({});
}

/** `raw` is the authoritative file's parsed JSON (unknown fields intact). */
export type LockfileResult =
  | { ok: true; data: Lockfile; raw: Record<string, unknown> }
  | { ok: false; status: number; error?: string };

/**
 * The raw-preserving read: the HTTP lockfile API and the instance-dir
 * resolution need the unknown-field-intact record alongside the wire view, so
 * this stays package-internal (never re-exported from the index) — everything
 * else reads through {@link readLockfile}.
 */
export function getLockfileData(): LockfileResult {
  const lockfilePath = resolveLockfilePath();
  let raw: string;
  try {
    raw = fs.readFileSync(lockfilePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const empty = { assistants: [], activeAssistant: null };
      return { ok: true, data: empty, raw: empty };
    }
    return { ok: false, status: 500 };
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 500 };
  }
  stripSensitiveFields(data);
  return { ok: true, data: parseLockfile(data), raw: data };
}

export type WriteResult =
  | { ok: true; lockfile: Lockfile }
  | { ok: false; status: number; error: string };

/** 423 Locked: the cross-process advisory lock could not be acquired. */
export function lockFailure(error: string): WriteResult {
  return { ok: false, status: 423, error };
}

/** The validated, sensitive-field-stripped wire view of a raw lockfile. */
function toWireLockfile(lockfile: Record<string, unknown>): Lockfile {
  const stripped = JSON.parse(JSON.stringify(lockfile)) as Record<
    string,
    unknown
  >;
  stripSensitiveFields(stripped);
  return parseLockfile(stripped);
}

/**
 * Atomically persist a raw lockfile (write-to-temp + rename) and return the
 * validated, sensitive-field-stripped view of what was written.
 */
export function writeRawLockfile(
  lockfile: Record<string, unknown>,
): WriteResult {
  const writePath = resolveLockfilePath();
  try {
    const dir = path.dirname(writePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${writePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(lockfile, null, 2));
    fs.renameSync(tmp, writePath);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Failed to write lockfile: ${err}`,
    };
  }

  return { ok: true, lockfile: toWireLockfile(lockfile) };
}

/** A partial entry patch, distributed over the union so each topology's own fields patch. */
type AssistantPatch<T> = { [K in keyof T]?: T[K] | undefined };
export type LockfileAssistantPatch = AssistantPatch<LockfileAssistant>;

export function saveLockfileAssistant(
  assistant: LockfileAssistantPatch,
  activeAssistant?: string,
): void {
  const assistantId = assistant?.assistantId;
  if (typeof assistantId !== "string") {
    throw new Error("Missing assistant.assistantId");
  }
  const locked = withLockfileLock((): WriteResult => {
    const lockfile = readLockfile();
    const assistants = [...lockfile.assistants];
    const existingIdx = assistants.findIndex(
      (a) => a.assistantId === assistantId,
    );
    // The contract's parse is total: unknown keys (the legacy on-disk
    // secrets) drop here, so the first write through the schema migrates an
    // old lockfile clean.
    if (existingIdx >= 0) {
      assistants[existingIdx] = LockfileAssistantSchema.parse({
        ...assistants[existingIdx]!,
        ...assistant,
        assistantId,
      });
    } else {
      assistants.push(
        LockfileAssistantSchema.parse({ ...assistant, assistantId }),
      );
    }
    lockfile.assistants = assistants;
    if (activeAssistant !== undefined) {
      lockfile.activeAssistant = activeAssistant;
    }

    return writeRawLockfile(lockfile);
  });
  if (!locked.ok) {
    throw new Error(locked.error);
  }
}

export function isActiveAssistant(assistantId: string): boolean {
  const lockfile = readLockfile();
  if (lockfile.activeAssistant === assistantId) return true;
  return (
    lockfile.assistants.length === 1 &&
    lockfile.assistants[0]!.assistantId === assistantId
  );
}
