import { initSigningKey } from "./auth/token-service.js";
import { logAuthBypassState } from "./http/middleware/auth.js";
import { startConfigFileWatcher } from "./config-file-watcher.js";
import { loadConfig } from "./config.js";
import { getCredentials } from "./credential-cache.js";
import { startCredentialWatcher } from "./credential-watcher.js";
import { initTrustRuleCache } from "./risk/trust-rule-cache.js";
import { initAdmissionPolicyCache } from "./risk/admission-policy-cache.js";
import {
  reconcilePluginWebhookRoutes,
  watchPluginIngressForWebhookRoutes,
} from "./channels/plugin-webhook-route-sync.js";
import {
  getLogger,
  initLogger,
  LOG_RETENTION_SWEEP_INTERVAL_MS,
  pruneOldLogFiles,
  type LogFileConfig,
} from "./logger.js";
import { bindCloudIdentityCredentialCache } from "./cloud-identity.js";
import { startDiscordGateway } from "./discord/lifecycle.js";
import { startSlackGateway } from "./slack/lifecycle.js";
import { startSleepWakeDetector } from "./sleep-wake-detector.js";
import { startIpcServer } from "./ipc/server.js";
import { initGatewayDb } from "./db/connection.js";
import { startTunnelClient } from "./tunnel/lifecycle.js";
import { markDraining, startServer } from "./server.js";
import { startInboundEventExpirationCleanup } from "./channels/inbound-event.js";
import { startEmail } from "./email/lifecycle.js";
import { startTelegram } from "./telegram/lifecycle.js";
import { startWhatsapp } from "./whatsapp/lifecycle.js";
process.title = "cadet-gateway";

const log = getLogger("main");

function startLogRetentionSweep(config: LogFileConfig): void {
  if (!config.dir) return;
  const interval = setInterval(() => {
    try {
      const removed = pruneOldLogFiles(config.dir!, config.retentionDays);
      if (removed > 0) {
        log.info(
          { removed, retentionDays: config.retentionDays },
          "Pruned old log files",
        );
      }
    } catch (err) {
      log.warn({ err }, "Log retention sweep failed");
    }
  }, LOG_RETENTION_SWEEP_INTERVAL_MS);
  interval.unref();
}

type StopTask = () => Promise<void> | void;

async function main() {
  const config = loadConfig();
  initLogger(config.logFile);
  startLogRetentionSweep(config.logFile);

  log.info("Starting Cadet Gateway...");

  logAuthBypassState();

  // Initialize the JWT signing key shared with the daemon.
  // This must happen before any request handling.
  initSigningKey();
  log.info("JWT signing key initialized");

  await initGatewayDb();
  initTrustRuleCache();
  initAdmissionPolicyCache();

  // Plugin rows in the webhook registry are derived from the declarations the
  // ingress gate currently serves, so startup recomputes them from what is
  // installed and approved right now rather than trusting whatever the last
  // run left behind. Anything that moved while the gateway was down settles
  // here, and the watch below keeps them settling while it runs.
  reconcilePluginWebhookRoutes();
  watchPluginIngressForWebhookRoutes();

  // ── TTL caches ──
  // Instantiate caches for credential and config file reads.
  // Handlers read dynamic credentials and config.json values from these
  // caches at call time, with automatic TTL refresh.
  //
  // The cloud-identity resolver shares this cache so a vault outage can
  // still retry its validate call with last-good secrets; binding it here
  // (where the cache is built) keeps that dependency at the composition
  // root. The warm-up itself is startServer's — see server.ts.
  const credentialCache = getCredentials();
  bindCloudIdentityCredentialCache(credentialCache);

  // Bind the HTTP server as a lifecycle task: startServer binds, completes
  // the post-assistant-ready work (so /healthz and /readyz observe the bound
  // process throughout), and returns the thunk the drain window calls last.
  const stopServer = await startServer();

  const tasks: (() => StopTask | Promise<StopTask>)[] = [
    startCredentialWatcher,
    startIpcServer,
    startConfigFileWatcher,
    startSleepWakeDetector,
    startInboundEventExpirationCleanup,
    startTelegram,
    startWhatsapp,
    startEmail,
    startSlackGateway,
    startDiscordGateway,
    startTunnelClient,
  ];
  const shutdownTasks: StopTask[] = await Promise.all(
    tasks.map((task) => task()),
  );

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    markDraining();
    const shutdownPromises = shutdownTasks.map((stopTask) => stopTask());
    setTimeout(() => {
      log.info("Drain window elapsed, stopping server");
      void Promise.allSettled(shutdownPromises).then(() => {
        stopServer();
        process.exit(0);
      });
    }, 5_000);
  });
}

main();
