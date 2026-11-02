import { join } from "node:path";

import type { LocalAssistant } from "@mycadet/local-mode/contract";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import {
  gatewayCliInvocation,
  hatchLocal as hatchLocalOp,
  readCloudToken,
  resolveAssistantsDir,
  resolveLogDir,
} from "@mycadet/local-mode";
import { execOutput } from "../step-runner.js";
import { setStartupLogging } from "@mycadet/local-mode";
import {
  GuardianLeasePermanentError,
  leaseGuardianToken,
} from "../guardian-token.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "../lifecycle-reporter.js";
import { configureHatchProviderApiKey } from "../provider-secrets.js";
import { logHatchNextSteps } from "../hatch-next-steps.js";
import { printInstanceDetails } from "../instance-details.js";
import { registerLocalAssistantWithCloud } from "../cloud-login.js";
import { fetchCurrentUser } from "../cloud-client.js";
import { green, yellow } from "../color.js";

// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../../package.json";

export interface HatchLocalParams {
  /** Instance display name. Defaults to an auto-generated name. */
  name?: string | null;
  /** Build from a local source tree and hot-reload on change. */
  watch?: boolean;
  /** Hatch-time config values (key → value). */
  configValues?: Record<string, string>;
  setupProviderCredentials?: boolean;
  /** The command's pre-collected provider choice, if it prompted. */
  provider?: string | null;
  /** The command's pre-collected provider API key, if it prompted. */
  precollectedApiKey?: string;
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

  if (!process.env.APP_VERSION) {
    process.env.APP_VERSION = cliPkg.version;
  }

  reporter.progress(1, 6, "Allocating resources...");
  const hatched = await hatchLocalOp({ name, watch, configValues });
  if (!hatched.ok) {
    if (hatched.status !== 409) {
      reporter.error(
        `\n❌ Local assistant startup failed — stopping partial processes.`,
      );
      reporter.error(
        `   Logs: ${join(resolveAssistantsDir(), hatched.assistantId ?? "", "logs")} and ${join(resolveLogDir(), "hatch.log")}`,
      );
    }
    throw new Error(hatched.error);
  }
  const assistant = hatched.entry;
  if (assistant.cloud !== "local") {
    throw new Error("The local hatch provisioned a non-local entry.");
  }
  const instanceName = assistant.assistantId;

  reporter.log(`🥚 Hatching local assistant: ${instanceName}`);
  reporter.log("");

  // Collected right after the provider choice (so the two prompts sit
  // back-to-back), consumed after the guardian token leases.
  const precollectedApiKey = params.precollectedApiKey;
  const provider = params.provider;

  // Lease a guardian token so the desktop app can import it on first launch
  // instead of hitting /v1/guardian/init itself.
  reporter.progress(6, 6, "Securing connection...");
  const maxLeaseAttempts = 3;
  let guardianAccessToken: string | undefined;
  for (let attempt = 1; attempt <= maxLeaseAttempts; attempt++) {
    try {
      const tokenData = await leaseGuardianToken(assistant);
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
  } else if (provider !== undefined && setupProviderCredentials) {
    await configureHatchProviderApiKey({
      gatewayUrl: getGatewayUrl(assistant),
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
      runtime: getGatewayUrl(assistant),
      root: assistant.instanceDir,
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
