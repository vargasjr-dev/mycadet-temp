/**
 * Owns the Discord Gateway client's lifecycle: boot, credential-change
 * teardown/rebuild, and the reconcile poll that makes both self-healing.
 */

import { getCredentials } from "../credential-cache.js";
import { getConfig } from "../config.js";
import { getConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { CredentialWatcher } from "../credential-watcher.js";
import { createConversationTaskQueue } from "../channels/conversation-queue.js";
import { createDiscordInboundEventHandler } from "./forward.js";
import { DiscordGatewayClient } from "./gateway-socket.js";
import { getLogger } from "../logger.js";

const log = getLogger("discord-gateway");

let client: DiscordGatewayClient | null = null;

/** The bot token the running client was booted with. Null while no client. */
let bootedToken: string | null = null;

/**
 * How often the reconcile pass re-reads the credential and repairs any drift
 * between the store and the running client. The credential watcher is the
 * fast path, but it is one-shot by construction — the watcher records a
 * change before its callback runs, so a stale read or a missed event (an
 * fs.watch that does not propagate across containers, a CES poll racing the
 * credential cache's TTL) leaves the client unbooted until the NEXT change.
 * The reconcile pass bounds that failure to one interval.
 */
const RECONCILE_INTERVAL_MS = 30_000;

export function getDiscordGatewayClient(): DiscordGatewayClient | null {
  return client;
}

async function reconcile(
  forwardQueue: ReturnType<typeof createConversationTaskQueue>,
): Promise<void> {
  // Forced: the watcher just told us the store moved, so a cached value
  // older than the event is exactly the wrong answer.
  const botToken = await getCredentials().get(
    credentialKey("discord_channel", "bot_token"),
    { force: true },
  );

  if (!botToken) {
    if (client) {
      log.info("Discord bot token cleared; stopping the Gateway client");
      client.stop();
      client = null;
      bootedToken = null;
    }
    return;
  }

  if (client) {
    if (bootedToken === botToken) {
      return;
    }
    log.info("Discord bot token changed; rebuilding the Gateway client");
    client.stop();
    client = null;
    bootedToken = null;
  }

  // Room admission defers to Discord's own channel permissions. A
  // non-empty legacy allow-list is persisted operator intent, so it keeps
  // gating rooms until the operator clears it; the log names the way out.
  const readLegacyAllowedChannelIds = (): ReadonlySet<string> | undefined => {
    const ids =
      getConfigFileCache().getStringArray("discord", "allowedChannelIds") ?? [];
    return ids.length > 0 ? new Set<string>(ids) : undefined;
  };
  if (readLegacyAllowedChannelIds() !== undefined) {
    log.warn(
      "discord.allowedChannelIds is a legacy setting and is still " +
        "enforced: the bot answers mentions only in listed channels. To " +
        "adopt Discord's own permission model, scope the bot with View " +
        "Channel permissions in Discord and remove the config entry.",
    );
  }

  client = new DiscordGatewayClient(
    {
      botToken,
      readLegacyAllowedChannelIds,
    },
    createDiscordInboundEventHandler({
      config: getConfig(),
      log,
      forwardQueue,
    }),
  );

  client.start().catch((err) => {
    log.error({ err }, "Failed to start Discord Gateway client");
  });
  bootedToken = botToken;
  log.info("Discord Gateway client started");
}

/**
 * Arms the credential watcher that boots the Discord Gateway client once a
 * bot token is stored — a token already present at boot surfaces as a
 * changed service on the watcher's first poll, the same path the Slack
 * socket boots through — and restarts it on every later token change.
 *
 * A reconcile interval rides alongside the watcher so a missed event is a
 * 30-second delay, not a permanent "token stored, gateway never started"
 * state that only an app restart repairs.
 *
 * Returns the stop thunk: it detaches the watcher and the interval and tears
 * the client down, safe to ride shutdownTasks.
 */
export function startDiscordGateway(): () => Promise<void> {
  const forwardQueue = createConversationTaskQueue();

  const watcher = new CredentialWatcher((event) => {
    if (!event.changedServices.has("discord_channel")) return;
    reconcile(forwardQueue).catch((err) => {
      log.error(
        { err },
        "Failed to restart Discord Gateway after credential change",
      );
    });
  });
  void watcher.start();

  const reconcileTimer = setInterval(() => {
    void reconcile(forwardQueue).catch((err) => {
      log.error({ err }, "Discord Gateway reconcile failed");
    });
  }, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  return () => {
    clearInterval(reconcileTimer);
    watcher.stop();
    const stopping = client;
    client = null;
    bootedToken = null;
    stopping?.stop();
    return Promise.resolve();
  };
}
