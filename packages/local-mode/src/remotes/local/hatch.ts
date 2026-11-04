import { findAssistantByName } from "../../operations/lookup";
import { saveLockfileAssistant } from "../../lockfile";
import type { LocalAssistant } from "../../lockfile-contract";
import { getGatewayUrl } from "../../lockfile-contract";
import { sleepLocal } from "./sleep";
import { wakeLocal } from "./wake";
import { setStartupLogging } from "./common";
import { withLocalHatchLock } from "./hatch-lock";
import { buildHatchConfigValues, writeInitialConfig } from "./hatch-config";
import { generateInstanceName } from "../../naming";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveAssistantsDir, resolveLogDir } from "../../config";
import { findAvailablePort, getDefaultPorts } from "../../ports";
import {
  GuardianLeasePermanentError,
  leaseGuardianToken,
} from "../../guardian-token";
import { configureHatchProviderApiKey } from "../../provider-credentials";
import { readCloudToken } from "../../cloud-auth";
import {
  fetchCurrentUser,
  registerLocalAssistantWithCloud,
} from "../../cloud-registration";

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
 * new services have bound their ports and the entry is on disk. The
 * guardian-token lease, the provider credential setup, and the cloud
 * registration are the same post-hatch mechanics the docker leg runs, so
 * they live here too; only the interactive provider prompt stays at the
 * CLI's command layer (it needs a TTY).
 */
export type HatchResult =
  | { ok: true; entry: LocalAssistant }
  | { ok: false; status: number; error: string; assistantId?: string };

export async function hatchLocal(params: {
  name?: string | null;
  watch?: boolean;
  configValues?: Record<string, string>;
  /** Show the per-service startup logs the wake leg emits. */
  verbose?: boolean;
  /** The caller's release version — stamped into the daemon's env. */
  version?: string;
  /** The caller's provider choice; undefined = skip provider credential setup. */
  provider?: string | null;
  precollectedApiKey?: string;
  /** The narration sink (defaults to console.log). */
  log?: (msg: string) => void;
}): Promise<HatchResult> {
  const {
    name,
    watch = false,
    configValues = {},
    provider,
    precollectedApiKey,
  } = params;
  const log = params.log ?? ((msg: string) => console.log(msg));
  setStartupLogging(params.verbose ?? false);
  if (params.version && !process.env.APP_VERSION) {
    process.env.APP_VERSION = params.version;
  }
  const instanceName = generateInstanceName(
    name ?? process.env.CADET_ASSISTANT_NAME,
  );

  let entry: LocalAssistant;
  try {
    const hatched = await withLocalHatchLock(async () => {
      const existing = findAssistantByName(instanceName);
      if (existing && (!existing.cloud || existing.cloud === "local")) {
        throw new HatchConflict(
          `An assistant named "${instanceName}" is already hatched.\n` +
            `Run \`cadet wake\` to restart it, or \`cadet retire ${instanceName}\` to remove it first.`,
        );
      }

      const fresh: LocalAssistant = {
        assistantId: instanceName,
        cloud: "local",
        ...(await allocateLocalPlacement(instanceName)),
      };

      const defaultWorkspaceConfigPath = writeInitialConfig(configValues);

      try {
        // The wake leg owns starting — the hatch only threads the fresh
        // daemon's first-boot config through.
        await wakeLocal(fresh, { watch, defaultWorkspaceConfigPath });
      } catch (error) {
        await sleepLocal(fresh, { force: true });
        throw error;
      }

      fresh.hatchedAt = new Date().toISOString();
      // The active-assistant switch rides the same locked write.
      saveLockfileAssistant(fresh, instanceName);

      return { entry: fresh };
    });
    entry = hatched.entry;
  } catch (error) {
    if (error instanceof HatchConflict) {
      return {
        ok: false,
        status: 409,
        error: error.message,
        assistantId: instanceName,
      };
    }
    return {
      ok: false,
      status: 500,
      error:
        (error instanceof Error ? error.message : String(error)) +
        `\n\n❌ Local assistant startup failed — stopping partial processes.\n` +
        `   Logs: ${join(resolveAssistantsDir(), instanceName, "logs")} and ${join(resolveLogDir(), "hatch.log")}`,
      assistantId: instanceName,
    };
  }

  log(`🥚 Hatching local assistant: ${instanceName}`);
  log("");

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself.
  const maxLeaseAttempts = 3;
  let guardianAccessToken: string | undefined;
  for (let attempt = 1; attempt <= maxLeaseAttempts; attempt++) {
    try {
      const tokenData = await leaseGuardianToken(entry);
      guardianAccessToken = tokenData.accessToken;
      break;
    } catch (err) {
      if (
        attempt < maxLeaseAttempts &&
        !(err instanceof GuardianLeasePermanentError)
      ) {
        const delayMs = 2000 * 2 ** (attempt - 1);
        log(
          `⚠️  Guardian token lease attempt ${attempt}/${maxLeaseAttempts} failed — retrying in ${delayMs / 1000}s: ${err}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        log(
          `⚠️  Guardian token lease failed${err instanceof GuardianLeasePermanentError ? ", not retrying — a malformed 200 will not fix itself" : ` after ${maxLeaseAttempts} attempts`}: ${err}\n` +
            `   The assistant is running but guardian-token.json was not written.\n` +
            `   Run \`cadet restart ${JSON.stringify(instanceName)} --repair-guardian\` to re-lease a token.`,
        );
      }
    }
  }

  if (provider !== undefined && provider !== null && !guardianAccessToken) {
    log(
      `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
        `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the connection.`,
    );
  } else if (provider !== undefined && provider !== null) {
    await configureHatchProviderApiKey({
      gatewayUrl: getGatewayUrl(entry),
      provider,
      bearerToken: guardianAccessToken,
      env: process.env,
      precollectedKey: precollectedApiKey,
    });
  }

  // Picking Cadet Cloud ends with the assistant registered on the cloud
  // and its cloud credentials injected — the same post-login flow
  // `cadet login` runs — so messages route through the cloud connection
  // immediately after hatch. Non-fatal: the assistant is up either way.
  const cloudToken = readCloudToken();
  if (provider === "cadet" && cloudToken) {
    try {
      const user = await fetchCurrentUser(cloudToken);
      await registerLocalAssistantWithCloud(user, log);
    } catch {
      // Non-fatal — `cadet login` can complete the registration later.
    }
  }

  return { ok: true, entry };
}

export class HatchConflict extends Error {}
