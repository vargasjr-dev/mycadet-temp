import fs from "node:fs";
import path from "node:path";

import {
  LockfileSchema,
  parseLockfile,
  type Lockfile,
  type LockfileAssistant,
} from "./lockfile-contract";
import { isCloudHome } from "./lockfile-contract";
import { resolveLockfilePath } from "./config";
import { z } from "zod";

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

/**
 * Rename an existing assistant entry, never creating one. Unlike the upserts,
 * a missing entry refuses (404) and an unreadable on-disk file refuses (409)
 * instead of being treated as an empty registry, so a stale renderer cache
 * can neither resurrect a retired assistant nor replace a registry it could
 * not read with a skeleton row. Never touches `activeAssistant`. The whole
 * read-check-write runs under the shared advisory lock so a concurrent writer
 * (e.g. a CLI retire) cannot be clobbered by this snapshot; lock contention
 * refuses (423) without writing.
 */
export function renameLockfileAssistantIfPresent(
  assistantId: string,
  name: string,
): WriteResult {
  if (typeof name !== "string" || name === "") {
    return { ok: false, status: 400, error: "Missing name" };
  }
  return updateLockfileAssistantIfPresent(assistantId, { name });
}

/**
 * Record when an assistant finished first-run onboarding. Update-only, on the
 * same terms as {@link renameLockfileAssistantIfPresent}. Keeps an existing
 * stamp: the first completion is the real one, and a replayed funnel must not
 * move it.
 */
export function stampLockfileAssistantOnboardedIfPresent(
  assistantId: string,
  onboardedAt: string,
): WriteResult {
  if (typeof onboardedAt !== "string" || onboardedAt === "") {
    return { ok: false, status: 400, error: "Missing onboardedAt" };
  }
  return updateLockfileAssistantIfPresent(
    assistantId,
    { onboardedAt },
    (entry) => typeof entry.onboardedAt === "string" && entry.onboardedAt !== "",
  );
}

/**
 * The shared update-only write: read the on-disk registry under the lock,
 * refuse a missing entry, and merge `patch` into it through
 * {@link saveLockfileAssistant} (re-entrant under the held lock).
 * `skip` short-circuits to a successful no-op for a field whose current
 * value should win.
 */
function updateLockfileAssistantIfPresent(
  assistantId: string,
  patch: LockfileAssistantPatch,
  skip?: (entry: LockfileAssistant) => boolean,
): WriteResult {
  if (typeof assistantId !== "string" || assistantId === "") {
    return { ok: false, status: 400, error: "Missing assistantId" };
  }

  const locked = withLockfileLock((): WriteResult => {
    const lockfile = readLockfile();
    const entry = lockfile.assistants.find(
      (a) => a?.assistantId === assistantId,
    );
    if (!entry) {
      return {
        ok: false,
        status: 404,
        error: "No lockfile entry for this assistant",
      };
    }
    if (skip?.(entry)) {
      return { ok: true, lockfile };
    }
    saveLockfileAssistant({ ...entry, ...patch });
    return { ok: true, lockfile: readLockfile() };
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
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
    if (existingIdx >= 0) {
      assistants[existingIdx] = {
        ...assistants[existingIdx]!,
        ...assistant,
        assistantId,
      } as LockfileAssistant;
    } else {
      assistants.push({ ...assistant, assistantId } as LockfileAssistant);
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

export function replaceCloudAssistants(
  cloudAssistants: LockfileAssistant[],
  cloudOrganizationId?: string,
): WriteResult {
  if (
    cloudAssistants.some(
      (assistant) =>
        typeof assistant?.assistantId !== "string" ||
        assistant.assistantId === "" ||
        !isCloudHome(assistant.cloud),
    )
  ) {
    return {
      ok: false,
      status: 403,
      error: "Platform sync only accepts platform assistants",
    };
  }

  const locked = withLockfileLock((): WriteResult => {
    const lockfile = readLockfile();
    const existing = lockfile.assistants;
    const syncedIds = new Set(cloudAssistants.map((a) => a.assistantId));
    // Org-scoped sync preserves other orgs' platform entries; no org full-replaces.
    const preserved = existing.filter((a) => {
      if (!isCloudHome(a.cloud)) return true;
      if (syncedIds.has(a.assistantId)) return false;
      return (
        cloudOrganizationId != null &&
        a.cloud === "cloud" &&
        a.cloudOrganizationId !== cloudOrganizationId
      );
    });
    // `onboardedAt` is recorded by the client and unknown to the cloud, so
    // the replacement rows never carry it. Without this it is erased by every
    // routine session sync.
    const priorOnboardedAt = new Map<string, unknown>();
    for (const a of existing) {
      if (a.onboardedAt != null) {
        priorOnboardedAt.set(a.assistantId, a.onboardedAt);
      }
    }
    // The rows are platform assistants the host boundary already validated.
    lockfile.assistants = [
      ...preserved,
      ...cloudAssistants.map((a) => {
        const prior = priorOnboardedAt.get(a.assistantId);
        return a.onboardedAt == null && prior != null
          ? { ...a, onboardedAt: prior }
          : a;
      }),
    ] as LockfileAssistant[];

    const active = lockfile.activeAssistant;
    if (active) {
      const stillExists = lockfile.assistants.some(
        (a) => a.assistantId === active,
      );
      if (!stillExists) lockfile.activeAssistant = null;
    }

    return writeRawLockfile(lockfile);
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
}
