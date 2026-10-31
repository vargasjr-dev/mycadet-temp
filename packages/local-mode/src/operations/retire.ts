import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { resolveConfigDir } from "../config";
import { isCloudEntry, isLoopbackGatewayCloud } from "../lockfile-contract";
import type { LockfileAssistant } from "../lockfile-contract";
import {
  getAssistantDisplayName,
  loadAllAssistants,
  removeLockfileAssistant,
} from "./lookup";
import { retireLocal } from "../remotes/local/retire";
import { retireDocker } from "../remotes/docker/retire";
import { retireAppleContainer } from "../remotes/apple-container/retire";
import { retireCustom } from "../remotes/custom/retire";
import {
  retireCloudEntry,
  unregisterSelfHostedLocalPlatformRecord,
} from "../remotes/cloud/retire";
import { stopContainerAppServer } from "../ingress";

/**
 * The retire OPERATION: the headless core of `cadet retire`, moved out of the
 * CLI command so the hosts answer the scoped surface's retire DELETE in
 * process instead of spawning the CLI. The command keeps the UX (target
 * print, confirmation, log tee) and delegates; the route in
 * `operations/routes.ts` hands it lockfile entries the host can retire.
 *
 * The operation self-resolves its credentials (the cloud unregister reads
 * the env token, else the on-disk cloud token) — callers never thread a
 * token through, which is what let the spawn-based `runRetire` and its
 * `cloudToken` plumbing die.
 */

export type RetireResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Entry clouds THIS machine can retire directly: the host owns their
 * teardown (daemon stop, container removal, instance archive). Every other
 * entry retires through the cloud's retire route the same proxy forwards, so
 * the bundle's one endpoint holds for every entry type.
 */
export function isHostExecutableRetireEntry(entry: LockfileAssistant): boolean {
  return isLoopbackGatewayCloud(entry.cloud) || entry.cloud === "apple-container";
}

/**
 * Retire one assistant entry: per-cloud teardown, then the lockfile removal
 * and the dock-display-name sentinel cleanup. Never throws and never exits
 * the process — failures (including the not-logged-in cloud leg and an
 * unknown remote type) come back structured so both the CLI's exit-code UX
 * and the route's wire mapping render the same detail.
 */
export async function retireAssistantEntry(
  entry: LockfileAssistant,
): Promise<RetireResult> {
  try {
    const assistantId = entry.assistantId;
    const cloud = entry.cloud;

    if (cloud === "apple-container") {
      await retireAppleContainer(assistantId, entry);
      await stopContainerAppServer(entry);
    } else if (cloud === "docker") {
      await retireDocker(assistantId);
      await stopContainerAppServer(entry);
    } else if (cloud === "local") {
      try {
        await unregisterSelfHostedLocalPlatformRecord(entry);
      } catch (error) {
        console.warn(
          `⚠️  Platform self-hosted unregister failed; continuing local retire: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      await retireLocal(assistantId, entry);
    } else if (cloud === "custom") {
      await retireCustom(entry);
    } else if (isCloudEntry(entry)) {
      await retireCloudEntry(entry);
    } else {
      return { ok: false, status: 400, error: `Unknown remote type '${cloud}'.` };
    }

    removeLockfileAssistant(assistantId);
    console.log(`Removed ${getAssistantDisplayName(entry)} from config.`);

    // When no assistants remain, remove the dock-display-name sentinel so
    // the dock label falls back to "Cadet" instead of using the
    // retired assistant's name.
    if (loadAllAssistants().length === 0) {
      const dockLabelFile = join(resolveConfigDir(), "dock-display-name");
      if (existsSync(dockLabelFile)) {
        try {
          unlinkSync(dockLabelFile);
        } catch {
          // Best-effort — the macOS app will also reset this on next launch.
        }
      }
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
