/**
 * Sends a reply email through the BYO provider's API and returns the
 * provider's Message-ID for the history row — unlike the webhook routes'
 * fire-and-forget senders, the reply surface must record what it sent so
 * later replies can thread against it.
 */

import { getLogger } from "../logger.js";

const log = getLogger("email-reply-sender");

export interface ProviderReplyInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo: string | null;
  /** Full References chain to carry forward, already joined. */
  references: string | null;
}

/** Resend: POST /emails, threading headers ride the `headers` object. */
export async function sendResendReply(
  apiKey: string,
  input: ProviderReplyInput,
): Promise<string | null> {
  try {
    const sendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        headers: {
          ...(input.inReplyTo ? { "In-Reply-To": input.inReplyTo } : {}),
          ...(input.references ? { References: input.references } : {}),
        },
      }),
    });
    if (!sendResponse.ok) {
      log.warn(
        { status: sendResponse.status, from: input.from, to: input.to },
        "Failed to send reply via Resend",
      );
      return null;
    }
    const body: { id?: string } = await sendResponse
      .json()
      .catch(() => ({}));
    log.info({ from: input.from, to: input.to }, "Sent reply via Resend");
    return body.id ?? null;
  } catch (err) {
    log.error({ err, from: input.from, to: input.to }, "Error sending reply via Resend");
    return null;
  }
}

/** Mailgun: POST /v3/{domain}/messages, threading headers as form fields. */
export async function sendMailgunReply(
  apiKey: string,
  input: ProviderReplyInput,
): Promise<string | null> {
  const domain = input.from.split("@")[1];
  if (!domain) {
    return null;
  }
  try {
    const form = new URLSearchParams();
    form.set("from", input.from);
    form.set("to", input.to);
    form.set("subject", input.subject);
    form.set("text", input.text);
    if (input.inReplyTo) {
      form.set("h:In-Reply-To", input.inReplyTo);
    }
    if (input.references) {
      form.set("h:References", input.references);
    }
    const sendResponse = await fetch(
      `https://api.mailgun.net/v3/${domain}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${apiKey}`).toString("base64")}`,
        },
        body: form,
      },
    );
    if (!sendResponse.ok) {
      log.warn(
        { status: sendResponse.status, from: input.from, to: input.to },
        "Failed to send reply via Mailgun",
      );
      return null;
    }
    const body: { id?: string } = await sendResponse
      .json()
      .catch(() => ({}));
    log.info({ from: input.from, to: input.to }, "Sent reply via Mailgun");
    return body.id ?? null;
  } catch (err) {
    log.error({ err, from: input.from, to: input.to }, "Error sending reply via Mailgun");
    return null;
  }
}
