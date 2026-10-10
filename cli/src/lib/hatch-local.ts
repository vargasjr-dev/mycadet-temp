import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  appendFileSync,
  readFileSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  allocateLocalResources,
  findAssistantByName,
  saveAssistantEntry,
  setActiveAssistant,
} from "./assistant-config.js";
import type { AssistantEntry } from "./assistant-config.js";
import { buildHatchConfigValues, writeInitialConfig } from "./config-utils.js";
import {
  generateLocalSigningKey,
  setStartupLogging,
  startCes,
  startLocalDaemon,
  startGateway,
  stopLocalProcesses,
} from "./local.js";

import { generateInstanceName } from "./random-name.js";
import {
  GuardianLeasePermanentError,
  leaseGuardianToken,
} from "./guardian-token.js";
import { archiveLogFile, resetLogFile } from "./xdg-log.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "./lifecycle-reporter.js";
import {
  collectProviderApiKey,
  configureHatchProviderApiKey,
  promptProviderChoice,
  resolveHatchProvider,
  shouldPromptForHatchProvider,
} from "./provider-secrets.js";
import { logHatchNextSteps } from "./hatch-next-steps.js";
import { printInstanceDetails } from "./instance-details.js";
import { checkProviderApiKey } from "./api-key-check.js";
import { loopbackSafeFetch } from "./loopback-fetch.js";
import {
  describeLoginError,
  ensureCloudLoginInteractive,
  registerLocalAssistantWithPlatform,
} from "./cloud-login.js";
import { fetchCurrentUser, readPlatformToken } from "./platform-client.js";
import { withLocalHatchLock } from "./local-hatch-lock.js";

/**
 * Attempts to place a symlink at the given path pointing to cliBinary.
 * Returns true if the symlink was created (or already correct), false on failure.
 */
function trySymlink(cliBinary: string, symlinkPath: string): boolean {
  try {
    // Use lstatSync (not existsSync) to detect dangling symlinks —
    // existsSync follows symlinks and returns false for broken links.
    try {
      const stats = lstatSync(symlinkPath);
      if (!stats.isSymbolicLink()) {
        // Real file — don't overwrite (developer's local install)
        return false;
      }
      // Already a symlink — skip if it already points to our binary
      const dest = readlinkSync(symlinkPath);
      if (dest === cliBinary) return true;
      // Stale or dangling symlink — remove before creating new one
      unlinkSync(symlinkPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
      // Path doesn't exist — proceed to create symlink
    }

    const dir = join(symlinkPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    symlinkSync(cliBinary, symlinkPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures ~/.local/bin is present in the user's shell profile so that
 * symlinks placed there are on PATH in new terminal sessions.
 */
function ensureLocalBinInShellProfile(localBinDir: string): void {
  const shell = process.env.SHELL ?? "";
  const home = homedir();
  // Determine the appropriate shell profile to modify
  const profilePath = shell.endsWith("/zsh")
    ? join(home, ".zshrc")
    : shell.endsWith("/bash")
      ? join(home, ".bash_profile")
      : null;
  if (!profilePath) return;

  try {
    const contents = existsSync(profilePath)
      ? readFileSync(profilePath, "utf-8")
      : "";
    // Check if ~/.local/bin is already referenced in PATH exports
    if (contents.includes(localBinDir)) return;
    const line = `\nexport PATH="${localBinDir}:\$PATH"\n`;
    appendFileSync(profilePath, line);
    console.log(`   Added ${localBinDir} to ${profilePath}`);
  } catch {
    // Not critical — user can add it manually
  }
}

function installCLISymlink(): void {
  const cliBinary = process.execPath;
  if (!cliBinary || !existsSync(cliBinary)) return;

  // Preferred location — works on most Macs where /usr/local/bin exists
  const preferredPath = "/usr/local/bin/cadet";
  if (trySymlink(cliBinary, preferredPath)) {
    console.log(`   Symlinked ${preferredPath} → ${cliBinary}`);
    return;
  }

  // Fallback — use ~/.local/bin which is user-writable and doesn't need root.
  // On some Macs /usr/local doesn't exist and creating it requires admin privileges.
  const localBinDir = join(homedir(), ".local", "bin");
  const fallbackPath = join(localBinDir, "cadet");
  if (trySymlink(cliBinary, fallbackPath)) {
    console.log(`   Symlinked ${fallbackPath} → ${cliBinary}`);
    ensureLocalBinInShellProfile(localBinDir);
    return;
  }

  console.log(
    `   ⚠ Could not create symlink for cadet CLI (tried ${preferredPath} and ${fallbackPath})`,
  );
}

export interface HatchLocalParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Stay attached after hatch and poll the gateway until it stops. */
  keepAlive?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  /** Extra env vars forwarded into the assistant process. */
  flagEnvVars?: Record<string, string>;
  setupProviderCredentials?: boolean;
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
  runtimeUrl: string;
  localUrl: string;
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
  const {
    name,
    watch = false,
    keepAlive = false,
    configValues = {},
    flagEnvVars = {},
  } = params;
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

  const { resources, runtimeUrl, loopbackUrl, bootstrapSecret } =
    await withLocalHatchLock(async () => {
      reporter.progress(1, 6, "Allocating resources...");

      const existing = findAssistantByName(instanceName);
      if (existing && (!existing.cloud || existing.cloud === "local")) {
        throw new Error(
          `An assistant named "${instanceName}" is already hatched.\n` +
            `Run \`cadet wake\` to restart it, or \`cadet retire ${instanceName}\` to remove it first.`,
        );
      }

      const resources = await allocateLocalResources(instanceName);

      const logsDir = join(resources.instanceDir, "workspace", "data", "logs");
      archiveLogFile("hatch.log", logsDir);
      resetLogFile("hatch.log");

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
          // mystery later — open the browser login right here. Skipped for
          // the desktop app (it runs its own login UI) and non-TTY runs.
          if (
            picked === "cadet" &&
            !process.env.CADET_DESKTOP_APP &&
            process.stdin.isTTY &&
            !readPlatformToken()
          ) {
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

      if (
        !apiKeyCheck.hasKey &&
        !pickedProvider &&
        !process.env.CADET_DESKTOP_APP
      ) {
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
      const signingKey = generateLocalSigningKey();
      const bootstrapSecret = generateLocalSigningKey();
      let runtimeUrl = `http://127.0.0.1:${resources.gatewayPort}`;
      try {
        // Launch the CES sibling alongside the daemon, in parallel — matching the
        // Docker topology. The assistant does not spawn its own CES, so a freshly
        // hatched instance would otherwise come up with CES unavailable.
        // startCes always launches the CES sibling.
        const startupResults = await Promise.allSettled([
          startCes(watch, resources),
          startLocalDaemon(watch, resources, {
            defaultWorkspaceConfigPath,
            requireReady: true,
            signingKey,
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
        runtimeUrl = await startGateway(watch, resources, {
          signingKey,
          bootstrapSecret,
          envOverrides: flagEnvVars,
          requireReady: true,
        });
      } catch (error) {
        reporter.error(
          `\n❌ Local assistant startup failed — stopping partial processes.`,
        );
        await stopLocalProcesses(resources);
        throw error;
      }

      const loopbackUrl = `http://127.0.0.1:${resources.gatewayPort}`;
      const localEntry: AssistantEntry = {
        assistantId: instanceName,
        runtimeUrl,
        localUrl: `http://127.0.0.1:${resources.gatewayPort}`,
        cloud: "local",
        hatchedAt: new Date().toISOString(),
        resources: { ...resources, signingKey },
        guardianBootstrapSecret: bootstrapSecret,
      };

      reporter.progress(5, 6, "Saving configuration...");
      saveAssistantEntry(localEntry);
      setActiveAssistant(instanceName);

      return { resources, runtimeUrl, loopbackUrl, bootstrapSecret };
    });

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself. Use loopback to satisfy
  // the daemon's local-only check — the mDNS runtimeUrl resolves to a LAN
  // IP which the daemon rejects as non-loopback.
  reporter.progress(6, 6, "Securing connection...");
  const maxLeaseAttempts = 3;
  let guardianAccessToken: string | undefined;
  for (let attempt = 1; attempt <= maxLeaseAttempts; attempt++) {
    try {
      const tokenData = await leaseGuardianToken(
        loopbackUrl,
        instanceName,
        bootstrapSecret,
      );
      guardianAccessToken = tokenData.accessToken;
      break;
    } catch (err) {
      if (
        attempt < maxLeaseAttempts &&
        !(err instanceof GuardianLeasePermanentError)
      ) {
        const delayMs = 2000 * 2 ** (attempt - 1);
        reporter.error(
          `⚠️  Guardian token lease attempt ${attempt}/${maxLeaseAttempts} failed — retrying in ${delayMs / 1000}s: ${err}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        reporter.error(
          `⚠️  Guardian token lease failed${err instanceof GuardianLeasePermanentError ? " (not retrying — a malformed 200 will not fix itself)" : ` after ${maxLeaseAttempts} attempts`}: ${err}\n` +
            `   The assistant is running but guardian-token.json was not written.\n` +
            `   Run \`cadet restart ${JSON.stringify(instanceName)} --repair-guardian\` to re-lease a token.`,
        );
      }
    }
  }

  if (process.env.CADET_DESKTOP_APP) {
    installCLISymlink();
  }

  if (provider !== undefined && provider !== null && !guardianAccessToken) {
    reporter.error(
      `⚠️  Provider credential setup skipped because the guardian token was not leased.\n` +
        `   The assistant is still hatched. Run \`cadet setup --provider ${provider}\` after fixing the connection.`,
    );
  } else if (provider !== undefined) {
    await configureHatchProviderApiKey({
      gatewayUrl: loopbackUrl,
      provider,
      bearerToken: guardianAccessToken,
      env: process.env,
      precollectedKey: precollectedApiKey,
    });
  }

  // Picking Cadet Cloud ends with the assistant registered on the platform
  // and its cloud credentials injected — the same post-login flow
  // `cadet login` runs — so messages route through the managed connection
  // immediately after hatch. Non-fatal: the assistant is up either way.
  if (provider === "cadet" && readPlatformToken()) {
    try {
      const token = readPlatformToken()!;
      const user = await fetchCurrentUser(token);
      await registerLocalAssistantWithPlatform(token, user, {
        bearerToken: guardianAccessToken,
        log: (m) => reporter.log(m),
      });
    } catch {
      // Non-fatal — `cadet login` can complete the registration later.
    }
  }

  reporter.log("");
  reporter.log(`✅ Local assistant hatched!`);
  printInstanceDetails(
    {
      name: instanceName,
      runtime: runtimeUrl,
      root: resources.instanceDir,
    },
    (message) => reporter.log(message),
  );
  logHatchNextSteps((message) => reporter.log(message), verbose);

  const result: HatchLocalResult = {
    assistantId: instanceName,
    runtimeUrl,
    localUrl: `http://127.0.0.1:${resources.gatewayPort}`,
    guardianAccessToken,
  };

  if (keepAlive) {
    const healthUrl = `http://127.0.0.1:${resources.gatewayPort}/healthz`;
    const healthTarget = "Gateway";
    const POLL_INTERVAL_MS = 5000;
    const MAX_FAILURES = 3;
    let consecutiveFailures = 0;

    const shutdown = async (): Promise<void> => {
      reporter.log("\nShutting down local processes...");
      await stopLocalProcesses(resources);
      process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());

    // Poll the health endpoint until it stops responding.
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const res = await loopbackSafeFetch(healthUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          consecutiveFailures = 0;
        } else {
          consecutiveFailures++;
        }
      } catch {
        consecutiveFailures++;
      }
      if (consecutiveFailures >= MAX_FAILURES) {
        reporter.log(
          `\n⚠️  ${healthTarget} stopped responding — shutting down.`,
        );
        await stopLocalProcesses(resources);
        process.exit(1);
      }
    }
  }

  return result;
}
