import fs from "node:fs";
import path from "node:path";

import { guardianTokenPath } from "./config";
import {
  lockFailure,
  readLockfile,
  writeRawLockfile,
} from "./lockfile";
import type { WriteResult } from "./lockfile";
import { withLockfileLock } from "./lockfile-lock";

/**
 * Forget a paired assistant on this machine: remove its lockfile entry and
 * delete its stored guardian token. Client-side only, mirroring the CLI's
 * `cadet unpair`: the remote assistant itself is never touched (host-side
 * device revocation is `cadet devices`).
 *
 * The whole read-check-write runs under the shared advisory lock, so a
 * missing entry refuses (404) and contention refuses (423) without writing.
 * The token choreography rides inside the same locked transaction: the token
 * is deleted before the entry's write commits and restored if that write
 * fails, so a failed delete aborts with the entry intact (unpair stays
 * retryable) and a failed write strands no credential on disk.
 */
export function unpairAssistant(assistantId: string): WriteResult {
  if (typeof assistantId !== "string" || assistantId === "") {
    return { ok: false, status: 400, error: "Missing assistantId" };
  }

  const locked = withLockfileLock((): WriteResult => {
    const lockfile = readLockfile();
    if (!lockfile.assistants.some((a) => a.assistantId === assistantId)) {
      return { ok: false, status: 404, error: "No such assistant" };
    }

    const tokenPath = guardianTokenPath(assistantId);
    let savedToken: string | null = null;
    try {
      savedToken = fs.readFileSync(tokenPath, "utf-8");
    } catch {
      savedToken = null;
    }
    try {
      fs.rmSync(tokenPath, { force: true });
    } catch (err) {
      return {
        ok: false,
        status: 500,
        error: `Failed to delete the stored guardian token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    try {
      fs.rmdirSync(path.dirname(tokenPath));
    } catch {
      // Directory not empty or absent.
    }
    const undo = (): void => {
      if (savedToken === null) return;
      try {
        fs.mkdirSync(path.dirname(tokenPath), {
          recursive: true,
          mode: 0o700,
        });
        fs.writeFileSync(tokenPath, savedToken, { mode: 0o600 });
      } catch {
        // Restore failed; the reported write error already covers it.
      }
    };

    lockfile.assistants = lockfile.assistants.filter(
      (a) => a.assistantId !== assistantId,
    );
    if (lockfile.activeAssistant === assistantId) {
      const next = lockfile.assistants[0]?.assistantId;
      lockfile.activeAssistant = typeof next === "string" ? next : null;
    }

    const result = writeRawLockfile(
      lockfile as unknown as Record<string, unknown>,
    );
    if (!result.ok) {
      undo();
    }
    return result;
  });
  return locked.ok ? locked.value : lockFailure(locked.error);
}
