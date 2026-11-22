import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import { fetchImpl } from "../fetch.js";
import { getLogger } from "../logger.js";

const log = getLogger("email-received");

/** The subset of the gateway's normalized payload the cloud row needs. */
export interface EmailReceivedRecord {
  /** RFC 5322 Message-ID of the received message. */
  messageId: string;
  /** Message-ID of the parent message, when this mail is itself a reply. */
  inReplyTo?: string;
  /** Space-separated ancestor Message-ID chain (the References header). */
  references?: string;
  from: string;
  to: string;
  subject?: string;
  text?: string;
  /** ISO 8601 timestamp of the original email, when the provider supplied one. */
  timestamp?: string;
}

/**
 * Best-effort recorder for the cloud email history: POSTs the normalized
 * inbound payload to `POST /v1/runtime-proxy/email/received/` so received
 * mail becomes an email row — without one, the model's reply_to has no
 * inbound message to reference and every reply goes out unthreaded.
 *
 * The gateway already holds the assistant's cloud credentials (the same
 * pair the callback-route registration uses: `CADET_CLOUD_URL` plus the
 * assistant api key). A missing credential cache yields an undefined
 * recorder; a resolved one still resolves the key per call and swallows
 * every error — the conversation forward is the primary path, recording is
 * bookkeeping.
 */
export function buildEmailReceivedRecorder(caches?: {
  credentials?: CredentialCache;
}): ((record: EmailReceivedRecord) => Promise<void>) | undefined {
  const credentials = caches?.credentials;
  if (!credentials) {
    log.debug("Email received recorder unavailable — no credential cache");
    return undefined;
  }

  return async (record: EmailReceivedRecord): Promise<void> => {
    try {
      const cloudBaseUrl = (process.env.CADET_CLOUD_URL?.trim() || "").replace(
        /\/+$/,
        "",
      );
      if (!cloudBaseUrl) {
        log.debug("CADET_CLOUD_URL unset — received email not recorded");
        return;
      }
      const apiKey = await credentials.get(
        credentialKey("cadet", "assistant_api_key"),
      );
      if (!apiKey?.trim()) {
        log.debug(
          "Assistant api key unavailable — received email not recorded",
        );
        return;
      }
      const response = await fetchImpl(
        `${cloudBaseUrl}/v1/runtime-proxy/email/received/`,
        {
          method: "POST",
          headers: {
            Authorization: `Api-Key ${apiKey.trim()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message_id: record.messageId,
            ...(record.inReplyTo ? { in_reply_to: record.inReplyTo } : {}),
            ...(record.references ? { references: record.references } : {}),
            from: record.from,
            to: [record.to],
            ...(record.subject ? { subject: record.subject } : {}),
            ...(record.text !== undefined ? { text: record.text } : {}),
            ...(record.timestamp ? { timestamp: record.timestamp } : {}),
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        log.warn(
          {
            status: response.status,
            detail: detail.slice(0, 200),
            messageId: record.messageId,
          },
          "Recording received email with cloud failed",
        );
        return;
      }
      log.info(
        { messageId: record.messageId },
        "Received email recorded with cloud",
      );
    } catch (err) {
      log.warn(
        { err, messageId: record.messageId },
        "Recording received email with cloud errored — conversation path unaffected",
      );
    }
  };
}
