import { findAssistantByName } from "../../operations/lookup";
import { saveLockfileAssistant } from "../../lockfile";
import type { LocalAssistant } from "../../lockfile-contract";
import { sleepLocal } from "./sleep";
import { wakeLocal } from "./wake";
import { withLocalHatchLock } from "./hatch-lock";
import {
  buildHatchConfigValues,
  writeInitialConfig,
} from "./hatch-config";
import { generateInstanceName } from "../../naming";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveAssistantsDir } from "../../config";
import { findAvailablePort, getDefaultPorts } from "../../ports";

/**
 * Allocate an isolated placement for a named local instance: its data root
 * and host ports. Every new local assistant is allocated under
 * `$XDG_DATA_HOME/cadet{-env}/assistants/<name>/`. The legacy `~/.cadet/`
 * path is only reached via existing lockfile entries from before this change
 * — the read path honors whatever `instanceDir` is stored, so production
 * users' existing first-local assistants keep their `~/.cadet/` roots
 * unchanged.
 */
export async function allocateLocalPlacement(
  instanceName: string,
): Promise<
  Pick<LocalAssistant, "instanceDir" | "port" | "daemonPort" | "cesPort">
> {
  const instanceDir = join(resolveAssistantsDir(), instanceName);
  mkdirSync(instanceDir, { recursive: true });

  // The probe is the source of truth — anything actually listening claims
  // its port, whether that listener is another assistant or not.
  // Env-aware bases: non-prod envs sit in their own 1000-port window so
  // running prod and staging assistants side-by-side doesn't collide. See
  // the `@mycadet/environments` `portBlock` layout.
  const basePorts = getDefaultPorts();
  const daemonPort = await findAvailablePort(basePorts.daemon);
  const gatewayPort = await findAvailablePort(basePorts.gateway);
  const cesPort = await findAvailablePort(basePorts.ces);

  return {
    instanceDir,
    port: gatewayPort,
    daemonPort,
    cesPort,
  };
}


/**
 * The hatch operation's local provision core: allocate the instance, write
 * the fresh daemon's first-boot workspace config, wake it, and persist the
 * entry — all under the machine-wide local hatch lock, because port
 * availability is machine-wide and allocation must stay exclusive until the
 * new services have bound their ports and the entry is on disk.
 *
 * The interactive provider prompt, the guardian-token lease, the provider
 * credential setup, and the cloud registration are the CLI's ceremony and
 * stay there — they need a TTY and cli-side credential machinery.
 */
export type HatchResult =
  | { ok: true; entry: LocalAssistant }
  | { ok: false; status: number; error: string; assistantId?: string };

export async function hatchLocal(params: {
  name?: string | null;
  watch?: boolean;
  configValues?: Record<string, string>;
}): Promise<HatchResult> {
  const { name, watch = false, configValues = {} } = params;
  const instanceName = generateInstanceName(
    name ?? process.env.CADET_ASSISTANT_NAME,
  );
  try {
    const { entry } = await withLocalHatchLock(async () => {
      const existing = findAssistantByName(instanceName);
      if (existing && (!existing.cloud || existing.cloud === "local")) {
        throw new HatchConflict(
          `An assistant named "${instanceName}" is already hatched.\n` +
            `Run \`cadet wake\` to restart it, or \`cadet retire ${instanceName}\` to remove it first.`,
        );
      }

      const entry: LocalAssistant = {
        assistantId: instanceName,
        cloud: "local",
        ...(await allocateLocalPlacement(instanceName)),
      };

      const defaultWorkspaceConfigPath = writeInitialConfig(configValues);

      try {
        // The wake leg owns starting — the hatch only threads the fresh
        // daemon's first-boot config through.
        await wakeLocal(entry, { watch, defaultWorkspaceConfigPath });
      } catch (error) {
        await sleepLocal(entry, { force: true });
        throw error;
      }

      entry.hatchedAt = new Date().toISOString();
      // The active-assistant switch rides the same locked write.
      saveLockfileAssistant(entry, instanceName);

      return { entry };
    });
    return { ok: true, entry };
  } catch (error) {
    if (error instanceof HatchConflict) {
      return { ok: false, status: 409, error: error.message, assistantId: instanceName };
    }
    return {
      ok: false,
      status: 500,
      error: error instanceof Error ? error.message : String(error),
      assistantId: instanceName,
    };
  }
}

export class HatchConflict extends Error {}
