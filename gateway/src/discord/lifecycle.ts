/**
 * Owns the Discord Gateway client's lifecycle: boot, credential-change
 * restarts, and teardown. index.ts lifts only `startDiscordGateway()`.
 */

import { createConversationTaskQueue } from "../channels/conversation-queue.js";
import { notifyRecordActivity } from "../channels/record-activity.js";
import { getConfig } from "../config.js";
import { getCredentials } from "../credential-cache.js";
import { getConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { CredentialWatcher } from "../credential-watcher.js";
import { getLogger } from "../logger.js";
import { createDiscordInboundEventHandler } from "./forward.js";
import { DiscordGatewayClient } from "./gateway-socket.js";

const log = getLogger("discord-gateway");

let client: DiscordGatewayClient | null = null;

/** Live-or-null client for the channel socket health check. */
export function getDiscordGatewayClient(): DiscordGatewayClient | null {
  return client;
}

async function start(
  forwardQueue: ReturnType<typeof createConversationTaskQueue>,
): Promise<void> {
  if (client) {
    client.stop();
    client = null;
  }

  const botToken = await getCredentials().get(
    credentialKey("discord_channel", "bot_token"),
  );
  if (!botToken) {
    return;
  }

  // Room admission defers to Discord's own channel permissions. A
  // non-empty legacy allow-list is persisted operator intent, so it keeps
  // gating rooms until the operator clears it; the log names the way out.
  const readLegacyAllowedChannelIds = (): ReadonlySet<string> | undefined => {
    const ids =
      getConfigFileCache().getStringArray("discord", "allowedChannelIds") ?? [];
    return ids.length > 0 ? new Set(ids) : undefined;
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
      notifyRecordActivity,
      forwardQueue,
    }),
  );

  client.start().catch((err) => {
    log.error({ err }, "Failed to start Discord Gateway client");
  });
  log.info("Discord Gateway client started");
}

/**
 * Arms the credential watcher that boots the Discord Gateway client once a
 * bot token is stored — a token already present at boot surfaces as a
 * changed service on the watcher's first poll, the same path the Slack
 * socket boots through — and restarts it on every later token change.
 * Returns the stop thunk: it detaches the watcher and tears the client
 * down, safe to ride shutdownTasks.
 */
export function startDiscordGateway(): () => Promise<void> {
  const forwardQueue = createConversationTaskQueue();

  const watcher = new CredentialWatcher((event) => {
    if (!event.changedServices.has("discord_channel")) return;
    start(forwardQueue).catch((err) => {
      log.error(
        { err },
        "Failed to restart Discord Gateway after credential change",
      );
    });
  });
  void watcher.start();

  return () => {
    watcher.stop();
    const stopping = client;
    client = null;
    stopping?.stop();
    return Promise.resolve();
  };
}
