import { restoreRootBackup } from "../../root-backup";
import type { LockfileAssistant } from "../../lockfile-contract";

export type RestoreDockerResult =
  | { ok: true; dryRun: boolean; recoveryPath?: string }
  | { ok: false; status: number; error: string };

/**
 * The docker restore leg: unpack a root archive back over the docker
 * assistant's volume-backed state roots — the shared root-backup machinery's
 * restore path, with DockerRootStorage supplying the `docker cp` mechanics
 * and the root-operation lock. A dry run validates the archive and stops.
 *
 * Throws on failure; the operation maps it.
 */
export async function restoreDocker(
  entry: LockfileAssistant,
  opts: { fromPath: string; dryRun: boolean },
): Promise<RestoreDockerResult> {
  const recoveryPath = await restoreRootBackup(entry, opts.fromPath, {
    dryRun: opts.dryRun,
  });
  return { ok: true, dryRun: opts.dryRun, recoveryPath };
}
