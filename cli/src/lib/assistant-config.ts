import { randomBytes } from "crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

import { readLockfile, withLockfileLock } from "@mycadet/local-mode";
import {
  type AppProcessRecord,
  type Lockfile,
  type LockfileAssistant,
  type TunnelProcessRecord,
} from "@mycadet/local-mode/contract";

import { resolveConfigDir, resolveLockfilePath } from "@mycadet/local-mode";

/** Either lockfile-root process record, keyed by `RootProcessKind`. */
export type RootProcessRecord = TunnelProcessRecord | AppProcessRecord;

/** The lockfile-root process entries keyed by their kind. */
export interface RootProcessRecords {
  tunnel?: TunnelProcessRecord;
  app?: AppProcessRecord;
}

export type RootProcessKind = keyof RootProcessRecords;

function writeLockfileUnlocked(data: Lockfile): void {
  const lockfilePath = resolveLockfilePath();
  mkdirSync(dirname(lockfilePath), { recursive: true });
  const tmpPath = `${lockfilePath}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmpPath, lockfilePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

/**
 * Run `fn` under the same cross-process advisory lock the local-mode hosts
 * use, keyed to this environment's write-path lockfile, so CLI writers and
 * package-side writers (Electron main, Vite plugin, `cadet client`) never
 * interleave read-modify-write cycles. Reentrant, so wrapped units may call
 * the locked write helpers. Throws on lock timeout, matching the fs-error
 * contract of the write path.
 */
function withCliLockfileLock<T>(fn: () => T): T {
  const locked = withLockfileLock(fn);
  if (!locked.ok) throw new Error(locked.error);
  return locked.value;
}

/** Record a CLI-managed root process (tunnel agent, app edge) by pid. */
export function stampRootProcess<K extends RootProcessKind>(
  kind: K,
  record: RootProcessRecords[K],
): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    (data as RootProcessRecords)[kind] = record;
    writeLockfileUnlocked(data);
  });
}

/** Release a recorded process record, pid-verified. */
export function clearRootProcess(
  kind: RootProcessKind,
  expectedPid?: number,
): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    const record = (data as RootProcessRecords)[kind];
    if (
      record === undefined ||
      (expectedPid !== undefined && record.pid !== expectedPid)
    )
      return;
    delete data[kind];
    writeLockfileUnlocked(data);
  });
}

/**
 * Read the root-level process entries for `cadet ps`. Read-only: no lock, so
 * a concurrently-updating lockfile is fine — the pid is verified separately.
 */
export function readRootProcesses(): RootProcessRecords {
  const data = readLockfile();
  return { tunnel: data.tunnel, app: data.app };
}

import { loadAllAssistants, findAssistant } from "@mycadet/local-mode";

export function loadLatestAssistant(): LockfileAssistant | null {
  const entries = loadAllAssistants();
  if (entries.length === 0) {
    return null;
  }
  const sorted = [...entries].sort((a, b) => {
    const ta = a.hatchedAt ? new Date(a.hatchedAt).getTime() : 0;
    const tb = b.hatchedAt ? new Date(b.hatchedAt).getTime() : 0;
    return tb - ta;
  });
  return sorted[0];
}

export function setActiveAssistant(assistantId: string): void {
  withCliLockfileLock(() => {
    const data = readLockfile();
    data.activeAssistant = assistantId;
    writeLockfileUnlocked(data);
  });
}

/**
 * Resolve which assistant to target for a command, exiting the process
 * with a user-facing error when nothing resolves: the explicit ID
 * argument, else findAssistant's served rule (active, or the sole entry
 * before a selection).
 */
export function resolveTargetAssistant(nameArg?: string): LockfileAssistant {
  const entry = findAssistant(nameArg);
  if (!entry) {
    console.error(
      nameArg
        ? `No assistant found with name or ID '${nameArg}'.`
        : `No assistant found. Run 'cadet hatch' first.`,
    );
    process.exit(1);
  }
  return entry;
}

/**
 * The client-minted uuid this CLI addresses the assistant's chat
 * conversation by (web's temp-client-id pattern: clients/web
 * document-conversation mints a uuid, persists it, and passes it as the
 * conversation key so creation is retry-safe). Minted once and persisted
 * to an xdg file keyed by assistant id — client bookkeeping, not an
 * assistant fact, so it stays off the lockfile entry.
 */
export function resolveConversationKey(assistantId: string): string {
  const path = conversationKeyPath(assistantId);
  try {
    const existing = readFileSync(path, "utf-8").trim();
    if (existing) return existing;
  } catch {
    // Not minted yet.
  }
  const minted = crypto.randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, minted);
  return minted;
}

function conversationKeyPath(assistantId: string): string {
  return join(
    resolveConfigDir(),
    "assistants",
    assistantId,
    "conversation-key",
  );
}
