/**
 * Owns the Slack Socket Mode client's lifecycle: boot, restarts on
 * credential and config change, and teardown. index.ts lifts only
 * `startSlackGateway()`.
 */

import { findGuardianForChannelActor } from "../auth/guardian-bootstrap.js";
import {
  appendFailedAttachmentNotice,
  ingestAttachments,
} from "../attachments/ingest.js";
import { createConversationTaskQueue } from "../channels/conversation-queue.js";
import { eventRefersToAnotherMessage } from "../channels/inbound-event.js";
import { getConfig } from "../config.js";
import { getCredentials } from "../credential-cache.js";
import { getConfigFileCache } from "../config-file-cache.js";
import { credentialKey } from "../credential-key.js";
import { CredentialWatcher } from "../credential-watcher.js";
import { ConfigFileWatcher } from "../config-file-watcher.js";
import { fetchImpl } from "../fetch.js";
import { handleInbound } from "../handlers/handle-inbound.js";
import { getLogger } from "../logger.js";
import { readSavedIngressPublicBaseUrl } from "../remote-web/public-base-url.js";
import { uploadAttachment } from "../runtime/client.js";
import { isNewCommand, handleNewCommand } from "../webhook-pipeline.js";
import { upsertContactChannel } from "../verification/contact-helpers.js";
import { slackBotContactNote } from "./actor.js";
import { downloadSlackFile } from "./download.js";
import {
  createSlackSocketModeClient,
  type SlackSocketModeClient,
} from "./socket-mode.js";
import { buildSlackSourceMetadata } from "./source-metadata.js";

const log = getLogger("slack-gateway");

let client: SlackSocketModeClient | null = null;

/** Live-or-null client for the channel socket health check. */
export function getSlackSocketClient(): SlackSocketModeClient | null {
  return client;
}

// Guards concurrent start calls: at boot both the credential watcher's and
// the config-file watcher's initial polls fire it, and the second call can
// pass the stop() guard while the first is still awaiting credentials,
// leaving the first client running (open WebSocket, reconnect loop, cleanup
// timer) with no reference to stop it.
let startGeneration = 0;

async function start(
  forwardQueue: ReturnType<typeof createConversationTaskQueue>,
): Promise<void> {
  const generation = ++startGeneration;
  if (client) {
    client.stop();
    client = null;
  }

  const credentialCache = getCredentials();
  const botToken = await credentialCache.get(
    credentialKey("slack_channel", "bot_token"),
  );
  const appToken = await credentialCache.get(
    credentialKey("slack_channel", "app_token"),
  );
  // A newer call started while we awaited credentials, so let it own the
  // client. Everything below is synchronous, so one check suffices.
  if (generation !== startGeneration) {
    return;
  }
  if (!botToken || !appToken) return;

  const config = getConfig();
  const configFileCache = getConfigFileCache();
  const threadModeRaw = configFileCache.getString("slack", "threadMode");
  const threadMode =
    threadModeRaw === "mention_only" || threadModeRaw === "mention_then_thread"
      ? threadModeRaw
      : "mention_then_thread";

  client = createSlackSocketModeClient(
    { appToken, botToken, gatewayConfig: config, threadMode },
    (normalized) => {
      const { threadTs, channel } = normalized;
      const params = new URLSearchParams({ channel });
      if (threadTs) params.set("threadTs", threadTs);
      // For non-threaded DMs, pass the original message ts so the runtime
      // can target it for emoji-based thinking indicators.
      const origMessageTs = normalized.event.source.messageId;
      if (!threadTs && origMessageTs) params.set("messageTs", origMessageTs);
      const replyCallbackUrl = `${readSavedIngressPublicBaseUrl()}/deliver/slack?${params}`;

      const refersToAnotherMessage = eventRefersToAnotherMessage(
        normalized.event.message,
      );
      const slackSourceMetadata = buildSlackSourceMetadata(normalized);

      // Handle /new command — reset conversation before it reaches the runtime
      if (isNewCommand(normalized.event.message.content)) {
        handleNewCommand(
          config,
          "slack",
          normalized.event.message.conversationExternalId,
          async (text) => {
            await fetchImpl("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${botToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                channel,
                text,
                ...(threadTs ? { thread_ts: threadTs } : {}),
              }),
            });
          },
          log,
          threadTs,
        );
        return;
      }

      const forward = async () => {
        // Seed contact channel for the Slack actor (dual-write, fire-and-forget).
        // Covers both DMs (externalChatId = DM channel) and workspace messages.
        // Bot/app senders are classified as 'assistant' contacts with a
        // provenance note instead of the default 'human'.
        // An unattributed event (a delete Slack names no human author for)
        // carries the channel's synthetic system id, not a person; seeding
        // a contact from it would mint a record for nobody.
        if (
          normalized.event.actor.actorExternalId &&
          !normalized.event.source.actorUnattributed
        ) {
          void upsertContactChannel({
            sourceChannel: "slack",
            externalUserId: normalized.event.actor.actorExternalId,
            ...(normalized.event.source.chatType === "im"
              ? {
                  externalChatId:
                    normalized.event.message.conversationExternalId,
                }
              : {}),
            displayName: normalized.event.actor.displayName,
            username: normalized.event.actor.username,
            ...(normalized.botSender
              ? {
                  contactType: "assistant" as const,
                  notes: slackBotContactNote(normalized.botSender),
                }
              : {}),
          }).catch(() => {});
        }

        try {
          // Download and upload attachments if present. An event that acts
          // on another message brings no media of its own.
          let attachmentIds: string[] | undefined;
          const eventAttachments = normalized.event.message.attachments;
          if (
            eventAttachments &&
            eventAttachments.length > 0 &&
            normalized.slackFiles &&
            !refersToAnotherMessage
          ) {
            // Guardian-actor bypass: when the Slack sender is the
            // assistant's owner, the upload is marked trustedSource so the
            // assistant accepts arbitrary MIME types and extensions
            // (e.g. .mkv, .dmg) for downstream processing. Resolved once
            // per message — the assistant re-checks gateway-service auth
            // before honoring the flag, so impersonation is not possible.
            // Lookup failures (e.g. assistant.db unavailable) default to
            // strict handling so non-guardian uploads still flow through
            // the normal validation path instead of being dropped.
            const slackActorId = normalized.event.actor.actorExternalId;
            let isGuardianActor = false;
            if (slackActorId) {
              try {
                isGuardianActor = !!(await findGuardianForChannelActor(
                  "slack",
                  slackActorId,
                ));
              } catch (err) {
                log.warn(
                  { err, slackActorId },
                  "Guardian lookup failed; defaulting to strict attachment validation",
                );
              }
            }

            const result = await ingestAttachments(
              config,
              "slack",
              eventAttachments,
              log,
              {
                download: (att, maxBytes) => {
                  const slackFile = normalized.slackFiles?.get(att.fileId);
                  if (!slackFile) {
                    throw new Error(
                      `No SlackFile found for attachment ${att.fileId}`,
                    );
                  }
                  return downloadSlackFile(slackFile, botToken, maxBytes);
                },
                upload: (downloaded) =>
                  uploadAttachment(
                    config,
                    { ...downloaded, trustedSource: isGuardianActor },
                    { skipCircuitBreaker: true },
                  ),
                failurePolicy: { mode: "skip" },
              },
            );
            attachmentIds = result.attachmentIds;
            normalized.event.message.content = appendFailedAttachmentNotice(
              normalized.event.message.content,
              result,
            );
          }

          await handleInbound(config, normalized.event, {
            replyCallbackUrl,
            routingOverride: normalized.routing,
            ...(Object.keys(slackSourceMetadata).length > 0
              ? { sourceMetadata: slackSourceMetadata }
              : {}),
            ...(attachmentIds && attachmentIds.length > 0
              ? { attachmentIds }
              : {}),
          }).catch((err) => {
            log.error(
              { err, channel, threadTs },
              "Failed to forward Slack event to runtime",
            );
          });
        } catch (err) {
          log.error(
            { err, channel, threadTs },
            "Failed to process Slack event — delivering message without attachments",
          );
          await handleInbound(config, normalized.event, {
            replyCallbackUrl,
            routingOverride: normalized.routing,
            ...(Object.keys(slackSourceMetadata).length > 0
              ? { sourceMetadata: slackSourceMetadata }
              : {}),
          }).catch((fwdErr) => {
            log.error(
              { err: fwdErr, channel, threadTs },
              "Failed to forward Slack event to runtime (fallback)",
            );
          });
        }
      };

      // Slack thread/DM context is now assembled on the daemon from
      // persisted message rows (see `assembleSlackChronologicalMessages`
      // in the assistant), so the gateway no longer fetches per-turn
      // thread/DM context to inject as transport hints.
      void forwardQueue
        .enqueue(normalized.event.message.conversationExternalId, forward)
        .catch((err) => {
          log.error(
            { err, channel, threadTs },
            "Unhandled error in Slack forward",
          );
        });

      // Approval message replacement is handled by the assistant's
      // direct Slack delivery path (messaging/providers/slack/send.ts).
    },
  );

  client.start().catch((err) => {
    log.error({ err }, "Failed to start Slack Socket Mode client");
  });
  log.info("Slack Socket Mode client started");
}

/**
 * Arms the credential watcher that boots the Slack Socket Mode client once
 * tokens are stored — tokens already present at boot surface as a changed
 * service on the first poll — and restarts it when either the bot/app
 * tokens or the config file's Slack settings (threadMode) change. Returns
 * the stop thunk: it detaches both watchers and tears the client down,
 * safe to ride shutdownTasks.
 */
export function startSlackGateway(): () => Promise<void> {
  const forwardQueue = createConversationTaskQueue();

  const credentialWatcher = new CredentialWatcher((event) => {
    if (!event.changedServices.has("slack_channel")) return;
    start(forwardQueue).catch((err) => {
      log.error(
        { err },
        "Failed to restart Slack Socket Mode after credential change",
      );
    });
  });
  void credentialWatcher.start();

  const configFileWatcher = new ConfigFileWatcher((event) => {
    // Invalidate the config file cache so the start below reads fresh
    // values, the way main's own watcher arms do.
    getConfigFileCache().invalidate();
    if (!event.changedKeys.has("slack")) return;
    start(forwardQueue).catch((err) => {
      log.error(
        { err },
        "Failed to restart Slack Socket Mode after config change",
      );
    });
  });
  configFileWatcher.start();

  return () => {
    credentialWatcher.stop();
    configFileWatcher.stop();
    const stopping = client;
    client = null;
    stopping?.stop();
    return Promise.resolve();
  };
}
