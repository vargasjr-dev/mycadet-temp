/**
 * Watches the encrypted credential store and CES so channel
 * credentials are reloaded when they are added, updated, or removed.
 *
 * Identity and policy live in CES (the credential-records catalog, dialed
 * over the shared Unix socket). When CES is configured, the watcher polls
 * that catalog instead of leftover workspace `metadata.json`. Local
 * keys.enc mode stays secrets-only.
 *
 * Watches parent directories rather than files themselves because
 * keys.enc is rewritten via atomic rename. File-scoped fs.watch()
 * subscriptions can stay attached to the old inode after the first write,
 * causing later credential changes to be missed until restart.
 */

import { mkdirSync, watch, type FSWatcher } from "node:fs";
import { getLogger } from "./logger.js";
import {
  ALL_CREDENTIAL_SPECS,
  getCesIpcClient,
  isCesManagedMode,
  readServiceCredentialsResult,
} from "./credential-reader.js";
import { getGatewaySecurityDir } from "./paths.js";
import { getCredentials } from "./credential-cache.js";
import { getConfigFileCache } from "./config-file-cache.js";
import { ensureCloudIdentityIds } from "./cloud-identity.js";
import { registerEmailCallbackRoute } from "./email/register-callback.js";
import { callTelegramApi } from "./telegram/api.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";
import { getTunnelClient } from "./tunnel/client.js";
import { hasTwilioSetupStarted } from "./twilio/setup-state.js";
import { syncConfiguredTwilioPhoneNumberWebhooks } from "./twilio/webhook-sync.js";
import { webhookDedupCaches } from "./http/routes/index.js";

const log = getLogger("credential-watcher");

const DEBOUNCE_MS = 500;
const MANAGED_BOOTSTRAP_POLL_MS = 1_000;
const MANAGED_BOOTSTRAP_STEADY_POLL_MS = 30_000;

export type CredentialChangeEvent = {
  /** Map from service name to resolved credentials (null if unavailable) */
  credentials: ReadonlyMap<string, Record<string, string> | null>;
  /** Set of service names whose credentials changed since last poll */
  changedServices: ReadonlySet<string>;
};

export type CredentialChangeCallback = (event: CredentialChangeEvent) => void;

export class CredentialWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private managedBootstrapTimer: ReturnType<typeof setInterval> | null = null;
  private managedBootstrapPollInFlight = false;
  private managedBootstrapInSteadyState = false;
  private lastConfiguredServices = new Set<string>();
  private lastReadyServices = new Set<string>();
  private lastSerialized: Map<string, string> = new Map();
  private polling = false;
  private pendingPoll = false;
  private callback: CredentialChangeCallback;

  constructor(callback: CredentialChangeCallback) {
    this.callback = callback;
  }

  async start(): Promise<void> {
    await this.pollOnce();

    const protectedDir = getGatewaySecurityDir();

    // Ensure directories exist so fs.watch() doesn't throw ENOENT
    // on a fresh hatch where no credentials have been written yet.
    mkdirSync(protectedDir, { recursive: true });

    // Watch the protected directory for store.key changes so that
    // creating or restoring the v2 store key triggers a credential reload.
    this.startWatcher(protectedDir, "store.key");

    // Watch keys.enc for credential writes. When credentials are re-saved
    // with the same values (e.g. re-entering existing tokens), the
    // serialized credential values won't change,
    // but the encrypted ciphertext will (new IV). Force a full reload so
    // channel listeners restart even when the plaintext values match.
    this.startWatcher(protectedDir, "keys.enc", { forceChanged: true });

    this.startManagedBootstrapRetry();
  }

  private startWatcher(
    dir: string,
    targetFilename: string,
    opts?: { forceChanged?: boolean },
  ): void {
    const forceChanged = opts?.forceChanged ?? false;
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && filename !== targetFilename) {
          return;
        }
        this.scheduleCheck(forceChanged);
      });

      // Prevent unhandled FSWatcher errors (e.g. ENXIO when the watched
      // directory is removed) from crashing the process.
      watcher.on("error", (err) => {
        log.warn(
          { err, path: dir, file: targetFilename },
          "Credential file watcher error",
        );
      });

      this.watchers.push(watcher);

      log.info(
        { path: dir, file: targetFilename },
        "Watching for credential changes",
      );
    } catch (err) {
      log.warn({ err, path: dir }, "Failed to start credential file watcher");
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.managedBootstrapTimer) {
      clearInterval(this.managedBootstrapTimer);
      this.managedBootstrapTimer = null;
    }
    this.managedBootstrapPollInFlight = false;
    this.managedBootstrapInSteadyState = false;
    this.pendingPoll = false;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private startManagedBootstrapRetry(): void {
    if (!isCesManagedMode()) {
      return;
    }

    const poll = (): void => {
      void this.pollManagedBootstrap();
    };

    this.managedBootstrapTimer = setInterval(poll, MANAGED_BOOTSTRAP_POLL_MS);
    this.managedBootstrapTimer.unref?.();
    poll();
  }

  private async pollManagedBootstrap(): Promise<void> {
    if (this.managedBootstrapPollInFlight) {
      return;
    }
    this.managedBootstrapPollInFlight = true;
    try {
      const client = getCesIpcClient();
      if (!client) {
        return;
      }
      const listResult = await client.list();
      const recordsResult = await client.listRecords();

      if (listResult.unreachable || recordsResult.unreachable) {
        // CES isn't reachable yet. Keep retrying.
        return;
      }

      await this.pollOnce();

      const ready =
        this.lastConfiguredServices.size > 0 &&
        this.allConfiguredServicesReady();

      if (ready && !this.managedBootstrapInSteadyState) {
        // All configured channel services have their credentials loaded.
        // Switch to a slower steady-state poll as a resilient fallback for
        // environments where fs.watch() doesn't propagate across containers.
        if (this.managedBootstrapTimer) {
          clearInterval(this.managedBootstrapTimer);
          this.managedBootstrapTimer = setInterval(() => {
            void this.pollManagedBootstrap();
          }, MANAGED_BOOTSTRAP_STEADY_POLL_MS);
          this.managedBootstrapTimer.unref?.();
        }
        this.managedBootstrapInSteadyState = true;
      } else if (!ready && this.managedBootstrapInSteadyState) {
        // A configured service lost its credentials: revert to fast polling
        // so we pick up restored credentials quickly.
        if (this.managedBootstrapTimer) {
          clearInterval(this.managedBootstrapTimer);
          this.managedBootstrapTimer = setInterval(() => {
            void this.pollManagedBootstrap();
          }, MANAGED_BOOTSTRAP_POLL_MS);
          this.managedBootstrapTimer.unref?.();
        }
        this.managedBootstrapInSteadyState = false;
      }
    } catch {
      // CES isn't reachable yet. Keep retrying until the sidecar is ready.
    } finally {
      this.managedBootstrapPollInFlight = false;
    }
  }

  /** Whether the next scheduled poll should treat all services as changed. */
  private pendingForceChanged = false;

  private scheduleCheck(forceChanged = false): void {
    if (forceChanged) {
      this.pendingForceChanged = true;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const force = this.pendingForceChanged;
      this.pendingForceChanged = false;
      void this.pollOnce(force);
    }, DEBOUNCE_MS);
  }

  private async pollOnce(forceChanged = false): Promise<void> {
    if (this.polling) {
      // A poll is already in flight: flag that another round is needed
      // so credential updates arriving mid-poll aren't silently dropped.
      this.pendingPoll = true;
      if (forceChanged) {
        this.pendingForceChanged = true;
      }
      return;
    }
    this.polling = true;
    try {
      const credentials = new Map<string, Record<string, string> | null>();
      const configuredServices = await this.loadConfiguredServices();
      for (const spec of ALL_CREDENTIAL_SPECS) {
        const read = await readServiceCredentialsResult(spec);
        if (read.status === "unreachable") {
          log.warn(
            { service: spec.service },
            "Credential store unreachable; keeping last known channel credentials",
          );
          return;
        }
        credentials.set(
          spec.service,
          read.status === "ok" ? read.credentials : null,
        );
      }
      this.lastConfiguredServices = configuredServices;
      this.lastReadyServices = new Set(
        [...credentials.entries()]
          .filter(([, creds]) => creds !== null)
          .map(([service]) => service),
      );

      const changedServices = new Set<string>();
      for (const [service, creds] of credentials) {
        const newVal = creds ? JSON.stringify(creds) : undefined;
        const oldVal = this.lastSerialized.get(service);
        if (newVal !== oldVal || (forceChanged && newVal !== undefined)) {
          changedServices.add(service);
          if (newVal !== undefined) {
            this.lastSerialized.set(service, newVal);
          } else {
            this.lastSerialized.delete(service);
          }
        }
      }

      if (changedServices.size === 0) {
        return;
      }

      this.callback({ credentials, changedServices });
    } finally {
      this.polling = false;
      if (this.pendingPoll) {
        this.pendingPoll = false;
        const force = this.pendingForceChanged;
        this.pendingForceChanged = false;
        void this.pollOnce(force);
      }
    }
  }

  private async loadConfiguredServices(): Promise<Set<string>> {
    const client = getCesIpcClient();
    if (!client) {
      return new Set(this.lastReadyServices);
    }

    try {
      const listed = await client.listRecords();
      if (listed.unreachable) {
        return new Set(this.lastConfiguredServices);
      }

      const configured = new Set<string>();
      for (const spec of ALL_CREDENTIAL_SPECS) {
        const hasAllRequiredFields = spec.requiredFields.every((field) =>
          listed.records.some(
            (entry) =>
              entry.record.service === spec.service &&
              entry.record.field === field,
          ),
        );
        if (hasAllRequiredFields) {
          configured.add(spec.service);
        }
      }
      return configured;
    } catch {
      return new Set(this.lastConfiguredServices);
    }
  }

  /** @internal Test-only: run one credential poll without starting watchers. */
  async _pollOnceForTest(forceChanged = false): Promise<void> {
    await this.pollOnce(forceChanged);
  }

  private allConfiguredServicesReady(): boolean {
    for (const service of this.lastConfiguredServices) {
      if (!this.lastReadyServices.has(service)) {
        return false;
      }
    }
    return true;
  }
}

// ── Lifecycle: startCredentialWatcher ───────────────────────────────────────

const SERVICE_DISPLAY_NAMES: Record<string, string> = {
  telegram: "Telegram",
  twilio: "Twilio",
  whatsapp: "WhatsApp",
  slack_channel: "Slack channel",
  discord_channel: "Discord channel",
};

/** Logs each changed service and returns the changed names. */
function detectCredentialChanges(
  event: CredentialChangeEvent,
  logTarget: { info: (msg: string) => void },
): Set<string> {
  const changed = new Set<string>();
  for (const service of event.changedServices) {
    const displayName = SERVICE_DISPLAY_NAMES[service] ?? service;
    const creds = event.credentials.get(service);
    logTarget.info(
      creds
        ? `${displayName} credentials loaded from credential vault`
        : `${displayName} credentials cleared`,
    );
    changed.add(service);
  }
  return changed;
}

function registerTelegramCommands(credentials: {
  credentials: ReturnType<typeof getCredentials>;
  configFile: ReturnType<typeof getConfigFileCache>;
}): void {
  callTelegramApi(
    "setMyCommands",
    {
      commands: [
        { command: "new", description: "Start a new conversation" },
        { command: "help", description: "Show available commands" },
      ],
    },
    {
      credentials: credentials.credentials,
      configFile: credentials.configFile,
    },
  ).catch((err) => {
    log.error({ err }, "Failed to register Telegram bot commands");
  });
}

/**
 * The credential-change path into the Tunnel: Twilio credentials arriving in
 * the event are themselves the setup evidence. The startup path keeps its
 * entrypoint-owned variant with the credentials read in hand.
 */
function maybeStartTunnelForTwilioCredentials(
  reason: string,
  twilioCredentials?: Record<string, string> | null,
): void {
  const tunnelClient = getTunnelClient();
  if (!tunnelClient || tunnelClient.isRunning()) {
    return;
  }
  if (!hasTwilioSetupStarted(getConfigFileCache(), twilioCredentials)) {
    return;
  }
  log.info({ reason }, "Starting Tunnel after Twilio setup detected");
  tunnelClient.start();
}

/** Integration readiness, updated from each credential event. */
let telegramReady = false;
let cadetReady = false;

/**
 * Fingerprint of the Telegram bot token the dedup cache's watermark belongs
 * to. Null while no token is stored, which is itself a bot change: the next
 * bot to arrive must not meet the departed one's mark.
 */
let lastTelegramTokenFingerprint: string | null = null;

async function onCredentialChange(event: CredentialChangeEvent): Promise<void> {
  const credentials = getCredentials();
  const configFile = getConfigFileCache();
  const { telegramDedupCache } = webhookDedupCaches();
  const changed = detectCredentialChanges(event, log);

  // Invalidate the credential cache so subsequent reads pick up fresh values
  if (changed.size > 0) {
    credentials.invalidate();
  }

  // Update integration readiness flags from the credential event
  const telegramCreds = event.credentials.get("telegram");
  telegramReady = !!(telegramCreds?.bot_token && telegramCreds?.webhook_secret);

  const cadetCreds = event.credentials.get("cadet");
  cadetReady = !!cadetCreds?.assistant_api_key;
  if (cadetReady) {
    // Re-run validate when the API key / base URL change so a warm-pool
    // claim does not keep the previous assistant's bound owner ids.
    void ensureCloudIdentityIds();
  }
  const twilioCreds = event.credentials.get("twilio");

  // Side effects keyed by service name
  // `update_id` is a per-bot sequence, so a replacement bot starts below the
  // previous one's high-water mark and every inbound would be rejected as an
  // already-processed replay and answered 200. Forgetting the mark is what
  // keeps delivery working across a bot swap.
  //
  // Keyed on the token itself rather than on `changed`. Every `keys.enc`
  // write polls with `forceChanged`, which reports every configured service
  // as changed even when its plaintext is identical, so re-saving an
  // unrelated credential would otherwise clear replay protection for a bot
  // that never moved and let a delayed retry be processed twice.
  const telegramTokenFingerprint = telegramCreds?.bot_token
    ? new Bun.CryptoHasher("sha256")
        .update(telegramCreds.bot_token)
        .digest("hex")
    : null;
  if (telegramTokenFingerprint !== lastTelegramTokenFingerprint) {
    lastTelegramTokenFingerprint = telegramTokenFingerprint;
    telegramDedupCache.reset();
  }
  if (changed.has("telegram") && telegramReady) {
    registerTelegramCommands({ credentials, configFile });
    reconcileTelegramWebhook({ credentials, configFile }).catch((err) => {
      log.error(
        { err },
        "Failed to reconcile Telegram webhook after credential change",
      );
    });
  }

  if (changed.has("twilio")) {
    maybeStartTunnelForTwilioCredentials(
      "twilio credentials changed",
      twilioCreds,
    );
    syncConfiguredTwilioPhoneNumberWebhooks({
      credentials,
      configFile,
    }).catch((err) => {
      log.warn({ err }, "Twilio webhook sync failed after credential change");
    });
  }

  // Register email callback route with the cloud so inbound email
  // webhooks are forwarded to this gateway (same pattern as Telegram).
  // Fires on initial credential load and whenever cadet credentials change
  // (key rotation, late provisioning).
  if (changed.has("cadet")) {
    getTunnelClient()?.refreshCredentials("cadet credentials changed");
    registerEmailCallbackRoute({ credentials, configFile }).catch((err) => {
      log.error(
        { err },
        "Failed to register email callback route after credential change",
      );
    });

    // Cadet credentials are load-bearing for the Telegram webhook URL when
    // the cloud callback fallback applies: a cloud connection arriving
    // or rotating after Telegram setup must repoint Telegram at the cloud
    // callback route without waiting for an unrelated Telegram or ingress
    // change, or a system wake. Skipped when telegram credentials changed in
    // the same event, since that branch already reconciled above.
    if (telegramReady && !changed.has("telegram")) {
      reconcileTelegramWebhook({ credentials, configFile }).catch((err) => {
        log.error(
          { err },
          "Failed to reconcile Telegram webhook after cadet credential change",
        );
      });
    }
  }
}

/**
 * Starts the credential watcher and returns the stop thunk, per the
 * gateway's `const stopX = startX()` lifecycle pattern. The start awaits the
 * initial poll: its callback carries the credential-backed startup side
 * effects (Telegram reconcile, Tunnel start, email callback registration),
 * and the remaining lifecycle starts wait for them.
 */
export async function startCredentialWatcher(): Promise<() => void> {
  const watcher = new CredentialWatcher(onCredentialChange);
  await watcher.start();
  return () => watcher.stop();
}
