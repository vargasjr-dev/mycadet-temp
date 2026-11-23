/**
 * Watches config.json for changes to any top-level key.
 * Uses the same fs.watch() + debounce pattern as CredentialWatcher.
 */

import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import {
  CONFIG_FILENAME,
  getConfigPath,
  readConfigFileOrEmpty,
} from "./config-file-utils.js";
import { getLogger } from "./logger.js";
import { getConfigFileCache } from "./config-file-cache.js";
import { getCredentials } from "./credential-cache.js";
import { registerEmailCallbackRoute } from "./email/register-callback.js";
import { reconcileTelegramWebhook } from "./telegram/webhook-manager.js";
import { getTunnelClient } from "./tunnel/client.js";
import { hasTwilioSetupStarted } from "./twilio/setup-state.js";
import {
  isOnlyTunnelPublicBaseUrlChange,
  shouldSyncTwilioPhoneWebhooksAfterConfigChange,
} from "./twilio/webhook-sync-trigger.js";
import { syncConfiguredTwilioPhoneNumberWebhooks } from "./twilio/webhook-sync.js";

const log = getLogger("config-file-watcher");

const DEBOUNCE_MS = 500;
const FALLBACK_POLL_MS = 1_000;

type IntervalHandle = ReturnType<typeof setInterval>;

type TimerApi = {
  setInterval: (fn: () => void, delayMs: number) => IntervalHandle;
  clearInterval: (timer: IntervalHandle) => void;
};

export type ConfigChangeEvent = {
  /** Full parsed config.json data. */
  data: Record<string, unknown>;
  /** Top-level keys whose serialized value changed since the last poll. */
  changedKeys: Set<string>;
  /**
   * Shallow object fields that changed for changed top-level object keys.
   * Non-object replacements are represented by the top-level key only.
   */
  changedFields: Map<string, Set<string>>;
};

export type ConfigChangeCallback = (event: ConfigChangeEvent) => void;

export class ConfigFileWatcher {
  private watcher: FSWatcher | null = null;
  private pollTimer: IntervalHandle | null = null;
  private watchingDirectory = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSerialized: Map<string, string> = new Map();
  private lastValues: Map<string, unknown> = new Map();
  private callback: ConfigChangeCallback;
  private configPath: string;
  private pollIntervalMs: number;
  private timerApi: TimerApi;

  constructor(
    callback: ConfigChangeCallback,
    opts?: { pollIntervalMs?: number; timerApi?: TimerApi },
  ) {
    this.callback = callback;
    this.configPath = getConfigPath();
    this.pollIntervalMs = opts?.pollIntervalMs ?? FALLBACK_POLL_MS;
    this.timerApi = opts?.timerApi ?? {
      setInterval,
      clearInterval,
    };
  }

  start(): void {
    this.pollOnce();

    this.watchingDirectory = !existsSync(this.configPath);
    const watchTarget = this.watchingDirectory
      ? dirname(this.configPath)
      : this.configPath;

    try {
      this.watcher = watch(
        watchTarget,
        { persistent: false },
        (_event, filename) => {
          if (this.watchingDirectory && filename !== CONFIG_FILENAME) {
            return;
          }
          this.scheduleCheck();
        },
      );

      // Prevent unhandled FSWatcher errors (e.g. ENXIO when the watched
      // directory is removed) from crashing the process.
      this.watcher.on("error", (err) => {
        log.warn({ err, path: watchTarget }, "Config file watcher error");
      });

      log.info({ path: watchTarget }, "Watching for config file changes");
    } catch (err) {
      log.warn(
        { err, path: watchTarget },
        "Failed to start config file watcher",
      );
    }

    this.startFallbackPolling();
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      this.timerApi.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private startFallbackPolling(): void {
    if (this.pollIntervalMs <= 0 || this.pollTimer) return;

    this.pollTimer = this.timerApi.setInterval(() => {
      this.pollOnce();

      if (this.watchingDirectory && existsSync(this.configPath)) {
        this.upgradeWatcher();
      }
    }, this.pollIntervalMs);
    (this.pollTimer as { unref?: () => void }).unref?.();

    log.info(
      { intervalMs: this.pollIntervalMs },
      "Polling config file for missed change events",
    );
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.pollOnce();

      if (this.watchingDirectory && existsSync(this.configPath)) {
        this.upgradeWatcher();
      }
    }, DEBOUNCE_MS);
  }

  private upgradeWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (!existsSync(this.configPath)) return;

    try {
      this.watcher = watch(this.configPath, { persistent: false }, () => {
        this.scheduleCheck();
      });
      this.watchingDirectory = false;
      log.debug("Upgraded watcher to config file");
    } catch (err) {
      log.warn({ err }, "Failed to upgrade config file watcher");
    }
  }

  private pollOnce(): void {
    const data = readConfigFileOrEmpty({
      onMalformed: (detail) => {
        log.debug({ err: detail }, "Failed to read config file");
      },
    });

    const changedKeys = new Set<string>();
    const changedFields = new Map<string, Set<string>>();

    // Detect changed or added keys
    const allKeys = new Set([
      ...Object.keys(data),
      ...this.lastSerialized.keys(),
    ]);

    for (const key of allKeys) {
      const newVal = key in data ? JSON.stringify(data[key]) : undefined;
      const oldVal = this.lastSerialized.get(key);

      if (newVal !== oldVal) {
        changedKeys.add(key);
        const fieldChanges = diffObjectFields(
          this.lastValues.get(key),
          key in data ? data[key] : undefined,
        );
        if (fieldChanges.size > 0) {
          changedFields.set(key, fieldChanges);
        }
        if (newVal !== undefined) {
          this.lastSerialized.set(key, newVal);
          this.lastValues.set(key, data[key]);
        } else {
          this.lastSerialized.delete(key);
          this.lastValues.delete(key);
        }
      }
    }

    if (changedKeys.size === 0) return;

    log.info({ changedKeys: [...changedKeys] }, "Config file changed");

    this.callback({ data, changedKeys, changedFields });
  }
}

function diffObjectFields(oldValue: unknown, newValue: unknown): Set<string> {
  if (!isPlainRecord(oldValue) && !isPlainRecord(newValue)) {
    return new Set();
  }

  const oldRecord = isPlainRecord(oldValue) ? oldValue : {};
  const newRecord = isPlainRecord(newValue) ? newValue : {};
  const changed = new Set<string>();
  const allKeys = new Set([
    ...Object.keys(oldRecord),
    ...Object.keys(newRecord),
  ]);
  for (const key of allKeys) {
    const oldSerialized =
      key in oldRecord ? JSON.stringify(oldRecord[key]) : undefined;
    const newSerialized =
      key in newRecord ? JSON.stringify(newRecord[key]) : undefined;
    if (oldSerialized !== newSerialized) {
      changed.add(key);
    }
  }
  return changed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Starts the config.json watcher and returns the stop thunk, per the
 * gateway's `const stopX = startX()` lifecycle pattern.
 *
 * The invalidation side effects live here with the watcher instead of in
 * the entrypoint: the caches resolve through their singletons at call time,
 * and each downstream manager owns its own readiness — the Telegram webhook
 * reconcile and the email callback registration skip themselves when their
 * credentials are missing, so no readiness flags cross the boundary.
 */
export function startConfigFileWatcher(): () => void {
  const configFileCache = getConfigFileCache();
  const credentials = getCredentials();

  const watcher = new ConfigFileWatcher((event) => {
    // Invalidate the config file cache so subsequent reads pick up fresh
    // values.
    configFileCache.invalidate();

    // Reconcile the Telegram webhook when the ingress URL changes. A
    // Tunnel-only publicBaseUrl change is the tunnel registering — that URL
    // is what Telegram must be pointed at, so a reconcile on that event is
    // exactly what lifts the suppression that keeps a tunnel address out of
    // provider config.
    if (
      event.changedKeys.has("ingress") &&
      !isOnlyTunnelPublicBaseUrlChange(event)
    ) {
      reconcileTelegramWebhook({
        credentials,
        configFile: configFileCache,
      }).catch((err) => {
        log.error(
          { err },
          "Failed to reconcile Telegram webhook after ingress URL change",
        );
      });
    }

    if (shouldSyncTwilioPhoneWebhooksAfterConfigChange(event)) {
      syncConfiguredTwilioPhoneNumberWebhooks({
        credentials,
        configFile: configFileCache,
      }).catch((err) => {
        log.warn({ err }, "Twilio webhook sync failed after config change");
      });
    }

    if (event.changedKeys.has("twilio")) {
      maybeStartTunnelForTwilioConfig("twilio config changed");
    }

    // Re-register the email callback route when the ingress URL changes so
    // the cloud callback route points at the new self-hosted URL. A
    // Tunnel-only publicBaseUrl change is the tunnel registering, which
    // doesn't move the email callback's host.
    if (
      event.changedKeys.has("ingress") &&
      !isOnlyTunnelPublicBaseUrlChange(event)
    ) {
      registerEmailCallbackRoute({
        credentials,
        configFile: configFileCache,
      }).catch((err) => {
        log.error(
          { err },
          "Failed to re-register email callback route after ingress URL change",
        );
      });
    }
  });
  watcher.start();
  return () => watcher.stop();
}

/**
 * The config-change path into the Tunnel: Twilio setup started via its
 * config field is the request for public ingress. The credential-change
 * and startup paths keep their own entrypoint-owned variant with the
 * credentials in hand.
 */
function maybeStartTunnelForTwilioConfig(reason: string): void {
  const tunnelClient = getTunnelClient();
  if (!tunnelClient || tunnelClient.isRunning()) {
    return;
  }
  if (!hasTwilioSetupStarted(getConfigFileCache())) {
    return;
  }
  log.info({ reason }, "Starting Tunnel after Twilio setup detected");
  tunnelClient.start();
}
