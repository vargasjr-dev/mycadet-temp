import type { LockfileAssistant, Remote } from "../lockfile-contract";
import { checkHealth } from "../daemon-readiness";
import { findAssistantByName } from "./lookup";
import { compareVersions } from "../version-compat";
import { ownVersion } from "../environment";
import { createBackup, pruneOldBackups } from "../backup-ops";
import { withRootOperationLock } from "../root-backup";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";
import { retireAssistant } from "./retire";
import { initializeDockerTeleportTarget } from "../remotes/docker/teleport";
import { initializeLocalTeleportTarget } from "../remotes/local/teleport";

/**
 * The teleport OPERATION: move an assistant to another remote.
 */
type TeleportAssistantResult =
  | { ok: true; sourceId: string; targetId: string }
  | { ok: false; status: number; error: string };

export interface TeleportAssistantOptions {
  /** The installation to move. */
  source: LockfileAssistant;
  /** Where the installation lands — the assistant keeps its name. */
  target: Remote;
  /** Progress narration (headless hosts omit it). */
  log?: (line: string) => void;
}

/** A target older than the source would drop transferred data — refuse. */
function checkVersion(
  source: string | undefined,
  target: string | undefined,
): void {
  const comparison = source && target ? compareVersions(target, source) : null;
  if (comparison !== null && comparison < 0) {
    throw new Error(
      `Target runtime ${target} is older than source ${source}. Upgrade the target before teleporting.`,
    );
  }
}

export async function teleportAssistant(
  opts: TeleportAssistantOptions,
): Promise<TeleportAssistantResult> {
  const source = opts.source;
  if (source.cloud === "apple-container") {
    return {
      ok: false,
      status: 400,
      error: `'${source.assistantId}' uses the Apple Containers runtime. Teleport is not yet supported for this remote.`,
    };
  }
  if (opts.target !== "local" && opts.target !== "docker") {
    return {
      ok: false,
      status: 400,
      error:
        "Cloud teleport is unavailable until cloud root archive transfer is supported. No installation was changed.",
    };
  }
  if (source.cloud === opts.target) {
    return {
      ok: false,
      status: 400,
      error: `Cannot teleport between two ${opts.target} assistants. Teleport transfers data across different remotes.`,
    };
  }

  try {
    return await withRootOperationLock(source, () => performTeleport(opts));
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function performTeleport(
  opts: TeleportAssistantOptions,
): Promise<TeleportAssistantResult> {
  const source = opts.source;
  const log = opts.log ?? (() => {});

  const sourceVersion = (await checkHealth(source)).version;
  checkVersion(sourceVersion, ownVersion());

  let sourceWasRunning = false;
  let sourceRetired = false;
  let target: LockfileAssistant | undefined;
  let ready = false;
  let archive: string | null | undefined;
  try {
    // Sleep the source.
    const sourceSlept = await sleepAssistant(source);
    if (!sourceSlept.ok) throw new Error(sourceSlept.error);
    sourceWasRunning = sourceSlept.wasRunning;

    // Back it up — this exact snapshot is both the safety archive and the
    // transferred state.
    archive = await createBackup(source.assistantId, {
      prefix: `${source.assistantId}-pre-teleport`,
    });
    if (!archive) {
      throw new Error(
        `Could not capture '${source.assistantId}'; teleport aborted.`,
      );
    }
    log(`Backup saved: ${archive}`);

    // Move: the source retires and frees the name; the target initializes
    // from the archive while nothing is up. The install IS the restore —
    // there is nothing to restore over. The save activates the target.
    const retired = await retireAssistant(source);
    if (!retired.ok) throw new Error(retired.error);
    sourceRetired = true;
    target =
      opts.target === "docker"
        ? await initializeDockerTeleportTarget(source.assistantId, archive, {
            log,
          })
        : await initializeLocalTeleportTarget(source.assistantId, archive);

    // Wake the target.
    const hatched = await wakeAssistant(target);
    if (!hatched.ok) throw new Error(hatched.error);
    checkVersion(sourceVersion, (await checkHealth(target)).version);
    ready = true;

    pruneOldBackups(source.assistantId, 3, "pre-teleport");
    log(`Teleport complete: ${source.assistantId} → ${target.assistantId}`);
    return {
      ok: true,
      sourceId: source.assistantId,
      targetId: target.assistantId,
    };
  } catch (error) {
    if (!ready) {
      // The half-built target goes — the one the init returned, or the one
      // its save landed before the throw. The original failure is the one
      // worth surfacing, plus where the data lives.
      const built =
        target ??
        (sourceRetired ? findAssistantByName(source.assistantId) : null);
      if (built) {
        await sleepAssistant(built);
        const retired = await retireAssistant(built);
        if (!retired.ok)
          log(`Teleport cleanup retire failed: ${retired.error}`);
        if (archive) {
          log(`The archive remains at ${archive}.`);
        }
      } else if (!sourceRetired && sourceWasRunning) {
        const woken = await wakeAssistant(source);
        if (!woken.ok) log(`Teleport cleanup wake failed: ${woken.error}`);
      }
    }
    throw error;
  }
}
