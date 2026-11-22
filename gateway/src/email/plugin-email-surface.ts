/**
 * The plugin email surface core: list the BYO lane's history and thread a
 * reply onto a stored message. Shared by both exposures — the gateway's
 * HTTP routes (capability-token, for anything outside the VM) and the IPC
 * handlers the daemon's email tool calls over the unix socket.
 */

import { getLogger } from "../logger.js";
import { resolveCredentialWithRefresh } from "../credential-refresh.js";
import { getCredentials } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";
import {
  getEmailMessageById,
  recordOutboundEmail,
  type EmailMessageRow,
} from "../db/email-message-store.js";
import { buildQuotedHistory } from "./quote.js";
import { sendMailgunReply, sendResendReply } from "./reply-sender.js";

const log = getLogger("plugin-email-surface");

export type PluginEmailReplyResult =
  | { ok: true; message: EmailMessageRow }
  | { ok: false; status: number; error: string };

/**
 * The RFC chain a reply carries: the parent's chain plus the parent's own
 * Message-ID — exactly what a composing client puts in References.
 */
export function buildReferencesChain(parent: {
  messageId: string | null;
  referencesChain: string | null;
}): string | null {
  return (
    [parent.referencesChain, parent.messageId]
      .filter((part): part is string => Boolean(part))
      .join(" ")
      .trim() || null
  );
}

export async function replyToPluginEmail(
  replyTo: number,
  text: string,
): Promise<PluginEmailReplyResult> {
  const parent = getEmailMessageById(replyTo);
  if (!parent) {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (parent.direction !== "in" || !parent.messageId) {
    // Replies thread onto RECEIVED mail carrying a real Message-ID.
    return { ok: false, status: 409, error: "Not replyable" };
  }

  let apiKey: string | undefined;
  try {
    apiKey =
      (await resolveCredentialWithRefresh(
        getCredentials(),
        credentialKey(parent.provider, "api_key"),
      )) ?? undefined;
  } catch (err) {
    log.error(
      { err, provider: parent.provider },
      "Failed to resolve provider credential",
    );
    return { ok: false, status: 500, error: "Internal error" };
  }
  if (!apiKey) {
    return { ok: false, status: 503, error: "Provider credentials not configured" };
  }

  const references = buildReferencesChain(parent);
  const subject = `Re: ${parent.subject ?? "(no subject)"}`;
  const quote = buildQuotedHistory(
    {
      fromAddress: parent.fromAddr,
      createdAt: new Date(parent.createdAt),
    },
    { text: parent.bodyText, html: null },
  );
  const composed = `${text}\n\n${quote.text}`;

  const replyInput = {
    from: parent.toAddr,
    to: parent.fromAddr,
    subject,
    text: composed,
    inReplyTo: parent.messageId,
    references,
  };
  const providerMessageId =
    parent.provider === "resend"
      ? await sendResendReply(apiKey, replyInput)
      : parent.provider === "mailgun"
        ? await sendMailgunReply(apiKey, replyInput)
        : null;
  if (!providerMessageId) {
    return { ok: false, status: 502, error: "Send failed" };
  }

  const row = recordOutboundEmail({
    assistantId: parent.assistantId,
    provider: parent.provider,
    messageId: providerMessageId,
    inReplyTo: parent.messageId,
    referencesChain: references,
    fromAddr: replyInput.from,
    toAddr: replyInput.to,
    subject,
    bodyText: composed,
  });
  return { ok: true, message: row };
}
