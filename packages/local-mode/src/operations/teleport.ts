import type { LockfileAssistant } from "../lockfile-contract";
import { checkHealth, isAssistantHealthy } from "../daemon-readiness";
import { compareVersions } from "../version-compat";
import { ownVersion } from "../environment";
import { createBackup, pruneOldBackups } from "../backup-ops";
import { withRootOperationLock } from "../root-backup";
import { findAssistantByName } from "./lookup";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";
import { restoreAssistant } from "./restore";
import { retireAssistant } from "./retire";
import { generateInstanceName } from "../naming";
import { validateAssistantName } from "../remotes/local/archive";
import { initializeDockerTeleportTarget } from "../remotes/docker/teleport";
import { initializeLocalTeleportTarget } from "../remotes/local/teleport";

/**
 * The teleport OPERATION: the headless core of `cadet teleport` — move an
 * installation across topologies, five steps: sleep the source, back it up
 * (that exact snapshot is both the safety archive and the transferred
 * state), move the archive to the new remote (for a fresh target: initialize
 * its placement and install the archive into it; for an existing target the
 * archive is already where it needs to be), restore it into the target, and
 * wake the target. Then the bookkeeping: activate is the caller's, the
 * source is retired unless `keepSource`, and the pre-teleport backups prune.
 *
 * Never throws and never exits the process — failures come back structured.
 * The root-operation locks hold over the source and an existing target for
 * the whole move; a failure rewinds what it can (a half-built target is
 * slept and retired, running assistants are woken) and reports the original
 * error.
 */
export type TeleportAssistantResult =
  | {
      ok: true;
      kind: "moved";
      sourceId: string;
      targetId: string;
      /** False when --keep-source retained the stopped original. */
      sourceRetired: boolean;
    }
  | { ok: true; kind: "dry-run"; lines: string[] }
  | { ok: false; status: number; error: string };

export interface TeleportAssistantOptions {
  /** The installation to move — a local or docker assistant. */
  source: LockfileAssistant;
  /** Where the installation lands. */
  targetEnv: "local" | "docker" | "cloud";
  /** The target's name; an existing entry restores over, a new one initializes. */
  targetName?: string;
  /** Keep the source around (stopped) instead of retiring it. */
  keepSource?: boolean;
  /** Report the move without stopping anything or creating archives. */
  dryRun?: boolean;
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
      error: `'${source.assistantId}' uses the Apple Containers runtime. Teleport is not yet supported for this topology.`,
    };
  }
  if (
    opts.targetEnv === "cloud" ||
    (source.cloud !== "local" && source.cloud !== "docker")
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "Cloud teleport is unavailable until cloud root archive transfer is supported. No installation was changed.",
    };
  }
  if (source.cloud === opts.targetEnv) {
    return {
      ok: false,
      status: 400,
      error: `Cannot teleport between two ${opts.targetEnv} assistants. Teleport transfers data across different environments.`,
    };
  }

  const existing = opts.targetName
    ? findAssistantByName(opts.targetName)
    : null;
  if (existing && existing.cloud !== opts.targetEnv) {
    return {
      ok: false,
      status: 400,
      error: `Assistant '${opts.targetName}' is a ${existing.cloud} assistant, not ${opts.targetEnv}.`,
    };
  }
  if (opts.targetName && !existing) {
    try {
      validateAssistantName(opts.targetName);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (opts.dryRun) {
    return {
      ok: true,
      kind: "dry-run",
      lines: [
        `Would move the installation roots of '${source.assistantId}' to ${existing ? `'${existing.assistantId}'` : `a new ${opts.targetEnv} assistant`}.`,
        "Would gracefully sleep services, save root tar safety backups, restore all roots, and verify the destination.",
        opts.keepSource
          ? "Would keep the source stopped."
          : "Would retire the source only after the destination is ready.",
        "Dry run complete. No services stopped or archives created.",
      ],
    };
  }

  try {
    return await withRootOperationLock(source, () =>
      existing
        ? withRootOperationLock(existing, () => performTeleport(opts, existing))
        : performTeleport(opts, null),
    );
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
  existing: LockfileAssistant | null,
): Promise<TeleportAssistantResult> {
  const source = opts.source;
  const log = opts.log ?? (() => {});

  const sourceVersion = (await checkHealth(source)).version;
  checkVersion(
    sourceVersion,
    existing ? (await checkHealth(existing)).version : ownVersion(),
  );

  let sourceWasRunning = false;
  let targetWasRunning = false;
  let target: LockfileAssistant | undefined;
  let ready = false;
  try {
    // Sleep the source.
    const sourceSlept = await sleepAssistant(source);
    if (!sourceSlept.ok) throw new Error(sourceSlept.error);
    sourceWasRunning = sourceSlept.wasRunning;

    // Back it up — this exact snapshot is both the safety archive and the
    // transferred state.
    const archive = await createBackup(source.assistantId, {
      prefix: `${source.assistantId}-pre-teleport`,
    });
    if (!archive) {
      throw new Error(
        `Could not capture '${source.assistantId}'; teleport aborted.`,
      );
    }
    log(`Backup saved: ${archive}`);

    if (existing) {
      // Move + restore: the target is on this machine, so the archive is
      // already where it needs to be. Sleep the target, then the restore
      // operation replaces its roots (retaining the previous state as its
      // own recovery archive).
      target = existing;
      const targetSlept = await sleepAssistant(target);
      if (!targetSlept.ok) throw new Error(targetSlept.error);
      targetWasRunning = targetSlept.wasRunning;
      const restored = await restoreAssistant({
        entry: target,
        fromPath: archive,
      });
      if (!restored.ok) throw new Error(restored.error);
    } else {
      // Move: a hatch is just initialize-data + wake — the teleport owns
      // both halves so the archive lands between allocation and first
      // startup. The install IS the restore (there is nothing to restore
      // over).
      const instanceName = generateInstanceName(opts.targetName ?? null);
      if (findAssistantByName(instanceName)) {
        throw new Error(`Assistant '${instanceName}' already exists.`);
      }
      target =
        opts.targetEnv === "docker"
          ? await initializeDockerTeleportTarget(instanceName, archive, { log })
          : await initializeLocalTeleportTarget(instanceName, archive);
    }

    // Wake the target.
    const hatched = await wakeAssistant(target);
    if (!hatched.ok) throw new Error(hatched.error);
    checkVersion(sourceVersion, (await checkHealth(target)).version);

    ready = true;
    if (opts.keepSource) {
      log(
        `Source '${source.assistantId}' retained, stopped, via --keep-source.`,
      );
    } else {
      if (await isAssistantHealthy(source)) {
        throw new Error(
          "Source was restarted during teleport. Destination is ready; source was retained to preserve newer writes.",
        );
      }
      const retired = await retireAssistant(source);
      if (!retired.ok) throw new Error(retired.error);
    }
    pruneOldBackups(source.assistantId, 3, "pre-teleport");

    log(`Teleport complete: ${source.assistantId} → ${target.assistantId}`);
    return {
      ok: true,
      kind: "moved",
      sourceId: source.assistantId,
      targetId: target.assistantId,
      sourceRetired: !opts.keepSource,
    };
  } catch (error) {
    if (!ready) {
      if (target && !existing) {
        await sleepAssistant(target);
        // Cleanup path — the original failure is the one worth surfacing.
        const retired = await retireAssistant(target);
        if (!retired.ok)
          log(`Teleport cleanup retire failed: ${retired.error}`);
      } else if (target && targetWasRunning) {
        // The restore operation's own rollback owns the roots; the wake
        // rewinds the lifecycle.
        const woken = await wakeAssistant(target);
        if (!woken.ok) throw new Error(woken.error);
      }
      if (sourceWasRunning) {
        const woken = await wakeAssistant(source);
        if (!woken.ok) throw new Error(woken.error);
      }
    }
    throw error;
  }
}
