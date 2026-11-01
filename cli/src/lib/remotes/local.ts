import { join } from "node:path";

import {
  allocateLocalPlacement,
  findAssistantByName,
  setActiveAssistant,
} from "../assistant-config.js";
import type {
  LocalAssistant,
  LockfileAssistant,
} from "@mycadet/local-mode/contract";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import {
  readCloudToken,
  resolveLogDir,
  saveLockfileAssistant,
} from "@mycadet/local-mode";
import {
  getLocalInstanceDir,
  gatewayCliInvocation,
  stopLocalProcesses,
} from "@mycadet/local-mode";
import {
  setStartupLogging,
  startCes,
  startGateway,
  startLocalDaemon,
} from "@mycadet/local-mode";
import {
  GuardianLeasePermanentError,
  leaseGuardianToken,
} from "../guardian-token.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "../lifecycle-reporter.js";
import {
  collectProviderApiKey,
  configureHatchProviderApiKey,
  promptProviderChoice,
  resolveHatchProvider,
  shouldPromptForHatchProvider,
} from "../provider-secrets.js";
import { logHatchNextSteps } from "../hatch-next-steps.js";
import { printInstanceDetails } from "../instance-details.js";
import { checkProviderApiKey } from "../api-key-check.js";
import {
  describeLoginError,
  ensureCloudLoginInteractive,
  registerLocalAssistantWithCloud,
} from "../cloud-login.js";
import { fetchCurrentUser } from "../cloud-client.js";
import { withLocalHatchLock } from "../local-hatch-lock.js";
import { generateInstanceName } from "../random-name.js";
import { buildHatchConfigValues, writeInitialConfig } from "../config-utils.js";
import { green, yellow } from "../color.js";
import { execOutput } from "../step-runner.js";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../../package.json";

/**
 * Stop any locally-running daemon and gateway processes
 * and clean up PID files. Called when hatch fails partway through
 * so we don't leave orphaned processes with no lock file entry.
 *
 * When `entry` is provided, uses instance-specific paths instead of
 * the default ~/.cadet/ paths.
 */

export interface HatchLocalParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  setupProviderCredentials?: boolean;
  /** Whole-installation state installed before the first service startup. */
  initialArchive?: string;
  /**
   * Show the per-service startup logs (assistant, credential executor,
   * gateway) and the extended next steps. Off by default — the happy path
   * ends at the hatched summary.
   */
  verbose?: boolean;
  /**
   * Sink for progress and log output. Defaults to the console reporter so CLI
   * callers keep their existing terminal output; in-process callers can inject
   * their own reporter to consume progress without writing to stdout.
   */
  reporter?: LifecycleReporter;
}

export interface HatchLocalResult {
  assistantId: string;
  /**
   * Guardian access token leased during hatch, when the lease succeeded. The
   * full token pair is persisted to disk regardless; this is surfaced so an
   * in-process caller can prime a connection without re-reading the file.
   */
  guardianAccessToken?: string;
}

export async function hatchLocal(
  params: HatchLocalParams = {},
): Promise<HatchLocalResult> {
  const { name, watch = false, configValues = {} } = params;
  const reporter = params.reporter ?? consoleLifecycleReporter;
  const verbose = params.verbose ?? false;
  const setupProviderCredentials = params.setupProviderCredentials !== false;
  setStartupLogging(verbose);
  let provider = setupProviderCredentials
    ? resolveHatchProvider(configValues)
    : undefined;
  const instanceName = generateInstanceName(
    name ?? process.env.CADET_ASSISTANT_NAME,
  );
  // Collected inside the lock (right after the provider choice, so the two
  // prompts sit back-to-back), consumed after the guardian token leases.
  let precollectedApiKey: string | undefined;

  const { entry } = await withLocalHatchLock(async () => {
    reporter.progress(1, 6, "Allocating resources...");

    const existing = findAssistantByName(instanceName);
    if (existing && (!existing.cloud || existing.cloud === "local")) {
      throw new Error(
        `An assistant named "${instanceName}" is already hatched.\n` +
          `Run \`cadet wake\` to restart it, or \`cadet retire ${instanceName}\` to remove it first.`,
      );
    }

    const entry: LockfileAssistant = {
      assistantId: instanceName,
      cloud: "local",
      ...(await allocateLocalPlacement(instanceName)),
    };

    reporter.log(`🥚 Hatching local assistant: ${instanceName}`);
    reporter.log("");

    const apiKeyCheck = checkProviderApiKey();
    let pickedProvider = false;
    if (
      shouldPromptForHatchProvider({
        configValues,
        setupProviderCredentials,
        hasProviderApiKey: apiKeyCheck.hasKey,
        stdinIsTTY: process.stdin.isTTY,
      })
    ) {
      const picked = await promptProviderChoice();
      if (picked) {
        provider = picked;
        pickedProvider = true;
        // Collect the key immediately, while the choice is fresh — the
        // startup logs are quiet now, so nothing separates the two prompts.
        precollectedApiKey = await collectProviderApiKey(picked);

        // Picking Cadet Cloud should feel like signing in, not like a
        // mystery later — open the browser login right here. Non-TTY
        // runs (including the desktop's in-process hatch) skip it.
        if (picked === "cadet" && process.stdin.isTTY && !readCloudToken()) {
          reporter.log("");
          reporter.log(
            "Cadet Cloud selected — opening your browser to log in...",
          );
          try {
            await ensureCloudLoginInteractive();
            reporter.log("✅ Logged in to Cadet Cloud");
          } catch (error) {
            reporter.warn(
              `⚠️  Cadet Cloud login failed: ${describeLoginError(error)}`,
            );
            reporter.warn("   You can retry later with `cadet login`.");
          }
        }
      }
    }

    if (!apiKeyCheck.hasKey && !pickedProvider) {
      reporter.warn(
        "Warning: No LLM provider API key is configured. The assistant will fail when you try to send a message.",
      );
      reporter.warn("  To fix, export your key before running cadet hatch:");
      reporter.warn("  export ANTHROPIC_API_KEY=<your-key>");
      reporter.warn("");
    }

    if (!process.env.APP_VERSION) {
      process.env.APP_VERSION = cliPkg.version;
    }

    reporter.progress(2, 6, "Setting up local assistant...");
    const hatchConfigValues = buildHatchConfigValues(configValues, provider);
    const defaultWorkspaceConfigPath = writeInitialConfig(hatchConfigValues);

    reporter.progress(3, 6, "Starting assistant...");
    if (params.initialArchive) {
      // Restores the archived state roots — gateway-security included, so
      // the gateway boots with the archived signing identity.
      await (
        await import("../root-backup.js")
      ).initializeRootArchive(entry, params.initialArchive);
    }
    try {
      // Launch the CES sibling alongside the daemon, in parallel — matching the
      // Docker topology. The assistant does not spawn its own CES, so a freshly
      // hatched instance would otherwise come up with CES unavailable.
      // startCes always launches the CES sibling.
      const startupResults = await Promise.allSettled([
        startCes(watch, entry),
        startLocalDaemon(watch, entry, {
          defaultWorkspaceConfigPath,
          requireReady: true,
        }),
      ]);
      const startupFailure = startupResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (startupFailure) {
        throw startupFailure.reason;
      }

      reporter.progress(4, 6, "Starting gateway...");
      await startGateway(watch, entry, {
        requireReady: true,
      });
    } catch (error) {
      reporter.error(
        `\n❌ Local assistant startup failed — stopping partial processes.`,
      );
      reporter.error(
        `   Logs: ${join(getLocalInstanceDir(entry), "logs")} and ${join(resolveLogDir(), "hatch.log")}`,
      );
      await stopLocalProcesses(entry);
      throw error;
    }

    entry.hatchedAt = new Date().toISOString();

    reporter.progress(5, 6, "Saving configuration...");
    saveLockfileAssistant(entry);
    setActiveAssistant(instanceName);

    return { entry };
  });

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself.
  reporter.progress(6, 6, "Securing connection...");
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
        reporter.error(
          yellow(
            `⚠️  Guardian token lease attempt ${attempt}/${maxLeaseAttempts} failed — retrying in ${delayMs / 1000}s: ${err}`,
          ),
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        reporter.error(
          yellow(
            `⚠️  Guardian token lease failed${err instanceof GuardianLeasePermanentError ? ", not retrying — a malformed 200 will not fix itself" : ` after ${maxLeaseAttempts} attempts`}: ${err}\n` +
              `   The assistant is running but guardian-token.json was not written.\n` +
              `   Run \`cadet restart ${JSON.stringify(instanceName)} --repair-guardian\` to re-lease a token.`,
          ),
        );
      }
    }
  }

  if (provider !== undefined && provider !== null && !guardianAccessToken) {
    reporter.error(
      yellow(
        `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
          `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the connection.`,
      ),
    );
  } else if (provider !== undefined) {
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
      await registerLocalAssistantWithCloud(user, (m) => reporter.log(m));
    } catch {
      // Non-fatal — `cadet login` can complete the registration later.
    }
  }

  reporter.log("");
  reporter.log(green(`✅ Local assistant hatched!`, process.stdout));
  printInstanceDetails(
    {
      name: instanceName,
      runtime: getGatewayUrl(entry),
      root: entry.instanceDir,
    },
    (message) => reporter.log(message),
  );
  logHatchNextSteps((message) => reporter.log(message));

  const result: HatchLocalResult = {
    assistantId: instanceName,
    guardianAccessToken,
  };

  return result;
}

/**

/**
 * Mint (and approve) a remote-web pairing challenge on the local gateway —
 * the `gateway pairing mint` the pair command wraps, run through the
 * gateway CLI invocation. Process execution is the local-presence proof.
 * Returns the command's stdout; its last line is the challenge JSON.
 */
export async function localPair(entry: LocalAssistant): Promise<string> {
  const invocation = gatewayCliInvocation(entry);
  return execOutput(
    invocation.command,
    [...invocation.args, "pairing", "mint"],
    {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 30_000,
    },
  );
}
