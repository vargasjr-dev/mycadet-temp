import fs from "node:fs";
import path from "node:path";

import { guardianTokenPath } from "./config";
import { removeLockfileAssistant } from "./lockfile";
import type { WriteResult } from "./lockfile";

/**
 * Forget a paired assistant on this machine: remove its lockfile entry and
 * delete its stored guardian token. Client-side only, mirroring the CLI's
 * `cadet unpair`: the remote assistant itself is never touched (host-side
 * device revocation is `cadet devices`).
 */
export function unpairAssistant(assistantId: string): WriteResult {
  // The token choreography rides inside the removal's locked transaction: the
  // token is deleted before the entry's write commits and restored if that
  // write fails, so a failed delete aborts with the entry intact (unpair
  // stays retryable) and a failed write strands no credential on disk.
  return removeLockfileAssistant(assistantId, {
    beforeWrite: () => {
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
        throw new Error(
          `Failed to delete the stored guardian token: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        fs.rmdirSync(path.dirname(tokenPath));
      } catch {
        // Directory not empty or absent.
      }
      if (savedToken === null) return undefined;
      return () => {
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
    },
  });
}
